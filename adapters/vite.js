// Vite plugin — the "devDependency" distribution.
// In dev it (1) picks a free port, (2) spawns the vibepin daemon pointed at the
// project root's inbox, and (3) injects the overlay <script> into every served
// HTML page. Production builds are untouched.
//
//   // vite.config.js
//   import vibepin from 'vibepin/vite'
//   export default { plugins: [vibepin()] }
//
// Options (any of them may instead be set in <root>/.vibepin/config.json, which
// the project commits; what you pass here wins):
//   port     daemon port. Explicit wins; otherwise 7331, else the next free port
//            up to 7370 — so every project's dev server gets its own daemon and
//            annotations can never land in another project's inbox.
//   inbox    inbox file (default <root>/.vibepin/inbox.jsonl)
//   target   who the notes are for, shown in the overlay (e.g. 'Claude Code');
//            '' (default) makes the overlay use a generic phrase. Falls back to
//            the config's "agent" field.
//   enabled  set false to disable the plugin entirely (dev-only anyway).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIRST_PORT = 7331;
const LAST_PORT = 7370;
const MAX_TRIES = 8;

// A port a daemon can actually bind, tested by binding it. This is a hint, not a
// reservation — two dev servers starting at once can probe the same free port —
// so every spawn is confirmed against /health before the page is pointed at it.
const bindable = (port) => new Promise((done) => {
  const probe = createServer();
  probe.unref();
  probe.once('error', () => done(false));
  probe.once('listening', () => probe.close(() => done(true)));
  probe.listen(port, '127.0.0.1');
});

async function freePort() {
  for (let p = FIRST_PORT; p <= LAST_PORT; p++) if (await bindable(p)) return p;
  throw new Error(`[vibepin] no free port in ${FIRST_PORT}-${LAST_PORT} — stop a vibepin dev server or pass { port } to the plugin`);
}

