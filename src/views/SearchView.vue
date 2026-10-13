<script setup lang="ts">
import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { bangumiSearch, type BangumiSubject } from '../api'
import { remember } from '../store'
import { formatWatchTime, recentWatches, clearRecentWatches, type RecentWatch } from '../history'

const router = useRouter()
const route = useRoute()
const q = ref('')
const items = ref<BangumiSubject[]>([])
const recent = ref<RecentWatch[]>([])
const loading = ref(false)
const error = ref('')
const searched = ref(false)
const activeTag = ref('')
let searchController: AbortController | null = null
let searchGeneration = 0
let active = true
let resumeSearch = false
function cancelSearch() {
  searchGeneration++
  searchController?.abort()
  searchController = null
  loading.value = false
}
const tags = computed(() => [...new Set(items.value.flatMap((item) => item.tags))].slice(0, 16))
const filteredItems = computed(() => items.value.filter((item) => !activeTag.value || item.tags.includes(activeTag.value)))

function openWatch(it: BangumiSubject) {
  remember(it)
  router.push({ name: 'watch', params: { id: it.id } })
}

function tryKeyword(keyword: string) {
  q.value = keyword
  void doSearch()
}

async function doSearch() {
  const kw = q.value.trim()
  cancelSearch()
  if (!kw || !active) return
  const request = searchGeneration
  const controller = new AbortController()
  searchController = controller
  loading.value = true
  error.value = ''
  searched.value = true
  try {
    const result = await bangumiSearch(kw, controller.signal)
    if (request !== searchGeneration || !active || controller.signal.aborted) return
    items.value = result
    activeTag.value = ''
  } catch (e: unknown) {
    if (request !== searchGeneration || !active || controller.signal.aborted) return
    items.value = []
    error.value = '搜索失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    if (request === searchGeneration) {
      loading.value = false
      searchController = null
    }
  }
}

onMounted(() => {
  recent.value = recentWatches()
  q.value = typeof route.query.q === 'string' ? route.query.q : '鬼灭之刃'
  void doSearch()
})
onActivated(() => {
  active = true
  recent.value = recentWatches()
  if (resumeSearch) { resumeSearch = false; void doSearch() }
})
onDeactivated(() => { resumeSearch = loading.value; active = false; cancelSearch() })
onBeforeUnmount(() => { active = false; cancelSearch() })
</script>

<template>
  <section class="search">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="eyebrow-dot"></span> 发现下一部好番</p>
        <h1 id="hero-title">想看的好番，<br /><em>从这里开始。</em></h1>
        <p class="hero-desc">找番、选集、换线路，一口气看个尽兴。</p>
        <form class="search-bar" role="search" @submit.prevent="doSearch">
          <input v-model="q" aria-label="搜索番剧目录" placeholder="搜索番剧，例如 葬送的芙莉莲" />
          <button type="submit" :aria-busy="loading">{{ loading ? '搜索中…' : '找番剧' }} <span aria-hidden="true">→</span></button>
        </form>
        <div class="quick-search"><span>试试搜</span><button v-for="keyword in ['葬送的芙莉莲', 'Re：从零开始的异世界生活', '鬼灭之刃']" :key="keyword" @click="tryKeyword(keyword)">{{ keyword }}</button></div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <span class="hero-circle"></span><span class="hero-orbit orbit-one"></span><span class="hero-orbit orbit-two"></span>
        <span class="hero-note note-top">今日看什么？</span>
        <span class="hero-mark">番<span>ANIMER</span></span>
        <span class="hero-note note-bottom">留一点时间给好故事 ✦</span>
      </div>
    </section>

    <section id="recent" class="section-block recent-block" aria-labelledby="recent-title">
      <div class="section-head"><div><p class="section-kicker">CONTINUE WATCHING</p><h2 id="recent-title">继续观看</h2></div><span class="section-sub">进度仅保存在当前浏览器 <button v-if="recent.length" @click="clearRecentWatches(); recent = []">清除本机记录</button></span></div>
      <div v-if="recent.length" class="recent-grid">
        <button v-for="row in recent.slice(0, 4)" :key="row.subjectId" class="recent-card" @click="router.push({ name: 'watch', params: { id: row.subjectId } })">
          <div class="recent-cover"><img v-if="row.cover" :src="row.cover" :alt="row.title" loading="lazy" /><span v-else>{{ row.title.slice(0, 1) }}</span></div>
          <div class="recent-info"><span class="recent-caption">{{ row.completed ? '已看完 · 再看一次' : '接着看' }}</span><strong>{{ row.title }}</strong><span class="recent-episode">{{ row.episodeName }} <template v-if="row.position > 0 && !row.completed">· {{ formatWatchTime(row.position) }}</template></span><span class="recent-bar"><i :style="{ width: `${row.completed ? 100 : row.duration > 0 ? Math.min(100, row.position / row.duration * 100) : 0}%` }"></i></span></div>
        </button>
      </div>
      <div v-else class="recent-empty"><span class="empty-mark" aria-hidden="true">▷</span><div><strong>还没有观看记录</strong><p>选一部喜欢的番，下次从这里继续。</p></div></div>
    </section>

    <section class="section-block discover" aria-labelledby="discover-title">
      <div class="section-head"><div><p class="section-kicker">DISCOVER ANIME</p><h2 id="discover-title">搜索结果 <small v-if="searched && !loading">{{ filteredItems.length }} 部</small></h2></div><span class="section-sub">番剧资料来自 Bangumi</span></div>
      <div v-if="tags.length" class="tag-filter" aria-label="按标签筛选"><button :class="{ active: !activeTag }" @click="activeTag = ''">全部</button><button v-for="tag in tags" :key="tag" :class="{ active: activeTag === tag }" @click="activeTag = tag">{{ tag }}</button></div>
      <p v-if="loading" class="result-message">正在找番…</p>
      <div v-else-if="filteredItems.length" class="grid">
        <button v-for="it in filteredItems" :key="it.id" class="card" @click="openWatch(it)">
          <div class="thumb"><img v-if="it.cover" :src="it.cover" :alt="it.name_cn || it.name" loading="lazy" /><span v-else class="ph">{{ (it.name_cn || it.name).slice(0, 1) }}</span><span v-if="it.rating.score" class="rating">★ {{ it.rating.score.toFixed(1) }}</span></div>
          <div class="meta"><h3 :title="it.name_cn || it.name">{{ it.name_cn || it.name }}</h3><p v-if="it.name_cn && it.name && it.name !== it.name_cn" class="native">{{ it.name }}</p><p class="sub">{{ it.eps ? `${it.eps} 集` : '集数待定' }} <span>·</span> {{ it.air_date || '时间待定' }}</p></div>
        </button>
      </div>
      <div v-else class="no-results"><span class="empty-mark" aria-hidden="true">⌕</span><p>{{ error || '没有找到匹配的番剧，换个关键词试试吧。' }}</p></div>
    </section>

  </section>
