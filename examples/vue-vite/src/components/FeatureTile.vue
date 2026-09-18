<script setup>
defineProps({ tone: { type: String, default: 'a' }, title: String, body: String });
</script>

<template>
  <article class="tile" :data-tone="tone">
    <h3 class="tile-title">{{ title }}</h3>
    <p class="tile-body">{{ body }}</p>
  </article>
</template>

<style scoped>
.tile {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}
.tile-title { margin: 0 0 8px; font-size: 15px; }
.tile-body { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.tile[data-tone='a'] { border-top: 2px solid #f5c518; }
.tile[data-tone='b'] { border-top: 2px solid #6ea8fe; }
.tile[data-tone='c'] { border-top: 2px solid #7ee2a8; }
</style>