// Ask a port which project it serves.
async function healthOf(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Wait until the daemon we spawned answers with OUR inbox. Anything else and the
// page would be sending this project's notes to whoever does own the port.
async function ownsPort(proc, port, inbox, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await healthOf(port);
    if (typeof health?.inbox === 'string' && resolve(health.inbox) === resolve(inbox)) return true;
    // A lost port race kills the daemon; nothing but a slow start keeps it alive.
    if (proc.exitCode !== null || proc.signalCode !== null) return false;
    // Never assume ownership on a timeout. A daemon that is alive but not answering
    // with our inbox for this long is hung or someone else's — pointing the page at
    // it would send this project's notes to their inbox. Refuse, so the caller
    // retries the next free port instead.
    if (Date.now() > deadline) {
      console.warn(
        `[vibepin] port ${port} never answered /health with this project's inbox ` +
        `(${inbox}) within ${timeoutMs}ms — treating it as another project's and refusing it`,
      );
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Safe inside an inline <script>: a `</script>` in a user-supplied value must
// not be able to close the tag it is embedded in.
const jsLiteral = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// The project root a config's relative paths resolve against — the directory that
// owns the .vibepin/ dir holding the file (or the file's own directory when it is
// kept elsewhere). Never cwd. Identical to daemon/daemon.js's rule: if the two
// disagreed on the inbox, ownsPort() would refuse the daemon we just spawned.
const configBase = (file) => {
  const dir = dirname(file);
  return basename(dir) === '.vibepin' ? dirname(dir) : dir;
};

// Reads the same <root>/.vibepin/config.json the daemon reads, so a project
// configures itself once: plugin options win, then this file, then the built-in
// defaults. A malformed file throws instead of falling back — a silent fallback
// would keep the dev server coming up while its page posted notes into some other
// project's inbox, and nothing downstream could tell.
function readProjectConfig(file) {
  if (!existsSync(file)) return {};   // absent is normal: the defaults apply
  const bad = (why) => { throw new Error(`[vibepin] bad config ${file}: ${why}`); };
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    bad(`cannot read — ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    bad(`not valid JSON — ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad(`expected a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  const base = configBase(file);
  const out = {};
  if (raw.inbox !== undefined) {
    if (typeof raw.inbox !== 'string' || !raw.inbox.trim()) bad('"inbox" must be a non-empty string');
    out.inbox = resolve(base, raw.inbox);
  }
  if (raw.port !== undefined) {
    // 0 = auto, like the plugin's own default; anything else is a pinned port.
    if (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) {
      bad(`"port" must be an integer 0-65535 (0 = auto), got ${JSON.stringify(raw.port)}`);
    }
    out.port = raw.port;
  }
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== 'string') bad(`"agent" must be a string, got ${JSON.stringify(raw.agent)}`);
    out.agent = raw.agent;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') bad(`"enabled" must be a boolean, got ${JSON.stringify(raw.enabled)}`);
    out.enabled = raw.enabled;
  }
  // "root" is checked but not used: this plugin already knows the project root
  // (the dev server's), and adopting another one would make the daemon's
  // projectRoot disagree with the __vibepinRoot we inject. The standalone daemon
  // has no such anchor, so there the field does the work — hence the check here
  // too: the same file must not pass under Vite and kill a bare `node daemon.js`.
  if (raw.root !== undefined && (typeof raw.root !== 'string' || !raw.root.trim())) {
    bad('"root" must be a non-empty string');
  }
  return out;
}

export default function vibepin(opts = {}) {
  let proc = null;
  let root = '';
  let port = 0;      // resolved in configResolved, before any HTML is served
  let active = true; // plugin option wins over config.json; resolved there too
  let globals = '';  // the head-prepend inline script, built once

  return {
    name: 'vibepin',
    apply: 'serve', // dev only
    // Vite awaits async configResolved hooks, so by the time anything is served
    // the port is final and the daemon is already coming up on it.
    async configResolved(config) {
      // Vue hands out project-relative __file paths (/src/App.vue) — the overlay
      // needs the root to resolve them to an absolute path it can hand to an agent.
      root = String(config.root).replace(/\\/g, '/');
      // Read from the project, not from cwd: `vite --root packages/app` launched
      // from a monorepo root must still find packages/app/.vibepin/config.json.
      const configPath = resolve(root, '.vibepin', 'config.json');
      const project = readProjectConfig(configPath);
      active = (opts.enabled ?? project.enabled) !== false;
      if (!active) return;
      const inbox = resolve(opts.inbox || project.inbox || join(config.root, '.vibepin', 'inbox.jsonl'));
      const daemon = join(__dirname, '..', 'daemon', 'daemon.js');
      // 0 = take the first free port; a port from either source is a pinned one.
      const wanted = opts.port ? Number(opts.port) : (project.port ?? 0);
      for (let tries = 0; ; tries++) {
        port = wanted || await freePort();
        // --root, not cwd: `vite --root packages/app` from a monorepo root would
        // otherwise attribute the project to the wrong directory. --config too, so
        // the daemon reads the very file we just resolved against instead of
        // whatever sits next to the dev server's cwd.
        proc = spawn(process.execPath, [daemon, '--config', configPath, '--inbox', inbox, '--root', root], {
          stdio: 'inherit',
          env: { ...process.env, ANNOTATE_PORT: String(port) },
        });
        if (await ownsPort(proc, port, inbox)) break;
        // Our daemon lost the port to another project's. Never keep that port:
        // the injected script src would send this project's notes to their inbox.
        if (wanted || tries >= MAX_TRIES) {
          proc.kill();
          throw new Error(`[vibepin] could not start a daemon for ${inbox} (tried up to port ${port}) — see the daemon output above`);
        }
        console.log(`[vibepin] port ${port} was taken while starting — trying the next free one`);
      }
      globals =
        `window.__vibepinRoot=${jsLiteral(root)};` +
        // An explicit target (even '') wins; the config's agent is the fallback.
        `window.__vibepinTarget=${jsLiteral(typeof opts.target === 'string' ? opts.target : project.agent ?? '')};`;
      const kill = () => proc && proc.kill();
      process.on('exit', kill);
      process.on('SIGINT', () => { kill(); process.exit(0); });
    },
    transformIndexHtml(html) {
      if (!active) return html;
      return {
        html,
        tags: [
          {
            tag: 'script',
            children: globals,
            injectTo: 'head-prepend',      // must land before the overlay script runs
          },
          {
            tag: 'script',
            attrs: { src: `http://127.0.0.1:${port}/annotate.js`, defer: true },
            injectTo: 'body',
          },
        ],
      };
    },
    closeBundle() { if (proc) proc.kill(); },
  };
}
