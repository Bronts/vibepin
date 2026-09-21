// S3 client-visibility suite — docs/20260918-session-routing-design.md
// §8.3 (two-layer destination row), §8.4 (settings page), §8.5 (discovery /
// per-origin daemon memory) and §9 (post-send receipt).
//
//   node --test tests/s3-client-visibility.test.mjs
//
// Zero deps: node:test + node:assert + node:http, and a real Chromium driven
// over the DevTools protocol through Node's built-in WebSocket. The daemons are
// fakes served from temp dirs, so the suite never talks to a real one and never
// binds 7331; the unpacked extension is loaded from extension/, so the settings
// page runs against real chrome.storage in a real MV3 context.
//
// Skips (does not fail) when no Chromium is installed: this repo is zero-dep, so
// a browser is a prerequisite of this file alone. Set VPIN_CHROME to override
// discovery, VPIN_S3_HEADED=1 to watch it run.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ANNOTATE_SRC = join(REPO, 'core', 'annotate.js');
const EXTENSION = join(REPO, 'extension');

// The range adapters/vite.js walks. 7331 is skipped on purpose: a real daemon may
// be running there, and this suite must not touch it.
const PORT_FIRST = 7332;
const PORT_LAST = 7370;

const heap = [];
after(() => { for (const d of heap) rmSync(d, { recursive: true, force: true }); });

const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  heap.push(dir);
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(step);
  }
  throw new Error(`timeout after ${ms}ms${last ? `: ${last.message}` : ''}`);
}

// --- chromium -------------------------------------------------------------------

function findChrome() {
  if (process.env.VPIN_CHROME && existsSync(process.env.VPIN_CHROME)) return process.env.VPIN_CHROME;
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(join(process.env.LOCALAPPDATA || '', 'ms-playwright'));
    roots.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
    roots.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  } else if (process.platform === 'darwin') {
    roots.push(join(process.env.HOME || '', 'Library/Caches/ms-playwright'));
    roots.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    roots.push(join(process.env.HOME || '', '.cache/ms-playwright'));
    roots.push('/usr/bin/google-chrome', '/usr/bin/chromium');
  }
  for (const root of roots) {
    if (!root) continue;
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).sort().reverse()) {      // newest build wins
      for (const rel of [
        ['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe'],
        ['chrome-linux', 'chrome'], ['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium'],
      ]) if (existsSync(join(root, d, ...rel))) return join(root, d, ...rel);
    }
  }
  return null;
}

const CHROME = findChrome();
const SKIP = CHROME ? false : 'no Chromium found — set VPIN_CHROME to run this suite';

async function freePort() {
  const s = createServer();
  await new Promise((res, rej) => { s.once('error', rej); s.listen(0, '127.0.0.1', res); });
  const { port } = s.address();
  await new Promise((res) => s.close(res));
  return port;
}

async function listen(handler, port) {
  const server = createServer(handler);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  return server;
}

