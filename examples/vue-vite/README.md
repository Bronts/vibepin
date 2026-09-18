# Vue 3 example — component-aware annotations

A minimal Vue 3 + Vite app that exists to prove the overlay resolves
**component name + source file** in a Vue project.

```bash
npm install
npm run dev      # vite + vue + vibepin daemon, all in one
```

Open the printed URL. Then:

1. **⌥A** (Option+A) → annotate mode.
2. **Click** the headline, a stat, a feature tile — the popup shows e.g.
   `<HeroCard> D:/…/examples/vue-vite/src/components/HeroCard.vue` or
   `<FeatureTile> D:/…/src/components/FeatureTile.vue`.
   The tiles are rendered *by* `FeatureGrid` through a child component, so a
   click on tile text resolves to `FeatureTile`, not to the grid.
3. **Drag** a box over the three tiles — the region lists the components inside.
4. Type a note → **Add** → **Send**. It lands in `.vibepin/inbox.jsonl` with the
   `component` / `source` fields filled in.

Dev only: the plugin has `apply: 'serve'`. A `npm run build && npm run preview`
page loads the overlay in demo mode (`__vibepinDemo`), where framework detection
is skipped and pins fall back to a CSS selector — production Vue compiles the
`__file` info away.

## How the source info is obtained

Two sources, no extra plugin required for the first one:

- **Runtime instance tree** (always): Vue stamps every rendered DOM node with
  `__vueParentComponent`. The overlay walks up from the pinned element to the
  nearest component whose type has a `__file` outside `node_modules` and uses its
  `__name` + `__file`. This is what makes component names work with zero config;
  it does not give a line number.
- **`data-v-inspector`** (optional): if you also install
  `vite-plugin-vue-inspector`, traced elements carry `file:line:col`, and the
  overlay prefers that value for `source`.

See `../../adapters/vue.md` for the setup guide and the caveats (Element Plus
internals, line numbers, coverage of the `data-v-inspector` attribute).

## Claude Code side

> Background-run `../../daemon/watch.js --inbox $PWD/.vibepin/inbox.jsonl`;
> on exit run `../../daemon/claim.js --inbox $PWD/.vibepin/inbox.jsonl`,
> apply each annotation (use its `source`/`component` to open the right `.vue`), re-arm.

Or use MCP watch mode (see the root README).
