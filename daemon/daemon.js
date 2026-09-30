#!/usr/bin/env node
// vibepin daemon
// - GET  /annotate.js   -> serves the framework-agnostic overlay (live from disk)
// - POST /annotations   -> appends a batch to <inbox> as JSONL
// - GET  /              -> a self-contained demo page that loads the overlay
// - GET  /health        -> { ok, inbox, pending, port, projectRoot, sessions, pendingTotal }
// - GET  /sessions      -> the read-only session table derived from .vibepin/sessions/
// - POST /annotations   -> append to <inbox>, or to sessions/<sid>.jsonl when the body
//                          names a targetSession that has a lease record
//
// Bound to 127.0.0.1 only. Inbox and project root are resolved once at startup
// so every annotation can say which project it came from and where it landed.

import http from 'node:http';
import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { resolveInbox, createStore, isValidSid, lastSeenSeconds, readLeases, writeLease as writeLeaseFile } from './store.js';
import { stamp as batchStamp, hex4 } from './batches.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
// The range "auto" walks, and the range the browser extension probes for daemons.
const FIRST_PORT = 7331;
const LAST_PORT = 7370;

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// Project config: the file that lets a project pin its own inbox/root/port once
// instead of every invocation repeating them. Lives at <cwd>/.vibepin/config.json
// (committed, unlike the inbox); --config <path> points elsewhere, which is what
// the Vite plugin does — it must not depend on the dev server's cwd.
if (process.argv.includes('--config') && !arg('--config')) {
  // Otherwise a value-less flag would quietly fall back to the cwd config, i.e.
  // the opposite of what the caller asked for.
  console.error('[vibepin] --config needs a path');
  process.exit(1);
}
const CONFIG_PATH = resolve(arg('--config') || join(process.cwd(), '.vibepin', 'config.json'));

// The project root a config's relative paths are resolved against — the directory
// that owns the .vibepin/ dir holding the file (<proj>/.vibepin/config.json), or
// the file's own directory when it is kept outside .vibepin/ (--config <path>).
// Never cwd: a config describes a project, and the daemon may be started from
// anywhere. Kept in sync with adapters/vite.js — if the two disagreed on the
// inbox, the plugin would refuse the daemon it just spawned.
function configBase(file) {
  const dir = dirname(file);
  return basename(dir) === '.vibepin' ? dirname(dir) : dir;
}

// A broken config is fatal on purpose. Falling back to the defaults would leave
// the daemon running while filing this project's annotations in whatever inbox
// the defaults happen to point at — and a wrong inbox is not detectable later.
function badConfig(why) {
  console.error(`[vibepin] bad config ${CONFIG_PATH}: ${why}`);
  process.exit(1);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};  // absent is normal: the defaults apply
  let src;
  try {
    src = readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    badConfig(`cannot read — ${e.message}`);   // e.g. it names a directory
  }
  let raw;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    badConfig(`not valid JSON — ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    badConfig(`expected a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  const base = configBase(CONFIG_PATH);
  const out = {};
  for (const key of ['inbox', 'root']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key].trim()) badConfig(`"${key}" must be a non-empty string`);
    out[key] = resolve(base, raw[key]);
  }
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) {
      badConfig(`"port" must be an integer 0-65535 (0 = auto), got ${JSON.stringify(raw.port)}`);
    }
    out.port = raw.port;
  }
  // "agent" is only the overlay's display name; the Vite plugin reads it, this
  // process does not — an odd value here is not a reason to refuse to start.
  return out;
}

const CONFIG = loadConfig();