async function launchChrome({ urls, extension = null }) {
  const profile = tmp('vibepin-s3-chrome-');
  const port = await freePort();
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,800',
    '--lang=en-US',                    // the overlay boots in the browser's locale; pin it
    ...(extension ? [
      `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
      // Chrome 137+ ignores --load-extension unless this kill-switch is disabled.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
    ] : []),
    ...(process.env.VPIN_S3_HEADED ? [] : ['--headless=new']),
    ...urls,
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr += d; });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 20000, 100);
  } catch (e) {
    proc.kill();
    throw new Error(`chromium did not start: ${e.message}\n${stderr.slice(-800)}`);
  }
  return {
    port,
    stderr: () => stderr,
    targets: async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()),
    stop: async () => { proc.kill(); await sleep(150); },
  };
}

// --- CDP (Node's global WebSocket — no dependency) -------------------------------

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`cannot open ${wsUrl}`)), { once: true });
  });
  let seq = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method) events.push(msg);
    const p = msg.id && waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  });
  return {
    events,
    send: (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      waiting.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

async function pageTab(chrome, match) {
  const target = await until(async () => {
    const t = (await chrome.targets()).find((x) => x.type === 'page' && x.url.includes(match));
    return t && t.webSocketDebuggerUrl ? t : null;
  });
  return connect(target.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function snap(cdp, name) {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(tmpdir(), `vibepin-s3-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.error(`[s3] screenshot: ${file}`);
  } catch { /* diagnostics only */ }
}

// Visual confirmation of the panel/options surface: VPIN_S3_SHOTS=1 keeps a PNG
// of each state so the copy and layout can be eyeballed, not just asserted.
async function shot(cdp, name) {
  if (!process.env.VPIN_S3_SHOTS) return;
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(tmpdir(), `vibepin-s3-shot-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.error(`[s3] shot ${name}: ${file}`);
  } catch { /* diagnostics only */ }
}

// --- the fake daemon --------------------------------------------------------------

const json = (res, body, code = 200) => {
  const b = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
};

// Daemon-like: GET /health, GET /sessions, GET /annotate.js (the real overlay),
// and POST /annotations answering exactly per §4.5 — routed when the target has a
// lease record, degraded broadcast when it does not.
async function startDaemon(state, { annotatePath = ANNOTATE_SRC, legacy = false } = {}) {
  const log = { health: 0, sessions: 0, script: 0, posts: [] };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' });
      return res.end();
    }
    if (url.pathname === '/health') {
      log.health += 1;
      return json(res, {
        ok: true, inbox: state.inbox, pending: state.inboxPending, port: server.address().port,
        projectRoot: state.projectRoot, sessions: state.sessions.length, pendingTotal: state.pendingTotal,
      });
    }
    if (url.pathname === '/sessions') {
      log.sessions += 1;
      // A pre-routing daemon has no such view at all.
      if (legacy) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      return json(res, { sessions: state.sessions, lastClaim: state.lastClaim });
    }
    if (url.pathname === '/annotate.js') {
      log.script += 1;
      const js = readFileSync(annotatePath);
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Content-Length': js.length });
      return res.end(js);
    }
    if (url.pathname === '/annotations' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const bare = Array.isArray(body);
        const target = bare ? '' : body.targetSession || '';
        const annotations = bare ? body : body.annotations;
        log.posts.push({ target, annotations, bare });
        if (legacy) return json(res, { ok: true, received: annotations.length, pending: state.inboxPending });
        if (target) {
          return state.sessions.some((s) => s.sessionId === target)
            ? json(res, { ok: true, received: annotations.length, routed: 'session', target, pending: 1 })
            : json(res, {
              ok: true, received: annotations.length, routed: 'broadcast', degraded: true,
              reason: 'unknown-session', target, pending: state.inboxPending,
            });
        }
        return json(res, { ok: true, received: annotations.length, routed: 'broadcast', pending: state.inboxPending });
      });
      return undefined;
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  };
  // Bind inside the range discover() scans so the extension test can find it.
  let server = null;
  for (let p = PORT_FIRST; p <= PORT_LAST; p++) {
    try { server = await listen(handler, p); break; } catch { /* busy */ }
  }
  if (!server) throw new Error(`no free daemon port in ${PORT_FIRST}-${PORT_LAST}`);
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, log, state, close: () => server.close() };
}

// A harness page. `direct=1` loads the overlay the way a page you own does (the
// README's <script src>); otherwise the extension's content script injects it.
async function startPages() {
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const daemon = url.searchParams.get('daemon') || '';
    const direct = url.searchParams.get('direct') === '1';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>vibepin harness</title></head>
<body style="font:14px system-ui;margin:24px">
  <h1 id="title">Harness page</h1>
  <button id="btn">Save</button>
  ${direct && daemon ? `<script src="${daemon}/annotate.js"></script>` : ''}
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
  }, 0);
  return { port: server.address().port, close: () => server.close() };
}

const oneSession = (sid, label, extra = {}) =>
  ({ sessionId: sid, agent: 'omp', label, lastSeenAt: 12, pending: 2, mode: 'file', ...extra });

function mkState({ pendingTotal = 7, inboxPending = 2, sessions }) {
  const dir = tmp('vibepin-s3-proj-');
  return {
    inbox: join(dir, '.vibepin', 'inbox.jsonl'),
    projectRoot: dir,
    sessions,
    lastClaim: { sessionId: sessions[0].sessionId, at: Date.now() - 12000, count: 2 },
    inboxPending,
    pendingTotal,
  };
}

async function makeWorld(stateFields, opts) {
  const daemon = await startDaemon(mkState(stateFields), opts);
  const pages = await startPages();
  return {
    daemon,
    pages,
    state: daemon.state,
    pageUrl: (q) => `http://127.0.0.1:${pages.port}/?${q}`,
    directUrl: (extra = '') => `http://127.0.0.1:${pages.port}/?direct=1&daemon=${encodeURIComponent(daemon.origin)}${extra}`,
    close: () => { daemon.close(); pages.close(); },
  };
}

// --- overlay driving ---------------------------------------------------------------

const SR = "document.getElementById('__vibepin_root').shadowRoot";

const overlayState = (cdp) => evaluate(cdp, `(() => { const sr = ${SR};
  const shown = (el) => !!el && !el.classList.contains('hidden');
  const textOf = (sel) => (sr.querySelector(sel) || {}).textContent || '';
  const toast = sr.querySelector('.toast');
  return {
    destPath: textOf('.dest .dp'),
    destTarget: textOf('.dest .dt'),
    pendingCount: textOf('.count'),
    routeNote: shown(sr.querySelector('.routenote')) ? sr.querySelector('.routenote').textContent : null,
    toast: toast && toast.classList.contains('show') ? textOf('.toast .tx') : null,
    lastToast: textOf('.toast .tx'),
    toastAction: shown(sr.querySelector('.toast .ta')) ? sr.querySelector('.toast .ta').textContent : null,
    settingsOpen: shown(sr.querySelector('.settings')),
    settingsText: sr.querySelector('.settings').textContent,
    sessionRows: [...sr.querySelectorAll('.sessrow')].map((r) => r.textContent),
    selectedRow: (sr.querySelector('.sessrow.on') || {}).textContent || null,
  };
})()`);

async function waitForOverlay(cdp) {
  await until(() => evaluate(cdp, `!!window.__vibepin && !!${SR}`), 15000);
  // The overlay boots in the browser's locale; pin it so the copy asserted below
  // is the copy under test and not whatever this machine is set to.
  const lang = await evaluate(cdp, `(() => { try { return localStorage.getItem('__vibepin_lang'); } catch { return null; } })()`);
  if (lang !== 'en') {
    await evaluate(cdp, `window.__vibepin.setLang('en')`);
    await sleep(150);
  }
}

async function openPage(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitForOverlay(cdp);
  // The row starts as the endpoint and is replaced once /health answers.
  await until(async () => !(await overlayState(cdp)).destPath.startsWith('→ http'), 5000);
}

async function annotateOne(cdp, note) {
  if (!(await evaluate(cdp, `${SR}.querySelector('.atog').classList.contains('on')`))) {
    await evaluate(cdp, `${SR}.querySelector('.atog').click()`);
  }
  const box = await evaluate(cdp, `(() => { const r = document.getElementById('btn').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  await until(() => evaluate(cdp, `!!${SR}.querySelector('.pop textarea')`), 5000);
  await evaluate(cdp, `(() => { const sr = ${SR}; const ta = sr.querySelector('.pop textarea');
    ta.value = ${JSON.stringify(note)}; ta.dispatchEvent(new Event('input', { bubbles: true }));
    sr.querySelector('.pop [data-a=add]').click(); return true; })()`);
  await until(() => evaluate(cdp, `${SR}.querySelector('.count').textContent.length > 0`), 5000);
}

async function send(cdp, expectedToast) {
  await evaluate(cdp, `${SR}.querySelector('.foot .send').click()`);
  return until(async () => {
    const s = await overlayState(cdp);
    return s.lastToast && s.lastToast.includes(expectedToast) ? s : null;
  }).catch(async (e) => {
    throw new Error(`${e.message} — toast was ${JSON.stringify((await overlayState(cdp)).lastToast)}`);
  });
}

// --- tests -------------------------------------------------------------------------

test('overlay §8.3/§9: two-layer destination row, routed / broadcast / degraded receipts', { skip: SKIP }, async () => {
  const w = await makeWorld({ sessions: [oneSession('omp-2f9c1a', '改简历解析页')] });
  const chrome = await launchChrome({ urls: [w.directUrl()] });
  let cdp = null;
  try {
    cdp = await pageTab(chrome, '/?');
    await waitForOverlay(cdp);

    // One session ⇒ explicit prefill, both lines of the destination row (§8.3).
    await until(async () => (await overlayState(cdp)).destTarget.includes('omp-2f9c1a'), 5000);
    let s = await overlayState(cdp);
    assert.equal(s.destPath, `→ ${w.state.inbox}`, 'line 1 keeps the inbox path verbatim (provenance)');
    assert.equal(s.destTarget, 'Target: omp-2f9c1a (only session)', 'line 2 names the only session');
    await shot(cdp, '1-one-session');

    await annotateOne(cdp, 'move the save button left');
    s = await overlayState(cdp);
    assert.equal(s.routeNote, null, 'one session is not the "undirected with several sessions" case');

    s = await send(cdp, 'Sent 1 → omp-2f9c1a');
    assert.equal(s.toast, 'Sent 1 → omp-2f9c1a (改简历解析页)', 'the receipt names the session and its label');
    assert.equal(s.toastAction, null, 'a routed send offers no re-target');
    await shot(cdp, '2-routed-toast');

    const post = w.daemon.log.posts.at(-1);
    assert.equal(post.target, 'omp-2f9c1a', 'the prefill is sent as an explicit targetSession');
    assert.equal(post.bare, false, 'a targeted body is {annotations, targetSession}');
    assert.equal(post.annotations.length, 1);
    const a = post.annotations[0];
    for (const k of ['selector', 'html', 'styles', 'rect', 'viewport']) assert.ok(k in a, `payload keeps ${k}`);
    assert.ok(!('_el' in a), 'the live DOM node never leaves the page');

    // Two sessions, nothing pinned ⇒ broadcast, and the panel says why (§9.5/§9.6).
    w.state.sessions = [oneSession('omp-2f9c1a', '改简历解析页'), oneSession('omp-77ab31', '改导出脚本', { lastSeenAt: 4000 })];
    await openPage(cdp, w.directUrl());
    s = await overlayState(cdp);
    assert.equal(s.destTarget, 'Target: broadcast (2 sessions, none picked)', 'no guess with several sessions');
    await annotateOne(cdp, 'tighten the toolbar');
    s = await overlayState(cdp);
    assert.ok(s.routeNote && s.routeNote.includes('Copy is the exact route'), 'the hint names Copy as the exact route');
    s = await send(cdp, 'broadcast');
    assert.equal(s.toast, 'Sent 1 (broadcast — no target)');
    assert.equal(w.daemon.log.posts.at(-1).bare, true, 'no target ⇒ the body is today’s bare array');

    // A default picked in the panel is sticky and visible before the next send.
    await evaluate(cdp, `${SR}.querySelector('.setbtn').click()`);
    await evaluate(cdp, `[...${SR}.querySelectorAll('.sessrow')].find((r) => r.dataset.sid === 'omp-77ab31').click()`);
    s = await overlayState(cdp);
    assert.ok(s.destTarget.includes('omp-77ab31') && s.destTarget.includes('(default)'), 'the pick is labelled as the default');

    // §9: the target lost its lease ⇒ degraded receipt + one-click re-target.
    w.state.sessions = [oneSession('omp-2f9c1a', '改简历解析页'), oneSession('omp-aa11bb', '改设置页')];
    await openPage(cdp, w.directUrl());
    s = await overlayState(cdp);
    assert.ok(s.destTarget.includes('omp-77ab31'), 'a remembered default survives even without a lease record');
    await annotateOne(cdp, 'fix the footer');
    s = await send(cdp, 'no lease');
    assert.equal(s.toast, 'Target omp-77ab31 has no lease — sent as broadcast (.vibepin/routed.jsonl has it)');
    assert.equal(s.toastAction, 'Re-target…', 'a degraded send offers the one-click re-target');
    assert.equal(w.daemon.log.posts.at(-1).target, 'omp-77ab31', 'the send still declared the target it wanted');
    await shot(cdp, '3-degraded-toast');

    await evaluate(cdp, `${SR}.querySelector('.toast .ta').click()`);
    s = await overlayState(cdp);
    assert.ok(s.settingsOpen, 'the receipt action opens the target picker');
    assert.ok(s.sessionRows.some((r) => r.includes('omp-aa11bb')), 'the picker lists what the daemon reports');
    assert.equal(s.selectedRow, 'Broadcast (no target)', 'the lease-less default is not silently kept');

    // forgetTarget is observable: with the old target back, the page still sends
    // undirected instead of resurrecting the default that just failed.
    w.state.sessions = [oneSession('omp-2f9c1a', '改简历解析页'), oneSession('omp-aa11bb', '改设置页'), oneSession('omp-77ab31', '改导出脚本')];
    await openPage(cdp, w.directUrl());
    s = await overlayState(cdp);
    assert.equal(s.destTarget, 'Target: broadcast (3 sessions, none picked)', 'the lease-less default is forgotten, not retried');

    // Settings block (§8.3): session rows + "last claim" from claims.jsonl.
    await evaluate(cdp, `${SR}.querySelector('.setbtn').click()`);
    s = await overlayState(cdp);
    const first = s.sessionRows[0];
    assert.ok(s.settingsText.includes('Sessions'), 'the settings block leads with the session list');
    assert.ok(first.includes('omp') && first.includes('omp-2f9c1a') && first.includes('pending') && first.includes('just now'),
      `a row carries agent · label · sid · freshness · pending — was ${first}`);
    assert.ok(s.settingsText.includes('Last claim') && s.settingsText.includes('2 notes'), 'last claim is the newest claims.jsonl line');
    await shot(cdp, '4-settings-panel');

    // zh copy uses the same slots (§9 wording).
    await evaluate(cdp, `window.__vibepin.setLang('zh')`);
    await until(async () => (await overlayState(cdp)).destTarget.startsWith('目标：'), 5000);
    s = await overlayState(cdp);
    assert.equal(s.destTarget, '目标：广播（3 个会话，未指定）');
    assert.ok(s.settingsText.includes('会话') && s.settingsText.includes('最后认领'), 'zh settings block');
    await annotateOne(cdp, '中文回执');
    s = await send(cdp, '广播');
    assert.equal(s.toast, '已发送 1 条（广播：未指定目标）');
    await shot(cdp, '5-zh');
  } catch (e) {
    if (cdp) await snap(cdp, 'overlay-failure');
    throw e;
  } finally {
    await chrome.stop();
    w.close();
  }
});

test('overlay §8.3 live: the panel and its list follow /sessions with no reload', { skip: SKIP }, async () => {
  const w = await makeWorld({ sessions: [oneSession('omp-2f9c1a', '改简历解析页')] });
  const chrome = await launchChrome({ urls: [w.directUrl()] });
  try {
    const cdp = await pageTab(chrome, '/?');
    await waitForOverlay(cdp);
    await until(async () => (await overlayState(cdp)).destTarget.includes('omp-2f9c1a'), 5000);
    // Leave the list open: §8.3's settings block must refresh under the user too.
    await evaluate(cdp, `${SR}.querySelector('.setbtn').click()`);

    // A second session parks while the page stays open (the 10 s /sessions poll).
    w.state.sessions = [oneSession('omp-2f9c1a', '改简历解析页'), oneSession('omp-77ab31', '改导出脚本')];
    const two = await until(async () => {
      const st = await overlayState(cdp);
      return st.destTarget === 'Target: broadcast (2 sessions, none picked)' && st.sessionRows.length === 3 ? st : null;
    }, 13000, 250);
    assert.ok(two.sessionRows.some((r) => r.includes('omp-77ab31')), 'the session that just parked appears in the open list');
    assert.equal(two.selectedRow, 'Broadcast (no target)', 'a live second session does not silently redirect anything');

    // And the last one goes away: a pin with no records left stays visible (a stale
    // target is still the target) and the list must still offer the way out.
    await evaluate(cdp, `[...${SR}.querySelectorAll('.sessrow')].find((r) => r.dataset.sid === 'omp-2f9c1a').click()`);
    assert.ok((await overlayState(cdp)).destTarget.includes('(default)'), 'clicking a row pins it as the default');
    w.state.sessions = [];
    const none = await until(async () => {
      const st = await overlayState(cdp);
      return st.destTarget === 'Target: omp-2f9c1a (default)' && st.sessionRows.length === 2 ? st : null;
    }, 13000, 250);
    assert.ok(none.selectedRow.includes('omp-2f9c1a') && none.selectedRow.includes('no lease record'),
      `the record-less target is named, not hidden — was ${none.selectedRow}`);
    await shot(cdp, '8-stale-pin');
    await evaluate(cdp, `[...${SR}.querySelectorAll('.sessrow')].find((r) => r.dataset.sid === '').click()`);
    assert.equal((await overlayState(cdp)).destTarget, 'Target: broadcast (no sessions)',
      'the escape hatch clears a target whose records are gone');
  } finally {
    await chrome.stop();
    w.close();
  }
});

test('overlay on a file:// page: self-sufficient with no extension context (§8.4/§15.5)', { skip: SKIP }, async () => {
  const w = await makeWorld({ sessions: [oneSession('omp-2f9c1a', '改简历解析页')] });
  const file = join(tmp('vibepin-s3-file-'), 'page.html');
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>file harness</title></head>
<body style="font:14px system-ui;margin:24px"><h1>Local file</h1><button id="btn">Save</button>
<script src="${w.daemon.origin}/annotate.js"></script></body></html>`);

  const chrome = await launchChrome({ urls: [pathToFileURL(file).href] });
  try {
    const cdp = await pageTab(chrome, 'page.html');
    await waitForOverlay(cdp);
    let s = await overlayState(cdp);
    // Line 1 still comes from /health; the panel needs nothing from the extension.
    assert.equal(s.destPath, `→ ${w.state.inbox}`);
    assert.equal(s.destTarget, 'Target: omp-2f9c1a (only session)');

    await annotateOne(cdp, 'from a file:// page');
    s = await send(cdp, 'Sent 1 → omp-2f9c1a');
    assert.equal(s.toast, 'Sent 1 → omp-2f9c1a (改简历解析页)', 'a file:// page can route on its own');
    assert.equal(w.daemon.log.posts.at(-1).target, 'omp-2f9c1a');
  } finally {
    await chrome.stop();
    w.close();
  }
});

