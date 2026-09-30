#!/usr/bin/env node
// vibepin CLI — resolves from the installed package, so projects reference
// it as `npx vibepin <cmd>` (no absolute paths, repo stays clean).
//
//   vibepin init [--agent <name>]                wire up the /vpin loop for an agent
//                [--root <dir>] [--vibepin-dir <dir>] [--dry-run] [--upgrade]
//   vibepin daemon [--inbox <path>] [--port N]   start daemon (overlay + /mcp)
//   vibepin watch  [--inbox <path>] [--queue <path|sid>] [--session <sid>]
//                                                block until there is work, then exit
//   vibepin claim  [--inbox <path>] [--queue <path|sid>] [--session <sid>] [--recover]
//                             [--ledger] [--full] [--json] [--open-ttl <ms>]
//                                                drain annotations, open a batch ledger,
//                                                print the instruction-layer delivery header
//   vibepin ack    [--batch <id|last>] [--seq <n[,n]>] [--status <s>] [--note <t>]
//                  [--reason <t>] [--all-done]  settle delivered items (the ledger's only writer)
//   vibepin report [--batch <id|last>] [--session <sid>] [--all] [--json] [--rebuild]
//                                                the user-facing per-batch table
//   vibepin batches [--json] [--session <sid>] [--open]
//                                                list claim batches: count / pages / open
//   vibepin show   [--batch <id|last>] [--seq <n[,n]>] [--evidence] [--json] [--group]
//                  [--record <line>]              re-print one batch or expand one record
//   vibepin sessions [--json]                    list session leases, pending, last activity
//   vibepin doctor [--root <dir>]                diagnose the wiring (exit 1 on defects)
//
// Default inbox for every command: ./.vibepin/inbox.jsonl (cwd-relative).
//   --agent: claude (default) | codex | cursor | antigravity | omp | all

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createStore, isValidSid, lastSeenSeconds, pathsFor, pidAlive, readLeases } from '../daemon/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const HOME = homedir();
const HOST_LABEL = '127.0.0.1';                 // daemon.js binds 127.0.0.1 only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...rest] = process.argv.slice(2);

// A value-less option must fail loudly rather than silently fall back: these
// decide where files are written / which checkout the printed commands point at,
// so guessing would do the opposite of the ask (same stance as daemon.js' --config).
const has = (name) => rest.includes(name);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const opt = (name) => {
  if (!has(name)) return undefined;
  const value = flag(name);
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};
const DRY = has('--dry-run');
const UPGRADE = has('--upgrade');

// §11.3: the marker the bundled templates carry, and that an already wired-up
// project is missing until it is rewritten. Marker generation == protocol
// generation: **marker v4 ⇔ protocol v4.1** (instruction-layer default, see
// docs/20260919-batch-ledger.md). The ledger schema itself is still `v: 1` —
// v4.1 changed what claim prints, so the old v3 marker could not reach a project
// wired before it (init reported "already batch-ledger-v3" and rewrote nothing).
const MARKER = '<!-- vibepin:batch-ledger-v4 -->';
// The generation the marker names. init/doctor messages derive it from MARKER so
// their wording can never drift from the marker again (the v3→v4 rename proved
// the cost of a second hardcoded copy).
const MARKER_GEN = MARKER.slice('<!-- vibepin:'.length, -' -->'.length);
const HEADING = '## 注记（vibepin）';

// The AGENTS.md section runs from its "## " heading to the next heading of the
// same or higher level (subsections are "###"), so upgrading rewrites exactly
// that section and never the rest of the file.
const sectionBounds = (text, heading = HEADING) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let n = start + 1; n < lines.length; n++) {
    if (/^#{1,2}\s/.test(lines[n])) { end = n; break; }
  }
  return { lines, start, end };
};
const sectionText = (text, heading = HEADING) => {
  const b = sectionBounds(text, heading);
  return b ? b.lines.slice(b.start, b.end).join('\n') : null;
};
const replaceSection = (text, heading, body) => {
  const b = sectionBounds(text, heading);
  const head = b.lines.slice(0, b.start).join('\n').replace(/\s+$/, '');
  const tail = b.lines.slice(b.end).join('\n').replace(/^\s+/, '');
  return `${[head, body.replace(/\s+$/, ''), tail].filter((part) => part !== '').join('\n\n')}\n`;
};