// CLI arg / env > config.json > built-in default. 0 means "auto" (freePort below).
const REQUESTED_PORT = Number(arg('--port') || process.env.ANNOTATE_PORT || (CONFIG.port ?? 7331));
if (!Number.isInteger(REQUESTED_PORT) || REQUESTED_PORT < 0 || REQUESTED_PORT > 65535) {
  // Config-sourced ports were validated above, so only the CLI/env can land here.
  console.error(`[vibepin] bad port "${arg('--port') ?? process.env.ANNOTATE_PORT}" — expected an integer 0-65535 (0 = auto)`);
  process.exit(1);
}
let PORT = REQUESTED_PORT;
// Which project this daemon speaks for. The Vite adapter passes its resolved
// root (a dev server may run from a monorepo root, so cwd is only the fallback);
// forward slashes, like the window.__vibepinRoot that adapter injects.
const PROJECT_ROOT = resolve(arg('--root') || process.env.ANNOTATE_ROOT || CONFIG.root || process.cwd()).replace(/\\/g, '/');
// Inbox lives next to whatever project the daemon serves. --inbox/ANNOTATE_INBOX
// (delegated to resolveInbox) still win, config.json sits between them and the
// built-in ./.vibepin/inbox.jsonl — so it can fill that gap, never override it.
const INBOX = (arg('--inbox') || process.env.ANNOTATE_INBOX) ? resolveInbox() : (CONFIG.inbox || resolveInbox());
const PIDFILE = join(dirname(INBOX), 'daemon.json');
const store = createStore(INBOX);
const OVERLAY = join(__dirname, '..', 'core', 'annotate.js');

// ---------------------------------------------------------------------------
// Session registry (design §4). The table is *derived from project files* under
// .vibepin/sessions/ and served read-only: this daemon answers with
// `Access-Control-Allow-Origin: *`, so any page that can reach the port can read
// these endpoints. A page has no way to write project files — which is exactly
// why the registry lives on disk instead of behind an HTTP write endpoint, and
// why the responses below carry a hand-built field whitelist (§4.4).
// ---------------------------------------------------------------------------
const SESSIONS = store.SESSIONS;
const ROUTED = join(dirname(INBOX), 'routed.jsonl');   // routing audit; no watcher listens to it
const CLAIMS = store.CLAIMS;                            // claim audit; written by claim.js and MCP resolve
const POLL_MS = 1000;    // snapshot freshness (§4.4); the file/CLI side polls at 400ms
const LABEL_MAX = 120;   // display ceiling, so one lease cannot fatten every /sessions answer

