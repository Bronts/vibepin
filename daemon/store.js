// Shared inbox + per-session queue operations, used by daemon.js, the MCP layer
// and the CLI (watch.js / claim.js). Zero npm deps.
//
// Layout (docs/20260918-session-routing-design.md §4.1):
//   <proj>/.vibepin/inbox.jsonl          shared inbox: broadcasts + no-target notes
//   <proj>/.vibepin/processed.jsonl      claim.js archive (append-only)
//   <proj>/.vibepin/claims.jsonl         claim accounting (append-only, one line per batch)
//   <proj>/.vibepin/sessions/<sid>.json  session lease (who has a queue)
//   <proj>/.vibepin/sessions/<sid>.jsonl that session's queue
//
// Why nothing here rewrites a queue file (§7.3): the old resolveByIds was a
// read-modify-write — it snapshotted the file, awaited, then overwrote it with
// the untouched remainder, so any annotation appended in that window was erased
// (measured: 200/200 interleaved appends lost). Claimed ids are now filtered on
// the READ path against claims.jsonl instead, which makes every writer
// append-only and single-writer with no window.

import { readFile, readdir, appendFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';

// §4.1: a sid is path-safe by construction — the first character is alphanumeric,
// so ".", "..", "/" and "\" can never appear, and the bounded length matters
// because GET /sessions echoes the id verbatim and the overlay posts it back.
export const SID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid);
}

export function assertSid(sid) {
  if (!isValidSid(sid)) throw new Error(`bad sid ${JSON.stringify(sid)} (must match ${SID_RE})`);
  return sid;
}

// `--inbox`/`--queue` name FILES. Windows rename() moves a directory just as
// happily as a file, so a plausible typo (`--inbox <proj>/.vibepin`) used to move
// the whole .vibepin/ tree to .vibepin.claiming and only then die on EISDIR. Both
// CLI scripts refuse a non-file up front and by name; a path that does not exist
// yet is fine (the daemon creates it on the first POST).
export function assertIsFile(file, what) {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return file;
    throw new Error(`cannot stat ${file} (${what}): ${e.code || e.message}`);
  }
  if (!st.isFile()) {
    throw new Error(`${file} (${what}) is not a file — it is ${st.isDirectory() ? 'a directory' : 'not a regular file'}; pass the inbox/queue path, e.g. <proj>/.vibepin/inbox.jsonl`);
  }
  return file;
}

export function resolveInbox(argv = process.argv, env = process.env) {
  const i = argv.indexOf('--inbox');
  return resolve(
    i !== -1 ? argv[i + 1]
      : env.ANNOTATE_INBOX || join(process.cwd(), '.vibepin', 'inbox.jsonl')
  );
}

const CLAIMS_NAME = 'claims.jsonl';

export function pathsFor(inbox) {
  const dir = dirname(inbox);
  return {
    dir,
    sessions: join(dir, 'sessions'),
    processed: join(dir, 'processed.jsonl'),
    claims: join(dir, CLAIMS_NAME),
  };
}

// Every session-scoped path derives from the SHARED inbox, never from --queue
// (§8.1): the lease, the queue and the audit files must stay in the project's own
// .vibepin/ even when --queue points somewhere else.
export function sessionPaths(inbox, sid) {
  assertSid(sid);
  const { sessions } = pathsFor(inbox);
  const queue = join(sessions, `${sid}.jsonl`);
  const lease = join(sessions, `${sid}.json`);
  if (dirname(resolve(queue)) !== resolve(sessions) || dirname(resolve(lease)) !== resolve(sessions)) {
    throw new Error(`sid escapes the sessions dir: ${JSON.stringify(sid)}`);
  }
  return { sessions, queue, lease };
}

// --- queue / CLI shared helpers ------------------------------------------------

