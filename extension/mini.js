// vibepin — toolbar popup. One job: turn annotate mode on and off for the page you
// are looking at, and say plainly why it cannot when it cannot.
//
// The overlay lives in the page's MAIN world (it is a <script src> the page
// loaded), so this popup cannot read `window.__vibepin` from its own isolated
// world. Both the read and the write therefore go through
// chrome.scripting.executeScript({ world: 'MAIN' }) — the same realm the overlay
// defined itself in.
//
// The read prefers the overlay's own `state()` and only falls back to sniffing
// the shadow DOM, so a page served by an older daemon (no `state()`) still shows
// a truthful button instead of a dead one.

const D = globalThis.VibepinDiscovery;
const $ = (id) => document.getElementById(id);

const TOGGLE_LABEL = { on: '关闭标注', off: '开启标注' };

// Self-contained: this function is serialised and evaluated in the page's main
// world, so it may not close over anything from this file.
const READ_STATE = () => {
  const api = globalThis.__vibepin;
  if (api && typeof api.state === 'function') {
    try { return { injected: true, ...api.state() }; } catch { /* fall through */ }
  }
  const host = document.getElementById('__vibepin_root');
  if (!api || !host) return { injected: false };
  const mini = host.shadowRoot && host.shadowRoot.querySelector('.mini');
  return {
    injected: true,
    on: mini ? mini.classList.contains('on') : false,
    pending: Array.isArray(api.pending) ? api.pending.length : 0,
    target: '',
  };
};

const DO_TOGGLE = () => {
  const api = globalThis.__vibepin;
  if (!api || typeof api.toggle !== 'function') return { ok: false };
  api.toggle();
  return { ok: true };
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// executeScript rejects on pages the extension has no access to (chrome://, the
// store, a PDF viewer) and on a tab that navigated away mid-click. Both are
// ordinary states for a toolbar button, not errors worth throwing.
async function inPage(tabId, func, args) {
  if (!Number.isInteger(tabId)) return { error: 'no-tab' };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      ...(args ? { args } : {}),
    });
    return { value: r && 'result' in r ? r.result : null };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// The daemon this popup last resolved, so the re-inject handler can build the
// right <script src> instead of assuming 7331 (a daemon that found 7331 busy
// takes the next free port, and the overlay derives its endpoint from that src).
let daemon = null;

function say(text, bad = false) {
  const el = $('why');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function render(daemonInfo, page) {
  const dot = $('dot'), btn = $('toggle'), label = $('toggleLabel');

  if (daemonInfo) {
    dot.className = 'dot ok';
    $('endpoint').textContent = D.origin(daemonInfo.port);
    $('inbox').textContent = daemonInfo.inbox || '—';
  } else {
    dot.className = 'dot bad';
    $('endpoint').textContent = '未连接';
    $('inbox').textContent = '—';
  }

  if (page && page.injected) {
    btn.disabled = false;
    btn.classList.toggle('on', !!page.on);
    label.textContent = page.on ? TOGGLE_LABEL.on : TOGGLE_LABEL.off;
    $('page').textContent = page.on
      ? `标注中${page.pending ? ` · ${page.pending} 条待发` : ''}`
      : '已注入 · 未标注';
    // The overlay is already loaded, so toggling still works with the daemon
    // down — but Send will fail, and that is worth saying rather than leaving
    // the user to discover it after writing a note.
    say(
      daemonInfo
        ? (page.on ? '点元素或拖拽框选来标注，Esc 退出。' : '')
        : 'daemon 没连上：标注能记，但 Send 会失败。',
      !daemonInfo
    );
  } else {
    btn.disabled = true;
    btn.classList.remove('on');
    label.textContent = '此页未注入';
    $('page').textContent = '无 overlay';
    if (daemonInfo) {
      say('这个页面还没加载 overlay。点「重新注入」现在补上（设置改动也需要刷新页面才生效）。');
    } else {
      say('没有 daemon 在跑，先起一个：npx vibepin daemon', true);
    }
  }
}

async function refresh() {
  const [{ port }, tab] = await Promise.all([
    chrome.storage.local.get({ port: null }),
    activeTab(),
  ]);
  daemon = await D.discover(port);
  const page = tab ? await inPage(tab.id, READ_STATE) : { error: 'no-tab' };
  render(daemon, page.value);
  return { tab, daemon };
}

$('toggle').addEventListener('click', async () => {
  const tab = await activeTab();
  const r = await inPage(tab && tab.id, DO_TOGGLE);
  if (!r.value || !r.value.ok) {
    say('这个页面控制不了（可能是 chrome:// 或无权限的站点）。', true);
    return;
  }
  await refresh();
});

$('reload').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  if (!daemon) { say('没有 daemon 在跑，先起一个：npx vibepin daemon', true); return; }
  const src = D.overlaySrc(daemon.port);
  // The overlay is a plain <script src>; re-adding it is all "reload" means. The
  // tag carries a stable id, so a page that already has it is left alone.
  const r = await inPage(tab.id, (url) => {
    if (globalThis.__vibepin) return { ok: true, already: true };
    const s = document.createElement('script');
    s.id = '__vibepin_overlay';
    s.src = url;
    (document.head || document.documentElement).appendChild(s);
    return { ok: true, already: false };
  }, [src]);
  if (r.error) { say('这个页面控制不了。', true); return; }
  say(r.value && r.value.already ? '这个页面已经有 overlay 了。' : '已注入，刷新后生效。');
});

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
