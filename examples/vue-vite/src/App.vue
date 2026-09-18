<script setup>
import NavBar from './components/NavBar.vue';
import HeroCard from './components/HeroCard.vue';
import FeatureGrid from './components/FeatureGrid.vue';
import SiteFooter from './components/SiteFooter.vue';
</script>

<template>
  <NavBar />
  <main class="wrap">
    <HeroCard />
    <FeatureGrid />
  </main>
  <SiteFooter />
</template>
