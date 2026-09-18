// vibepin — settings (toolbar popup, and the options page from chrome://extensions).
// Shows which daemon the overlay would talk to, lets you pin the port when the
// 7331-7370 auto-scan is not what you want, and controls how far the overlay reaches.
//
// Two more jobs, both about *visibility* (spec §8.4/§8.5): report what the daemon
// knows about sessions, and remember which daemon a site belongs to — with one
// daemon per project, "lowest port wins" can point a page at another project.
//
// 🔴 It never decides who a note goes to. On a file:// page there is no extension
// context at all (manifest.json matches local http only, and there is no page
// origin to key a choice on), so the overlay panel is the only place that can pick
// a session. Everything here is a record: the choice is read back by discovery,
// and the default target is what the panel's own localStorage mirrors.

(() => {
  const D = globalThis.VibepinDiscovery;

  const DEFAULTS = { port: null, localOnly: true };
  const ALL_SITES_ID = 'vibepin-all-sites';
  const ALL_SITES_ORIGINS = ['http://*/*', 'https://*/*'];
  // Two remembered choices with one shape — { <key>: <value> } in
  // chrome.storage.local, never localStorage (that belongs to the page, and a
  // file:// page has no extension to read it). `<key>` is the page origin for the
  // daemon choice, the project inbox for the default target.
  const SITES_KEY = D.SITES_KEY;
  const TARGETS_KEY = 'defaultTarget';
  const STALE_AFTER = 900;         // seconds ≈ one work round, same as the overlay (§6.3)

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status'), endpointEl = $('endpoint'), inboxEl = $('inbox'),
        projectEl = $('project'), pendingEl = $('pending'), msgEl = $('msg'),
        portEl = $('port'), hintEl = $('portHint'), localOnlyEl = $('localOnly'),
        sessionCountEl = $('sessionCount'), candidatesEl = $('candidates'), sitesEl = $('sites'),
        sessionsEl = $('sessions'), targetEl = $('target'), lastClaimEl = $('lastClaim'),
        sessionsNoteEl = $('sessionsNote');

  let cfg = { ...DEFAULTS };
  let hits = [];        // every daemon answering now, lowest port first
  let hit = null;       // the one this page reports on — { port, info }
  let siteMap = {};     // origin → port
  let targetMap = {};   // inbox → sessionId
  let curOrigin = null; // the site this UI is being looked at *for*
  let sessions = [];    // GET /sessions of `hit`; [] = the daemon has no such view
  let lastClaim = null;

  const say = (text, bad) => { msgEl.textContent = text; msgEl.classList.toggle('bad', !!bad); };
  const dash = (v) => (v == null || v === '' ? '—' : String(v));
  // Everything below is built as HTML strings from daemon-supplied values
  // (agent/label/sessionId come out of .vibepin/sessions/*.json), so quotes are
  // escaped too — an attribute is not a text node.
  const esc = (v) => String(v == null ? '' : v)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- shared storage ----------------------------------------------------
  // One helper for both maps: read a key that holds an object, write it back.
  async function getMap(key) {
    try {
      const v = (await chrome.storage.local.get({ [key]: {} }))[key];
      return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
  }
  async function putMap(key, map) {
    try { await chrome.storage.local.set({ [key]: map }); } catch { /* ignore */ }
  }

  // ---- daemon ------------------------------------------------------------
  // The site this UI is being looked at *for*: the active tab while the popup is
  // open, else the first tab that is on an http(s) page. chrome.tabs yields a
  // tab's url when our host permissions cover it (localhost/127.0.0.1 and
  // anything else you granted) — no extra permission is needed for that much.
  async function currentOrigin() {
    try {
      if (!chrome.tabs || !chrome.tabs.query) return null;
      const tabs = await chrome.tabs.query({});
      const pages = tabs.filter((t) => t.url && /^https?:/.test(t.url));
      const tab = pages.find((t) => t.active) || pages[0];
      return tab ? new URL(tab.url).origin : null;
    } catch { return null; }
  }

  // What discovery would pick for this page right now: pinned port, then the
  // site's remembered daemon, then the lowest answering port. Same order as
  // discover() in discover.js — this row must not promise something else.
  function effectivePort() {
    if (cfg.port) return cfg.port;
    if (curOrigin && siteMap[curOrigin]) return siteMap[curOrigin];
    return hits.length ? hits[0].port : null;
  }

  async function rescan() {
    statusEl.innerHTML = '<span class="dot"></span>scanning…';
    statusEl.className = 'v';
    endpointEl.textContent = inboxEl.textContent = projectEl.textContent =
      pendingEl.textContent = sessionCountEl.textContent = '…';
    say('');

    siteMap = await getMap(SITES_KEY);
    targetMap = await getMap(TARGETS_KEY);
    hits = await D.discoverAll(cfg.port);
    hit = hits.find((h) => h.port === effectivePort()) || hits[0] || null;

    renderCandidates();
    renderSites();
    await loadSessions();
    renderSessions();

    if (!hit) {
      statusEl.innerHTML = '<span class="dot bad"></span>no daemon';
      statusEl.className = 'v bad';
      endpointEl.textContent = inboxEl.textContent = projectEl.textContent =
        pendingEl.textContent = sessionCountEl.textContent = '—';
      // The hint is part of the format, not a value: keep it even when nothing answers.
      statusEl.title = `Nothing answered on 127.0.0.1:${D.FIRST_PORT}-${D.LAST_PORT}. Start one with \`npx vibepin daemon\`.`;
      return;
    }

    const info = hit.info;
    statusEl.innerHTML = '<span class="dot ok"></span>connected';
    statusEl.className = 'v ok';
    statusEl.title = D.origin(hit.port);
    endpointEl.textContent = D.origin(hit.port);
    inboxEl.textContent = dash(info.inbox);
    projectEl.textContent = dash(info.projectRoot);
    // pendingTotal = shared inbox + every session queue. Showing the old
    // shared-inbox-only number here would systematically under-report once
    // targeted notes exist (§8.4); `pending` stays as the fallback for a daemon
    // that predates the total.
    pendingEl.textContent = dash(info.pendingTotal != null ? info.pendingTotal : info.pending);
    pendingEl.title = info.pendingTotal != null
      ? 'shared inbox + all session queues'
      : 'shared inbox only — this daemon predates session routing';
    sessionCountEl.textContent = dash(info.sessions != null ? info.sessions : sessions.length);
  }

  function renderCandidates() {
    if (!hits.length) {
      candidatesEl.innerHTML = '<div class="empty">no daemon answering</div>';
      return;
    }
    const eff = hit ? hit.port : null;
    candidatesEl.innerHTML = hits.map((h) => {
      const i = h.info;
      const meta = [
        D.origin(h.port), dash(i.projectRoot), dash(i.inbox),
        `sessions ${dash(i.sessions)}`,
        `pending ${dash(i.pendingTotal != null ? i.pendingTotal : i.pending)}`,
      ].join(' · ');
      // The radio is how the choice is made; without a known origin there is
      // nothing to remember it against, so the row stays a report.
      const box = curOrigin ? `<input type="radio" name="cand" value="${h.port}"${h.port === eff ? ' checked' : ''}>` : '';
      return `<label class="cand${h.port === eff ? ' on' : ''}">${box}<span class="cbody">` +
        `<span class="cname">127.0.0.1:${h.port}</span><div class="cmeta">${esc(meta)}</div></span></label>`;
    }).join('');
    if (!curOrigin) return;
    candidatesEl.querySelectorAll('input[name=cand]').forEach((r) =>
      r.addEventListener('change', () => pickCandidate(Number(r.value))));
  }

  async function pickCandidate(port) {
    if (!curOrigin) return;
    siteMap[curOrigin] = port;
    await putMap(SITES_KEY, siteMap);
    say(`Remembered 127.0.0.1:${port} for ${curOrigin}. Reload that page to apply.`);
    await rescan();
  }

  function renderSites() {
    const origins = [...new Set([...Object.keys(siteMap), ...(curOrigin ? [curOrigin] : [])])];
    if (!origins.length) {
      sitesEl.innerHTML = '<div class="empty">No site known yet — open this popup on the page you want to route, then pick its daemon above.</div>';
      return;
    }
    sitesEl.innerHTML = origins.map((o) => {
      const chosen = siteMap[o] || null;
      const opts = [`<option value=""${chosen ? '' : ' selected'}>Auto (lowest port)</option>`]
        .concat(hits.map((h) => `<option value="${h.port}"${chosen === h.port ? ' selected' : ''}>` +
          `${h.port}${h.info.projectRoot ? ' — ' + esc(h.info.projectRoot) : ''}</option>`))
        // A remembered daemon that is not answering right now must stay visible,
        // or the row would read "Auto" while discovery still prefers that port.
        .concat(chosen && !hits.some((h) => h.port === chosen)
          ? [`<option value="${chosen}" selected>${chosen} — not answering</option>`] : []);
      return `<div class="site"><span class="sname">${esc(o)}${o === curOrigin ? ' · this page' : ''}</span>` +
        `<select data-origin="${esc(o)}">${opts.join('')}</select></div>`;
    }).join('');
    sitesEl.querySelectorAll('select[data-origin]').forEach((s) => s.addEventListener('change', async () => {
      const o = s.dataset.origin;
      if (s.value) siteMap[o] = Number(s.value); else delete siteMap[o];
      await putMap(SITES_KEY, siteMap);
      say(s.value
        ? `Remembered 127.0.0.1:${s.value} for ${o}. Reload that page to apply.`
        : `Auto for ${o} — the lowest answering port wins.`);
      await rescan();
    }));
  }

  // ---- sessions (read-only) ----------------------------------------------
  async function loadSessions() {
    sessions = [];
    lastClaim = null;
    sessionsNoteEl.textContent = '';
    if (!hit) return;
    try {
      const r = await fetch(`${D.origin(hit.port)}/sessions`, { cache: 'no-store' });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && Array.isArray(j.sessions)) {
        sessions = j.sessions;
        lastClaim = j.lastClaim || null;
      } else {
        sessionsNoteEl.textContent = 'This daemon has no /sessions view (pre-routing vibepin) — notes go to the shared inbox and every parked session hears them.';
      }
    } catch {
      sessionsNoteEl.textContent = `Could not read /sessions from ${D.origin(hit.port)}.`;
    }
  }

  function fmtSeen(sec) {
    if (!Number.isFinite(sec)) return '';
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
    return `${Math.floor(sec / 3600)} h ago`;
  }

  function renderSessions() {
    const inbox = hit && typeof hit.info.inbox === 'string' ? hit.info.inbox : '';
    const chosen = (inbox && targetMap[inbox]) || '';
    const listed = sessions.some((s) => s.sessionId === chosen);
    const opts = ['<option value="">Broadcast (no target)</option>']
      .concat(sessions.map((s) => `<option value="${esc(s.sessionId)}"${s.sessionId === chosen ? ' selected' : ''}>` +
        `${esc(s.sessionId)}${s.label ? ' — ' + esc(s.label) : ''}</option>`))
      // A stored default whose record is gone must still be pickable and named as
      // what it is: the daemon would degrade that send to a broadcast.
      .concat(chosen && !listed
        ? [`<option value="${esc(chosen)}" selected>${esc(chosen)} — no lease record</option>`] : []);
    targetEl.innerHTML = opts.join('');
    targetEl.disabled = !inbox;
    targetEl.onchange = async () => {
      if (!inbox) return;
      if (targetEl.value) targetMap[inbox] = targetEl.value; else delete targetMap[inbox];
      await putMap(TARGETS_KEY, targetMap);
      say(targetEl.value
        ? `Recorded ${targetEl.value} as this project's default. It lives here — the overlay panel keeps its own memory and always shows the target before sending.`
        : 'No default target — notes are broadcast to the shared inbox.');
      renderSessions();
    };

    sessionsEl.innerHTML = sessions.length
      ? sessions.map((s) => {
        const head = [s.agent, s.label].filter(Boolean).map(esc).join(' · ');
        const meta = [
          esc(s.sessionId),
          s.mode ? esc(s.mode) : null,
          fmtSeen(s.lastSeenAt),
          `${Number(s.pending) || 0} pending`,
          // Freshness only — never an alive/dead verdict (§6.3). Staleness does
          // not stop a note from being delivered to this session.
          s.lastSeenAt > STALE_AFTER ? 'idle for a while' : null,
        ].filter(Boolean).join(' · ');
        return `<div class="srow${s.sessionId === chosen ? ' on' : ''}">` +
          `<span class="sn">${head || esc(s.sessionId)}</span><span class="sm">${meta}</span></div>`;
      }).join('')
      : '<div class="empty">no sessions</div>';

    lastClaimEl.textContent = lastClaim && lastClaim.at
      ? [
        lastClaim.sessionId || null,
        fmtSeen(Math.floor((Date.now() - lastClaim.at) / 1000)),
        Number.isFinite(lastClaim.count) ? `${lastClaim.count} notes` : null,
      ].filter(Boolean).join(' · ')
      : '—';
  }

  // ---- scope -------------------------------------------------------------
  // "Only on local pages" is not just a flag we remember: with it off, the
  // overlay needs host permissions for every site plus a second, registered
  // content script — so the switch is the thing that grants and registers.
  async function registerAllSites() {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
    if (existing.length) return;
    await chrome.scripting.registerContentScripts([{
      id: ALL_SITES_ID,
      matches: ALL_SITES_ORIGINS,
      excludeMatches: D.LOCAL_MATCHES,     // local pages are already covered statically
      js: ['discover.js', 'inject.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    }]);
  }

  async function dropAllSites() {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] });
  }

  // Make the browser match the stored setting; returns the scope actually in effect.
  async function syncScope() {
    if (cfg.localOnly) { await dropAllSites(); return true; }
    if (!(await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS }))) {
      // The grant is gone (revoked from chrome://extensions) — the settings have to
      // follow reality, or every page load would keep a stale "all sites" state.
      cfg.localOnly = true;
      await dropAllSites();
      await chrome.storage.local.set({ localOnly: true });
      say('Access to other sites is not granted — running on local pages only.', true);
      return true;
    }
    await registerAllSites();
    return false;
  }

  function renderScope(localOnly) {
    localOnlyEl.checked = localOnly;
  }

  localOnlyEl.addEventListener('change', async () => {
    if (localOnlyEl.checked) {                       // back to local pages: drop the reach
      cfg.localOnly = true;
      await chrome.storage.local.set({ localOnly: true });
      await syncScope();
      say('Local pages only. Reload any open page to apply.');
      return;
    }
    // Widen the reach: the prompt must ride this click, so ask before anything else.
    const granted = await chrome.permissions.request({ origins: ALL_SITES_ORIGINS });
    if (!granted) {
      cfg.localOnly = true;
      renderScope(true);
      say('Permission for other sites was not granted — staying on local pages.', true);
      return;
    }
    cfg.localOnly = false;
    await chrome.storage.local.set({ localOnly: false });
    await syncScope();
    say('Overlay enabled on the http(s) sites you granted. Reload any open page to apply.');
  });

  // ---- port --------------------------------------------------------------
  function renderPortHint() {
    hintEl.textContent = cfg.port
      ? `Pinned to ${cfg.port} — the auto-scan (${D.FIRST_PORT}-${D.LAST_PORT}) is off. Leave empty to scan.`
      : `Empty: the lowest answering daemon in ${D.FIRST_PORT}-${D.LAST_PORT} wins, unless a site below remembers one.`;
  }

  $('portForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = portEl.value.trim();
    if (!raw) {
      cfg.port = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return say('Port must be an integer between 1 and 65535.', true);
      cfg.port = n;
    }
    await chrome.storage.local.set({ port: cfg.port });
    renderPortHint();
    say('Saved — reload any open page to apply.');
    await rescan();
  });

  $('rescan').addEventListener('click', () => { say(''); rescan(); });

  // ---- boot --------------------------------------------------------------
  (async () => {
    cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
    curOrigin = await currentOrigin();
    renderScope(await syncScope());
    renderPortHint();
    portEl.value = cfg.port ?? '';
    await rescan();
  })();
})();