// `init` wires the /vpin file-watcher loop into a coding agent's config. npm/npx
// can't do this — these command/prompt files live in the agent's config dir (or the
// project's), not node_modules. Each agent also gets the MCP endpoint as an
// alternative (printed, never auto-merged, so existing config is never clobbered).
if (cmd === 'init') {
  const MCP_URL = 'http://127.0.0.1:7331/mcp';

  // Copy a bundled command/prompt template over its destination. copyFileSync
  // replaces silently (§13 #1), so report which of the two actually happened, on
  // the absolute path: for claude/codex/cursor re-running init IS the upgrade
  // path (§11.1), whereas the omp files below are never rewritten without
  // --upgrade. Returns the verb for the caller's message.
  const install = (srcRel, dest) => {
    const existed = existsSync(dest);
    if (DRY) return existed ? 'would overwrite' : 'would install';
    if (UPGRADE && existed) console.log(`  replacing ${dest}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(REPO, srcRel), dest);
    return existed ? 'overwrote' : 'installed';
  };

  const AGENTS = {
    claude: () => {
      const dest = join(HOME, '.claude', 'commands', 'vpin.md');
      console.log(`✓ Claude Code: ${install('.claude/commands/vpin.md', dest)} /vpin → ${dest}`);
      console.log('  This file is replaced on every init (the omp files are not).');
      console.log('  Restart Claude Code, then run /vpin in your project.');
      console.log(`  MCP alternative: claude mcp add --transport http vibepin ${MCP_URL}`);
    },
    codex: () => {
      const dest = join(HOME, '.codex', 'prompts', 'vpin.md');
      console.log(`✓ Codex: ${install('adapters/commands/vpin.codex.md', dest)} /vpin prompt → ${dest}`);
      console.log('  This file is replaced on every init (the omp files are not).');
      console.log('  Run /vpin in Codex in your project.');
      console.log('  MCP alternative — add to ~/.codex/config.toml:');
      console.log('    [mcp_servers.vibepin]');
      console.log('    command = "npx"');
      console.log(`    args = ["-y", "mcp-remote", "${MCP_URL}"]`);
    },
    cursor: () => {
      // Cursor commands & MCP are project-scoped — install into the current project.
      const dest = join(process.cwd(), '.cursor', 'commands', 'vpin.md');
      console.log(`✓ Cursor: ${install('adapters/commands/vpin.cursor.md', dest)} /vpin command → ${dest}`);
      console.log('  This file is replaced on every init (the omp files are not).');
      console.log('  Run /vpin in Cursor in this project.');
      console.log('  MCP alternative — add to .cursor/mcp.json:');
      console.log(`    { "mcpServers": { "vibepin": { "url": "${MCP_URL}" } } }`);
    },
    antigravity: () => {
      // Antigravity has no stable command-file path yet — MCP is the supported route.
      console.log('✓ Antigravity: register the MCP server (no auto-installed command).');
      console.log('  Add to Antigravity\'s MCP config (mcpServers object):');
      console.log(`    { "mcpServers": { "vibepin": { "serverUrl": "${MCP_URL}" } } }`);
      console.log('  Verify the field name (serverUrl/url) against Antigravity\'s current docs.');
      console.log('  See adapters/antigravity.md.');
    },
    // omp (oh-my-pi) needs no agent-side command file: the wiring is three project
    // files — a seeded config.json, a skill, and a section in AGENTS.md (omp loads
    // AGENTS.md by itself). config.json is only ever validated; the skill and the
    // AGENTS.md section are written when absent, reported when they are on an older
    // protocol, and rewritten only with --upgrade (§11.2/§11.3); --dry-run prints
    // the plan without touching disk. Injecting the overlay stays the project's
    // business (adapters/omp.md).
    omp: () => {
      const projectDir = resolve(opt('--root') || process.cwd());
      const vibepinDir = resolve(opt('--vibepin-dir') || REPO);
      const abs = (p) => p.replace(/\\/g, '/');
      if (!existsSync(projectDir)) throw new Error(`--root ${abs(projectDir)} does not exist`);

      const at = (...p) => join(projectDir, ...p);
      const configPath = at('.vibepin', 'config.json');
      const skillPath = at('.omp', 'skills', 'vibepin-annotations', 'SKILL.md');
      const agentsPath = at('AGENTS.md');
      const gitignorePath = at('.gitignore');
      const inbox = at('.vibepin', 'inbox.jsonl');
      const GITIGNORE_LINES = ['.vibepin/*', '!.vibepin/config.json'];

      // Templates ship in this package; only the paths inside them are project-specific.
      const template = (name) => {
        const src = readFileSync(join(REPO, 'adapters', 'omp', name), 'utf8');
        return src.replaceAll('{{VIBEPIN_DIR}}', abs(vibepinDir)).replaceAll('{{PROJECT_DIR}}', abs(projectDir));
      };
      // The daemon refuses a config it cannot parse or type-check (daemon.js
      // loadConfig); init must report the same defect instead of treating the
      // file as "already wired up" — a config the daemon rejects is a mis-route.
      const configProblem = (text) => {
        let raw;
        try { raw = JSON.parse(text); } catch (e) { return `not valid JSON — ${e.message}`; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `expected a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`;
        for (const key of ['inbox', 'root']) {
          if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return `"${key}" must be a non-empty string`;
        }
        if (raw.port !== undefined && (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535)) return `"port" must be an integer 0-65535 (0 = auto)`;
        return null;
      };

      const steps = [];
      const add = (file, how, note, apply) => steps.push({ file, how, note, apply });

      if (existsSync(configPath)) {
        const why = configProblem(readFileSync(configPath, 'utf8'));
        if (why) throw new Error(`${abs(configPath)} is unusable — ${why}; fix or delete it (init never overwrites it).`);
        add('.vibepin/config.json', 'skip', 'exists — kept', null);
      } else {
        add('.vibepin/config.json', 'write', 'agent: omp · inbox: .vibepin/inbox.jsonl · root: . · port: 0 (auto)', () => {
          mkdirSync(dirname(configPath), { recursive: true });
          writeFileSync(configPath, `${JSON.stringify({ agent: 'omp', inbox: '.vibepin/inbox.jsonl', root: '.', port: 0 }, null, 2)}\n`);
        });
      }

      const ignores = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : null;
      const missing = ignores === null ? GITIGNORE_LINES : GITIGNORE_LINES.filter((line) => !ignores.split(/\r?\n/).includes(line));
      if (!missing.length) {
        add('.gitignore', 'skip', 'both lines already present', null);
      } else {
        add('.gitignore', ignores === null ? 'write' : 'append', `+ ${missing.join(', ')}`, () => {
          const head = ignores === null ? '' : ignores.endsWith('\n') ? ignores : `${ignores}\n`;
          writeFileSync(gitignorePath, `${head}${missing.join('\n')}\n`);
        });
      }

      // §11.3: the two agent-side targets are only rewritten by --upgrade, and
      // only when they are still on the old protocol (identified by the version
      // marker the bundled templates carry).
      const skill = template('SKILL.md');
      const skillNow = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null;
      if (skillNow === null) {
        add('.omp/skills/vibepin-annotations/SKILL.md', 'write', 'from adapters/omp/SKILL.md, paths filled in', () => {
          mkdirSync(dirname(skillPath), { recursive: true });
          writeFileSync(skillPath, skill);
        });
      } else if (skillNow.includes(MARKER)) {
        add('.omp/skills/vibepin-annotations/SKILL.md', 'skip', `exists — already ${MARKER_GEN}`, null);
      } else if (UPGRADE) {
        add('.omp/skills/vibepin-annotations/SKILL.md', 'rewrite', `old protocol → ${MARKER_GEN}`, () => {
          writeFileSync(skillPath, skill);
        });
      } else {
        add('.omp/skills/vibepin-annotations/SKILL.md', 'skip', `exists — OLD protocol (no ${MARKER}); re-run with --upgrade to rewrite`, null);
      }

      const section = `${template('AGENTS.md').replace(/\s+$/, '')}\n`;
      const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null;
      const current = agents === null ? null : sectionText(agents);
      if (current === null) {
        add('AGENTS.md', agents === null ? 'write' : 'append', `+ section "${HEADING}"`, () => {
          const head = agents === null || !agents ? '' : agents.endsWith('\n') ? `${agents}\n` : `${agents}\n\n`;
          writeFileSync(agentsPath, `${head}${section}`);
        });
      } else if (current.includes(MARKER)) {
        add('AGENTS.md', 'skip', `section "${HEADING}" already ${MARKER_GEN}`, null);
      } else if (UPGRADE) {
        add('AGENTS.md', 'rewrite', `section "${HEADING}" — old protocol → ${MARKER_GEN}`, () => {
          writeFileSync(agentsPath, replaceSection(agents, HEADING, section));
        });
      } else {
        add('AGENTS.md', 'skip', `section "${HEADING}" is the OLD protocol; re-run with --upgrade to rewrite just that section`, null);
      }

      console.log('vibepin init --agent omp');
      console.log(`  project  ${abs(projectDir)}`);
      console.log(`  vibepin  ${abs(vibepinDir)}`);
      console.log(`  inbox    ${abs(inbox)}`);
      console.log('');
      console.log('Plan — config.json is validated only; SKILL.md / AGENTS.md are rewritten only with --upgrade:');
      steps.forEach((s, n) => console.log(`  ${n + 1}. ${s.how.padEnd(7)} ${s.file}${s.note ? `  (${s.note})` : ''}`));
      console.log('');

      if (DRY) {
        console.log(UPGRADE ? 'Dry run — this is what --upgrade would write; nothing written.' : 'Dry run — nothing written.');
        console.log('');
      } else if (!steps.some((s) => s.apply)) {
        const stale = steps.filter((s) => /OLD protocol/.test(s.note || '')).length;
        console.log(stale
          ? `Nothing to do — ${stale} file(s) above are on the old protocol; re-run with --upgrade to migrate them.`
          : 'Nothing to do — already wired up.');
        console.log('');
      } else {
        const VERB = { write: 'wrote', append: 'appended', rewrite: 'rewrote' };
        steps.forEach((s, n) => {
          if (!s.apply) return;
          s.apply();
          console.log(`${n + 1}. ${VERB[s.how]} ${s.file}`);
        });
        console.log('');
      }

      const sid = '<sid>';
      const queue = `${abs(projectDir)}/.vibepin/sessions/${sid}.jsonl`;
      console.log('Next:');
      console.log('  1. start the daemon from the project root, so it reads .vibepin/config.json:');
      console.log(`       npx vibepin daemon        # or: node ${abs(vibepinDir)}/daemon/daemon.js`);
      console.log('  2. pick a session id (any name matching ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$, e.g. omp-2f9c1a)');
      console.log('     and park the watch && claim loop as a background job (0 tokens while it waits):');
      console.log(`       node ${abs(vibepinDir)}/daemon/watch.js --inbox ${abs(inbox)} --queue ${queue} --session ${sid} && node ${abs(vibepinDir)}/daemon/claim.js --inbox ${abs(inbox)} --queue ${queue} --session ${sid}`);
      console.log('     Re-arm with the SAME --session every round: that id is what the overlay targets.');
      console.log(`  3. after claim prints a delivery header: fix each item, then \`npx vibepin ack --batch <b-…> --seq <n> --note "<file:line: what changed>"\` per item, and finish with \`npx vibepin report --batch <b-…>\` (exit 3 while rows stay open/stale).`);
      console.log(`  Omitting --queue/--session keeps the old broadcast-only loop (directed annotations then wait in the queue: see "vibepin sessions").`);
      console.log(`  MCP alternative: register http://127.0.0.1:<port>/mcp — <port> is the daemon's real port (with "port": 0 it is auto-picked, so read the startup banner or /health; do not assume 7331) — it long-polls, so it keeps spending tokens while the inbox is empty.`);
    },
  };

  const i = rest.indexOf('--agent');
  const which = i >= 0 ? rest[i + 1] : 'claude';
  const names = which === 'all' ? Object.keys(AGENTS) : [which];

  if (!names.every((n) => AGENTS[n])) {
    console.error(`vibepin init: unknown --agent "${which}". Use: ${Object.keys(AGENTS).join(', ')}, all`);
    process.exit(1);
  }

  try {
    names.forEach((n) => AGENTS[n]());
    process.exit(0);
  } catch (e) {
    console.error('vibepin init failed:', e.message);
    process.exit(1);
  }
}

