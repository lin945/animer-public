<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const headerQuery = ref('')
const sourceUrl = /^https:\/\//.test(import.meta.env.VITE_SOURCE_URL || '') ? import.meta.env.VITE_SOURCE_URL : 'https://github.com/lin945/animer-public'

function searchFromHeader() {
  const q = headerQuery.value.trim()
  if (q) router.push({ name: 'search', query: { q } })
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <RouterLink class="brand" to="/" aria-label="Animer 首页">
          <span>Animer<small>发现好番，接着看</small></span>
        </RouterLink>
        <nav class="nav" aria-label="主导航">
          <RouterLink to="/" :class="{ on: route.path === '/' && route.hash !== '#recent' }">找番</RouterLink>
          <RouterLink to="/calendar" :class="{ on: route.name === 'calendar' }">新番日历</RouterLink>
          <RouterLink to="/#recent" :class="{ on: route.hash === '#recent' }">继续看</RouterLink>
        </nav>
        <form class="header-search" role="search" @submit.prevent="searchFromHeader">
          <input v-model="headerQuery" aria-label="搜索番剧" placeholder="搜番剧、角色或关键词" />
          <button type="submit" aria-label="提交搜索">搜索</button>
        </form>
      </div>
    </header>

    <main class="content">
      <RouterView v-slot="{ Component, route: current }">
        <keep-alive :max="12">
          <component v-if="!current.meta.sensitive" :is="Component" :key="current.path + JSON.stringify(current.query)" />
        </keep-alive>
        <component v-if="current.meta.sensitive" :is="Component" :key="current.fullPath" />
      </RouterView>
    </main>

    <footer class="footer">Animer <span>·</span> 发现好番，接着看 <span>·</span> <a href="/LICENSE.txt">许可证</a> <a href="/THIRD_PARTY_NOTICES.md">第三方声明</a> <a v-if="sourceUrl" :href="sourceUrl" target="_blank" rel="noopener noreferrer">源码</a></footer>
  </div>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  border-bottom: 1px solid rgba(223, 233, 239, .95);
  background: rgba(255, 255, 255, .94);
  backdrop-filter: blur(14px);
}
.topbar-inner {
  width: min(100% - 48px, 1240px);
  min-height: 72px;
  margin: auto;
  display: flex;
  align-items: center;
  gap: clamp(20px, 3vw, 44px);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: none;
  text-decoration: none;
  color: var(--text);
  font-size: 21px;
  line-height: 1.06;
  font-weight: 800;
  white-space: nowrap;
}
.brand img { width: 44px; height: 44px; border-radius: 13px; }
.brand small { display: block; margin-top: 5px; color: var(--muted); font-size: 10px; font-weight: 500; letter-spacing: .12em; }
.nav { display: flex; align-items: center; gap: 6px; flex: none; }
.nav a {
  padding: 10px 14px;
  border-radius: 10px;
  color: #5c6775;
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.nav a:hover, .nav a.on { background: var(--accent-soft); color: #008cae; }
.header-search {
  display: flex;
  align-items: center;
  max-width: 340px;
  min-width: 190px;
  margin-left: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #f4f7f9;
}
.header-search:focus-within { border-color: var(--accent); background: #fff; }
.header-search input { width: 100%; min-width: 0; padding: 7px 10px; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
.header-search button { padding: 7px 15px; border: 0; border-radius: 9px; background: var(--accent); color: white; font-size: 12px; font-weight: 700; white-space: nowrap; cursor: pointer; }
.content { width: min(100% - 48px, 1240px); margin: 0 auto; padding: 28px 0 70px; }
.footer { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 22px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.footer { flex-wrap: wrap; }.footer a { color: inherit; }.footer span { color: #a6b3bf; }
@media (max-width: 900px) {
  .topbar-inner { gap: 18px; }
  .brand small { display: none; }
  .nav a { padding: 9px 10px; }
}
@media (max-width: 680px) {
  .topbar-inner { width: min(100% - 28px, 1240px); min-height: 66px; gap: 8px; flex-wrap: wrap; padding: 9px 0; }
  .brand { font-size: 17px; }.brand img { width: 37px; height: 37px; }
  .nav { margin-left: auto; gap: 0; }.nav a { padding: 8px; font-size: 12px; }
  .header-search { order: 3; width: 100%; max-width: none; margin: 0; }
  .content { width: min(100% - 28px, 1240px); padding-top: 16px; }
}
</style>

