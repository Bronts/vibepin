# How framework detection works (and how to add a stack)

The overlay is framework-agnostic: it is a static script served by the daemon, it
imports nothing, and it feeds the same `{ component, source }` fields into every
annotation regardless of the stack. Support for a stack is one **detector** in a
registry inside `core/annotate.js`.

## The registry

```js
// core/annotate.js
const FRAMEWORK_DETECTORS = [domAttributeInfo, reactInfo, vueInfo];
//                                                 ↑ future: svelteInfo, solidInfo, angularInfo…

function frameworkInfo(el) {
  if (DEMO) return null;               // production bundles: selectors only
  let component = null, source = null;
  for (const detect of FRAMEWORK_DETECTORS) {
    const r = detect(el);
    if (!r) continue;
    if (!component && r.component) component = r.component;   // first non-empty wins…
    if (!source && r.source) source = r.source;               // …independently, per field
    if (component && source) break;
  }
  return (component || source) ? { component, source } : null;
}
```

Rules that keep this cheap and composable:

- **Contract.** A detector is `(el) => ({ component, source } | null)`. Either field
  may be `null`, and `null` means "this stack isn't here" — the registry then just
  tries the next one. Nothing throws; a missing signature returns early.
- **Self-guarding signature.** Every detector checks for its own runtime fingerprint
  before walking anything, so a page of another stack costs one property read:
  `__reactFiber$`/`__reactInternalInstance$` (React), `__vueParentComponent` (Vue),
  `__svelte_meta` (Svelte), `__$owner` (Solid), `window.ng.getComponent` (Angular).
- **Per-field filling.** `component` and `source` are filled independently, first
  non-empty wins. That is what makes mixed trees work: a React island inside a Vue
  shell resolves to the React component for `component` while Vue can still supply a
  file, and vice versa.
- **Order = specificity.** Explicit DOM stamps (`domAttributeInfo`) first, then the
  runtime detectors.
- **Consumers.** Three call sites use `frameworkInfo(el)` — region sampling
  (`elementsInRect`), the hover label (`onMove`), and the element popup
  (`openElementPopup`). They only read `component`/`source`, as do the payload, the
  panel UI, the daemon and the MCP layer. None of them ever needs to change.

## The DOM-attribute table

Dev inspector plugins stamp the info onto the DOM, which needs no runtime signature
at all. That is one table row per plugin, not a branch per stack:

```js
const DOM_SOURCE_ATTRS = [
  ['data-source', (v) => v],                        // react-dev-inspector
  ['data-inspector-relative-path', (v, host) => {…}],  //   "  (+ data-inspector-line)
  ['data-v-inspector', vueTraceSource],             // vite-plugin-vue-inspector (file:line:col)
];
const DOM_COMPONENT_ATTRS = ['data-component', 'data-inspector-component'];
```

`domAttributeInfo` walks `el.closest('[attr]')` for each row, fills `source` from the
first match and `component` from the first component-key match — independently, as
above. A stack can therefore contribute **only** an attribute row if its plugin is
installed (nothing else needed).

A DOM stamp is passed through **verbatim**: `data-source` and
`data-inspector-relative-path` (+ `data-inspector-line`) reach the payload exactly as
the plugin wrote them, with no project root prepended — a relative stamp stays
relative. Only the Vue row (`data-v-inspector`) is normalised: `vueTraceSource` sends
it through `normVuePath()`, which resolves a project-relative `/src/…` path against
`window.__vibepinRoot` to an absolute one (same rule as [`vue.md`](./vue.md)).

## Adding a stack: what actually changes

Say Svelte 5 — `el.__svelte_meta` gives `{ loc: { file, line, column } }` and the
component name is not on the element. Three edits, one file:

| # | Where | Lines |
| --- | --- | --- |
| 1 | a `svelteInfo(el)` detector next to `vueInfo` (signature → name → file → optional line → return contract) | ~12–20 |
| 2 | one entry in `FRAMEWORK_DETECTORS` | 1 |
| 3 | a row in `DOM_SOURCE_ATTRS` / `DOM_COMPONENT_ATTRS` **only if** a dev plugin stamps the attribute | 1–3 |

```js
// 1. detector
function svelteInfo(el) {
  const meta = el.__svelte_meta;                       // signature
  if (!meta || !meta.loc) return null;
  const file = normPath(meta.loc.file);                // path helper (as Vue's)
  return file ? { component: baseName(file), source: file + ':' + meta.loc.line } : null;
}
// 2. register
const FRAMEWORK_DETECTORS = [domAttributeInfo, reactInfo, vueInfo, svelteInfo];
```

That is the whole change: **0** edits to the three call sites, **0** to the payload,
panel UI, daemon, adapters or MCP layer, and **0** new dependencies (the overlay
still imports nothing — it may only read page globals and DOM attributes).

For reference, the existing detectors in `core/annotate.js`:
`domAttributeInfo` (~18 lines), `reactInfo` + fiber helpers (~30), `vueInfo` plus its
instance walk, path normalisation and the two inspector channels (~55 with comments).
Vue is the larger one because it resolves project-relative paths itself; a stack
whose tooling already reports absolute paths needs only the detector skeleton above.

## Verifying a new stack

1. Point an example at it and click an element — the hover tag and the popup must
   show `<Component> /abs/path/File.ext[:line:col]` instead of a CSS selector.
2. Send one annotation and check `.vibepin/inbox.jsonl` for `component`/`source`.
3. Re-run a React and a Vue page to prove the registry still fills both fields
   (the detectors are independent, so a new entry can only *add* information).
