/* vibepin overlay — framework-agnostic, zero-dependency.
 * Toggle with ⌥A / Alt+A. The gesture decides the kind — no mode switch:
 *   - Click an element      → element annotation (hover-highlights first).
 *   - Drag a box (>5px move) → region annotation (the area + elements inside).
 * Batch-send to the daemon.
 *
 * Framework-aware: annotations carry the component name and source file (plus a
 * line number when the stack's dev tooling provides one) instead of a bare CSS
 * selector. Detection is a registry of self-guarding detectors — see
 * FRAMEWORK_DETECTORS and adapters/frameworks.md — currently React (fiber
 * _debugSource) and Vue 3 (runtime instance tree), plus DOM-attribute stamps
 * from dev inspector plugins. Falls back to the selector when neither is present.
 *
 * Screenshot is pluggable: if window.__vibepinCapture(rect) is defined
 * (e.g. Electron preload using webContents.capturePage), it is awaited and the
 * returned data URL is attached.
 */
(() => {
  if (window.__vibepin) {
    window.__vibepin.toggle();
    return;
  }

  // Demo mode (e.g. the hosted landing page): no daemon — Send just shows a toast.
  const DEMO = !!window.__vibepinDemo;

  const ENDPOINT =
    (document.currentScript && new URL(document.currentScript.src).origin) ||
    'http://127.0.0.1:7331';

  // Where the notes go, named the way the project calls it: the adapter injects
  // window.__vibepinTarget (vibepin({ target: 'omp' })). Empty → the
  // language-specific generic phrase baked into I18N below.
  const TARGET = typeof window.__vibepinTarget === 'string' ? window.__vibepinTarget.trim() : '';

  const STYLE_KEYS = [
    'display', 'position', 'boxSizing', 'width', 'height',
    'margin', 'padding', 'color', 'backgroundColor', 'border', 'borderRadius',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'textAlign', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
    'gridTemplateColumns', 'opacity', 'boxShadow', 'zIndex',
  ];

  const pending = [];
  let on = false;
  let hovered = null;
  let down = null;            // pointer-down origin — decides click vs drag
  let drawing = false;
  let start = null;
  let suppressClick = false;  // swallow the click that ends a drag
  let panelDrag = null;       // dragging the floating panel to reposition
  let settingsOpen = false;

  // Session routing (§5.2/§8.3). The page cannot see the project's files, so all
  // of this comes from the daemon's read-only views; the target is a client-side
  // prefill that the user can see and change — the daemon decides, never infers.
  let sessions = [];          // GET /sessions snapshot; [] = daemon has no such view
  let lastClaim = null;       // newest claims.jsonl line, or null
  let inboxPath = '';         // provenance: the inbox /health reports (or the endpoint)
  let targetSid = '';         // '' = broadcast (no targetSession is sent)
  let targetPinned = false;   // the user picked it (stored) vs "the only session"

  // ---- i18n --------------------------------------------------------------
  const I18N = {
    zh: {
      annotate: '标注', annotating: '标注中',
      modeOn: '标注模式开 (⌥A / Esc 退出)', modeOff: '标注模式关',
      sent: (n) => `已发送 ${n} 条,${TARGET || '你的 agent'} 会处理`, sendFail: '发送失败:',
      demoSent: '演示:真实项目里这会发给你的 AI agent 去改代码。',
      copy: '复制', copied: (n) => `已复制 ${n} 条,粘贴给你的 AI agent`, copyFail: '复制失败,请手动选择文本',
      copyIntro: '请按这些 UI 修改要求改代码:',
      empty: '还没有标注,点击或拖拽开始。',
      ph: '改这里要做什么?', cancel: '取消', add: '添加', save: '保存',
      count: (n) => `${n} 条`,
      tDrag: '拖动', tStatus: 'daemon 连接状态', tHide: '隐藏 · ⌥A 重新打开',
      tAnno: '进入/退出标注 (⌥A)', tEdit: '点击编辑', tRemove: '删除', tSettings: '设置',
      tMini: '开关标注（右下角小钮）', miniBtn: '右下角小开关', miniShow: '显示', miniHide: '隐藏',
      tSend: `发送给 ${TARGET || '你的 agent'}`,
      sOk: 'daemon 已连接', sNoResp: 'daemon 无响应', sNo: 'daemon 未连接',
      // 目标行 / 回执 / 会话列表 (§8.3/§9)。面板是唯一能回答"这条发给谁"的地方：
      // file:// 页面上没有扩展（§8.4）。
      targetLine: (x) => `目标：${x}`, targetOf: (sid, why) => `${sid}（${why}）`,
      onlyOne: '唯一会话', defTarget: '默认目标',
      bcAll: (n) => `广播（${n} 个会话，未指定）`, bcNone: '广播（暂无会话）',
      sentTo: (n, sid, label) => `已发送 ${n} 条 → ${sid}${label ? `（${label}）` : ''}`,
      sentBc: (n) => `已发送 ${n} 条（广播：未指定目标）`,
      sentDeg: (sid) => `目标 ${sid} 已无租约记录，已广播（.vibepin/routed.jsonl 有记录）`,
      retarget: '改投…', tPickTarget: '点击选择目标',
      staleIn: (m) => `目标 ${m} 分钟前活动`,
      sessions: '会话', lastClaim: '最后认领', pickBc: '广播（不指定目标）', noLease: '已无租约记录',
      justNow: '刚刚', minAgo: (m) => `${m} 分钟前`, hourAgo: (h) => `${h} 小时前`,
      unclaimed: (n) => `${n} 条未认领`, notes: (n) => `${n} 条`, noSession: '（daemon 没有会话记录）',
      staleWarn: '很久没活动',
      multiHint: (n) => `未指定目标：Send 会广播给 ${n} 个会话。要指定接收人，用 Copy 粘贴给谁由你决定。`,
      noNote: '(无备注)', region: (w, h, n) => `▦ 区域 ${w}×${h} · ${n} 元素`,
      lang: '语言', shortcuts: '快捷键', theme: '主题', dark: '暗色', light: '浅色',
      g: [['⌥A', '开关标注'], ['点击', '标注单个元素'], ['拖拽', '框选一片区域'],
          ['点钉 / 行', '编辑备注'], ['Esc', '退出标注'], ['Send', `发给 ${TARGET || '你的 agent'}`]],
    },
    en: {
      annotate: 'Annotate', annotating: 'Annotating',
      modeOn: 'Annotate mode on (⌥A / Esc to exit)', modeOff: 'Annotate mode off',
      sent: (n) => `Sent ${n}. ${TARGET || 'your agent'} will pick it up.`, sendFail: 'Send failed: ',
      demoSent: 'Demo — in a real project this goes to your AI agent to edit the code.',
      copy: 'Copy', copied: (n) => `Copied ${n} — paste into your AI agent.`, copyFail: 'Copy failed — select the text manually.',
      copyIntro: 'Apply these UI change requests:',
      empty: 'No annotations yet — click or drag to start.',
      ph: 'What should change here?', cancel: 'Cancel', add: 'Add', save: 'Save',
      count: (n) => `${n}`,
      tDrag: 'Drag', tStatus: 'daemon status', tHide: 'Hide · ⌥A to reopen',
      tAnno: 'Toggle annotate (⌥A)', tEdit: 'Click to edit', tRemove: 'Remove', tSettings: 'Settings',
      tMini: 'Toggle annotate (mini button)', miniBtn: 'Mini button', miniShow: 'Show', miniHide: 'Hide',
      tSend: `Send to ${TARGET || 'your agent'}`,
      sOk: 'daemon connected', sNoResp: 'daemon not responding', sNo: 'daemon not connected',
      targetLine: (x) => `Target: ${x}`, targetOf: (sid, why) => `${sid} (${why})`,
      onlyOne: 'only session', defTarget: 'default',
      bcAll: (n) => `broadcast (${n} sessions, none picked)`, bcNone: 'broadcast (no sessions)',
      sentTo: (n, sid, label) => `Sent ${n} → ${sid}${label ? ` (${label})` : ''}`,
      sentBc: (n) => `Sent ${n} (broadcast — no target)`,
      sentDeg: (sid) => `Target ${sid} has no lease — sent as broadcast (.vibepin/routed.jsonl has it)`,
      retarget: 'Re-target…', tPickTarget: 'Click to pick a target',
      staleIn: (m) => `target active ${m} min ago`,
      sessions: 'Sessions', lastClaim: 'Last claim', pickBc: 'Broadcast (no target)', noLease: 'no lease record',
      justNow: 'just now', minAgo: (m) => `${m} min ago`, hourAgo: (h) => `${h} h ago`,
      unclaimed: (n) => `${n} pending`, notes: (n) => `${n} notes`, noSession: '(this daemon has no session records)',
      staleWarn: 'idle for a while',
      multiHint: (n) => `No target: Send broadcasts to all ${n} sessions. Copy is the exact route — you name the receiver.`,
      noNote: '(no note)', region: (w, h, n) => `▦ Region ${w}×${h} · ${n} elements`,
      lang: 'Language', shortcuts: 'Shortcuts', theme: 'Theme', dark: 'Dark', light: 'Light',
      g: [['⌥A', 'Toggle annotate'], ['Click', 'Annotate an element'], ['Drag', 'Select a region'],
          ['Pin / Row', 'Edit note'], ['Esc', 'Exit annotate'], ['Send', `Hand off to ${TARGET || 'your agent'}`]],
    },
  };
  let lang = localStorage.getItem('__vibepin_lang') ||
    (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const t = (k) => (I18N[lang] && I18N[lang][k] != null ? I18N[lang][k] : I18N.zh[k]);
  let theme = localStorage.getItem('__vibepin_theme') || 'dark';

  // ---- UI ----------------------------------------------------------------
  const root = document.createElement('div');
  root.id = '__vibepin_root';
  root.setAttribute('data-theme', theme);
  const shadow = root.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(root);

  // Keystrokes typed into the overlay's own inputs must not reach the host app
  // (e.g. Space hitting a play/pause shortcut while you're writing a note).
  // Stop them at the shadow boundary — after the overlay's internal handlers
  // have run, before they bubble out to the app's document/window listeners.
  // Scoped to the shadow root, so only overlay-originated keys are affected;
  // keys typed into the app itself never enter here.
  ['keydown', 'keyup', 'keypress'].forEach((type) =>
    shadow.addEventListener(type, (e) => { e.stopPropagation(); })
  );

  shadow.innerHTML = `
  <style>
    :host { all: initial;
      --ov-bg:#161616; --ov-bg2:#0f0f0f; --ov-border:#2c2c2c; --ov-border2:#262626; --ov-row:#1f1f1f;
      --ov-text:#e8e8e8; --ov-muted:#9a9a9a; --ov-faint:#6f6f6f; --ov-chip:#222; --ov-chip-text:#cfcfcf;
      --ov-accent:#f5c518; --ov-ink:#1a1a1a; --ov-accent-ink:#f5c518; --ov-sel:#7a8aa0; --ov-cmp:#8bd5a0;
      --ov-seton:#2b2b2b; --ov-shadow:0 12px 40px rgba(0,0,0,.55); }
    :host([data-theme="light"]) {
      --ov-bg:#ffffff; --ov-bg2:#f3f3f5; --ov-border:#e3e3e8; --ov-border2:#ededf0; --ov-row:#eeeef1;
      --ov-text:#1a1a1a; --ov-muted:#6a6a73; --ov-faint:#9a9aa3; --ov-chip:#eef0f2; --ov-chip-text:#33333a;
      --ov-accent:#f5c518; --ov-ink:#161300; --ov-accent-ink:#8a6a00; --ov-sel:#5a6b85; --ov-cmp:#2e7d4f;
      --ov-seton:#ececf0; --ov-shadow:0 12px 36px rgba(0,0,0,.18); }
    *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .hl{position:fixed;pointer-events:none;z-index:2147483640;border:2px solid #f5c518;
        background:rgba(245,197,24,.16);border-radius:3px;transition:all .04s linear}
    .band{position:fixed;pointer-events:none;z-index:2147483640;border:2px dashed #f5c518;
          background:rgba(245,197,24,.16);border-radius:2px}
    .tag{position:fixed;z-index:2147483641;pointer-events:none;background:var(--ov-accent);color:var(--ov-ink);
         font-size:11px;padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
    .panel{position:fixed;right:16px;top:16px;z-index:2147483642;width:auto;
           background:var(--ov-bg);color:var(--ov-text);border:1px solid var(--ov-border);border-radius:12px;
           box-shadow:var(--ov-shadow);overflow:hidden}
    .panel.open{width:300px}
    .phead{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;user-select:none}
    .phead:active{cursor:grabbing}
    .grip{display:flex;align-items:center;color:var(--ov-faint);cursor:grab}
    .atog{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:28px;background:var(--ov-chip);color:var(--ov-chip-text);padding:0 12px 0 10px;font-size:12px;border-radius:7px}
    .atog.on{background:var(--ov-accent);color:var(--ov-ink);font-weight:600}
    .grip svg,.atog svg,.setbtn svg,.hidebtn svg{display:block}
    .count{font-size:11px;color:var(--ov-muted);margin-left:auto}
    .dest{padding:0 10px 8px;font:10px/1.5 ui-monospace,Menlo,monospace;color:var(--ov-faint);
          max-width:280px;word-break:break-all}
    .dest .dt{margin-top:2px;color:var(--ov-muted);cursor:pointer}
    .dest .dt:hover{color:var(--ov-text)}
    .dest .dt.stale{color:#e0a056}
    .sesslist{display:flex;flex-direction:column;gap:2px}
    .sessrow{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:7px;cursor:pointer;pointer-events:auto}
    .sessrow:hover{background:var(--ov-row)}
    .sessrow.on{background:var(--ov-seton);box-shadow:inset 0 0 0 1px var(--ov-accent)}
    .sessrow .sname{font-size:11.5px;color:var(--ov-text)}
    .sessrow.on .sname{font-weight:600}
    .sessrow .smeta{font:10px/1.5 ui-monospace,Menlo,monospace;color:var(--ov-faint);word-break:break-all}
    .claimrow{display:flex;justify-content:space-between;gap:8px;margin-top:8px}
    .routenote{padding:8px 12px 0;font-size:11px;line-height:1.5;color:var(--ov-muted)}
    .hidebtn{flex:0 0 auto;height:28px;display:inline-grid;place-items:center;background:transparent;color:var(--ov-faint);padding:0 7px;border-radius:7px}
    .hidebtn:hover{color:#e05656}
    .setbtn{flex:0 0 auto;height:28px;display:inline-grid;place-items:center;background:transparent;color:var(--ov-muted);padding:0 7px;border-radius:7px}
    .setbtn:hover{color:var(--ov-text)}
    .setbtn.on{background:var(--ov-accent);color:var(--ov-ink)}
    .settings{padding:10px 12px;border-top:1px solid var(--ov-border2)}
    .setrow{display:flex;align-items:center;justify-content:space-between}
    .setrow+.setrow{margin-top:10px}
    .langlabel{font-size:11px;color:var(--ov-faint)}
    .seg2{display:inline-flex;gap:2px;background:var(--ov-chip);border-radius:8px;padding:2px}
    .seg2 button{flex:0 0 auto;background:transparent;color:var(--ov-muted);padding:3px 11px;font-size:11px;border-radius:6px}
    .seg2 button.on{background:var(--ov-accent);color:var(--ov-ink);font-weight:600}
    .setdiv{height:1px;background:var(--ov-border2);margin:12px 0}
    .setgt{color:var(--ov-faint);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}
    .guide{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center}
    .gkey{justify-self:start;padding:3px 9px;background:var(--ov-chip);border-radius:6px;
          font:11px/1.5 ui-monospace,Menlo,monospace;color:var(--ov-text);white-space:nowrap}
    .gdesc{color:var(--ov-muted);font-size:12px}
    .status{width:8px;height:8px;border-radius:50%;background:#555;flex:0 0 auto}
    .status.ok{background:#36d399}
    .pin{position:fixed;z-index:2147483641;transform:translate(-50%,-50%);min-width:18px;height:18px;padding:0 4px;
         border-radius:9px;background:#f5c518;color:#1a1a1a;font-size:11px;font-weight:700;line-height:18px;
         text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 1px 3px rgba(0,0,0,.22)}
    .body{border-top:1px solid var(--ov-border2)}
    .list{max-height:240px;overflow:auto}
    .row{padding:8px 12px;border-bottom:1px solid var(--ov-row);display:flex;gap:8px;align-items:flex-start}
    .row .sel{font-size:10px;color:var(--ov-sel);font-family:ui-monospace,Menlo,monospace;word-break:break-all}
    .row .cmp{color:var(--ov-cmp)}
    .row .nt{font-size:12px;color:var(--ov-text);margin-top:2px}
    .row .x{margin-left:auto;color:var(--ov-muted);cursor:pointer;pointer-events:auto;font-size:14px;line-height:1}
    .row .x:hover{color:#e05656}
    .pinno{flex:0 0 auto;width:16px;height:16px;border-radius:8px;background:var(--ov-accent);color:var(--ov-ink);font-size:10px;font-weight:700;line-height:16px;text-align:center}
    .foot{display:flex;gap:8px;padding:10px 12px}
    button{flex:1;border:0;border-radius:8px;padding:9px;font-size:13px;cursor:pointer;pointer-events:auto}
    .send{background:var(--ov-accent);color:var(--ov-ink);font-weight:600}
    .send:disabled{background:var(--ov-chip);color:var(--ov-faint);cursor:default}
    .clear{background:var(--ov-chip);color:var(--ov-text)}
    .copy{background:var(--ov-chip);color:var(--ov-text)}
    .copy:disabled{color:var(--ov-faint);cursor:default}
    .empty{padding:16px 12px;color:var(--ov-faint);font-size:11px;text-align:center;white-space:nowrap}
    .pop{position:fixed;z-index:2147483643;width:280px;background:var(--ov-bg);border:1px solid var(--ov-border);
         border-radius:10px;box-shadow:var(--ov-shadow);padding:10px;pointer-events:auto}
    .pop .sel{font-size:10px;color:var(--ov-sel);font-family:ui-monospace,Menlo,monospace;word-break:break-all;margin-bottom:6px}
    .pop .sel .cmp{color:var(--ov-cmp)}
    textarea{width:100%;height:64px;resize:none;background:var(--ov-bg2);color:var(--ov-text);border:1px solid var(--ov-border);
             border-radius:8px;padding:8px;font-size:13px;font-family:inherit}
    textarea:focus{outline:none;border-color:var(--ov-accent)}
    .pact{display:flex;gap:6px;margin-top:8px}
    .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483644;
           display:flex;align-items:center;gap:10px;max-width:min(560px,90vw);
           background:#1b3a1b;color:#bdf0bd;border:1px solid #2e572e;padding:8px 14px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .2s}
    .toast.show{opacity:1}
    .toast .ta{flex:0 0 auto;background:#2e572e;color:#dff5df;border:1px solid #3f7a3f;border-radius:6px;
               padding:3px 9px;font-size:11px;cursor:pointer}
    .toast .ta:hover{background:#3a6b3a}
    /* 常驻迷你开关：右下角一颗 28px 圆钮。折叠态只剩图标，hover 横向展开露出
       「标注中/标注」；进入标注态时常驻展开并整颗点亮，这样不靠快捷键也一眼
       看得出当前是不是在标注。pointer-events 只作用在这颗钮上（overflow:hidden
       让展开的余量不拦截点击），不挡页面。 */
    .mini{position:fixed;right:16px;bottom:16px;z-index:2147483643;pointer-events:auto;
          display:inline-flex;align-items:center;height:28px;padding:0;border:0;
          border-radius:14px;overflow:hidden;cursor:pointer;
          background:var(--ov-chip);color:var(--ov-chip-text);box-shadow:var(--ov-shadow);
          opacity:.55;transition:opacity .15s,background .15s,padding .18s}
    .mini:hover{opacity:1;padding-right:10px}
    .mini.on{opacity:1;padding-right:10px;background:var(--ov-accent);color:var(--ov-ink)}
    .mini svg{display:block;flex:0 0 auto;margin:0 6px}
    .mini .mlabel{font-size:12px;line-height:1;white-space:nowrap;max-width:0;opacity:0;
                  transition:max-width .18s,opacity .15s}
    .mini:hover .mlabel,.mini.on .mlabel{max-width:90px;opacity:1}
    .hidden{display:none}
  </style>
  <div class="hl hidden"></div>
  <div class="band hidden"></div>
  <div class="tag hidden"></div>
  <div class="pins"></div>
  <div class="panel">
    <div class="phead">
      <span class="grip"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>
      <span class="status"></span>
      <button class="atog"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg><span class="atog-label">标注</span></button>
      <span class="count">0</span>
      <button class="setbtn"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      <button class="hidebtn"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
    </div>
    <div class="dest"><div class="dp"></div><div class="dt"></div></div>
    <div class="body hidden">
      <div class="list"></div>
      <div class="routenote hidden"></div>
      <div class="foot"><button class="clear">Clear</button><button class="copy" disabled>Copy</button><button class="send" disabled>Send 0</button></div>
    </div>
    <div class="settings hidden"></div>
  </div>
  <div class="toast"><span class="tx"></span><button class="ta hidden"></button></div>
  <button class="mini" type="button"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg><span class="mlabel"></span></button>`;

  const $ = (s) => shadow.querySelector(s);
  const hlEl = $('.hl'), bandEl = $('.band'), tagEl = $('.tag'), panel = $('.panel'),
        pinsEl = $('.pins'), statusEl = $('.status'),
        pheadEl = $('.phead'), bodyEl = $('.body'), atogBtn = $('.atog'), hideBtn = $('.hidebtn'),
        setBtn = $('.setbtn'), settingsEl = $('.settings'), atogLabel = $('.atog-label'),
        listEl = $('.list'), countEl = $('.count'), sendBtn = $('.send'),
        clearBtn = $('.clear'), copyBtn = $('.copy'), toastEl = $('.toast'), destEl = $('.dest'),
        destPathEl = $('.dp'), destTargetEl = $('.dt'), toastTxEl = $('.tx'), toastActEl = $('.ta'),
        routeNoteEl = $('.routenote');
  const miniBtn = $('.mini'), miniLabel = $('.mlabel');

  // 常驻迷你钮默认开着；存 '0' 才关。读取失败（隐私模式等）按默认开——它是
  // 「面板被关掉之后唯一的入口」，默认关掉等于给用户留一个进不去的死路。
  let miniOn = (() => {
    try { return localStorage.getItem('__vibepin_mini') !== '0'; } catch { return true; }
  })();
  miniBtn.classList.toggle('hidden', !miniOn);

  // ---- helpers -----------------------------------------------------------
  // Ids a component library invents while rendering come back different on the
  // next render, so a selector built from one reads fine in the note and then
  // misses after a reload (Element Plus' useId stamps `el-id-477-18` on every
  // input, Vue 3.5's useId `v-9`, React's `:r1:` — and Radix's `radix-«r2»`
  // variant of it — Ant Design's `rc_select_1`, Ember's `ember123`). App ids
  // (#app, #pane-access) are the opposite: stable, short, and what a human would
  // type themselves, so only those are trusted as a shortcut.
  const AUTO_ID = /^(?:el-id-\d+(?:-\d+)?|v-\d+|ember\d+|:r[0-9a-z]+:|«r[0-9a-z]+»|radix-[:«]r[0-9a-z]+[:»]|rc_[a-z]+_[\w-]*\d|rc-[a-z]+-\d[\w-]*)$/i;
  function idSel(node) {
    const id = node.id;
    return id && !AUTO_ID.test(id) ? '#' + CSS.escape(id) : null;
  }

  // One hop of a structural selector: tag, up to two classes, plus a positional
  // qualifier only where siblings of that same tag make it ambiguous.
  function stepSel(node) {
    let sel = node.tagName.toLowerCase();
    const cls = [...node.classList].filter((c) => !c.startsWith('__')).slice(0, 2);
    if (cls.length) sel += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const parent = node.parentNode;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    return sel;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const direct = idSel(el);
    if (direct) return direct;
    const parts = [];
    let node = el, anchored = false;
    while (node && node.nodeType === 1 && node !== document.body) {
      const id = idSel(node);
      if (id) { parts.unshift(id); anchored = true; break; }
      parts.unshift(stepSel(node));
      node = node.parentNode;
    }
    let sel = parts.join(' > ');
    // A structural path is not automatically a working selector: <body> can hold
    // several same-tag siblings, and the top hop then resolves to whichever comes
    // first instead of the annotated node. Check against the live document and,
    // on a miss, complete the path with the one level the walk stopped short of —
    // <body> — rather than hand back a string that lands somewhere else. (An
    // id-anchored path is unambiguous by construction, and a node in a shadow
    // root or a detached tree resolves from document by no path at all.)
    if (sel && !anchored && !resolves(sel, el) && resolves('body > ' + sel, el)) sel = 'body > ' + sel;
    return sel;
  }

  // Round-trip check: a selector only earns its place in a note if it lands back
  // on the annotated node, and a malformed one must read as a miss, not throw.
  function resolves(sel, el) {
    try { return document.querySelector(sel) === el; } catch { return false; }
  }

  // ---- framework detectors ------------------------------------------------
  // Every stack is recognised by its own runtime signature, and every detector
  // has the same contract: (el) => { component, source } | null, either field may
  // be null, nothing throws, and a page of a different stack exits on the
  // signature check before doing any work. frameworkInfo() fills the two fields
  // independently — first non-empty wins, later detectors only plug the gaps — so
  // a React island inside a Vue shell (or the reverse) resolves on both sides.
  //
  // Adding a stack = a detector in FRAMEWORK_DETECTORS below (+ a row in the
  // attribute table if its dev plugin stamps the DOM). The three call sites and
  // the whole send path stay untouched — see adapters/frameworks.md.

  // React (dev builds): the fiber carries _debugSource (file + line).
  // Signature: __reactFiber$ / __reactInternalInstance$.
  function getFiber(el) {
    const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  }
  function fiberName(f) {
    const t = f && f.type;
    if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || null;
  }
  function srcStr(s) {
    if (!s || !s.fileName) return null;
    return s.lineNumber ? `${s.fileName}:${s.lineNumber}` : s.fileName;
  }
  function reactInfo(el) {
    let f = getFiber(el);
    if (!f) return null;
    let component = null, source = null;
    while (f && (!source || !component)) {
      if (!source && f._debugSource) source = srcStr(f._debugSource);
      if (!component) { const n = fiberName(f); if (n) component = n; }
      f = f.return;
    }
    return (component || source) ? { component, source } : null;
  }

  // ---- Vue 3 -------------------------------------------------------------
  // The runtime stamps every node it renders with the instance that produced it
  // (__vueParentComponent), so instance.type.__name / .__file give the SFC — no
  // plugin needed, but no line number either. vite-plugin-vue-inspector adds the
  // position (file:line:col): as data-v-inspector on the elements the compiler
  // inlined into a static HTML string, and for the rest on a hidden, non-
  // enumerable vnode prop (__v_inspector) that its runtime swaps the attribute
  // for. Both channels are read; they barely overlap (measured 6/32 disjoint on
  // the example app). Element Plus & friends live in node_modules / have no
  // __file, so the walk skips them and stops at the nearest component of the app.
  const VUE_MAX_UP = 24;

  let vueRootCache = null;
  function vueRoot() {
    if (vueRootCache === null) {
      const r = window.__vibepinRoot;          // injected by adapters/vite.js
      vueRootCache = typeof r === 'string' ? r.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    }
    return vueRootCache;
  }
  // A .vue file can arrive as an absolute path (D:/p/src/A.vue, /home/u/p/src/A.vue)
  // or project-relative (/src/A.vue), so root-relative paths get the root prepended.
  // Dependencies return null — a pin pointing into node_modules is useless.
  function normVuePath(p) {
    if (!p) return null;
    const s = String(p).split('?')[0].replace(/\\/g, '/');
    if (!s || s.includes('node_modules')) return null;
    const root = vueRoot();
    if (/^[a-zA-Z]:\//.test(s) || s.startsWith('//')) return s;   // drive letter / UNC
    if (root && s.startsWith(root + '/')) return s;               // already absolute
    return root ? root + '/' + s.replace(/^\/+/, '') : s;
  }
  function baseName(file) { return file.slice(file.lastIndexOf('/') + 1).replace(/\.\w+$/, ''); }
  // "…/A.vue:12:5" → absolute path + position, or null for a dependency path.
  function vueTraceSource(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const m = /^(.*?)(:\d+(?::\d+)?)$/.exec(raw.trim());
    const file = normVuePath(m ? m[1] : raw);
    return file ? file + (m ? m[2] : '') : null;
  }
  // Position of the node itself, written by the plugin's runtime (see above).
  function vueHiddenSource(el) {
    const props = el.__vnode && el.__vnode.props;
    const raw = props && props.__v_inspector;
    return typeof raw === 'string' ? vueTraceSource(raw) : null;
  }
  // Nearest instance that rendered this node. Teleports and fragments sometimes
  // stamp a parent node instead, and a run of static siblings becomes one
  // innerHTML string — those elements have no vnode of their own.
  function vueInst(el) {
    if (el.__vueParentComponent) return el.__vueParentComponent;
    for (let n = el.parentElement; n; n = n.parentElement) if (n.__vueParentComponent) return n.__vueParentComponent;
    return null;
  }
  function vueRuntimeInfo(inst) {
    let named = null;
    for (let depth = 0; inst && depth < VUE_MAX_UP; depth++, inst = inst.parent || null) {
      const type = inst.type || {};
      if (!named) named = type.__name || type.name || null;
      const file = normVuePath(type.__file);
      // name and file must come from the same instance, or a pin on an app panel
      // would be labelled with an Element Plus component it merely contains
      if (file) return { component: type.__name || type.name || baseName(file), source: file };
    }
    return { component: named, source: null };
  }
  function vueInfo(el) {
    const inst = vueInst(el);
    if (!inst) return null;                                  // signature: __vueParentComponent
    const rt = vueRuntimeInfo(inst);
    const source = vueHiddenSource(el) || rt.source;          // exact line if vue-inspector is on
    return (rt.component || source) ? { component: rt.component, source } : null;
  }
  // The instances that rendered this node, innermost first: the first entry names
  // the piece, the outer ones say who owns the surrounding layout (which is what
  // decides whether a control may move into another row). One entry per instance,
  // so the name and file always come from the same component.
  function vueChain(el, max) {
    const out = [];
    for (let inst = vueInst(el); inst && out.length < (max || 6); inst = inst.parent || null) {
      const type = inst.type || {};
      const file = normVuePath(type.__file);
      const name = type.__name || type.name || (file ? baseName(file) : null);
      if (!name && !file) continue;
      const prev = out[out.length - 1];
      if (!prev || prev.component !== name) out.push({ component: name || null, source: file || null });
    }
    return out.length ? out : null;
  }
  // Structured line/column, when an inspector plugin supplied one (source stays the
  // raw string so nothing that already consumes it changes).
  function sourcePos(source) {
    const m = /:(\d+)(?::(\d+))?$/.exec(source || '');
    return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : null } : null;
  }
  // The parent box a control actually lives in — enough to answer "is there room on
  // that row, and who lays it out" without opening a browser.
  function containerInfo(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    const cs = getComputedStyle(parent);
    const r = parent.getBoundingClientRect();
    return {
      selector: cssPath(parent),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display, flexDirection: cs.flexDirection, gap: cs.gap,
      justify: cs.justifyContent, align: cs.alignItems,
      childCount: parent.children.length,
    };
  }
  // Viewport + theme: some "looks wrong" reports only reproduce on a narrow window
  // or in dark mode.
  function viewInfo() {
    const dark = document.documentElement.classList.contains('dark') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, theme: dark ? 'dark' : 'light' };
  }

  // Dev-only inspector plugins stamp source/component onto the DOM, which needs no
  // runtime signature at all — one table row per plugin, checked before the runtime
  // detectors. parse(value, host) returns the source string (null = unusable, e.g.
  // a dependency path). The component keys are independent of the source keys:
  // an element may carry either, both, or none.
  const DOM_SOURCE_ATTRS = [
    ['data-source', (v) => v],                                   // react-dev-inspector
    ['data-inspector-relative-path', (v, host) => {              //   "  (+ :line)
      const line = host.getAttribute('data-inspector-line');
      return line ? `${v}:${line}` : v;
    }],
    ['data-v-inspector', vueTraceSource],                        // vite-plugin-vue-inspector
  ];
  const DOM_COMPONENT_ATTRS = ['data-component', 'data-inspector-component'];
  function domAttributeInfo(el) {
    if (!el.closest) return null;
    let component = null, source = null;
    for (const [attr, parse] of DOM_SOURCE_ATTRS) {
      const host = el.closest(`[${attr}]`);
      const raw = host && host.getAttribute(attr);
      if (raw) { source = parse(raw, host); break; }
    }
    for (const attr of DOM_COMPONENT_ATTRS) {
      const host = el.closest(`[${attr}]`);
      const raw = host && host.getAttribute(attr);
      if (raw) { component = raw; break; }
    }
    return (component || source) ? { component, source } : null;
  }

  // Order = specificity: explicit DOM stamps, then runtime signatures.
  // (future: svelteInfo — __svelte_meta; solidInfo — __$owner; angularInfo — ng.getComponent)
  const FRAMEWORK_DETECTORS = [domAttributeInfo, reactInfo, vueInfo];

  function frameworkInfo(el) {
    // A production bundle (the demo page) has minified names and no debug source,
    // and no inspector plugin runs in it — so detection is skipped entirely and
    // annotations fall back to the CSS selector.
    if (DEMO) return null;
    let component = null, source = null;
    for (const detect of FRAMEWORK_DETECTORS) {
      const r = detect(el);
      if (!r) continue;
      if (!component && r.component) component = r.component;
      if (!source && r.source) source = r.source;
      if (component && source) break;
    }
    return (component || source) ? { component, source } : null;
  }

  function pickStyles(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of STYLE_KEYS) out[k] = cs[k];
    return out;
  }

  function isOurs(el) {
    return el === root || (el && el.getRootNode && el.getRootNode() === shadow);
  }

  function place(box, x, y, w, h) {
    box.style.left = x + 'px'; box.style.top = y + 'px';
    if (w != null) box.style.width = w + 'px';
    if (h != null) box.style.height = h + 'px';
  }

  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  // A send has three outcomes the user must be able to tell apart — routed to a
  // session, broadcast because no target was given, broadcast because the target
  // had no lease. The last one carries an action: the notes are already in the
  // shared inbox, so re-sending would deliver them twice — what is fixable is
  // *the next* send, by picking a target that exists.
  let toastTimer = null;
  function toast(msg, ok = true, action = null) {
    toastTxEl.textContent = msg;
    toastEl.style.background = ok ? '#1b3a1b' : '#3a1b1b';
    toastEl.style.color = ok ? '#bdf0bd' : '#f0bdbd';
    if (action) {
      toastActEl.textContent = action.label;
      toastActEl.classList.remove('hidden');
      toastActEl.onclick = () => { hideToast(); action.run(); };
    } else {
      toastActEl.classList.add('hidden');
      toastActEl.onclick = null;
    }
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 8000 : 1600);
  }
  function hideToast() { toastEl.classList.remove('show'); }

  // Sample a grid of points to find the elements under a region.
  function elementsInRect(r) {
    const seen = new Set(), out = [];
    const cols = 4, rows = 3;
    for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) {
      const el = document.elementFromPoint(r.x + (r.w * i) / cols, r.y + (r.h * j) / rows);
      if (!el || isOurs(el)) continue;
      const sel = cssPath(el);
      if (seen.has(sel)) continue;
      seen.add(sel);
      const fi = frameworkInfo(el);
      out.push({ selector: sel, component: fi && fi.component, source: fi && fi.source });
      if (out.length >= 8) break;
    }
    return out;
  }

  // ---- hover highlight (element mode) ------------------------------------
  function onMove(e) {
    if (panelDrag || !on) return;
    // moving past the threshold while the button is down turns it into a region drag
    if (down && !drawing && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
      drawing = true; start = { x: down.x, y: down.y };
      hlEl.classList.add('hidden'); tagEl.classList.add('hidden');
      bandEl.classList.remove('hidden');
      document.body.style.userSelect = 'none';
    }
    if (drawing) { const r = rectFrom(start, { x: e.clientX, y: e.clientY }); place(bandEl, r.x, r.y, r.w, r.h); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOurs(el)) { hlEl.classList.add('hidden'); tagEl.classList.add('hidden'); hovered = null; return; }
    hovered = el;
    const r = el.getBoundingClientRect();
    hlEl.classList.remove('hidden');
    place(hlEl, r.left, r.top, r.width, r.height);
    const fi = frameworkInfo(el);
    const label = fi && fi.component
      ? '<' + fi.component + '>'
      : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.classList.length ? '.' + [...el.classList].filter((c) => !c.startsWith('__'))[0] : '');
    tagEl.textContent = label;
    tagEl.classList.remove('hidden');
    place(tagEl, r.left, Math.max(0, r.top - 20));
  }

  // ---- region drawing ----------------------------------------------------
  function onDown(e) {
    if (!on || isOurs(e.target) || pop) return;
    down = { x: e.clientX, y: e.clientY };  // wait to see if it becomes a drag
  }
  function onUp(e) {
    if (drawing) {
      drawing = false;
      document.body.style.userSelect = '';
      down = null;
      suppressClick = true;                 // swallow the trailing click
      const r = rectFrom(start, { x: e.clientX, y: e.clientY });
      if (r.w < 6 || r.h < 6) { bandEl.classList.add('hidden'); return; }
      e.preventDefault(); e.stopPropagation();
      openRegionPopup(r, e);
      return;
    }
    down = null;                            // a plain click → onClick handles it
  }

  // ---- note popup (shared) ----------------------------------------------
  let pop = null;
  function openNotePopup(labelHtml, e, onCommit, initial) {
    closePopup();
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.innerHTML = `<div class="sel"></div><textarea placeholder="${esc(t('ph'))}"></textarea>
      <div class="pact"><button class="clear" data-a="cancel">${esc(t('cancel'))}</button><button class="send" data-a="add" style="opacity:1">${initial ? esc(t('save')) : esc(t('add'))}</button></div>`;
    pop.querySelector('.sel').innerHTML = labelHtml;
    shadow.appendChild(pop);
    place(pop, Math.min(e.clientX, window.innerWidth - 296), Math.min(e.clientY, window.innerHeight - 170));
    const ta = pop.querySelector('textarea');
    if (initial) ta.value = initial;
    ta.focus();
    const commit = () => {
      const note = ta.value.trim();
      if (!note) { closePopup(); return; }
      onCommit(note);
      closePopup();
      renderList();
    };
    pop.addEventListener('click', (ev) => {
      const a = ev.target.dataset.a;
      if (a === 'add') commit();
      if (a === 'cancel') closePopup();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) commit();
      if (ev.key === 'Escape') { ev.stopPropagation(); closePopup(); }
    });
  }
  function closePopup() { if (pop) { pop.remove(); pop = null; } bandEl.classList.add('hidden'); }

  // Escapes quotes as well as brackets: these strings also land inside
  // attributes (placeholder=, title=, data-sid=), where a quote ends the value.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openElementPopup(el, e) {
    const r = el.getBoundingClientRect();
    const selector = cssPath(el);
    const fi = frameworkInfo(el);
    const label = (fi && fi.component ? `<span class="cmp">&lt;${esc(fi.component)}&gt;</span> ` : '') +
      esc(fi && fi.source ? fi.source : selector);
    openNotePopup(label, e, (note) => {
      const item = {
        id: `${Date.now()}-${pending.length}`, ts: Date.now(), url: location.href, note,
        kind: 'element', selector,
        component: fi && fi.component || null, source: fi && fi.source || null,
        chain: vueChain(el), sourcePos: sourcePos(fi && fi.source),
        container: containerInfo(el), viewport: viewInfo(),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        pin: { px: r.left + window.scrollX, py: r.top + window.scrollY },
        html: el.outerHTML.slice(0, 4000), styles: pickStyles(el), _el: el,
      };
      pending.push(item);
      maybeShot(item, { left: r.left, top: r.top, width: r.width, height: r.height });
    });
  }

  function openRegionPopup(r, e) {
    const els = elementsInRect(r);
    const comp = els.find((x) => x.component);
    const label = esc(t('region')(Math.round(r.w), Math.round(r.h), els.length)) +
      (comp ? ` <span class="cmp">&lt;${esc(comp.component)}&gt;</span>` : '');
    openNotePopup(label, e, (note) => {
      const item = {
        id: `${Date.now()}-${pending.length}`, ts: Date.now(), url: location.href, note,
        kind: 'region', selector: null, elements: els,
        component: comp ? comp.component : null, source: comp ? comp.source : null,
        viewport: viewInfo(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        pin: { px: r.x + window.scrollX, py: r.y + window.scrollY },
        _el: null,
      };
      pending.push(item);
      maybeShot(item, { left: r.x, top: r.y, width: r.w, height: r.h });
    });
  }

  async function maybeShot(item, r) {
    if (typeof window.__vibepinCapture !== 'function') return;
    try {
      item.screenshot = await window.__vibepinCapture({
        x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
      });
      renderList();
    } catch { /* optional */ }
  }

  function onClick(e) {
    if (panelDrag || !on) return;
    if (suppressClick) { suppressClick = false; return; }  // this click ended a drag
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (el && !isOurs(el)) openElementPopup(el, e);
  }

  // keep the floating panel's chrome in sync (active state + collapse when idle)
  function updatePanel() {
    atogBtn.classList.toggle('on', on);
    atogLabel.textContent = on ? t('annotating') : t('annotate');
    miniBtn.classList.toggle('on', on);
    miniLabel.textContent = on ? t('annotating') : t('annotate');
    countEl.textContent = pending.length ? t('count')(pending.length) : '';
    setBtn.classList.toggle('on', settingsOpen);
    settingsEl.classList.toggle('hidden', !settingsOpen);
    bodyEl.classList.toggle('hidden', settingsOpen || !(on || pending.length));
    // Undirected + several listeners: say so before Send, and name Copy — the one
    // route with no mechanism to get wrong (spec §9.6). Never a silent broadcast.
    const undirected = !!(pending.length && !targetSid && sessions.length >= 2);
    routeNoteEl.classList.toggle('hidden', !undirected);
    if (undirected) routeNoteEl.textContent = t('multiHint')(sessions.length);
    // compact pill when idle; full-width when the body/settings is open
    panel.classList.toggle('open', !!(settingsOpen || on || pending.length));
  }

  // ---- pending list ------------------------------------------------------
  function renderList() {
    countEl.textContent = pending.length;
    sendBtn.textContent = `Send ${pending.length}`;
    sendBtn.title = t('tSend');
    sendBtn.disabled = pending.length === 0;
    copyBtn.textContent = t('copy');
    copyBtn.disabled = pending.length === 0;
    updatePanel();
    if (!pending.length) { listEl.innerHTML = `<div class="empty">${esc(t('empty'))}</div>`; repositionPins(); return; }
    listEl.innerHTML = '';
    pending.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cursor = 'pointer';
      row.title = t('tEdit');
      let head;
      if (p.component) head = `<span class="cmp">&lt;${esc(p.component)}&gt;</span>`;
      else if (p.kind === 'region') head = `▦ region ${p.rect.w}×${p.rect.h}`;
      else head = esc(p.selector || '');
      const src = p.source ? ' · ' + esc(p.source.split('/').pop()) : '';
      row.innerHTML = `<span class="pinno">${i + 1}</span><div style="flex:1"><div class="sel">${head}${src}${p.screenshot ? ' 📷' : ''}</div><div class="nt"></div></div><span class="x" title="${esc(t('tRemove'))}">✕</span>`;
      row.querySelector('.nt').textContent = p.note;
      row.querySelector('.x').addEventListener('click', (ev) => { ev.stopPropagation(); pending.splice(i, 1); renderList(); });
      row.addEventListener('click', (ev) => { if (ev.target.classList.contains('x')) return; editAnnotation(i, ev); });
      listEl.appendChild(row);
    });
    repositionPins();
  }

  // ---- on-page numbered pins + inline edit --------------------------------
  function repositionPins() {
    pinsEl.innerHTML = '';
    pending.forEach((p, i) => {
      if (!p.pin) return;
      const d = document.createElement('div');
      d.className = 'pin';
      d.textContent = i + 1;
      d.title = p.note || t('noNote');
      d.style.left = (p.pin.px - window.scrollX) + 'px';
      d.style.top = (p.pin.py - window.scrollY) + 'px';
      d.addEventListener('click', (ev) => { ev.stopPropagation(); editAnnotation(i, ev); });
      pinsEl.appendChild(d);
    });
  }
  function editAnnotation(i, e) {
    const p = pending[i];
    if (!p) return;
    const head = p.component ? `<span class="cmp">&lt;${esc(p.component)}&gt;</span> ` : '';
    const label = head + esc(p.source || p.selector || (p.kind === 'region' ? `region ${p.rect.w}×${p.rect.h}` : ''));
    openNotePopup(label, e, (note) => { p.note = note; renderList(); }, p.note);
  }

  async function send() {
    if (!pending.length) return;
    if (DEMO) { pending.length = 0; renderList(); toast(t('demoSent')); return; }
    const annotations = pending.map(({ _el, ...rest }) => rest);
    // No target ⇒ the body is byte-for-byte today's (a bare array). A target adds
    // the new optional key beside the items, which is what the daemon reads; a
    // daemon without routing reads `annotations` exactly as before and ignores it.
    const body = targetSid ? { annotations, targetSession: targetSid } : annotations;
    try {
      const res = await fetch(ENDPOINT + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      pending.length = 0;
      renderList();
      // The POST response is the only authoritative receipt (§8.3): what the
      // pre-send row showed is a plan, this is what happened.
      const sid = j.target || targetSid;
      if (j.routed === 'session') toast(t('sentTo')(j.received, sid, sessionLabel(sid)));
      else if (j.routed === 'broadcast' && j.degraded) {
        forgetTarget(sid);   // that lease is gone; stop prefilling a target that cannot route
        toast(t('sentDeg')(sid), true, { label: t('retarget'), run: openTargetPicker });
      } else if (j.routed === 'broadcast') toast(t('sentBc')(j.received));
      else toast(t('sent')(j.received));   // pre-routing daemon: today's wording, unchanged
    } catch (err) {
      toast(t('sendFail') + err.message, false);
    }
  }

  // ---- copy to clipboard (no daemon / agent needed — paste anywhere) -----
  function clipboardText() {
    const lines = [t('copyIntro'), ''];
    pending.forEach((p, i) => {
      let head;
      if (p.component) head = `<${p.component}>` + (p.source ? ` — ${p.source}` : '');
      else if (p.kind === 'region') head = `region ${p.rect.w}×${p.rect.h}` + (p.source ? ` — ${p.source}` : '');
      else head = p.selector || '(element)';
      lines.push(`${i + 1}. ${head}`);
      if (p.note) lines.push(`   ${p.note}`);
      if (p.kind === 'region' && p.elements && p.elements.length) {
        let skipped = false;   // drop the one component already shown as the head
        const els = p.elements
          .filter((e) => {
            if (!skipped && p.component && e.component === p.component) { skipped = true; return false; }
            return true;
          })
          .map((e) => e.component ? `<${e.component}>` : e.selector)
          .filter(Boolean).slice(0, 8);
        if (els.length) lines.push(`   elements: ${els.join(', ')}`);
      }
      lines.push('');
    });
    lines.push(`page: ${location.href}`);
    return lines.join('\n');
  }

  async function copyPending() {
    if (!pending.length) return;
    const text = clipboardText();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(text);
      toast(t('copied')(pending.length));
    } catch {
      // fallback for insecure contexts / older Electron webviews
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        toast(ok ? t('copied')(pending.length) : t('copyFail'), ok);
      } catch { toast(t('copyFail'), false); }
    }
  }

  sendBtn.addEventListener('click', send);
  copyBtn.addEventListener('click', copyPending);
  clearBtn.addEventListener('click', () => { pending.length = 0; renderList(); });

  // ---- toggle (capture mode; the panel itself stays put) -----------------
  function toggle(force) {
    on = force == null ? !on : force;
    document.body.style.cursor = on ? 'crosshair' : '';
    panel.classList.remove('hidden');          // a toggle always reveals the panel
    if (!on) {
      down = null; drawing = false; document.body.style.userSelect = '';
      hlEl.classList.add('hidden'); tagEl.classList.add('hidden'); bandEl.classList.add('hidden'); closePopup();
    }
    renderList();
    toast(on ? t('modeOn') : t('modeOff'));
  }

  atogBtn.addEventListener('click', () => toggle());
  // 迷你钮走同一个 toggle：capture 态、面板显隐、toast 提示全部复用，不另开一条
  // 状态路径。面板被 hideBtn 关掉后，这颗钮是唯一还能把它叫回来的入口。
  miniBtn.addEventListener('click', () => toggle());
  hideBtn.addEventListener('click', () => { if (on) toggle(false); panel.classList.add('hidden'); });
  setBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    updatePanel();
    // The list is derived from the last /sessions snapshot, and nothing re-renders
    // it while it is closed — so opening it must render, or the user sees the
    // (empty) list from boot even though the destination row already knows better.
    if (settingsOpen) renderSettings();
  });

  // ---- settings (routing + language + shortcuts) --------------------------
  // Routing first: it is the only thing here that changes on its own. The list is
  // what the daemon reports — freshness, never an alive/dead verdict (§6.3).
  function sessionsHtml() {
    const rows = [];
    // Why the list is otherwise empty: a daemon that cannot answer /sessions at all.
    if (!sessions.length) rows.push(`<div class="smeta">${esc(t('noSession'))}</div>`);
    // The current target is always drawn, even when its session record is gone —
    // a stale target is still the target (§6.3), and the row is where the user
    // sees what is selected (the settings page names it the same way).
    if (targetSid && !sessions.some((s) => s.sessionId === targetSid)) {
      rows.push(`<div class="sessrow on" data-sid="${esc(targetSid)}">` +
        `<span class="sname">${esc(targetSid)}</span><span class="smeta">${esc(t('noLease'))}</span></div>`);
    }
    for (const s of sessions) {
      const stale = s.lastSeenAt > STALE_AFTER;
      const head = [s.agent, s.label].filter(Boolean).map(esc).join(' · ');
      const meta = [
        esc(s.sessionId),
        s.mode ? esc(s.mode) : null,
        esc(fmtSeen(s.lastSeenAt)),
        esc(t('unclaimed')(s.pending || 0)),
        stale ? esc(t('staleWarn')) : null,
      ].filter(Boolean).join(' · ');
      rows.push(`<div class="sessrow${s.sessionId === targetSid ? ' on' : ''}" data-sid="${esc(s.sessionId)}">` +
        `<span class="sname">${head || esc(s.sessionId)}</span><span class="smeta">${meta}</span></div>`);
    }
    // The escape hatch is always on the list: undirected is a first-class choice —
    // including when nothing else is on it, or a target with no records left could
    // never be cleared from the panel.
    rows.push(`<div class="sessrow${targetSid ? '' : ' on'}" data-sid="">` +
      `<span class="sname">${esc(t('pickBc'))}</span></div>`);
    return rows.join('');
  }
  function renderSettings() {
    const g = t('g');
    const claim = lastClaim && lastClaim.at
      ? [
          lastClaim.sessionId ? lastClaim.sessionId : null,
          fmtSeen(Math.floor((Date.now() - lastClaim.at) / 1000)),
          Number.isFinite(lastClaim.count) ? t('notes')(lastClaim.count) : null,
        ].filter(Boolean).map(esc).join(' · ')
      : '—';
    settingsEl.innerHTML =
      `<div class="setgt">${esc(t('sessions'))}</div>` +
      `<div class="sesslist">${sessionsHtml()}</div>` +
      `<div class="claimrow"><span class="langlabel">${esc(t('lastClaim'))}</span>` +
      `<span class="smeta">${claim}</span></div>` +
      `<div class="setdiv"></div>` +
      `<div class="setgt">${esc(t('shortcuts'))}</div>` +
      `<div class="guide">` +
      g.map(([k, d]) => `<kbd class="gkey">${esc(k)}</kbd><span class="gdesc">${esc(d)}</span>`).join('') +
      `</div>` +
      `<div class="setdiv"></div>` +
      `<div class="setrow"><span class="langlabel">${esc(t('theme'))}</span>` +
      `<span class="seg2">` +
      `<button data-tm="dark" class="${theme === 'dark' ? 'on' : ''}">${esc(t('dark'))}</button>` +
      `<button data-tm="light" class="${theme === 'light' ? 'on' : ''}">${esc(t('light'))}</button>` +
      `</span></div>` +
      `<div class="setrow"><span class="langlabel">${esc(t('lang'))}</span>` +
      `<span class="seg2">` +
      `<button data-l="zh" class="${lang === 'zh' ? 'on' : ''}">中文</button>` +
      `<button data-l="en" class="${lang === 'en' ? 'on' : ''}">English</button>` +
      `</span></div>` +
      `<div class="setrow"><span class="langlabel">${esc(t('miniBtn'))}</span>` +
      `<span class="seg2">` +
      `<button data-mb="1" class="${miniOn ? 'on' : ''}">${esc(t('miniShow'))}</button>` +
      `<button data-mb="0" class="${miniOn ? '' : 'on'}">${esc(t('miniHide'))}</button>` +
      `</span></div>`;
    settingsEl.querySelectorAll('[data-sid]').forEach((r) =>
      r.addEventListener('click', () => setTarget(r.dataset.sid)));
    settingsEl.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.l)));
    settingsEl.querySelectorAll('[data-tm]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.tm)));
    settingsEl.querySelectorAll('[data-mb]').forEach((b) => b.addEventListener('click', () => setMini(b.dataset.mb === '1')));
  }
  function setMini(v) {
    miniOn = v;
    miniBtn.classList.toggle('hidden', !v);
    try { localStorage.setItem('__vibepin_mini', v ? '1' : '0'); } catch { /* ignore */ }
    renderSettings();
  }
  function setLang(l) {
    lang = l;
    try { localStorage.setItem('__vibepin_lang', l); } catch { /* ignore */ }
    applyI18n();
  }
  function setTheme(tm) {
    theme = tm;
    root.setAttribute('data-theme', tm);
    try { localStorage.setItem('__vibepin_theme', tm); } catch { /* ignore */ }
    renderSettings();
  }
  function applyI18n() {
    pheadEl.querySelector('.grip').title = t('tDrag');
    statusEl.title = t('tStatus');
    atogBtn.title = t('tAnno');
    miniBtn.title = t('tMini');
    setBtn.title = t('tSettings');
    hideBtn.title = t('tHide');
    renderSettings();
    renderList();   // rows + empty + updatePanel + pins
    checkHealth();  // refresh the status tooltip in the new language
  }

  // ---- drag the panel to reposition (persisted) --------------------------
  const POS_KEY = '__vibepin_pos';
  function clampIntoView() {
    if (panel.style.left === '' && panel.style.top === '') return; // still default right/bottom
    const w = panel.offsetWidth || 300, h = panel.offsetHeight || 40;
    const left = Math.max(4, Math.min(parseFloat(panel.style.left) || 0, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(parseFloat(panel.style.top) || 0, window.innerHeight - h - 4));
    panel.style.left = left + 'px'; panel.style.top = top + 'px';
  }
  function loadPos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
        panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        clampIntoView();                 // a stale/off-screen saved pos gets pulled back in
      }
    } catch { /* ignore */ }
  }
  // if the window shrinks below the panel's position, keep it reachable
  window.addEventListener('resize', clampIntoView);
  // pins are page-anchored — keep them under their elements while scrolling/resizing
  window.addEventListener('scroll', repositionPins, true);
  window.addEventListener('resize', repositionPins);

  // ---- daemon connection indicator, provenance, and the effective target ---
  // Two lines, two different truths, never merged (spec §8.3):
  //   line 1 = the inbox the daemon reports — provenance, and the only evidence a
  //            note cannot land in another project;
  //   line 2 = who this batch goes to right now, derived from GET /sessions.
  // The target is a *client-side prefill* (§5.2): the daemon is told explicitly,
  // nothing is inferred, and the POST response is what the toast reports.
  // Freshness is display-only (§6.3) — a stale target is labelled, never dropped,
  // because staleness is not a delivery rule and must never become one.
  const STALE_AFTER = 900;                 // seconds ≈ one work round, spec §6.3
  const TARGET_KEY = '__vibepin_target';   // { <inbox>: <sid> } — per project

  function storedTargets() {
    try { return JSON.parse(localStorage.getItem(TARGET_KEY) || '{}') || {}; } catch { return {}; }
  }
  function rememberTarget(sid) {
    if (!inboxPath) return;
    const map = storedTargets();
    if (sid) map[inboxPath] = sid; else delete map[inboxPath];
    try { localStorage.setItem(TARGET_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  }
  const sessionById = (sid) => sessions.find((s) => s.sessionId === sid) || null;
  const sessionLabel = (sid) => { const s = sessionById(sid); return s && s.label ? s.label : ''; };

  function resolveTarget() {
    const stored = inboxPath ? storedTargets()[inboxPath] : '';
    if (stored) { targetSid = stored; targetPinned = true; return; }
    // Exactly one session ⇒ free of charge: prefill *explicitly*, visibly, and
    // undoably. Zero or several ⇒ broadcast — never a guess.
    if (sessions.length === 1) { targetSid = sessions[0].sessionId; targetPinned = false; return; }
    targetSid = ''; targetPinned = false;
  }
  // Picking is sticky on purpose (spec §5.2): choose once per project.
  function setTarget(sid) {
    targetSid = sid || '';
    targetPinned = !!targetSid;
    rememberTarget(targetSid);
    renderDest();
    if (settingsOpen) renderSettings();
  }
  function forgetTarget(sid) {
    if (!sid || sid !== targetSid) return;
    rememberTarget('');
    resolveTarget();
    renderDest();
    if (settingsOpen) renderSettings();
  }
  function openTargetPicker() {
    settingsOpen = true;
    updatePanel();
    renderSettings();
    try { settingsEl.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  }

  function paintProvenance(dest) { destPathEl.textContent = '→ ' + dest; destPathEl.title = dest; }
  function fmtSeen(sec) {
    if (!Number.isFinite(sec)) return '';
    if (sec < 60) return t('justNow');
    if (sec < 3600) return t('minAgo')(Math.floor(sec / 60));
    return t('hourAgo')(Math.floor(sec / 3600));
  }
  function renderDest() {
    const s = sessionById(targetSid);
    let text;
    if (!targetSid) {
      text = sessions.length ? t('bcAll')(sessions.length) : t('bcNone');
    } else {
      // Why this target, not which label it carries: the label already rides the
      // receipt and the session list, and §8.3's row names the reason.
      const why = targetPinned ? t('defTarget') : t('onlyOne');
      const stale = s && s.lastSeenAt > STALE_AFTER ? ` · ${t('staleIn')(Math.floor(s.lastSeenAt / 60))}` : '';
      text = t('targetOf')(targetSid, why) + stale;
    }
    destTargetEl.textContent = t('targetLine')(text);
    destTargetEl.title = t('tPickTarget');
    destTargetEl.classList.toggle('stale', !!(s && s.lastSeenAt > STALE_AFTER));
    updatePanel();   // the undirected-with-several-sessions hint follows the target
  }
  destTargetEl.addEventListener('click', openTargetPicker);

  // GET /sessions is read-only and may simply not exist (pre-routing daemon):
  // then there are no sessions, no target is ever sent, and the overlay behaves
  // exactly as it did before — the old-daemon contract is "broadcast", not an error.
  async function fetchSessions() {
    try {
      const r = await fetch(ENDPOINT + '/sessions', { cache: 'no-store' });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && Array.isArray(j.sessions)) { sessions = j.sessions; lastClaim = j.lastClaim || null; }
      else { sessions = []; lastClaim = null; }
    } catch { sessions = []; lastClaim = null; }
    resolveTarget();
    renderDest();
    if (settingsOpen) renderSettings();
  }
  // Both views ride the existing 10s poll — one interval, no extra timer (§8.3).
  async function checkHealth() {
    try {
      const r = await fetch(ENDPOINT + '/health', { cache: 'no-store' });
      statusEl.classList.toggle('ok', r.ok);
      statusEl.title = r.ok ? t('sOk') : t('sNoResp');
      if (r.ok) {
        const info = await r.json().catch(() => null);
        if (info && typeof info.inbox === 'string' && info.inbox && info.inbox !== inboxPath) {
          inboxPath = info.inbox;
          paintProvenance(info.inbox);
        }
      }
    } catch {
      statusEl.classList.remove('ok');
      statusEl.title = t('sNo');
    }
    await fetchSessions();
  }
  if (DEMO) { statusEl.style.display = 'none'; destEl.style.display = 'none'; }   // no daemon → no destination to name
  else { checkHealth(); setInterval(checkHealth, 10000); }
  pheadEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;    // buttons aren't drag handles
    const r = panel.getBoundingClientRect();
    panelDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!panelDrag) return;
    const x = Math.max(4, Math.min(e.clientX - panelDrag.dx, window.innerWidth - panel.offsetWidth - 4));
    const y = Math.max(4, Math.min(e.clientY - panelDrag.dy, window.innerHeight - panel.offsetHeight - 4));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  }, true);
  document.addEventListener('mouseup', () => {
    if (!panelDrag) return;
    panelDrag = null;
    try { localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })); } catch { /* ignore */ }
  }, true);

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', (e) => {
    // e.code (physical key) not e.key — on macOS Option+A emits 'å', breaking e.key.
    if (e.altKey && e.code === 'KeyA') { e.preventDefault(); toggle(); }
    else if (e.key === 'Escape' && on && !pop && !drawing) toggle(false);
  }, true);

  loadPos();
  paintProvenance(ENDPOINT);   // replaced by the daemon's inbox once /health answers
  renderDest();                // target row starts as "broadcast" — nothing is claimed yet
  window.__vibepin = {
    toggle, pending, endpoint: ENDPOINT, setLang, setTarget,
    route: () => ({ sessions: sessions.map((s) => s.sessionId), target: targetSid, pinned: targetPinned, lastClaim }),
    // Read-only snapshot for out-of-page callers (the browser extension's toolbar
    // popup runs in the main world and must not have to reach into the shadow DOM
    // to learn whether capture is on).
    state: () => ({ on, lang, theme, mini: miniOn, target: targetSid, pending: pending.length, inbox: inboxPath }),
  };
  applyI18n();   // sets all text/titles for the current language + first render
  console.log('[vibepin] overlay ready — floating panel; ⌥A toggle · click=element, drag=region. endpoint:', ENDPOINT);})();