// `sessions` and `doctor` read the project's own .vibepin/ and never write: the
// session table is file-derived (§4.2) and there is deliberately no HTTP write
// path (§2). doctor exits 1 only on real defects (✗), not on warnings (!).
const projectDir = () => resolve(opt('--root') || process.cwd());
const inboxFor = (dir) => resolve(opt('--inbox') || process.env.ANNOTATE_INBOX || join(dir, '.vibepin', 'inbox.jsonl'));
const pretty = (p) => p.replace(/\\/g, '/');

const ago = (s) => (s === null ? 'unknown'
  : s < 90 ? `${s}s ago`
    : s < 5400 ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`);

async function probeDaemon(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
    if (!res.ok) return null;
    const info = await res.json();
    // Same test as extension/discover.js: only `inbox` + a numeric `port` counts.
    if (!info || typeof info.inbox !== 'string' || !info.inbox || !Number.isFinite(info.port)) return null;
    return { port, info };
  } catch {
    return null;
  }
}

// --- batch ledger helpers (v4) -------------------------------------------------
// ack/report/batches/show are LOCAL commands (never in TARGETS): .vibepin/batches/
// <b-…>.json is the whole state, and these commands are its only writers (through
// ackItems/rebuildBatch). They never talk to the daemon and never touch a queue.
//
// v4 invariant: an unsettled batch is VISIBLE DEBT, never a delivery gate. watch
// and claim keep delivering whatever is queued (watch always exits 0); only
// `report` signals debt (exit 3) and only `doctor` nudges about it (a `!`, never a
// defect). --open-ttl therefore decides how a still-open item is *shown* — it
// never decides whether anything can be delivered.
//
// Fail-open: batches.js is imported lazily, so a missing/broken ledger module can
// never take down init/doctor/sessions/--help or the watch/claim passthrough.
const LEDGER_MODULE = '../daemon/batches.js';
const LEDGER_WHY = `the batch-ledger commands need ${LEDGER_MODULE} (see docs/20260919-batch-ledger.md)`;
let ledgerModule;
async function ledger() {
  if (!ledgerModule) {
    try {
      ledgerModule = await import(LEDGER_MODULE);
    } catch (e) {
      throw new Error(`${LEDGER_WHY} — cannot load it: ${e.code || e.message}`);
    }
    for (const fn of ['batchDir', 'readBatch', 'listBatches', 'rollup', 'displayRollup', 'expired', 'openCount', 'reportRows', 'reportExitCode', 'ackItems', 'rebuildBatch', 'formatHeader', 'formatDigest', 'formatReport']) {
      if (typeof ledgerModule[fn] !== 'function') throw new Error(`${LEDGER_WHY} — it does not export ${fn}()`);
    }
  }
  return ledgerModule;
}

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '—');
const ttlLabel = (ms) => (ms >= 3600000 ? `${Math.round(ms / 3600000)}h` : `${ms}ms`);
const asText = (v) => (Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '');

// --open-ttl / ANNOTATE_OPEN_TTL_MS override the module default (8h). A *display*
// threshold: an `open` item older than it reads as `stale` in report/batches.
const openTtl = (L) => {
  const raw = opt('--open-ttl') ?? process.env.ANNOTATE_OPEN_TTL_MS;
  if (raw === undefined) return L && Number.isFinite(L.DEFAULT_OPEN_TTL_MS) ? L.DEFAULT_OPEN_TTL_MS : 28800000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--open-ttl must be a non-negative number of milliseconds (got ${JSON.stringify(raw)})`);
  return n;
};

// 1-based seqs from repeated and/or comma-separated --seq.
const seqList = () => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--seq') continue;
    const v = rest[i + 1];
    if (!v || v.startsWith('--')) throw new Error('--seq needs a value (e.g. --seq 2 or --seq 2,3)');
    for (const part of String(v).split(',')) {
      const n = Number(part.trim());
      if (!Number.isInteger(n) || n < 1) throw new Error(`--seq expects 1-based item numbers (got ${JSON.stringify(part)})`);
      out.push(n);
    }
  }
  return [...new Set(out)];
};

