import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vibepin from 'vibepin/vite';

// vue() compiles the SFCs; every DOM node it renders carries the component
// instance that produced it, and vibepin's overlay reads that — so annotations
// on this app carry the component name and the .vue file, no extra config.
// (Install vite-plugin-vue-inspector too and they also get a line number.)
export default defineConfig({
  plugins: [vue(), vibepin()],
});
