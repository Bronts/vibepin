<script setup>
const stats = [
  ['0', 'runtime deps in the overlay'],
  ['2', 'frameworks: React + Vue'],
  ['1', 'line of config'],
];
</script>

<template>
  <section class="hero">
    <p class="eyebrow">Vue 3 · Vite</p>
    <h1 class="title">Point at the UI. The agent edits the .vue file.</h1>
    <p class="lede">
      Click any element, write what should change, send. The pin carries the
      component name and the source file it came from.
    </p>
    <div class="cta">
      <button class="primary">Get started</button>
      <button class="ghost">Read the docs</button>
    </div>
    <ul class="stats">
      <li v-for="[n, label] in stats" :key="label">
        <strong>{{ n }}</strong><span>{{ label }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.hero { padding: 56px 0 40px; max-width: 720px; }
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin: 0 0 12px;
}
.title { font-size: 42px; line-height: 1.12; margin: 0 0 16px; letter-spacing: -0.02em; }
.lede { color: var(--muted); font-size: 16px; line-height: 1.6; margin: 0 0 24px; }
.cta { display: flex; gap: 12px; }
.cta button { font-size: 14px; padding: 10px 18px; border-radius: 8px; cursor: pointer; border: 1px solid var(--line); }
.primary { background: var(--accent); color: #161300; border-color: transparent; font-weight: 600; }
.ghost { background: transparent; color: var(--text); }
.stats { list-style: none; display: flex; gap: 32px; padding: 0; margin: 36px 0 0; }
.stats li { display: flex; flex-direction: column; gap: 4px; }
.stats strong { font-size: 22px; }
.stats span { color: var(--muted); font-size: 12px; }
</style>