const itemAt = (batch, n) => {
  const item = (batch.items || []).find((i) => i.seq === n);
  if (!item) throw new Error(`batch ${batch.id} has ${batch.items.length} items (seq 1..${batch.items.length})`);
  return item;
};

// §6.2: the ledger file can be gone while claims.jsonl still holds the batch (deleted
// by hand, or a rebuild that never got written). Such a batch is REBUILDABLE and must
// never be reported as "unknown". Read-only probe — rebuilding itself stays opt-in
// (report/ack --rebuild) or automatic (show), so this never turns a read into a write.
const claimsHasBatch = (inbox, id) => {
  let text;
  try {
    text = readFileSync(pathsFor(inbox).claims, 'utf8');
  } catch {
    return false; // no claims file = nothing was ever claimed here
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).batchId === id) return true;
    } catch { /* a torn line is not evidence of a batch */ }
  }
  return false;
};

// The batch the user meant: --batch <id|last>, else the newest (of --session).
// `show` always rebuilds a missing ledger (§4.6); report/ack only with --rebuild.
async function pickBatch(inbox, L, { rebuild = false } = {}) {
  const spec = opt('--batch');
  const sid = opt('--session');
  const all = await L.listBatches(inbox);
  if (!spec || spec === 'last') {
    const pool = sid ? all.filter((b) => b.sessionId === sid) : all;
    if (!pool.length) {
      throw new Error(sid ? `no batch for session ${sid} yet — nothing has been claimed there` : 'no batches yet — nothing has been claimed (vibepin batches)');
    }
    return pool[0];
  }
  const hit = all.find((b) => b.id === spec) || (await L.readBatch(inbox, spec));
  if (hit) return hit;
  if (rebuild || has('--rebuild')) {
    const made = await L.rebuildBatch(inbox, spec);
    const batch = made && made.batch ? made.batch : made;
    if (batch && batch.items) {
      // Only reached when the ledger file was missing; the module owns the warning
      // wording (and already carries its own [vibepin] prefix).
      console.log((made && made.warning) || '[vibepin] 账本缺失，已从 claims.jsonl + processed.jsonl 重建（所有项记 stale/ledger-missing）');
      return batch;
    }
  }
  const near = all.slice(0, 3).map((b) => b.id);
  if (claimsHasBatch(inbox, spec)) {
    throw new Error(`账本缺失：batch ${spec} 的账本文件不在，但 claims.jsonl 里有这一批 —— 可以重建：vibepin report --batch ${spec} --rebuild（ack 同理；show 会自动重建）`);
  }
  throw new Error(`unknown batch: ${spec}${near.length ? ` — recent: ${near.join(', ')}` : ' — this project has no ledgers yet'}`);
}

