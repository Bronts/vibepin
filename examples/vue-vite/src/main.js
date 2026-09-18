import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

// In dev the vibepin Vite plugin injects the real overlay (wired to the daemon)
// and exposes the project root for source-path resolution. A production build
// has no daemon, so load the overlay in DEMO mode: pin/drag still work, Send
// just pops a toast.
if (import.meta.env.PROD) {
  window.__vibepinDemo = true;
  import('vibepin/overlay');
}