test('overlay against a pre-routing daemon: broadcast, and today’s receipt (§11.1)', { skip: SKIP }, async () => {
  const w = await makeWorld({ sessions: [oneSession('omp-2f9c1a', '改简历解析页')] }, { legacy: true });
  const chrome = await launchChrome({ urls: [w.directUrl()] });
  try {
    const cdp = await pageTab(chrome, '/?');
    await waitForOverlay(cdp);
    let s = await overlayState(cdp);
    assert.equal(s.destPath, `→ ${w.state.inbox}`, 'provenance still comes from /health');
    assert.equal(s.destTarget, 'Target: broadcast (no sessions)', 'a daemon without /sessions can never be targeted');

    await annotateOne(cdp, 'legacy daemon');
    s = await send(cdp, 'Sent 1.');
    assert.equal(s.toast, 'Sent 1. your agent will pick it up.', 'no routed/degraded in the answer ⇒ the old wording');
    assert.equal(w.daemon.log.posts.at(-1).bare, true, 'nothing is targeted at a daemon that cannot route');
  } finally {
    await chrome.stop();
    w.close();
  }
});

test('overlay §8.3/§9 before: the pre-routing overlay has no destination row and reports only a count', { skip: SKIP }, async () => {
  // The "before" arm the repo's P0 suite uses: run the overlay as it shipped
  // BEFORE routing, both against the same daemon that already answers with
  // `routed`, so the new assertions are proven to discriminate rather than to pass
  // vacuously. The revision is pinned to d21e5dc's parent (the commit the routing
  // overlay landed in): `git show HEAD:` would hand the arm the AFTER overlay, and
  // the assertion below would be checking the feature against itself.
  const head = join(tmp('vibepin-s3-head-'), 'annotate.js');
  writeFileSync(head, execFileSync('git', ['-C', REPO, 'show', 'd21e5dc^:core/annotate.js'], { encoding: 'utf8', maxBuffer: 1 << 24 }));

  const w = await makeWorld({ sessions: [oneSession('omp-2f9c1a', '改简历解析页')] }, { annotatePath: head });
  const chrome = await launchChrome({ urls: [w.directUrl()] });
  try {
    const cdp = await pageTab(chrome, '/?');
    await waitForOverlay(cdp);
    assert.equal(await evaluate(cdp, `!!${SR}.querySelector('.dest')`), false, 'HEAD has no destination row at all');

    await annotateOne(cdp, 'move the save button left');
    await evaluate(cdp, `${SR}.querySelector('.foot .send').click()`);
    // The toggle already toasted; wait for the receipt, not for any text at all.
    await until(() => evaluate(cdp, `${SR}.querySelector('.toast').textContent.includes('Sent 1.')`), 5000);
    assert.equal(
      await evaluate(cdp, `${SR}.querySelector('.toast').textContent`),
      'Sent 1. Claude Code will pick it up.',
      'HEAD reports a bare count — no target, no routed/broadcast/degraded distinction',
    );
    assert.equal(w.daemon.log.posts.at(-1).bare, true, 'HEAD never sends targetSession');
  } finally {
    await chrome.stop();
    w.close();
  }
});