// §6.1's lowest-level pointer: one raw line of processed.jsonl (evidence.line is a
// 1-based, append-only line number).
const processedLine = (inbox, line) => {
  const file = pretty(pathsFor(inbox).processed);
  let text;
  try {
    text = readFileSync(pathsFor(inbox).processed, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.code || e.message}`);
  }
  const rows = text.split(/\r?\n/);
  const total = rows[rows.length - 1] === '' ? rows.length - 1 : rows.length;
  if (!Number.isInteger(line) || line < 1 || line > total) throw new Error(`evidence line ${line} is gone (${file} has ${total} lines)`);
  return rows[line - 1];
};

const historyText = (item) => (item.history || []).map((h) => `${iso(h.at)} ${h.by} ${h.from ?? '—'} → ${h.to}${h.note ? `（${h.note}）` : h.reason ? `（${h.reason}）` : ''}`).join(' · ');

// One line per item, in seq order. The canonical renderer is the module's
// formatDigest, so `show` and the delivery header can never drift apart.
const digestLines = (L, batch, opts) => asText(L.formatDigest(batch, opts)).split('\n').filter((l) => /^\d+\./.test(l));

// §11.4 recovery channel: which sessions exist, what is waiting in each queue,
// and how long ago each was last active.
if (cmd === 'sessions') {
  const inbox = inboxFor(projectDir());
  const store = createStore(inbox);
  const now = Date.now();
  const rows = [];
  for (const rec of await readLeases(inbox)) {
    if (!isValidSid(rec.sessionId)) continue; // a filename that cannot be a target (§4.1)
    rows.push({
      sessionId: rec.sessionId,
      agent: typeof rec.agent === 'string' ? rec.agent : '?',
      label: typeof rec.label === 'string' ? rec.label : '',
      mode: typeof rec.mode === 'string' ? rec.mode : '?',
      pending: await store.count(store.queuePath(rec.sessionId)),
      lastSeenAt: lastSeenSeconds(rec, now),
      watcher: pidAlive(rec.watcherPid) ? rec.watcherPid : null,
      queue: store.queuePath(rec.sessionId),
    });
  }
  rows.sort((a, b) => (a.lastSeenAt ?? Number.MAX_SAFE_INTEGER) - (b.lastSeenAt ?? Number.MAX_SAFE_INTEGER));
  if (has('--json')) {
    console.log(JSON.stringify({ inbox, sessions: rows }, null, 2));
  } else if (!rows.length) {
    console.log(`no sessions — nothing has registered a lease in ${pretty(pathsFor(inbox).sessions)}`);
    console.log("park a watcher with --queue/--session to register one (npx vibepin init --agent omp prints the command).");
  } else {
    const width = Math.max(...rows.map((r) => r.sessionId.length));
    for (const r of rows) {
      const watcher = r.watcher ? '' : '(no watcher) ';
      console.log(`${r.sessionId.padEnd(width)}  ${r.agent.padEnd(9)} ${String(r.pending).padStart(3)} pending  ${ago(r.lastSeenAt).padEnd(9)} ${watcher}${r.label}`);
    }
    console.log('');
    console.log(`claim one queue by hand: npx vibepin claim --queue <sid>   (queues live in ${pretty(pathsFor(inbox).sessions)})`);
  }
  process.exit(0);
}

// §11.3 diagnostics. Liveness is reported, never used to decide delivery (§1.4-3).
if (cmd === 'doctor') {
  const dir = projectDir();
  const inbox = inboxFor(dir);
  const { sessions: SESSIONS, processed, claims } = pathsFor(inbox);
  const defects = [];
  const say = (mark, text) => { console.log(`${mark} ${text}`); if (mark === '✗') defects.push(text); };

  console.log('vibepin doctor');
  console.log(`  project  ${pretty(dir)}`);
  console.log(`  inbox    ${pretty(inbox)}`);
  console.log(`  audit    ${pretty(processed)} · ${pretty(claims)}`);
  console.log('');

  // ① the registry is files, so "does it exist" is the whole state
  const leases = await readLeases(inbox);
  if (!existsSync(SESSIONS)) say('!', `no session registry at ${pretty(SESSIONS)} — every annotation broadcasts until a watcher registers with --queue/--session`);
  else say('✓', `session registry ${pretty(SESSIONS)} — ${leases.length} lease(s)`);

  // ② leases whose watcher process is gone: kept on purpose (§12), but nothing
  // will wake up for their queued annotations
  const store = createStore(inbox);
  for (const rec of leases.filter((r) => isValidSid(r.sessionId))) {
    const who = rec.label ? ` "${rec.label}"` : '';
    const pending = await store.count(store.queuePath(rec.sessionId));
    if (rec.watcherPid === undefined) say('!', `${rec.sessionId}${who}: no watcherPid (MCP or pre-v2 lease) — ${pending} pending, last activity ${ago(lastSeenSeconds(rec))}`);
    else if (pidAlive(rec.watcherPid)) say('✓', `${rec.sessionId}${who}: watcher pid ${rec.watcherPid} alive — ${pending} pending, last activity ${ago(lastSeenSeconds(rec))}`);
    else say('!', `${rec.sessionId}${who}: watcher pid ${rec.watcherPid} is gone — ${pending} pending annotation(s) will not wake anything; the lease and queue are kept (§12)`);
  }

  // ③ agent-side files still telling the agent to watch/claim without --queue
  // §8.1 prints the v2 command as a `\`-continued multi-line block, so testing one
  // raw line at a time flagged its first line ("--inbox" with the "--queue" still
  // on the next line) as the old protocol. Join continuations, then test commands.
  const oldCommand = (text) => text.replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .find((line) => /(watch|claim)\.js/.test(line) && /--inbox/.test(line) && !/--queue/.test(line));
  const stale = [];
  const skillPath = join(dir, '.omp', 'skills', 'vibepin-annotations', 'SKILL.md');
  const agentsPath = join(dir, 'AGENTS.md');
  if (existsSync(skillPath)) {
    const text = readFileSync(skillPath, 'utf8');
    const hit = oldCommand(text);
    if (hit) stale.push(`.omp/skills/vibepin-annotations/SKILL.md: ${hit.trim()}`);
    if (!text.includes(MARKER)) say('!', `SKILL.md predates the batch-ledger protocol — run: npx vibepin init --agent omp --upgrade`);
  }
  if (existsSync(agentsPath)) {
    const section = sectionText(readFileSync(agentsPath, 'utf8'));
    if (section === null) say('!', `AGENTS.md has no "${HEADING}" section — run: npx vibepin init --agent omp`);
    else {
      const hit = oldCommand(section);
      if (hit) stale.push(`AGENTS.md ${HEADING}: ${hit.trim()}`);
      if (!section.includes(MARKER)) say('!', `AGENTS.md section predates the batch-ledger protocol — run: npx vibepin init --agent omp --upgrade`);
    }
  }
  for (const file of [join(dir, '.cursor', 'commands', 'vpin.md'), join(HOME, '.claude', 'commands', 'vpin.md'), join(HOME, '.codex', 'prompts', 'vpin.md')]) {
    if (!existsSync(file)) continue;
    const hit = oldCommand(readFileSync(file, 'utf8'));
    if (hit) stale.push(`${pretty(file)}: ${hit.trim()}`);
  }
  if (stale.length) for (const hit of stale) say('!', `old protocol command — ${hit}`);
  else say('✓', 'no watch/claim invocation on the old --inbox-only protocol found');

  // ④ a daemon that is reachable, new enough, and pointed at THIS project
  const configPath = join(dir, '.vibepin', 'config.json');
  let configuredPort = 0;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      if (Number.isInteger(raw.port)) configuredPort = raw.port;
    } catch {
      say('✗', `${pretty(configPath)} is not valid JSON — the daemon refuses it and init never repairs it; fix it by hand`);
    }
  }
  const ports = configuredPort > 0 ? [configuredPort] : Array.from({ length: 40 }, (_, n) => 7331 + n);
  const found = (await Promise.all(ports.map(probeDaemon))).filter(Boolean).sort((a, b) => a.port - b.port)[0];
  if (!found) {
    say('!', `no vibepin daemon reachable on ${configuredPort > 0 ? `port ${configuredPort} (from .vibepin/config.json)` : 'ports 7331-7370'} — pages cannot deliver annotations until one runs from the project root`);
  } else {
    if (!('sessions' in found.info)) say('✗', `daemon on port ${found.port} is an older build (no "sessions" in /health) while this CLI is v2 — mixed versions; session listing and routing will not work`);
    else say('✓', `daemon on port ${found.port} — ${found.info.sessions} session(s), pendingTotal ${found.info.pendingTotal}`);
    if (typeof found.info.inbox === 'string' && resolve(found.info.inbox) !== resolve(inbox)) {
      say('✗', `daemon on port ${found.port} collects into ${pretty(resolve(found.info.inbox))}, not ${pretty(inbox)} — a page connected to it lands in another project (§8.5)`);
    }
  }

  // ⑤ the batch ledger (§6.4): unsettled rows are visible debt, never a defect.
  // v4 has no delivery gate, so this is a `!` nudge and never changes the exit code.
  try {
    const L = await ledger();
    const ttl = openTtl(L);
    const ledgers = await L.listBatches(inbox, { onWarn: (m) => say('!', `批账本 读取告警 — ${m}`) });
    if (!ledgers.length) {
      say('✓', `批账本 无账本（${pretty(L.batchDir(inbox))}）`);
    } else {
      const now = Date.now();
      const held = ledgers.filter((b) => b.items.some((i) => i.status === 'open'));
      if (!held.length) {
        say('✓', `批账本 ${ledgers.length} 个批，没有未结清项（${pretty(L.batchDir(inbox))}）`);
      } else {
        const b = held[0];
        const open = b.items.filter((i) => i.status === 'open');
        const old = open.filter((i) => L.expired(i, now, ttl)).length;
        const seqs = open.slice(0, 4).map((i) => i.seq).join(',');
        say('!', `批账本 ${ledgers.length} 个批，${held.length} 个未结清${old ? `（其中 ${old} 项超过 ${ttlLabel(ttl)} 仍未结清）` : ''}：${b.id} 还有 seq ${seqs}${open.length > 4 ? ' …' : ''} —— 逐条结清：vibepin ack --batch ${b.id} --seq ${open[0].seq} --note "改了什么（file:line）"；对比表：vibepin report --batch ${b.id}`);
      }
    }
  } catch (e) {
    say('!', `批账本 不可用 — ${e.message}`);
  }

  console.log('');
  console.log(defects.length ? `${defects.length} defect(s) — fix the ✗ lines above (warnings ! are informational).` : 'no defects found (warnings ! are informational).');
  process.exit(defects.length ? 1 : 0);
}

// §4.2 `ack` — the only writer of item statuses (§1.5). Every failure is exit 1
// and leaves the ledger untouched; a repeat ack is a no-op (exit 0).
if (cmd === 'ack') {
  try {
    const inbox = inboxFor(projectDir());
    const L = await ledger();
    const batch = await pickBatch(inbox, L, { rebuild: has('--rebuild') });
    const seqs = seqList();
    const allDone = has('--all-done');
    const status = opt('--status') || 'done';
    const note = opt('--note');
    const reason = opt('--reason');
    if (allDone && seqs.length) throw new Error('--all-done and --seq are mutually exclusive');
    if (allDone && has('--status')) throw new Error('--all-done and --status are mutually exclusive');
    if (!['done', 'wontfix', 'blocked', 'deferred', 'open', 'stale'].includes(status)) {
      throw new Error(`--status must be done | wontfix | blocked | deferred | open | stale (got ${JSON.stringify(status)})`);
    }
    if (!allDone && !seqs.length) throw new Error(`nothing selected: pass --seq <n> (batch ${batch.id} has ${batch.items.length} items; see vibepin show --batch ${batch.id})`);
    if (status === 'done' && !note) throw new Error('--note is required for done — it becomes the 证据 column of vibepin report');
    if (['wontfix', 'blocked', 'deferred'].includes(status) && !reason) throw new Error(`--reason is required for ${status}`);
    if (['open', 'stale'].includes(status) && !note) throw new Error(`--note is required for ${status}`);
    if (!allDone) for (const n of seqs) itemAt(batch, n); // range-check before touching disk
    const res = await L.ackItems(inbox, batch.id, { seqs: allDone ? null : seqs, status, note, reason });
    const after = (res && res.batch) || (await L.readBatch(inbox, batch.id)) || batch;
    const updated = res && typeof res.updated === 'number' ? res.updated : '?';
    const remaining = after.items.filter((i) => i.status === 'open').length;
    console.log(`${updated} 项更新：${batch.id}${allDone ? ' 全部 open 项' : `#${seqs.join(',')}`} → ${status}（剩余 open ${remaining}）`);
    if (allDone) {
      const counts = L.rollup(after);
      const untouched = ['blocked', 'deferred', 'stale'].filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`);
      if (untouched.length) console.log(`（--all-done 只动 open；未改：${untouched.join(' · ')}）`);
    }
    // closedAt is the ledger's own "no open item" mark; the batch only reads as
    // settled once no row is left — an aged open row still shows as stale debt, and
    // v4 has no gate either way (this line reports, it does not unblock anything).
    const debt = L.reportRows(after, { now: Date.now(), ttl: openTtl(L) }).filter((r) => r.unsettled);
    if (!debt.length) console.log(`批 ${batch.id} 已结清（closedAt ${iso(after.closedAt)}）`);
    else if (!debt.some((r) => r.display === 'open')) console.log(`批 ${batch.id} 已无 open 项，但仍有 ${debt.length} 行未结清（${debt.map((r) => `${r.display} #${r.seq}`).join(' · ')}）—— vibepin report --batch ${batch.id}`);
    process.exit(0);
  } catch (e) {
    console.error(`vibepin ack: ${e.message}`);
    process.exit(1);
  }
}