</template>

<style scoped>
.search { display: grid; gap: 34px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(290px, .75fr); min-height: 330px; overflow: hidden; border: 1px solid #d9edf1; border-radius: 24px; background: linear-gradient(110deg, #e2f8fb 0%, #effaff 48%, #fff3d4 100%); box-shadow: var(--shadow); }
.hero-copy { position: relative; z-index: 1; padding: clamp(26px, 4vw, 50px); }
.eyebrow, .section-kicker { margin: 0 0 14px; color: #008caa; font-size: 12px; font-weight: 800; letter-spacing: .1em; }
.eyebrow-dot { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 50%; background: #ffc342; }
.hero h1 { margin: 0; font-size: clamp(29px, 3vw, 42px); line-height: 1.25; letter-spacing: -.03em; }.hero h1 em { color: #00a3c6; font-style: normal; }
.hero-desc { margin: 14px 0 24px; color: #687888; font-size: 14px; }
.search-bar { display: flex; width: min(100%, 560px); padding: 5px; border: 1px solid #d6e9ed; border-radius: 13px; background: white; box-shadow: 0 8px 18px rgba(32, 97, 113, .08); }
.search-bar:focus-within { border-color: var(--accent); }.search-bar input { flex: 1; min-width: 0; padding: 11px 12px; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 14px; }
.search-bar button { flex: none; padding: 0 20px; border: 0; border-radius: 9px; background: var(--accent); color: white; font-size: 14px; font-weight: 700; cursor: pointer; }.search-bar button span { margin-left: 6px; }
.search-bar button:disabled { opacity: .6; cursor: default; }
.quick-search { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 13px; color: #8999a7; font-size: 11px; }.quick-search button { padding: 4px 8px; border: 0; border-radius: 7px; background: rgba(255,255,255,.6); color: #537481; cursor: pointer; font-size: 11px; }.quick-search button:hover { color: #008ba9; background: white; }
.hero-art { position: relative; display: grid; place-items: end center; min-height: 280px; }.hero-circle { position: absolute; width: 260px; height: 260px; bottom: -30px; border-radius: 50%; background: #ffdf76; box-shadow: 0 0 0 34px rgba(255,255,255,.28); }.hero-mark { position: relative; z-index: 2; align-self: center; color: #317889; font-size: 100px; font-weight: 800; line-height: 1; transform: rotate(-8deg); }.hero-mark span { display: block; font-size: 14px; letter-spacing: .3em; margin-top: 12px; text-align: center; }.empty-mark { display: block; color: #71a6b5; font-size: 52px; line-height: 1.2; }
.hero-orbit { position: absolute; display: block; width: 18px; height: 18px; border-radius: 50%; background: white; opacity: .8; }.orbit-one { top: 30px; left: 24%; }.orbit-two { top: 78px; right: 16%; width: 10px; height: 10px; }
.hero-note { position: absolute; z-index: 3; padding: 10px 13px; border-radius: 12px; background: white; color: #556573; box-shadow: var(--shadow); font-size: 12px; font-weight: 700; }.note-top { top: 42px; right: 12%; transform: rotate(5deg); }.note-bottom { bottom: 26px; left: 5%; transform: rotate(-6deg); }
.section-block { scroll-margin-top: 105px; }.section-head { display: flex; justify-content: space-between; align-items: end; gap: 12px; margin-bottom: 16px; }.section-head h2 { margin: 0; color: var(--text); font-size: 24px; letter-spacing: -.02em; }.section-head h2 small { margin-left: 6px; color: #9aabba; font-size: 14px; font-weight: 500; }.section-kicker { margin-bottom: 5px; font-size: 10px; }.section-sub { color: var(--muted); font-size: 12px; }
.recent-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }.recent-card { display: flex; gap: 12px; min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 15px; background: white; box-shadow: 0 5px 14px rgba(33, 64, 82, .035); text-align: left; cursor: pointer; }.recent-card:hover, .card:hover { transform: translateY(-3px); border-color: #b2e6f0; box-shadow: var(--shadow); }.recent-cover { flex: none; width: 65px; height: 88px; overflow: hidden; border-radius: 10px; background: #e9f5f8; display: grid; place-items: center; color: var(--accent); font-size: 28px; }.recent-cover img { width: 100%; height: 100%; object-fit: cover; }.recent-info { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }.recent-caption { color: #0099b6; font-size: 10px; font-weight: 700; }.recent-info strong { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--text); font-size: 13px; line-height: 1.35; }.recent-episode { margin-top: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }.recent-bar { height: 4px; overflow: hidden; border-radius: 999px; background: #e6f1f4; }.recent-bar i { display: block; height: 100%; border-radius: inherit; background: #00b4d4; }
.recent-empty { display: flex; align-items: center; justify-content: center; gap: 20px; min-height: 118px; padding: 10px 24px; border: 1px dashed #cae4e9; border-radius: 15px; background: rgba(255,255,255,.64); }.recent-empty strong { font-size: 14px; }.recent-empty p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.tag-filter { display: flex; gap: 8px; overflow-x: auto; margin-bottom: 16px; padding: 0 0 5px; scrollbar-width: none; }.tag-filter button { flex: none; padding: 7px 13px; border: 1px solid var(--border); border-radius: 9px; background: white; color: #64717d; font-size: 12px; cursor: pointer; }.tag-filter button:hover, .tag-filter button.active { border-color: var(--accent); background: var(--accent-soft); color: #008dac; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: 18px 15px; }.card { min-width: 0; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 13px; background: white; text-align: left; cursor: pointer; transition: transform .15s, border-color .15s, box-shadow .15s; }.thumb { position: relative; display: grid; place-items: center; aspect-ratio: 3 / 4; overflow: hidden; background: #e5f1f5; }.thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }.ph { color: #8cbcc8; font-size: 52px; font-weight: 800; }.rating { position: absolute; right: 8px; bottom: 8px; padding: 4px 7px; border-radius: 6px; background: rgba(31, 40, 51, .76); color: #ffdb70; font-size: 12px; font-weight: 700; }.meta { min-height: 80px; padding: 10px 11px 12px; }.meta h3 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin: 0; color: var(--text); font-size: 14px; line-height: 1.35; }.meta .native { overflow: hidden; margin: 4px 0 0; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.meta .sub { margin: 7px 0 0; color: #92a0ac; font-size: 11px; }.meta .sub span { margin: 0 3px; }
.result-message, .no-results { min-height: 220px; display: grid; place-content: center; color: var(--muted); text-align: center; font-size: 14px; }.no-results p { margin: 10px 0; }
@media (max-width: 900px) { .recent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .search { gap: 28px; }.hero { grid-template-columns: minmax(0, 1fr); min-height: auto; }.hero-copy { padding: 26px 22px 10px; }.hero h1 { font-size: 31px; }.hero-art { min-height: 145px; place-items: end end; }.hero-circle { width: 180px; height: 180px; right: 15px; bottom: -70px; }.hero-mark { font-size: 72px; margin-right: 50px; }.note-top { top: 18px; left: 24px; right: auto; }.note-bottom { bottom: 18px; left: 22px; }.section-head h2 { font-size: 21px; }.section-sub { font-size: 10px; }.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }.recent-grid { gap: 10px; }.recent-card { gap: 8px; padding: 8px; }.recent-cover { width: 51px; height: 76px; }.recent-info strong { font-size: 11px; } }
@media (max-width: 420px) { .quick-search button:last-child { display: none; }.section-sub { display: none; }.recent-grid { grid-template-columns: minmax(0, 1fr); }.recent-cover { width: 57px; height: 78px; } }
</style>


<style scoped>
.section-sub button { margin-left: 8px; border: 1px solid var(--border); border-radius: 7px; padding: 5px 8px; background: var(--surface); color: var(--muted); cursor: pointer; font: inherit; }
</style>
