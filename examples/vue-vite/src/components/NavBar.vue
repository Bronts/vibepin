<script setup>
const links = ['Docs', 'Examples', 'Pricing'];
</script>

<template>
  <header class="nav">
    <span class="brand">vibepin<span class="dot">•</span></span>
    <nav class="links">
      <a v-for="l in links" :key="l" href="#">{{ l }}</a>
    </nav>
  </header>
</template>

<style scoped>
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 32px;
  border-bottom: 1px solid var(--line);
}
.brand { font-weight: 700; letter-spacing: -0.01em; }
.dot { color: var(--accent); margin-left: 2px; }
.links { display: flex; gap: 20px; }
.links a { color: var(--muted); text-decoration: none; font-size: 14px; }
.links a:hover { color: var(--text); }
</style>