// §4.3 `report` — the user-facing table: one row per item (rows === total), `!` on
// open/stale rows, exit 3 while any remain. blocked/deferred/wontfix are accounted
// for and never change the exit code (they are answers, not debt).
if (cmd === 'report') {
  try {
    const inbox = inboxFor(projectDir());
    const L = await ledger();
    const now = Date.now();
    const ttl = openTtl(L);
    const sid = opt('--session');
    const json = has('--json');
    if (has('--all') && has('--batch')) throw new Error('--all and --batch are mutually exclusive');
    let batches;
    if (has('--all')) {
      const list = await L.listBatches(inbox);
      batches = sid ? list.filter((b) => b.sessionId === sid) : list;
      if (!batches.length) {
        if (json) console.log(JSON.stringify({ batches: [] }, null, 2));
        else console.log(`没有账本：${sid ? `会话 ${sid} ` : ''}还没出现过认领批`);
        process.exit(0);
      }
    } else {
      batches = [await pickBatch(inbox, L, { rebuild: has('--rebuild') })];
    }
    const rendered = batches.map((b) => {
      const out = L.formatReport(b, { inbox, now, ttl, json });
      return json && typeof out === 'string' ? JSON.parse(out) : out;
    });
    console.log(json ? JSON.stringify(has('--all') ? { batches: rendered } : rendered[0], null, 2) : rendered.join('\n'));
    process.exit(batches.some((b) => L.reportExitCode(b, { now, ttl }) === 3) ? 3 : 0);
  } catch (e) {
    console.error(`vibepin report: ${e.message}`);
    process.exit(1);
  }
}

// §4.4 `batches` — the index. `open` is the un-expired open count (§4.4); the
// footer's 未结清 counts batches a report would still flag (open or shown-stale),
// which is the same debt notion `report`'s exit code uses.
if (cmd === 'batches') {
  try {
    const inbox = inboxFor(projectDir());
    const L = await ledger();
    const now = Date.now();
    const ttl = openTtl(L);
    const sid = opt('--session');
    const every = await L.listBatches(inbox, { onWarn: (m) => console.error(`[vibepin] ${m}`) });
    const list = every.filter((b) => !sid || b.sessionId === sid);
    const openOf = (b) => L.openCount(b, { now, ttl });
    const shown = has('--open') ? list.filter((b) => openOf(b) > 0) : list;
    if (has('--json')) {
      console.log(JSON.stringify({
        dir: L.batchDir(inbox),
        batches: shown.map((b) => ({
          id: b.id,
          at: b.at,
          sessionId: b.sessionId ?? null,
          total: b.total,
          pages: (b.pages || []).length,
          open: openOf(b),
          rollup: L.displayRollup(b, { now, ttl }),
          closedAt: b.closedAt ?? null,
        })),
      }, null, 2));
      process.exit(0);
    }
    console.log(`vibepin batches — ${pretty(L.batchDir(inbox))}（${list.length} 个账本）`);
    if (!shown.length) {
      console.log('');
      console.log(list.length
        ? '没有未结清的批。'
        : every.length ? `没有账本：会话 ${sid} 没有账本（项目里共 ${every.length} 个）。` : '没有账本：这个项目还没出现过认领批。');
      process.exit(0);
    }
    const cells = [['id', 'at', 'count', 'pages', 'open', 'session']];
    for (const b of shown) cells.push([b.id, iso(b.at), String(b.total), String((b.pages || []).length), String(openOf(b)), b.sessionId ?? '(no session)']);
    const width = cells[0].map((h, i) => Math.max(...cells.map((r) => r[i].length)));
    console.log('');
    for (const row of cells) console.log(row.map((c, i) => c.padEnd(width[i])).join('  ').trimEnd());
    const unsettled = list.filter((b) => L.reportExitCode(b, { now, ttl }) === 3).length;
    const newest = shown[0]; // listBatches is newest-first by `at`
    console.log('');
    console.log(`${list.length} 个 · 未结清 ${unsettled}${sid ? ` · 会话 ${sid}` : ''} 最新：${newest.id}`);
    console.log(`对比表：vibepin report --batch ${newest.id}    ·    未结清项：vibepin show --batch ${newest.id}`);
    process.exit(0);
  } catch (e) {
    console.error(`vibepin batches: ${e.message}`);
    process.exit(1);
  }
}