// Lines are the unit of truth; a file that is not there yet simply has none.
export async function readJsonlLines(file) {
  let txt;
  try {
    txt = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return txt.split('\n').filter(Boolean);
}

export function parseItem(line) {
  try { return JSON.parse(line); } catch { return { raw: line }; }
}

// A line is an annotation only when it parses to a JSON object. The §7.1 lesson
// applies to reads too: "the file has bytes" is not "there is work", and handing
// a torn or hand-edited line to an agent as pending is the same mistake in
// another form. Nothing rewrites a queue, so a rejected line stays on disk and
// claim.js still drains it into processed.jsonl.
function parseAnnotation(line) {
  try {
    const it = JSON.parse(line);
    return it && typeof it === 'object' && !Array.isArray(it) ? it : null;
  } catch { return null; }
}

// claims.jsonl is append-only and only records ids, so it is the authoritative
// "already handled" ledger for every reader (MCP resolve + claim.js).
export async function claimedIdSet(claimsFile) {
  const set = new Set();
  for (const line of await readJsonlLines(claimsFile)) {
    const rec = parseItem(line);
    if (rec && Array.isArray(rec.ids)) for (const id of rec.ids) if (typeof id === 'string') set.add(id);
  }
  return set;
}

// Pending annotation lines, minus the ones already accounted for in
// claims.jsonl. This is exactly the definition `count()` uses, so a displayed
// pending count and a delivered batch can never disagree.
export async function unclaimedLines(file, claimsFile) {
  const claimed = await claimedIdSet(claimsFile);
  const out = [];
  for (const line of await readJsonlLines(file)) {
    const it = parseAnnotation(line);
    if (!it) continue;
    if (it.id !== undefined && claimed.has(it.id)) continue;
    out.push(line);
  }
  return out;
}

// `--queue` accepts a path or a bare sid (§8.1); a bare sid only when it cannot
// be a filename (no separator, no .jsonl suffix), so the two never get confused.
export function resolveQueue(inbox, value) {
  if (!value) return null;
  if (/[\\/]/.test(value) || value.endsWith('.jsonl')) return resolve(value);
  return sessionPaths(inbox, value).queue;
}

export function resolveSessionId(inbox, { queue, session } = {}, env = process.env) {
  const explicit = session || env.VPIN_SESSION_ID;
  if (explicit) return assertSid(explicit);
  const path = resolveQueue(inbox, queue);
  if (!path) return null; // legacy `--inbox`-only watcher: no session, exactly as today
  return assertSid(basename(path).replace(/\.jsonl$/, ''));
}

// --- leases (§4.2) -------------------------------------------------------------

// Read-only view of .vibepin/sessions/*.json. The daemon (GET /sessions) and the
// CLI (vibepin sessions) both go through here so they cannot disagree.
export async function readLeases(inbox) {
  const { sessions } = pathsFor(inbox);
  let names;
  try {
    names = await readdir(sessions);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // .token (§10.3) lives here too
    const file = join(sessions, name);
    let rec, mtimeMs;
    try {
      // mtime before the read: a lease replaced between the two would otherwise
      // be reported fresher than the record we actually parsed.
      mtimeMs = statSync(file).mtimeMs;
      rec = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // half-written or just removed — display only, never fatal
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    out.push({ sessionId: name.slice(0, -'.json'.length), ...rec, file, mtimeMs });
  }
  return out;
}

// Relative seconds since the last sign of life (§4.4). Display only: judging
// liveness never decides where an annotation goes (§1.4 invariant 3).
export function lastSeenSeconds(rec, now = Date.now()) {
  const stamps = [rec.mtimeMs, rec.lastClaimAt, rec.lastReArmAt].filter((n) => Number.isFinite(n));
  if (!stamps.length) return null;
  return Math.max(0, Math.floor((now - Math.max(...stamps)) / 1000));
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Atomic lease write (§4.2): temp file + rename, so a concurrent 1s poll can
// never read half a JSON. `patch` is an object merged over the record on disk, or
// a function of that record. startedAt is stamped once, on creation.
export async function writeLease(inbox, sid, patch) {
  const { lease } = sessionPaths(inbox, sid);
  let prev = {};
  try {
    const parsed = JSON.parse(await readFile(lease, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prev = parsed;
  } catch { /* absent or unreadable: start from an empty record */ }
  const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
  if (typeof next.startedAt !== 'string') next.startedAt = new Date().toISOString();
  await mkdir(dirname(lease), { recursive: true });
  const tmp = `${lease}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, lease);
  return next;
}

// --- store ---------------------------------------------------------------------

export function createStore(INBOX) {
  const { dir: DIR, sessions: SESSIONS, processed: PROCESSED, claims: CLAIMS } = pathsFor(INBOX);

  const queuePath = (sid) => sessionPaths(INBOX, sid).queue;
  const leasePath = (sid) => sessionPaths(INBOX, sid).lease;

  // Items across several files: claimed ids are dropped (no rewrite ever happens)
  // and the same id never arrives twice, so a batch that exists in both the queue
  // and the shared inbox is delivered once.
  async function readAll(files) {
    const claimed = await claimedIdSet(CLAIMS);
    const seen = new Set();
    const out = [];
    for (const file of files) {
      for (const line of await readJsonlLines(file)) {
        const it = parseAnnotation(line);
        if (!it) continue;
        if (it.id !== undefined) {
          if (claimed.has(it.id) || seen.has(it.id)) continue;
          seen.add(it.id);
        }
        out.push(it);
      }
    }
    return out;
  }

  async function readPending(opts) {
    const sid = typeof opts === 'string' ? opts : opts && opts.sid;
    return readAll([sid ? queuePath(sid) : INBOX]);
  }

  const countLines = async (file) => (await readJsonlLines(file)).length;
  const count = async (file) => (await unclaimedLines(file, CLAIMS)).length;

  async function append(items, opts = {}) {
    const file = opts.sid ? queuePath(opts.sid) : INBOX;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
    return file;
  }

  function queueFiles() {
    try {
      return readdirSync(SESSIONS).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(SESSIONS, f));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async function listQueues() {
    return [INBOX, ...queueFiles()];
  }

  async function pendingTotal() {
    let n = await count(INBOX);
    for (const f of queueFiles()) n += await count(f);
    return n;
  }

  // §7.1: the baseline is the whole {size,mtimeMs,ino} triple. The old byte
  // counter only ever fired on growth, so a claim that drained the file and a
  // shorter follow-up annotation left the watcher blind forever; the triple also
  // covers replacement and rename-onto-new-inode.
  function signature(file) {
    try {
      const s = statSync(file);
      return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
    } catch (e) {
      if (e.code === 'ENOENT') return null; // not created yet is normal
      throw e;
    }
  }

  const sameSig = (a, b) => (a === null || b === null) ? a === b
    : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

  // Long-poll over several files: resolve immediately when anything is pending,
  // else wake as soon as any file changes; [] on timeout so the caller loops.
  // The first file wins the delivery order, so callers pass the session queue
  // before the shared inbox.
  function waitForAny(files, opts = {}) {
    const timeoutMs = typeof opts === 'number' ? opts : (opts.timeoutMs ?? 25000);
    const intervalMs = (typeof opts === 'object' && opts && opts.intervalMs) || 400;
    return new Promise((res, rej) => {
      let iv, to, done = false, busy = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        clearTimeout(to);
        if (err) rej(err); else res(val);
      };
      (async () => {
        try {
          const existing = await readAll(files);
          if (existing.length) return finish(null, existing);
          const base = files.map(signature);
          iv = setInterval(async () => {
            if (done || busy) return;
            busy = true;
            try {
              const now = files.map(signature);
              if (!now.every((s, i) => sameSig(s, base[i]))) {
                const items = await readAll(files);
                // A non-append writer (an editor, a shell redirect, a test) can be
                // caught mid-write. Only hand over a read whose files were quiet for
                // the whole read; otherwise look again on the next tick, so a torn
                // line is never delivered as an annotation.
                const after = files.map(signature);
                if (after.every((s, i) => sameSig(s, now[i]))) finish(null, items);
              }
            } catch (e) {
              finish(e);
            } finally {
              busy = false;
            }
          }, intervalMs);
          to = setTimeout(() => finish(null, []), timeoutMs);
        } catch (e) {
          finish(e);
        }
      })();
    });
  }

  function waitForPending(opts = {}) {
    if (typeof opts === 'number') return waitForAny([INBOX], opts);
    const { sid, ...rest } = opts;
    return waitForAny(sid ? [queuePath(sid), INBOX] : [INBOX], rest);
  }

  // §7.3: append one accounting line, never touch a queue file. `files` is what
  // the caller actually read from, so the returned count only counts ids that
  // were really pending there.
  async function resolveByIds(ids, files, opts = {}) {
    const sessionId = typeof opts === 'string' ? opts : (opts && opts.sessionId) || null;
    const targets = Array.isArray(files) ? files : files ? [files] : [INBOX];
    const wanted = new Set(ids);
    const seen = new Set();
    const resolved = [];
    for (const it of await readAll(targets)) {
      if (it.id === undefined || !wanted.has(it.id) || seen.has(it.id)) continue;
      seen.add(it.id);
      resolved.push(it.id);
    }
    if (resolved.length) {
      await mkdir(DIR, { recursive: true });
      await appendFile(CLAIMS, JSON.stringify({ ids: resolved, sessionId, at: Date.now() }) + '\n', 'utf8');
    }
    return resolved.length;
  }

  return {
    INBOX, DIR, SESSIONS, PROCESSED, CLAIMS,
    queuePath, leasePath,
    listQueues, readAll, readPending, count, countLines, append, pendingTotal,
    waitForAny, waitForPending, resolveByIds,
  };
}
