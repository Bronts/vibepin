// Finding the daemon — shared by the content script and the settings page.
//
// A daemon is not always on 7331: adapters/vite.js picks the first free port in
// 7331..7370 so every project's dev server gets its own daemon and annotations
// can never land in another project's inbox. So the port is discovered, not
// assumed — ask each port's /health and keep the first real answer.
//
// What counts as a real answer: another dev server (or anything else) can hold a
// port in that range. Only a payload carrying `inbox` + numeric `port` is a
// daemon, and only then is it safe to point a page at it.
//
// "First answer wins" is a guess: with two projects up, a page of the second one
// connects to the *first* project's daemon — the one failure mode that actually
// misroutes a note (docs/omp-integration.md). So discovery also honours a
// per-site choice (SITES_KEY) written by the settings page; with no choice it
// keeps the old lowest-port behaviour, byte for byte.

(() => {
  const FIRST_PORT = 7331;
  const LAST_PORT = 7370;          // inclusive, same range as adapters/vite.js
  const PROBE_TIMEOUT_MS = 1500;   // per port; a hung host must not stall the scan

  // Where the overlay runs by default. Duplicated in manifest.json (a manifest
  // cannot import) — keep the two in sync.
  const LOCAL_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*'];
  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

  // chrome.storage.local key holding { <page origin>: <port> }. Exported so the
  // settings page writes exactly what discovery reads, and so the same
  // "remember one choice per key" helper covers the default session too.
  const SITES_KEY = 'siteDaemon';

  const isLocalHost = (hostname) =>
    LOCAL_HOSTNAMES.has(hostname) || String(hostname).endsWith('.localhost');

  const origin = (port) => `http://127.0.0.1:${port}`;
  const overlaySrc = (port) => `${origin(port)}/annotate.js`;

  // Ask one port who it is. null = not a daemon (refused, timed out, non-200,
  // or a payload that isn't ours).
  async function health(port) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${origin(port)}/health`, { cache: 'no-store', signal: abort.signal });
      if (!res.ok) return null;
      const info = await res.json().catch(() => null);
      return info && typeof info.inbox === 'string' && info.inbox && Number.isFinite(info.port) ? info : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Probing runs in parallel on purpose: a port that accepts nothing can hang
  // until the timeout instead of failing fast (measured 1.5s each on Windows in
  // the worst case — a sequential walk of an empty range took ~56s before the page
  // could say "no daemon"). In parallel the whole scan costs one timeout at most.
  async function probeRange() {
    const ports = [];
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) ports.push(port);
    const answers = await Promise.all(ports.map(health));
    const hits = [];
    for (let i = 0; i < ports.length; i++) if (answers[i]) hits.push({ port: ports[i], info: answers[i] });
    return hits;
  }

  // Every daemon that answers, lowest port first. The settings page lists these:
  // when several projects run at once, the user needs to see them to pick one.
  // A pinned port narrows the scan to that single daemon (same as discover()).
  async function discoverAll(pinnedPort) {
    if (Number.isFinite(pinnedPort) && pinnedPort > 0) {
      const info = await health(pinnedPort);
      return info ? [{ port: pinnedPort, info }] : [];
    }
    return probeRange();
  }

  // The daemon this page belongs to, as remembered by the settings page.
  // chrome.storage is available to a content script — and keyed by origin,
  // because "which project is this site" is a per-site question, and
  // localStorage would be the page's storage, not ours.
  async function siteChoice() {
    if (!/^https?:$/.test(location.protocol)) return null;          // settings page itself
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    try {
      const store = await chrome.storage.local.get({ [SITES_KEY]: {} });
      const port = (store[SITES_KEY] || {})[location.origin];
      return Number.isFinite(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  }

  // What the overlay should use on this page. Precedence: explicit port pin
  // (settings) > this site's remembered daemon > lowest answering port.
  async function discover(pinnedPort) {
    const pinned = Number.isFinite(pinnedPort) && pinnedPort > 0;
    const chosen = pinned ? pinnedPort : await siteChoice();
    if (chosen) {
      const info = await health(chosen);
      if (info) return info;      // a remembered daemon that is gone falls through
    }
    const hit = (await discoverAll(pinnedPort))[0];
    return hit ? hit.info : null;
  }

  globalThis.VibepinDiscovery = {
    FIRST_PORT, LAST_PORT, LOCAL_MATCHES, LOCAL_HOSTNAMES, SITES_KEY,
    isLocalHost, origin, overlaySrc, health, discover, discoverAll,
  };
})();