// §4.5 `show` — re-print one batch, or expand one record. A missing ledger is
// rebuilt automatically here (§4.6); --evidence prints the raw processed line.
if (cmd === 'show') {
  try {
    const inbox = inboxFor(projectDir());
    const L = await ledger();
    const now = Date.now();
    const json = has('--json');
    // v4.1 removed --brief (the default output IS the instruction layer); a removed
    // flag must fail loudly rather than silently fall back to the new default.
    if (has('--brief')) {
      throw new Error('--brief is gone (v4.1): the digest always carries the [e:<line>] pointer — '
        + 'take one record with `--seq <n> --evidence`, the whole ledger with `--json`');
    }
    if (has('--record')) {
      console.log(processedLine(inbox, Number(opt('--record'))));
      process.exit(0);
    }
    const batch = await pickBatch(inbox, L, { rebuild: true });
    const seqs = seqList();
    if (has('--evidence')) {
      if (!seqs.length) throw new Error('--evidence needs --seq <n> (one record at a time)');
      for (const n of seqs) console.log(processedLine(inbox, itemAt(batch, n).evidence?.line));
      process.exit(0);
    }
    if (json && !seqs.length) {
      console.log(JSON.stringify(batch, null, 2)); // the ledger file, verbatim
      process.exit(0);
    }
    // v4.1: the digest always carries the [e:<line>] pointer — it is the only
    // way back to the payload now that the default output is the instruction layer.
    const lines = digestLines(L, batch, { pointers: true, status: true });
    // The digest is one line per item in seq order, so its leading number is the
    // ack key the user saw in the delivery header.
    const lineOf = (n) => lines.find((l) => Number(/^(\d+)\./.exec(l)[1]) === n) || `${n}. (digest line unavailable)`;
    if (seqs.length) {
      const items = seqs.map((n) => itemAt(batch, n));
      if (json) {
        console.log(JSON.stringify(items.length === 1 ? items[0] : items, null, 2));
        process.exit(0);
      }
      for (const item of items) {
        console.log(lineOf(item.seq));
        console.log(`   历史 ${historyText(item)}`);
      }
      process.exit(0);
    }
    const head = asText(L.formatHeader(batch, { inbox, now }));
    if (has('--group')) {
      if (head.trim()) console.log(head);
      const groups = new Map();
      for (const item of batch.items) {
        const key = item.writeBatch || null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const [key, items] of groups) {
        console.log(`— ${key || '无批号'} (${items.length})`);
        for (const item of items) console.log(lineOf(item.seq));
      }
    } else {
      console.log([head, lines.join('\n')].filter((s) => s && s.trim()).join('\n'));
    }
    process.exit(0);
  } catch (e) {
    console.error(`vibepin show: ${e.message}`);
    process.exit(1);
  }
}

// --- up / down: the daemon's lifecycle ------------------------------------------
// `daemon` starts it in the foreground (right for a dev server that owns the
// process). `up` answers a different need: the daemon is shared infrastructure
// that must outlive whichever terminal happened to start it — and a harness that
// reclaims its background jobs is exactly what killed it before. So `up` reuses an
// existing daemon when there is one and otherwise spawns a DETACHED one, which is
// the only form that survives.
//
// A project's own start script may call `vibepin up`; the logic must live here so
// there is one implementation, not one per project.

const DAEMON_MAIN = join(__dirname, '..', 'daemon', 'daemon.js');

// The daemon serving a given inbox — not merely "a vibepin daemon somewhere".
// `doctor` deliberately takes the first daemon it finds; `up` must not, or it would
// report another project's daemon as ours.
async function daemonFor(inbox, { configuredPort = 0 } = {}) {
  const ports = configuredPort > 0 ? [configuredPort] : Array.from({ length: 40 }, (_, n) => 7331 + n);
  const hits = (await Promise.all(ports.map(probeDaemon))).filter(Boolean);
  const mine = hits.filter((h) => typeof h.info.inbox === 'string' && resolve(h.info.inbox) === resolve(inbox));
  return { mine: mine.sort((a, b) => a.port - b.port)[0] ?? null, others: hits.length - mine.length };
}

function readConfiguredPort(root) {
  const configPath = join(root, '.vibepin', 'config.json');
  if (!existsSync(configPath)) return 0;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    return Number.isInteger(raw.port) ? raw.port : 0;
  } catch {
    return 0;                 // doctor reports a malformed config; `up` just ignores it
  }
}