test('extension §8.4/§8.5: lists sessions, remembers a default target, and a daemon per site', { skip: SKIP }, async () => {
  const sessions = [oneSession('omp-2f9c1a', '改简历解析页'), oneSession('omp-77ab31', '改导出脚本', { lastSeenAt: 300 })];
  // Two daemons in the discovery range: without a per-site choice the lowest
  // answering port wins, so a choice for the *higher* one is observable.
  const w = await makeWorld({ sessions, pendingTotal: 7, inboxPending: 2 });
  const other = await startDaemon(mkState({ sessions, pendingTotal: 3, inboxPending: 1 }));
  const low = w.daemon;
  const high = other;
  assert.ok(high.port > low.port, `expected the second daemon above the first (${low.port} < ${high.port})`);

  const chrome = await launchChrome({ extension: EXTENSION, urls: [w.pageUrl('direct=0')] });
  try {
    const page = await pageTab(chrome, '/?');
    // The content script's execution context is the only in-page source of the
    // extension's own id (manifest.json is not web-accessible to a plain tab).
    await page.send('Runtime.enable');
    const extId = await until(() => {
      const ctx = page.events
        .filter((e) => e.method === 'Runtime.executionContextCreated')
        .map((e) => e.params.context)
        .find((c) => c.origin && c.origin.startsWith('chrome-extension://'));
      return ctx && ctx.origin.slice('chrome-extension://'.length);
    }, 15000);

    const browser = await connect((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);
    const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
    const target = await until(async () => {
      const t = (await chrome.targets()).find((x) => x.id === created.targetId);
      return t && t.webSocketDebuggerUrl && t.url.endsWith('/options.html') ? t : null;
    });
    const opt = await connect(target.webSocketDebuggerUrl);

    const text = (id) => evaluate(opt, `document.getElementById(${JSON.stringify(id)}).textContent`);
    // `expect` guards against reading the previous document's value during a reload.
    const settled = (expect) => until(async () => {
      const status = await text('status');
      if (!status || status === 'scanning…') return null;
      if (expect && (await text('endpoint')) !== expect) return null;
      return status;
    }, 10000);
    await settled();

    // §8.5: every answering daemon is a candidate, each with its own numbers.
    const candidates = await text('candidates');
    for (const d of [low, high]) assert.ok(candidates.includes(`127.0.0.1:${d.port}`), `candidate ${d.port} missing from ${candidates}`);
    assert.ok(candidates.includes('pending 7') && candidates.includes('pending 3'), 'each candidate carries its own pending');
    assert.ok((await text('sites')).includes('this page'), 'the site row belongs to the page the popup was opened on');

    // Remember the higher daemon for this origin (the settings page's own control).
    await evaluate(opt, `(() => { const r = [...document.querySelectorAll('#candidates input[name=cand]')]
      .find((x) => Number(x.value) === ${high.port});
      if (!r) throw new Error('no candidate radio for ${high.port}');
      r.checked = true; r.dispatchEvent(new Event('change')); return true; })()`);
    await until(async () => (await text('endpoint')) === high.origin, 10000);

    // §8.4: the page now reports the daemon it would use — including pendingTotal,
    // because the shared-inbox-only number would systematically under-report.
    assert.equal(await text('inbox'), high.state.inbox);
    assert.equal(await text('project'), high.state.projectRoot);
    await shot(opt, '6-options-sessions');
    await evaluate(opt, 'window.scrollTo(0, document.body.scrollHeight)');
    await sleep(150);
    await shot(opt, '7-options-sessions-bottom');
    assert.equal(await text('pending'), '3', 'pending shows pendingTotal, not /health.pending');
    assert.equal(await text('sessionCount'), '2');
    assert.ok((await text('sites')).includes(String(high.port)), 'the remembered daemon is shown for the origin');

    // The choice lives in chrome.storage, so it survives a reload of the page.
    await opt.send('Page.reload', { ignoreCache: true });
    await sleep(300);
    await settled(high.origin);
    assert.equal(await text('endpoint'), high.origin, 'the per-site daemon choice persists');

    // Session list + last claim (§8.4).
    const sessionsText = await text('sessions');
    assert.ok(sessionsText.includes('omp-2f9c1a') && sessionsText.includes('改简历解析页'), sessionsText);
    assert.ok(sessionsText.includes('omp-77ab31') && sessionsText.includes('5 min ago'), 'rows carry pending + freshness');
    assert.match(await text('lastClaim'), /^omp-2f9c1a · (just now|\d+ min ago|\d+ h ago) · 2 notes$/);

    // Default target: chosen here, persisted in chrome.storage, read back after reload.
    const options = await evaluate(opt, `[...document.getElementById('target').options].map((o) => o.textContent)`);
    assert.ok(options.includes('Broadcast (no target)'), 'undirected stays a first-class choice');
    assert.ok(options.includes('omp-2f9c1a — 改简历解析页'), JSON.stringify(options));
    await evaluate(opt, `(() => { const el = document.getElementById('target'); el.value = 'omp-77ab31';
      el.dispatchEvent(new Event('change')); return el.value; })()`);
    await sleep(250);
    await opt.send('Page.reload', { ignoreCache: true });
    await sleep(300);
    await settled(high.origin);
    assert.equal(await evaluate(opt, `document.getElementById('target').value`), 'omp-77ab31', 'the default survives a reload');
    assert.ok((await evaluate(opt, `[...document.querySelectorAll('#sessions .srow.on')].map((r) => r.textContent).join('|')`)).includes('omp-77ab31'),
      'the marked row follows the stored default');

    // §8.5 end to end: the remembered daemon is what the page's overlay loads from.
    const before = { low: low.log.script, high: high.log.script };
    await page.send('Page.navigate', { url: w.pageUrl('direct=0&t=1') });
    await waitForOverlay(page);
    assert.ok(high.log.script > before.high, 'the remembered daemon served annotate.js after the page reload');
    assert.equal(low.log.script, before.low, 'the lowest-port daemon was not used');
    assert.equal(await evaluate(page, 'window.__vibepin.endpoint'), high.origin, 'the overlay talks to the daemon remembered for its origin');

    // §8.4: the settings page is a record, never a sender — it has no way to
    // decide (or deliver) a note's target on a file:// page.
    assert.equal(low.log.posts.length + high.log.posts.length, 0, 'the settings page posted no annotation');
  } finally {
    await chrome.stop();
    w.close();
    other.close();
  }
});
