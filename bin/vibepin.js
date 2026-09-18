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
//                                                drain pending annotations as JSON
//   vibepin sessions [--json]                    list session leases, pending, last activity
//   vibepin doctor [--root <dir>]                diagnose the wiring (exit 1 on defects)
//
// Default inbox for every command: ./.vibepin/inbox.jsonl (cwd-relative).
//   --agent: claude (default) | codex | cursor | antigravity | omp | all

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createStore, isValidSid, lastSeenSeconds, pathsFor, pidAlive, readLeases } from '../daemon/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const HOME = homedir();
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

// §11.3: the marker the bundled v2 templates carry, and that an already wired-up
// project is missing until it is rewritten.
const MARKER = '<!-- vibepin:session-routing-v2 -->';
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
        add('.omp/skills/vibepin-annotations/SKILL.md', 'skip', 'exists — already session-routing-v2', null);
      } else if (UPGRADE) {
        add('.omp/skills/vibepin-annotations/SKILL.md', 'rewrite', 'old protocol → session-routing-v2', () => {
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
        add('AGENTS.md', 'skip', `section "${HEADING}" already session-routing-v2`, null);
      } else if (UPGRADE) {
        add('AGENTS.md', 'rewrite', `section "${HEADING}" — old protocol → session-routing-v2`, () => {
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
    if (!text.includes(MARKER)) say('!', `SKILL.md predates session routing — run: npx vibepin init --agent omp --upgrade`);
  }
  if (existsSync(agentsPath)) {
    const section = sectionText(readFileSync(agentsPath, 'utf8'));
    if (section === null) say('!', `AGENTS.md has no "${HEADING}" section — run: npx vibepin init --agent omp`);
    else {
      const hit = oldCommand(section);
      if (hit) stale.push(`AGENTS.md ${HEADING}: ${hit.trim()}`);
      if (!section.includes(MARKER)) say('!', `AGENTS.md section predates session routing — run: npx vibepin init --agent omp --upgrade`);
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

  console.log('');
  console.log(defects.length ? `${defects.length} defect(s) — fix the ✗ lines above (warnings ! are informational).` : 'no defects found (warnings ! are informational).');
  process.exit(defects.length ? 1 : 0);
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
  daemon    start the daemon (serves overlay, collects annotations, exposes /mcp)
  watch     block until there is work to claim, then exit (wake primitive)
  claim     drain pending annotations as JSON and archive them to processed.jsonl
  sessions  list sessions with pending counts and last activity
  doctor    diagnose wiring, protocol version and daemon reachability (exit 1 on defects)

Options:
  --agent <name>   init only: claude (default) | codex | cursor | antigravity | omp | all
  --root <dir>     project root (init --agent omp, sessions, doctor; default: cwd)
  --vibepin-dir <dir>  init --agent omp only: checkout the printed commands point at (default: this package)
  --dry-run        init: print the plan (including what --upgrade would write), write nothing
  --upgrade        init: rewrite the files that are still on the old protocol
  --inbox <path>   shared inbox (default: ./.vibepin/inbox.jsonl)
  --queue <path|sid>   session queue to watch/claim (default: none — broadcast only)
  --session <sid>  session id to register/claim for (default: the queue file's basename)
  --recover        claim only: recover batches left by an interrupted claim, no live drain
  --json           sessions only: print JSON
  --port N         daemon only (default: 7331)

Notes:
  init copies the claude/codex/cursor command files over any existing ones (that is
  how those agents are upgraded); the omp files (config.json, SKILL.md, the AGENTS.md
  section) are never rewritten without --upgrade.`);
  process.exit(known ? 1 : 0);
}

const child = spawn(process.execPath, [join(__dirname, '..', TARGETS[cmd]), ...rest], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
