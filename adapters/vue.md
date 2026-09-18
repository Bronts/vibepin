# Vue 3 integration

Vue needs no adapter of its own — the same Vite plugin you already use for React
covers it:

```js
// vite.config.js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vibepin from 'vibepin/vite';

export default defineConfig({
  plugins: [vue(), vibepin()],
});
```

`vibepin()` starts the daemon and injects the overlay in dev; it also exposes the
project root to the page (`window.__vibepinRoot`) so a Vue source path can be
turned into an absolute one for your agent. Production builds are untouched.

## What a pin carries

| Setup | `component` | `source` |
| --- | --- | --- |
| `vue()` + `vibepin()` | ✅ nearest SFC that owns the element | ✅ **absolute** `.vue` path |
| … plus `vite-plugin-vue-inspector` | ✅ | ✅ **path:line:column** |

So the baseline (no extra plugin) already gives `<HeroCard> /abs/src/components/HeroCard.vue`.
Install the inspector only if you want the line/column too:

```bash
npm i -D vite-plugin-vue-inspector

# vite.config.js
import Inspector from 'vite-plugin-vue-inspector';
plugins: [vue(), Inspector(), vibepin()],
```

```jsonc
// .vibepin/inbox.jsonl — one annotation
{ "kind": "element", "component": "HeroCard",
  "source": "D:/app/src/components/HeroCard.vue:12:5", "note": "make the title shorter" }
```

Without the inspector the overlay returns the file only; with it, file + position.
Neither changes the payload shape, the daemon, or the MCP/watch side.

## How it is resolved

1. **Runtime instance tree** (always, no config). Vue stamps every node it renders
   with the instance that produced it (`el.__vueParentComponent`). The overlay walks
   up from the pinned element and takes the nearest instance whose type has a
   `__file`, using its `__name` (or the file's basename) as the component name.
   `__file` is absolute in Vite dev; a project-relative `/src/…` form is resolved
   against `window.__vibepinRoot`.
2. **`data-v-inspector`** (only with the inspector). The plugin stamps
   `file:line:col`; the overlay prefers it for `source`.

Details worth knowing:

- **Component libraries are skipped, not reported.** Element Plus (and any other
  dependency) ships compiled components whose type has no `__file` — an `el-button`
  chain reads `button` → `ToolbarPanel` → `App`, and a dropdown can go 17 levels
  deep. The walk therefore stops at the nearest component *of your app*: clicking
  an `el-dropdown` item or an `el-button` inside your panel yields
  `<AISettingsRolePanel>` / `<ToolbarPanel>` — never `<ElButton>`.
  `node_modules` paths are dropped and the walk is capped at 24 levels.
  Their elements get the component and file, but no line: line/column comes from
  *your* SFC's compiled template, and a prebuilt library never had one stamped.
- **Static content still resolves.** The Vue compiler inlines a run of static
  siblings into one HTML string (`_createStaticVNode`), so those elements have no
  runtime instance of their own (no `__vnode` either — verified: 32 of 38 elements
  on `examples/vue-vite` have one). The overlay falls back to the nearest ancestor
  element that has one, which is the component that owns the block.
- **Two independent channels for the inspector.** The plugin's visible
  `data-v-inspector` attribute survives only on the elements it inlined into a
  static HTML string; for every other element its runtime moves the value onto a
  hidden `__v_inspector` vnode prop (the attribute is deleted, so it never reaches
  the DOM). The overlay reads both. Measured on a copy of `examples/vue-vite` with
  `vite-plugin-vue-inspector@7.0.0` added: attribute alone covers **6/38 elements
  (15.8 %)**, hidden prop covers **32/38 (84.2 %)**, the two are disjoint, and the
  union is **38/38 (100 %)** — reading only the attribute would have shown a line
  number for one element in six.
- **Production builds have no detection.** Vue compiles `__file`/`__name` away, so
  a built page falls back to the CSS selector (the overlay's demo mode does the
  same deliberately).
- **The inspector's path is relative to the process cwd**, and the overlay resolves
  it against the project root (`window.__vibepinRoot`). Running
  `vite --root packages/app` from a monorepo root can therefore duplicate the
  prefix on stamped lines; the runtime channel (`__file`) is absolute and is not
  affected.
- **Non-Vite setups** (Nuxt, Vue CLI, webpack) work too: runtime `__file` paths are
  already absolute there. If paths show up as `/src/App.vue`, tell the overlay where
  the project lives before it loads:
  `<script>window.__vibepinRoot='C:/path/to/project'</script>`.

## Adding another stack

Detection is a registry of self-guarding detectors, not a Vue/React special case —
see [`frameworks.md`](./frameworks.md) for the contract and the 3 steps a new
framework takes.
