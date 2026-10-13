<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import Danmaku from 'danmaku'
import { getDanmaku, type DanmakuItem } from '../api'

const props = defineProps<{ media: HTMLVideoElement | null; subjectId: number; episodeUrl: string | null }>()
type DisplayMode = 'all' | 'rtl' | 'top' | 'bottom'
const settingsKey = 'animer:danmaku:settings:v1'
function readSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
const saved = readSettings()
const stage = ref<HTMLElement | null>(null)
const enabled = ref(saved.enabled !== false)
const opacity = ref(bounded(saved.opacity, 0.85, 0.2, 1))
const fontSize = ref(bounded(saved.fontSize, 20, 14, 36))
const area = ref(bounded(saved.area, 75, 25, 100))
const mode = ref<DisplayMode>(['all', 'rtl', 'top', 'bottom'].includes(saved.mode) ? saved.mode : 'all')
const blocklist = ref<string>(typeof saved.blocklist === 'string' ? saved.blocklist.slice(0, 2000) : '')
const message = ref('')
let engine: Danmaku | null = null
let observer: ResizeObserver | null = null
let controller: AbortController | null = null
let generation = 0
let active = true
let comments: DanmakuItem[] = []

function disposeEngine() {
  observer?.disconnect()
  observer = null
  engine?.destroy()
  engine = null
}
function cancel() {
  generation++
  controller?.abort()
  controller = null
  disposeEngine()
}
function filteredComments() {
  const words = blocklist.value.toLocaleLowerCase().split(/[\n,，]/).map(word => word.trim()).filter(Boolean)
  return comments.filter(item => (mode.value === 'all' || item.mode === mode.value)
    && !words.some(word => item.text.toLocaleLowerCase().includes(word)))
}
function renderComments() {
  disposeEngine()
  if (!active || !enabled.value || !stage.value || !props.media || !props.episodeUrl) return
  const container = stage.value
  engine = new Danmaku({
    container, media: props.media, engine: 'canvas',
    comments: filteredComments().map(item => ({
      text: item.text, time: item.time_seconds, mode: item.mode,
      style: { color: item.color, fontSize: `${fontSize.value}px`, textShadow: '1px 1px 2px #000' },
    })),
  })
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => engine?.resize())
    observer.observe(container)
  }
}
async function setup() {
  cancel()
  comments = []
  message.value = ''
  if (!active) return
  const request = generation
  const media = props.media
  const episodeUrl = props.episodeUrl
  const subjectId = props.subjectId
  await nextTick()
  if (request !== generation || !active || !stage.value || !media || !episodeUrl) return
  const abort = new AbortController()
  controller = abort
  message.value = '正在加载弹幕…'
  try {
    const result = await getDanmaku(subjectId, episodeUrl, abort.signal)
    if (request !== generation || !active || abort.signal.aborted) return
    comments = result
    message.value = result.length ? `${result.length} 条弹幕 · 只读` : '暂无弹幕'
    renderComments()
  } catch (error: unknown) {
    if (request !== generation || !active || abort.signal.aborted) return
    message.value = error instanceof Error ? error.message : '弹幕暂不可用'
  } finally {
    if (controller === abort) controller = null
  }
}
function persistSettings() {
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ enabled: enabled.value, opacity: opacity.value,
      fontSize: fontSize.value, area: area.value, mode: mode.value, blocklist: blocklist.value }))
  } catch { /* Browsers with storage disabled can still use the controls. */ }
}
watch(() => [props.media, props.subjectId, props.episodeUrl] as const, setup, { immediate: true, flush: 'sync' })
watch([enabled, opacity, fontSize, area, mode, blocklist], () => {
  persistSettings()
  renderComments()
}, { flush: 'post' })
onDeactivated(() => { active = false; cancel(); comments = [] })
onActivated(() => { if (!active) { active = true; void setup() } })
onBeforeUnmount(() => { active = false; cancel(); comments = [] })
</script>

<template>
  <div ref="stage" class="danmaku-stage" :class="{ hidden: !enabled }" :style="{ opacity, height: `${area}%` }" aria-hidden="true"></div>
  <div class="danmaku-bar">
    <button class="toggle" :class="{ active: enabled }" :aria-pressed="enabled" @click="enabled = !enabled">弹幕{{ enabled ? '开' : '关' }}</button>
    <details class="danmaku-settings">
      <summary>弹幕设置</summary>
      <div class="settings-panel">
        <label>透明度 <input v-model.number="opacity" type="range" min="0.2" max="1" step="0.05" /><output>{{ Math.round(opacity * 100) }}%</output></label>
        <label>字号 <input v-model.number="fontSize" type="range" min="14" max="36" step="1" /><output>{{ fontSize }}px</output></label>
        <label>显示区域 <input v-model.number="area" type="range" min="25" max="100" step="25" /><output>{{ area }}%</output></label>
        <label>显示类型 <select v-model="mode"><option value="all">全部</option><option value="rtl">滚动</option><option value="top">顶部</option><option value="bottom">底部</option></select></label>
        <label class="blocklist">屏蔽关键词<textarea v-model="blocklist" maxlength="2000" rows="2" placeholder="每行一个词，或用逗号分隔"></textarea></label>
        <p>设置仅保存在当前浏览器。弹幕只读。</p>
      </div>
    </details>
    <span class="notice" role="status">{{ message }}</span>
  </div>
</template>

<style scoped>
.danmaku-stage { position: absolute; top: 0; left: 0; right: 0; z-index: 2; pointer-events: none; overflow: hidden; }
.danmaku-stage.hidden { display: none; }
.danmaku-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-top: 8px; min-width: 0; }
.danmaku-bar button, summary { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 7px; padding: 7px 9px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.danmaku-bar .toggle.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.danmaku-bar .notice { color: var(--muted); font-size: 11px; }
.danmaku-settings { position: relative; }
.settings-panel { position: absolute; bottom: calc(100% + 8px); left: -65px; z-index: 5; width: min(300px, 80vw); padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.settings-panel label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; }
.settings-panel input { flex: 1; min-width: 0; accent-color: var(--accent); }
.settings-panel output { min-width: 38px; text-align: right; }
.settings-panel .blocklist { display: grid; }
.settings-panel textarea, .settings-panel select { border: 1px solid var(--border); border-radius: 6px; padding: 6px; color: var(--text); background: var(--surface); font: inherit; }
.settings-panel textarea { resize: vertical; max-height: 140px; }
.settings-panel p { margin: 0; font-size: 11px; color: var(--muted); }
</style>