async function cmdUp(root, inbox) {
  const configuredPort = readConfiguredPort(root);
  const before = await daemonFor(inbox, { configuredPort });
  if (before.mine) {
    console.log(`[vibepin] already up on ${HOST_LABEL}:${before.mine.port} for this inbox — reusing it`);
    console.log(`[vibepin] inbox ${inbox}`);
    return 0;
  }

  const logPath = join(dirname(inbox), 'daemon.log');
  let out;
  try {
    out = openSync(logPath, 'a');
  } catch (e) {
    console.error(`vibepin up: cannot open ${logPath}: ${e.message}`);
    return 1;
  }
  // detached + unref: the child must not be killed when this CLI (or the harness
  // job that ran it) exits. stdio ignores stdin and appends to the log, so a
  // detached daemon still leaves a diagnosable trail.
  const child = spawn(process.execPath, [DAEMON_MAIN, '--inbox', inbox, '--root', root], {
    cwd: root, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();

  // Wait for /health rather than trusting the spawn: the daemon still has to bind a
  // port and open the store, and a failure after fork would otherwise be reported
  // as success.
  const deadline = Date.now() + 15000;
  let found = null;
  while (Date.now() < deadline) {
    await sleep(250);
    found = (await daemonFor(inbox, { configuredPort })).mine;
    if (found) break;
    if (child.exitCode !== null) break;      // died before binding
  }
  if (!found) {
    console.error(`vibepin up: the daemon did not come up within 15s — see ${pretty(logPath)}`);
    return 1;
  }
  console.log(`[vibepin] up on ${HOST_LABEL}:${found.port}  (pid ${child.pid})`);
  console.log(`[vibepin] inbox ${inbox}`);
  console.log(`[vibepin] log   ${pretty(logPath)}`);
  console.log('[vibepin] stop  vibepin down');
  return 0;
}

async function cmdDown(root, inbox) {
  const pidPath = join(dirname(inbox), 'daemon.json');
  const configuredPort = readConfiguredPort(root);
  const found = (await daemonFor(inbox, { configuredPort })).mine;

  let rec = null;
  try {
    rec = JSON.parse(readFileSync(pidPath, 'utf8'));
  } catch { /* no pidfile: below */ }

  if (rec && Number.isInteger(rec.pid) && pidAlive(rec.pid)) {
    try {
      process.kill(rec.pid);
    } catch (e) {
      console.error(`vibepin down: cannot stop pid ${rec.pid}: ${e.message}`);
      return 1;
    }
    for (let i = 0; i < 40 && pidAlive(rec.pid); i++) await sleep(100);
    if (pidAlive(rec.pid)) {
      console.error(`vibepin down: pid ${rec.pid} is still alive after 4s`);
      return 1;
    }
    console.log(`[vibepin] stopped pid ${rec.pid}${found ? ` (${HOST_LABEL}:${found.port})` : ''}`);
    if (existsSync(pidPath)) rmSync(pidPath, { force: true });
    return 0;
  }

  // A daemon started by hand (`node daemon/daemon.js`, or a foreign start script)
  // has no pidfile, and /health deliberately never exposes a PID — so the honest
  // answer is "this one was not started by `vibepin up`", not a guessed kill.
  if (found) {
    console.error(`vibepin down: a daemon is serving ${pretty(inbox)} on port ${found.port}, but there is no pidfile at ${pretty(pidPath)}.`);
    console.error('  It was not started by `vibepin up`, so this command will not guess a PID. Stop it where it was started,');
    console.error('  or restart it as `vibepin up` so it becomes manageable.');
    return 1;
  }
  console.log('[vibepin] no daemon for this inbox — nothing to stop');
  if (existsSync(pidPath)) rmSync(pidPath, { force: true });
  return 0;
}

if (cmd === 'up' || cmd === 'down') {
  // `--root` then cwd, same order as every other command that needs a project.
  const root = resolve(opt('--root') || process.cwd());
  const inbox = opt('--inbox') ? resolve(opt('--inbox')) : join(root, '.vibepin', 'inbox.jsonl');
  process.exit(cmd === 'up' ? await cmdUp(root, inbox) : await cmdDown(root, inbox));
}

const TARGETS = {
  daemon: 'daemon/daemon.js',
  watch: 'daemon/watch.js',
  claim: 'daemon/claim.js',
};

if (!cmd || ['help', '-h', '--help'].includes(cmd) || !TARGETS[cmd]) {
  const known = cmd && !TARGETS[cmd] && !['help', '-h', '--help'].includes(cmd);
  if (known) console.error(`vibepin: unknown command "${cmd}"\n`);
  console.log(`vibepin <command> [options]

Commands:
  init      wire the /vpin loop into an agent (--agent claude|codex|cursor|antigravity|omp|all)
  up        start the daemon detached (reuse if one already serves this inbox) — survives a terminal or job going away
  down      stop the daemon started by "up" (reads .vibepin/daemon.json; never guesses a PID)
  daemon    start the daemon in the foreground (serves overlay, collects annotations, exposes /mcp)
  watch     block until there is work to claim, then exit (wake primitive)
  claim     drain pending annotations, open a batch ledger and print the instruction-layer delivery header
  ack       settle delivered annotations (done/wontfix/blocked/deferred) — the ledger's only writer
  report    print the per-batch comparison table for the user (exit 3 while open/stale rows remain)
  batches   list claim batches with page count and open count
  show      re-print one batch (add --seq N --evidence to expand a record from processed.jsonl)
  sessions  list sessions with pending counts and last activity
  doctor    diagnose wiring, protocol version, ledger and daemon reachability (exit 1 on defects)

Options:
  --agent <name>   init only: claude (default) | codex | cursor | antigravity | omp | all
  --root <dir>     project root (init --agent omp, ack/report/batches/show/sessions/doctor; default: cwd)
  --vibepin-dir <dir>  init --agent omp only: checkout the printed commands point at (default: this package)
  --dry-run        init: print the plan (including what --upgrade would write), write nothing
  --upgrade        init: rewrite the files that are still on the old protocol
  --inbox <path>   shared inbox (default: ./.vibepin/inbox.jsonl)
  --queue <path|sid>   session queue to watch/claim (default: none — broadcast only)
  --session <sid>  session id to register/claim for, and to filter ack/report/batches (default: the queue file's basename)
  --recover        claim only: recover batches left by an interrupted claim, no live drain
  --ledger         claim only: open a ledger even without --session (otherwise the legacy [] / bare-JSON output)
  --full           claim only: also inline the full JSON payload after the header (debugging)
  --json           claim/show: the JSON array / the ledger verbatim · batches/report: machine-readable
  --open-ttl <ms>  report/batches: age at which a still-open item is shown as stale (default 28800000 = 8h; 0 = never)
  --batch <id|last>    ack/report/show: which ledger (default: the newest batch in the project)
  --seq <n[,n]>    ack/show: which item(s) inside the batch (1-based, as printed in the delivery header)
  --status <s>     ack: done (default) | wontfix | blocked | deferred | open | stale
  --note <text>    ack: what was changed — becomes the 证据 column of the report
  --reason <text>  ack: required for wontfix / blocked / deferred
  --all-done       ack: mark every open item of the batch done in one write
  --all            report: one table per batch
  --open           batches: only batches with an un-expired open item
  --rebuild        report/show/ack: rebuild a missing ledger from claims.jsonl + processed.jsonl
  --evidence       show: with --seq <n>, print that record verbatim from processed.jsonl (the [e:<line>] pointer)
  --group          show: group the digest by write batch
  --record <line>  show: print one raw line of processed.jsonl
  --port N         daemon only (default: 7331)
  --json           sessions only: print JSON

Exit codes:
  watch   0 = work is waiting · 2 = cannot stat a watched file
  claim   0 = delivered ([] when nothing is pending) · 1 = error
  ack     0 = updated · 1 = unknown batch/seq, or a missing --note/--reason
  report  0 = every row settled · 3 = open/stale rows remain · 1 = error
  batches/show  0 = printed · 1 = unknown batch

Notes:
  init copies the claude/codex/cursor command files over any existing ones (that is
  how those agents are upgraded); the omp files (config.json, SKILL.md, the AGENTS.md
  section) are never rewritten without --upgrade.
  every annotation carries batch{id,seq,total} stamped by the daemon; claim writes
  .vibepin/batches/<id>.json, ack is the only writer of its statuses, and report is
  the user-facing table — unsettled rows are visible debt and never block delivery.
  claim's default stdout is the instruction layer only (batch id, seq, locator, note,
  [e:<line>] pointer); the evidence layer is one command away — vibepin show --batch
  <id> --seq <n> --evidence for one record, vibepin show --batch <id> --json for the
  whole ledger. --full inlines the payload for debugging.
  the ack key is the seq printed in the delivery header (1-based), not a record's own
  batch.seq: one claim can merge several write batches into one ledger.`);
  process.exit(known ? 1 : 0);
}

const child = spawn(process.execPath, [join(__dirname, '..', TARGETS[cmd]), ...rest], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
