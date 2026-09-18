<script setup>
const year = new Date().getFullYear();
</script>

<template>
  <footer class="foot">
    <span>© {{ year }} vibepin — MIT</span>
    <a href="#">github.com/YIWANG3/vibepin</a>
  </footer>
</template>

<style scoped>
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
}
.foot a { color: var(--muted); text-decoration: none; }
.foot a:hover { color: var(--text); }
</style>
