# vibepin browser extension

A **no-build MV3 unpacked extension** that puts the vibepin overlay into *your* everyday
Chrome or Edge — no Vite plugin, no dependency in the project you're annotating. Same
`extension/` folder for both browsers.

What it does is one line, the same one the [README](../README.md) documents for pages you
don't own:

```html
<script src="http://127.0.0.1:7331/annotate.js"></script>
```

The overlay derives its endpoint from its own `<script src>`, so the injected src *is* the
configuration. The extension finds the daemon, injects that tag, and stops.

- **Port discovery** — a daemon that found 7331 busy takes the next free port (up to 7370,
  see `adapters/vite.js`), so the extension probes `127.0.0.1:7331-7370/health` in parallel and
  uses the lowest port that answers as a real daemon (anything else on the port is rejected).
  Worst case, an empty range costs one probe timeout (~1.5s). Pin a port in the settings to
  skip the scan.
- **Local pages only by default** — `http://localhost/*` and `http://127.0.0.1/*`. A
  production site never gets the overlay unless you turn that off and grant it.
- **Idempotent** — a page that already carries the overlay (Vite plugin, bookmarklet, an
  earlier run) is left alone.
- **No daemon → no injection.** One `console.info` line says so; nothing is retried.

## Requirements

A running daemon — the extension only injects; it does not start one:

```bash
npx vibepin daemon              # standalone: overlay + demo + inbox (any project)
```

or just run a dev server with the Vite plugin (`import vibepin from 'vibepin/vite'`), which
spawns its own daemon pointed at that project's inbox.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this `extension/` folder (the one containing `manifest.json`).
5. Optional: open the puzzle-piece toolbar menu and **pin** "vibepin overlay" so the
   settings popup is one click away.

## Load it in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked**.
4. Select this `extension/` folder.
5. Edge pins it to the toolbar; **Details → Extension options** opens the same settings page
   as Chrome's **Details → Extension options**.

Neither browser copies the folder — it is read in place, so editing these files and hitting
**Reload** on the extension card is the whole dev loop. Chrome may keep an "unnamed
extension is running in developer mode" notice on startup; that is expected for unpacked
extensions.

## Confirm it works

Start a daemon and a dev server, then open a local page (`http://localhost:5173`,
`http://127.0.0.1:5173`, …) and look at the DevTools console:

```
[vibepin] daemon http://127.0.0.1:7331 — overlay injected (inbox D:/work/app/.vibepin/inbox.jsonl)
[vibepin] overlay ready — floating panel; ⌥A toggle · click=element, drag=region. endpoint: http://127.0.0.1:7331
```

or on one line:

```js
typeof window.__vibepin      // "object"
```

Press **Alt+A** (⌥A) and the panel appears, or click the persistent mini button at the
bottom-right of the page — it is always there, so the hotkey is never the only way in. The
daemon row under the panel title shows the real destination — `→ <inbox path>` — refreshed
from `/health` every 10s.

If the console instead shows:

```
[vibepin] no daemon found — overlay not injected. Nothing on 127.0.0.1:7331-7370. Start one with `npx vibepin daemon` (or the Vite plugin), then reload this page.
```

…the extension is loaded but nothing is listening, which is the intended outcome — start the
daemon and reload. Confirm which port it took from its startup banner or
`curl http://127.0.0.1:7331/health`.

## Toolbar button

Click the toolbar icon and a **mini popup** opens: one big toggle that turns annotate mode on
and off for the tab you are on, the daemon endpoint and inbox, and what the popup can or
cannot do right now.

It talks to the overlay through `chrome.scripting.executeScript({ world: 'MAIN' })`, because
the overlay is a `<script src>` the page loaded — it lives in the page's **main world**, which
the popup's isolated world cannot read. Reading prefers the overlay's own `state()` and only
falls back to sniffing the shadow DOM, so a page served by an older daemon still shows a
truthful button instead of a dead one.

| Popup state | What it says |
|---|---|
| green dot, **开启标注** / **关闭标注** | Daemon found and the page has the overlay. Click to toggle. |
| green dot, **此页未注入** | The daemon is up but this page never loaded the overlay. **重新注入** adds the tag now (settings changes still need a reload). |
| red dot, **此页未注入** | No daemon on 7331-7370. Start one with `npx vibepin daemon`. |

Toggling while the overlay is *not* loaded is impossible by definition, so the button is
disabled there rather than silently failing.

## Settings

**完整设置** in the popup, or **Details → Extension options** (both open `options.html`):

| Setting | Meaning |
|---|---|
| **Daemon** | The daemon the overlay would use right now — endpoint, inbox, project root, pending count. Re-detected every time the page opens; **Re-detect** probes on demand. |
| **Port** | Pin a fixed port instead of scanning 7331-7370. Empty = scan. Saved per browser profile. |
| **Only on local pages** | On (default): `http://localhost/*` and `http://127.0.0.1/*` only. Off: asks for access to all http(s) sites and registers a second content script, so the overlay also runs on staging, a LAN address, or a site you don't own. Nothing is injected anywhere else until you grant it. |

Settings are read when a page loads, so reload open tabs after changing them.

## Zero-install alternative (bookmarklet)

No extension at all — a bookmark whose URL is this, dragged onto the bookmarks bar:

```
javascript:(()=>{const s=document.createElement('script');s.src='http://127.0.0.1:7331/annotate.js';document.body.appendChild(s)})()
```

Click it on any page and the overlay loads (press **Alt+A**). Caveats: the port is hard-coded
in the bookmark, so if the daemon had to move off 7331 it must match — the daemon's startup
banner prints the real URL, and `http://127.0.0.1:7331/health` answers with `port`/`inbox`.
A page with a strict Content-Security-Policy can block it, and it has to be re-clicked on
every navigation. The extension has neither problem.

## Files

| File | |
|---|---|
| `manifest.json` | MV3 manifest: content script on local pages, toolbar popup + options page, minimal permissions. |
| `discover.js` | Shared daemon discovery (`/health` probe over 7331-7370). Loaded by the content script, the settings page and the toolbar popup. |
| `inject.js` | Content script: decide, probe, inject the `<script>`, report. |
| `mini.html` / `mini.js` | Toolbar popup: the annotate on/off toggle for the active tab, daemon status, links to re-inject and to the settings page. |
| `options.html` / `options.js` | Settings UI: daemon status, port pin, local-only scope. |
