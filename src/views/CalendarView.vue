<script setup lang="ts">
import { computed, onMounted, onActivated, onDeactivated, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { bangumiCalendar, type BangumiCalendarDay } from '../api'
import { remember } from '../store'

const router = useRouter()
const days = ref<BangumiCalendarDay[]>([])
const activeDay = ref<number | null>(null)
const activeTag = ref('')
const loading = ref(true)
const error = ref('')
const currentDay = computed(() => days.value.find((day) => day.weekday.id === activeDay.value) || days.value[0])
const tags = computed(() => [...new Set((currentDay.value?.items || []).flatMap((item) => item.tags))].slice(0, 18))
const visibleItems = computed(() => (currentDay.value?.items || []).filter((item) => !activeTag.value || item.tags.includes(activeTag.value)))

function open(subject: any) { remember(subject); router.push({ name: 'watch', params: { id: subject.id } }) }
let controller: AbortController | null = null
async function load() {
  if (controller) return
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  try {
    const result = await bangumiCalendar(request.signal)
    if (request.signal.aborted) return
    days.value = result
    const jsDay = new Date().getDay()
    activeDay.value = jsDay === 0 ? 7 : jsDay
  } catch (e: any) {
    if (!request.signal.aborted) error.value = '读取新番日历失败：' + (e?.message || e)
  } finally {
    if (controller === request) { controller = null; loading.value = false }
  }
}
function cancel() { controller?.abort(); controller = null; loading.value = false }
onMounted(load)
onActivated(() => { if (!days.value.length) void load() })
onDeactivated(cancel)
onBeforeUnmount(cancel)
</script>

<template>
  <section class="calendar-page">
    <header class="calendar-hero"><div><p class="eyebrow">WEEKLY SCHEDULE · 每周更新</p><h1>新番日历</h1><p>看看今天有哪些新番，挑一部加入今天的片单。</p></div><span class="calendar-mark" aria-hidden="true">7<small>DAYS / ANIME</small></span></header>
    <p v-if="loading" class="hint">正在加载日历…</p><p v-else-if="error" class="hint error">{{ error }} <button @click="load">重试</button></p>
    <template v-else>
      <div class="day-tabs"><button v-for="day in days" :key="day.weekday.id" :class="{ active: activeDay === day.weekday.id }" @click="activeDay = day.weekday.id; activeTag = ''">{{ day.weekday.cn }}</button></div>
      <div v-if="tags.length" class="tags"><button :class="{ active: !activeTag }" @click="activeTag = ''">全部</button><button v-for="tag in tags" :key="tag" :class="{ active: activeTag === tag }" @click="activeTag = tag">{{ tag }}</button></div>
      <p class="count">{{ currentDay?.weekday.cn }} · {{ visibleItems.length }} 部</p>
      <div class="grid"><article v-for="item in visibleItems" :key="item.id" role="link" tabindex="0" @click="open(item)" @keyup.enter="open(item)"><img v-if="item.cover" :src="item.cover" :alt="item.name_cn || item.name" loading="lazy" /><div v-else class="placeholder">{{ (item.name_cn || item.name).slice(0, 1) }}</div><div class="meta"><h2>{{ item.name_cn || item.name }}</h2><p>{{ item.name }}</p><span v-if="item.rating.score">★ {{ item.rating.score.toFixed(1) }}</span></div></article></div>
      <div v-if="!visibleItems.length" class="calendar-empty"><span class="empty-mark" aria-hidden="true">☷</span><p>这个筛选下暂无番剧，换一天看看吧。</p></div>
    </template>
  </section>
</template>

<style scoped>
.calendar-page { max-width: 1200px; margin: 0 auto; }.eyebrow { color: var(--accent); font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .08em; }.calendar-page h1 { margin: 0; font-size: 28px; }.calendar-page header > p:last-child, .hint, .count { color: var(--muted); }.day-tabs, .tags { display: flex; gap: 8px; overflow-x: auto; padding: 16px 0 6px; scrollbar-width: none; }.tags { padding-top: 8px; }.day-tabs button, .tags button { white-space: nowrap; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 7px 11px; cursor: pointer; font-size: 13px; }.day-tabs button.active, .tags button.active { background: var(--accent); border-color: var(--accent); color: #fff; }.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }.grid article { overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); cursor: pointer; transition: transform .15s, border-color .15s; }.grid article:hover { transform: translateY(-3px); border-color: var(--accent); }.grid img, .placeholder { width: 100%; aspect-ratio: 3 / 4; display: block; object-fit: cover; background: #252936; }.placeholder { display: grid; place-items: center; color: var(--muted); font-size: 40px; }.meta { padding: 9px; }.meta h2 { margin: 0; font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }.meta p { margin: 3px 0; color: var(--muted); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.meta span { font-size: 12px; color: #f6c35b; }.error { color: #ff6b6b; } @media (max-width: 560px) { .calendar-page h1 { font-size: 24px; }.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } }
.calendar-page { max-width: 1240px; }
.calendar-hero { display: flex; align-items: center; justify-content: space-between; min-height: 184px; overflow: hidden; padding: 25px clamp(24px, 4vw, 45px); border: 1px solid #d9edf1; border-radius: 22px; background: linear-gradient(105deg, #e7f9fc, #f1fcfc 58%, #fff1d1); box-shadow: var(--shadow); }
.calendar-hero .eyebrow { margin-bottom: 8px; color: #008fab; font-size: 11px; font-weight: 800; }.calendar-hero h1 { font-size: clamp(26px, 3vw, 38px); }.calendar-hero p:last-child { margin: 11px 0 0; color: #6b7e8a; font-size: 14px; }.calendar-mark { flex: none; text-align: center; padding: 12px 20px; border: 1px solid #b2e4ec; border-radius: 18px; color: #008da9; font-size: 64px; font-weight: 800; background: #ffffff88; }.calendar-mark small { display: block; font-size: 9px; letter-spacing: .1em; }
.day-tabs { gap: 10px; padding-top: 24px; }.day-tabs button { min-width: 84px; padding: 10px 16px; border-radius: 10px; background: #fff; font-weight: 650; }.day-tabs button:hover, .day-tabs button.active { border-color: #b2e4ec; background: var(--accent-soft); color: #008da9; }.tags { gap: 7px; padding: 12px 0; }.tags button { border-radius: 8px; font-size: 12px; }.tags button:hover, .tags button.active { border-color: var(--accent); background: var(--accent-soft); color: #008da9; }.count { margin: 6px 0 16px; font-size: 12px; }
.grid { grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: 18px 15px; }.grid article { border-radius: 13px; background: #fff; box-shadow: 0 5px 15px rgba(33, 64, 82, .035); }.grid article:hover { border-color: #b2e4ec; box-shadow: var(--shadow); }.grid img, .placeholder { background: #e4f1f5; }.meta { padding: 10px 11px 12px; }.meta h2 { color: var(--text); font-size: 14px; }.meta span { color: #da8b12; }
.calendar-empty { display: grid; place-items: center; padding: 30px; color: var(--muted); font-size: 13px; }.empty-mark { font-size: 42px; color: var(--accent); }.calendar-empty p { margin: 5px 0; }
@media (max-width: 560px) { .calendar-hero { min-height: 156px; padding: 21px 22px; }.calendar-mark { font-size: 40px; padding: 10px; margin-left: 12px; }.calendar-hero p:last-child { max-width: 200px; font-size: 12px; }.day-tabs button { min-width: 66px; padding: 8px 10px; }.grid { gap: 12px; } }
</style>

