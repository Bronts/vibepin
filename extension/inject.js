// vibepin — content script. Puts the overlay on your local dev pages without the
// page (or its build) knowing anything about vibepin.
//
// It injects exactly the line the README documents for pages you don't own:
//   <script src="http://127.0.0.1:<daemonPort>/annotate.js"></script>
// The overlay reads its own origin off document.currentScript, so the injected
// src IS the daemon endpoint — there is nothing else to configure.

(() => {
  const LOG = '[vibepin]';
  const SCRIPT_ID = '__vibepin_overlay';
  const D = globalThis.VibepinDiscovery;

  (async () => {
    // Idempotent: the overlay itself (or the Vite plugin, or a second run of this
    // script) already put it on the page. Re-injecting would double the panel.
    if (window.__vibepin || document.getElementById(SCRIPT_ID)) return;

    const { port = null, localOnly = true } = await chrome.storage.local.get({ port: null, localOnly: true });

    // Default posture: local dev pages only — a production site never gets the
    // overlay behind your back. Off (opt-in, settings) reaches every http(s) page.
    if (localOnly && !D.isLocalHost(location.hostname)) return;

    const hit = await D.discover(port);
    if (!hit) {
      console.info(
        `${LOG} no daemon found — overlay not injected.` +
        (port ? ` Nothing answering on the pinned port ${port}.` : ` Nothing on 127.0.0.1:${D.FIRST_PORT}-${D.LAST_PORT}.`) +
        ` Start one with \`npx vibepin daemon\` (or the Vite plugin), then reload this page.`
      );
      return;
    }

    // The page may have grown the overlay while we were probing.
    if (window.__vibepin || document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = D.overlaySrc(hit.port);
    script.defer = true;                       // async by insertion; defer keeps the intent
    (document.head || document.documentElement).appendChild(script);

    console.info(`${LOG} daemon ${D.origin(hit.port)} — overlay injected (inbox ${hit.inbox})`);
  })().catch((e) => console.info(`${LOG} overlay not injected:`, e));
})();