// Exported so the MCP layer's routing can be driven against the very same
// registry the HTTP views serve (see daemon/mcp.sessions.test.mjs). Running
// `node daemon.js` as a CLI ignores the exports.
export function createSessions() {
  // MCP sessions parked inside waitForPending right now. A parked agent session
  // is alive by definition, so it reports `lastSeenAt: 0` (§8.2) — the most
  // accurate liveness signal available, and still display-only (§6.1).
  const inFlight = new Set();

  // §4.1: validate against the shared regex, *and* re-derive the directory each
  // path lands in (the store asserts the same thing). The regex already excludes
  // '.'/'..'/separators; this is the belt to its braces, so a later regex edit
  // cannot silently open a traversal.
  function valid(sid) {
    if (!isValidSid(sid)) return false;
    try {
      return resolve(dirname(store.queuePath(sid))) === resolve(SESSIONS)
        && resolve(dirname(store.leasePath(sid))) === resolve(SESSIONS);
    } catch {
      return false;
    }
  }

  // A lease record exists ⇒ the sid may receive targeted notes. That is the only
  // routing qualification there is: liveness never enters it (§1.4 invariant 3).
  const hasLease = (sid) => valid(sid) && existsSync(store.leasePath(sid));

  // The lease chain is serialized: two tool calls in the same tick must not
  // interleave read → write on one file. A failed link must neither block the
  // next write nor surface as an unhandled rejection, and must still reach its
  // own caller. The write itself is the store's (temp + rename), so the daemon,
  // watch.js and claim.js all touch lease files the same way.
  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function writeLease(sid, patch) {
    if (!valid(sid)) return Promise.reject(new Error(`bad sid ${JSON.stringify(sid)}`));
    return serialize(async () => {
      const next = await writeLeaseFile(INBOX, sid, patch);
      await refresh();   // a tool call is a heartbeat: show it now, not a tick later
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot (§4.4): rebuilt from readdir+stat every POLL_MS and returned as-is
  // to requests. Every exposed field is written out by hand below — no lease
  // object is ever spread into a response — so cwd / pid / watcherPid / paths
  // cannot leak by accident (they stay on disk, where only the project can read
  // them). The lease scan itself is the store's, so the CLI's `vibepin sessions`
  // and this HTTP view can never disagree about which sessions exist.
  // -------------------------------------------------------------------------
  let snapshot = { sessions: [], lastClaim: null, inboxPending: 0, pendingTotal: 0 };
  let busy = false;

  // Newest claim line (metadata only). claims.jsonl is append-only, so the last
  // parseable line is the most recent claim; ids are collapsed to a count so the
  // panel gets "who, when, how many" and nothing else.
  async function readLastClaim() {
    let txt;
    try { txt = await readFile(CLAIMS, 'utf8'); } catch { return null; }
    const lines = txt.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (!Array.isArray(rec.ids)) continue;
        return {
          sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : null,
          at: Number(rec.at) || 0,
          count: rec.ids.length,
        };
      } catch { /* corrupt tail line — keep scanning older ones */ }
    }
    return null;
  }

  async function refresh() {
    if (busy) return;   // a slow tick must not stack up behind a slow disk
    busy = true;
    if (process.env.VPIN_TICK_DEBUG) console.error("[tick] start "+Date.now());
    try {
      const now = Date.now();
      const rows = [];
      let queuePending = 0;
      for (const lease of await readLeases(INBOX)) {
        const sid = lease.sessionId;
        if (!valid(sid)) continue;      // a stray file must not become a "session"
        let pending = 0;
        try { pending = await store.count(store.queuePath(sid)); } catch { pending = 0; }
        queuePending += pending;
        rows.push({
          sessionId: sid,
          agent: typeof lease.agent === 'string' && lease.agent ? lease.agent.slice(0, 40) : 'unknown',
          label: typeof lease.label === 'string' ? lease.label.slice(0, LABEL_MAX) : '',
          // Parked MCP sessions are alive right now: 0 seconds, not "0 seconds ago".
          lastSeenAt: inFlight.has(sid) ? 0 : (lastSeenSeconds(lease, now) ?? 0),
          pending,
          mode: lease.mode === 'mcp' ? 'mcp' : 'file',
        });
      }
      rows.sort((a, b) => a.lastSeenAt - b.lastSeenAt);   // freshest first (§4.4)
      // Both numbers come from this one tick, so /health can never answer
      // pending > pendingTotal while a POST lands between two reads.
      snapshot = { sessions: rows, lastClaim: await readLastClaim(), inboxPending: await store.count(INBOX), pendingTotal: await store.pendingTotal() };
    } finally {
      busy = false;
      if (process.env.VPIN_TICK_DEBUG) console.error("[tick] snap "+JSON.stringify(snapshot));
      if (process.env.VPIN_TICK_DEBUG) console.error("[tick] end "+Date.now());
    }
  }

  return {
    SESSIONS, valid, hasLease, writeLease,
    queuePath: (sid) => store.queuePath(sid),
    leasePath: (sid) => store.leasePath(sid),
    inFlight,
    markInFlight: (sid, on) => { if (on) inFlight.add(sid); else inFlight.delete(sid); },
    snapshot: () => snapshot,
    start: () => {
      if (process.env.VPIN_TICK_DEBUG) console.error("[tick] start-called");
      refresh().catch((e) => console.error(`[vibepin] session snapshot: ${e.message}`));
      setInterval(() => refresh().catch((e) => console.error(`[vibepin] session snapshot: ${e.message}`)), POLL_MS).unref();
    },
  };
}

// Routing audit (§4.6): metadata only — never the note/html/styles body, so the
// audit cannot become a second copy of the content.
async function auditRoute(rec) {
  try {
    await mkdir(dirname(ROUTED), { recursive: true });
    await appendFile(ROUTED, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    // The annotation is already stored; a failed audit line is worth a word on
    // stderr, but not a 500 that would make the client re-send it.
    console.error(`[vibepin] routed.jsonl audit failed: ${e.message}`);
  }
}

// The instance the HTTP views and the MCP tools share (exported for the tests).
export const sessions = createSessions();

// MCP mode is opt-in: it needs @modelcontextprotocol/sdk. If that isn't
// installed, the daemon still runs in plain file mode (watch.js / claim.js).
let mcpHandler = null;
try {
  const { createMcpHandler } = await import('./mcp.js');
  mcpHandler = await createMcpHandler(store, sessions);
} catch (e) {
  mcpHandler = null;
  if (process.env.ANNOTATE_DEBUG) console.log('[vibepin] MCP mode off:', e.message);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const send = (code, body, type = 'application/json') =>
    res.writeHead(code, { ...CORS, 'Content-Type': type }).end(body);

  // MCP transport owns its own request/response lifecycle — route it first.
  if (url.pathname === '/mcp') {
    if (!mcpHandler) return send(503, JSON.stringify({ error: 'MCP mode not enabled — run `npm install` in vibepin' }));
    try { return await mcpHandler(req, res); }
    catch (e) { if (!res.headersSent) send(500, JSON.stringify({ error: String(e.message || e) })); return; }
  }

  if (req.method === 'OPTIONS') return send(204, '');

  try {
    if (req.method === 'GET' && url.pathname === '/annotate.js') {
      const js = await readFile(OVERLAY, 'utf8');
      // never cache the overlay — a plain reload should always get the latest
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(js);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const snap = sessions.snapshot();
      return send(200, JSON.stringify({
        ok: true,
        inbox: INBOX,
        // Line count = unclaimed annotations in the shared inbox (the store's
        // count() filters ids already recorded in claims.jsonl, which is where a
        // resolve lands now that queues are append-only — raw lines would over-
        // report claimed-but-still-present entries).
        pending: snap.inboxPending,
        port: PORT,
        projectRoot: PROJECT_ROOT,
        // §4.4 additions. `inbox` (string) and a numeric `port` stay put:
        // extension/discover.js recognises a daemon by exactly those two, so
        // dropping either makes this daemon undiscoverable. Nothing else may be
        // added here — any page that can reach the port can read this response.
        sessions: snap.sessions.length,
        pendingTotal: snap.pendingTotal,
      }));
    }

    // Read-only session table (§4.4). Snapshot, not a fresh disk scan: the 1s
    // poll already did that, and a request must never be able to make the daemon
    // touch the filesystem on a page's behalf.
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const snap = sessions.snapshot();
      return send(200, JSON.stringify({ sessions: snap.sessions, lastClaim: snap.lastClaim }));
    }

    if (req.method === 'POST' && url.pathname === '/annotations') {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : Array.isArray(data.annotations) ? data.annotations : [data];
      if (!items.length) return send(400, JSON.stringify({ error: 'no annotations' }));

      // §4.5: the target is a routing key that sits beside the annotations, never
      // one of their fields — read here, and left out of the whitelist below.
      const target = data && !Array.isArray(data) ? data.targetSession : undefined;
      const aimed = target !== undefined && target !== null && target !== '';
      if (aimed && !sessions.valid(target)) {
        return send(400, JSON.stringify({ error: 'bad targetSession' }));   // nothing touches the disk
      }

      await mkdir(dirname(INBOX), { recursive: true });
      const now = Date.now();
      // One POST = one write batch. The id is minted here and never taken from
      // the page: the batch number is the daemon's accounting, not a field a
      // client may forge (the same reason inbox/projectRoot are stamped here).
      const batchId = `w-${batchStamp(now)}-${hex4()}`;
      const records = items.map((a, i) => ({
        id: a.id || `${now}-${i}`,
        ts: a.ts || now,
        url: a.url || '',
        note: a.note || '',
        kind: a.kind || 'element',          // 'element' | 'region'
        selector: a.selector || '',
        component: a.component || null,      // React component name (dev builds)
        source: a.source || null,           // source file:line (dev builds)
        chain: a.chain || null,             // component chain, innermost first (who owns the layout)
        sourcePos: a.sourcePos || null,     // { line, column } when an inspector plugin is on
        elements: a.elements || null,       // region mode: sampled elements
        rect: a.rect || null,
        container: a.container || null,     // parent box + layout of the annotated element
        viewport: a.viewport || null,       // { w, h, dpr, theme }
        html: a.html || '',
        styles: a.styles || null,
        screenshot: a.screenshot || null,
        // Write-batch provenance (seq is 1-based, the same number the overlay's
        // pin list shows). claim.js groups these into ONE claim batch, so the
        // ack key is the claim `seq` printed in the delivery header — this one is
        // for tracing a record back to the POST that delivered it.
        batch: { id: batchId, seq: i + 1, total: items.length },
        // Stamped here, never taken from the page: provenance has to be true
        // even when the overlay is stale or the page belongs to another project.
        inbox: INBOX,
        projectRoot: PROJECT_ROOT,
        daemonPort: PORT,
      }));

      // Two rules and no third one (§5.1). Liveness is never consulted: a session
      // with a lease record that has been quiet for an hour still owns its queue —
      // the note waits there, visibly, instead of being broadcast somewhere else.
      let routed = 'broadcast';
      let degraded = false;
      let reason = null;
      let pending;
      if (aimed && sessions.hasLease(target)) {
        // Its queue, and only its queue. No shadow copy in the shared inbox:
        // claim.js takes a whole file with no field filtering, so a copy would be
        // handed to whichever session claims first — and wake every other watcher
        // (watch.js counts bytes) for a note that is not theirs (§4.5 rule 1).
        // The queue file is created only here, i.e. only for a sid that already
        // has a lease record: a request cannot mint a session by naming one.
        await store.append(records, { sid: target });
        routed = 'session';
        pending = await store.count(store.queuePath(target));
      } else {
        await appendFile(INBOX, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        pending = await store.count(INBOX);
        if (aimed) {
          // The only degraded path: the user picked a target whose lease record is
          // gone (session exited, sessions/ cleaned). Behaviour falls back to
          // today's broadcast + first-claim-wins, and says so in three places: the
          // response, the panel, and routed.jsonl.
          degraded = true;
          reason = 'unknown-session';
        }
      }

      if (aimed) {
        await auditRoute({ at: now, target, routed, degraded, reason, received: records.length, ids: records.map((r) => r.id), url: records[0].url });
      }

      const body = { ok: true, received: records.length, routed, pending };
      if (aimed) body.target = target;
      if (degraded) { body.degraded = true; body.reason = reason; }
      return send(200, JSON.stringify(body));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>vibepin demo</title>
<style>body{margin:0;background:#111;color:#eee;font:14px system-ui;padding:40px}
.card{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;padding:20px;max-width:520px;margin:14px 0}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}
h1{font-size:18px;margin:0 0 6px}.muted{color:#888}</style></head>
<body><h1>vibepin · demo</h1>
<p class="muted">Press <b>⌥A</b> (Option+A on Mac) / <b>Alt+A</b> to toggle annotate mode, hover an element, click it, type a note, then Send.</p>
<div class="card"><h1>A sample card</h1><p class="muted">Annotate this heading, this paragraph, or the button below.</p>
<button id="cta">A button</button></div>
<div class="card"><h1>Another block</h1><p>Whatever you click gets a CSS selector, outerHTML, computed styles and your note posted to the inbox.</p></div>
<script src="/annotate.js"></script></body></html>`,
        'text/html; charset=utf-8'
      );
    }

    return send(404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    return send(500, JSON.stringify({ error: String(e.message || e) }));
  }
});

// A busy port tells us nothing about *whose* port it is, so ask the daemon
// holding it. Returns { inbox } when it answers usably, { error } when it does not.
async function probeHealth(port, timeoutMs = 2000) {
  const url = `http://${HOST}:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `${url} -> HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.inbox !== 'string') return { error: `${url} -> unrecognised payload` };
    return { inbox: body.inbox };
  } catch (e) {
    return { error: `${url} -> ${e.name === 'TimeoutError' ? `no response in ${timeoutMs}ms` : e.message || e}` };
  }
}

// Windows paths are case-insensitive; a drive-letter difference is not a
// different project.
const sameInbox = (a, b) => {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// "Auto" port: the first one in the range we can actually bind. Same walk the
// Vite plugin does, so an auto-picked daemon stays where the browser extension
// probes (7331-7370) instead of landing on an ephemeral port nobody looks at.
const bindable = (port) => new Promise((done) => {
  const probe = createServer();
  probe.unref();
  probe.once('error', () => done(false));
  probe.once('listening', () => probe.close(() => done(true)));
  probe.listen(port, HOST);
});

async function freePort() {
  for (let p = FIRST_PORT; p <= LAST_PORT; p++) if (await bindable(p)) return p;
  console.error(`[vibepin] no free port in ${FIRST_PORT}-${LAST_PORT} — stop a vibepin daemon or pass --port N`);
  process.exit(1);
}

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.error('[vibepin] daemon error:', e.message);
    process.exit(1);
  }
  // Two very different situations hide behind EADDRINUSE: this project's daemon
  // is already up (reuse it), or another project owns the port (reusing it would
  // silently file our annotations in their inbox — refuse and be loud).
  const health = await probeHealth(PORT);
  if (health.inbox && sameInbox(health.inbox, INBOX)) {
    console.log(`[vibepin] daemon already running on ${HOST}:${PORT} for this inbox — reusing it`);
    console.log(`[vibepin] inbox   ${INBOX}`);
    process.exit(0);
  }
  if (health.inbox) {
    console.error(`[vibepin] FATAL ${HOST}:${PORT} already serves a different project.`);
    console.error(`[vibepin]   its inbox:  ${health.inbox}`);
    console.error(`[vibepin]   this inbox: ${INBOX}`);
  } else {
    console.error(`[vibepin] FATAL ${HOST}:${PORT} is in use and is not a vibepin daemon we can identify.`);
    console.error(`[vibepin]   ${health.error}`);
    console.error(`[vibepin]   this inbox: ${INBOX}`);
  }
  console.error(`[vibepin]   project root: ${PROJECT_ROOT}`);
  console.error('[vibepin] Refusing to start: annotations from this project would be delivered elsewhere.');
  console.error('[vibepin]   Stop whatever holds the port, or pick a free one (--port N / ANNOTATE_PORT=N).');
  process.exit(1);
});

// `port: 0` means "pick one": do it before binding, so /health and the injected
// script src advertise the port we actually hold.
//
// A listener is opened only when this file is the entry point. `sessions` and
// `createSessions` are exported above so daemon/mcp.sessions.test.mjs can drive
// the MCP routing against the very same registry the HTTP views serve (§8.2) —
// an import must not leave a second daemon listening on the machine.
// `import.meta.main` is not available on every Node this package supports
// ("engines": ">=18"), so the equivalent is an argv/realpath comparison. The
// realpath leg matters: Node resolves a symlinked main module by default
// (`--preserve-symlinks-main` is opt-in), so the argv path and import.meta.url can
// differ textually while naming the same file.
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;                       // node -e / REPL: nothing to boot
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const here = fileURLToPath(import.meta.url);
  const mine = resolve(invoked);
  if (same(mine, here)) return true;
  try { return same(realpathSync(mine), realpathSync(here)); } catch { return false; }
}

if (isEntryPoint()) {
  if (!PORT) PORT = await freePort();

  server.listen(PORT, HOST, async () => {
    if (!existsSync(dirname(INBOX))) await mkdir(dirname(INBOX), { recursive: true }).catch(() => {});
    // A pidfile is what lets `vibepin down` (and a human) stop *this* daemon rather
    // than guess a PID. /health deliberately never exposes one, so without this the
    // only way out of a detached daemon is the task manager.
    await mkdir(dirname(INBOX), { recursive: true }).catch(() => {});
    await writeFile(PIDFILE, `${JSON.stringify({ pid: process.pid, port: PORT, inbox: INBOX, startedAt: Date.now() })}\n`, 'utf8').catch(() => {});
    const dropPidfile = () => { try { rmSync(PIDFILE, { force: true }); } catch { /* best effort */ } };
    process.on('exit', dropPidfile);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dropPidfile(); process.exit(0); });
    sessions.start();   // §4.4: 1s readdir+stat poll, started with the server
    console.log(`[vibepin] daemon  http://${HOST}:${PORT}`);
    console.log(`[vibepin] overlay http://${HOST}:${PORT}/annotate.js`);
    console.log(`[vibepin] inbox   ${INBOX}`);
    console.log(`[vibepin] root    ${PROJECT_ROOT}`);
    console.log(`[vibepin] pid     ${process.pid}  (stop with: vibepin down)`);
    console.log(`[vibepin] sessions ${SESSIONS} (read-only for the browser: GET /sessions)`);
    if (existsSync(CONFIG_PATH)) console.log(`[vibepin] config  ${CONFIG_PATH}`);
    console.log(mcpHandler
      ? `[vibepin] MCP     http://${HOST}:${PORT}/mcp  (tools: list/watch/resolve_annotations)`
      : `[vibepin] MCP     off — run \`npm install\` in vibepin to enable /mcp`);
  });
}
