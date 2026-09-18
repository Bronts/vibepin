<script setup>
import FeatureTile from './FeatureTile.vue';

const features = [
  { tone: 'a', title: 'Point at the element', body: 'Click it. The overlay reads the component that rendered it.' },
  { tone: 'b', title: 'Write the change', body: 'One sentence is enough — the pin carries the context.' },
  { tone: 'c', title: 'The agent edits the SFC', body: 'It opens the .vue file from the pin, not a selector guess.' },
];
</script>

<template>
  <section class="grid">
    <FeatureTile v-for="f in features" :key="f.title" v-bind="f" />
  </section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding-bottom: 56px; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
</style>
