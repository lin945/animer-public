<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Hls from 'hls.js'
import {
  mediaSources,
  sourceSearch,
  sourceEpisodes,
  resolveStream,
  bangumiSubject,
  type MediaSource,
  type LinkItem,
  type EpisodeChannel,
  type BangumiSubject,
  type SourceSearchResult,
} from '../api'
import { recall, remember } from '../store'
import { bestSubject, episodeAlternatives, orderedSources, sameEpisodeName, waitForMediaReady } from '../playback'
import { recentFor, rememberEpisode, updateRecentProgress } from '../history'
import DanmakuOverlay from '../components/DanmakuOverlay.vue'

// 详情页由路由参数驱动（/watch/:id），元信息优先走本地缓存，缺失时回源 /api/bgm-subject。
const props = defineProps<{ id: number }>()
const router = useRouter()

const subject = ref<BangumiSubject | null>(null)
const subjectError = ref('')
const subjectLoading = ref(false)

const sources = ref<MediaSource[]>([])
const sourceId = ref<number | null>(null)
const subjects = ref<LinkItem[]>([])
const episodes = ref<LinkItem[]>([])
const episodeChannels = ref<EpisodeChannel[]>([])
const selectedChannel = ref('')
const currentEp = ref<LinkItem | null>(null)
const status = ref('')
const error = ref('')
const loading = ref(false)
// 用于打源站的关键词，默认中文名，可手动改
const kwInput = ref('')
// 后端实际命中的关键词（后端会按 animeko 规则试多个候选词）
const usedKeyword = ref('')
// 命中流地址的策略（便于判断走的哪条路）
const streamVia = ref('')

const videoEl = ref<HTMLVideoElement | null>(null)
let hls: Hls | null = null
let requestController: AbortController | null = null
let mediaController: AbortController | null = null
const failedEpisodes = new Set<string>()
const preferenceKey = `animer:playback:${props.id}`
let preferredPlayback: { source: string; channel: string } | null = null
try {
  preferredPlayback = JSON.parse(localStorage.getItem(preferenceKey) || 'null')
} catch {
  // 隐私模式或旧缓存损坏不影响播放。
}

// ---- 自动换源 ----
// 同集备用线路 → 其它源；按实际媒体加载结果决定是否继续。
const triedIds = ref<number[]>([])
const triedLog = ref<Array<{ name: string; why: string }>>([])
let lastWhy = ''

type PlaybackState = 'idle' | 'searching' | 'episodes' | 'resolving' | 'loading' | 'ready' | 'playing' | 'failed' | 'unsupported'
const playbackStates = ref<Record<number, { state: PlaybackState; detail: string }>>({})

const currentSource = computed(() => sources.value.find((s) => s.id === sourceId.value) || null)
const visibleEpisodes = computed(() => {
  const current = episodeChannels.value.find((channel) => channel.name === selectedChannel.value)
  return current?.items || episodes.value
})
const nextEpisode = computed(() => {
  const at = visibleEpisodes.value.findIndex((ep) => ep.url === currentEp.value?.url)
  return at >= 0 ? visibleEpisodes.value[at + 1] : undefined
})
const finished = ref(false)

function normalizeSubject(value: BangumiSubject): BangumiSubject {
  // 兼容上线前存入 sessionStorage 的详情缓存，它们没有 rating/tags 字段。
  return { ...value, tags: value.tags || [], rating: value.rating || { score: null, total: null }, rank: value.rank ?? null }
}

function setPlaybackState(id: number, state: PlaybackState, detail = '') {
  playbackStates.value = { ...playbackStates.value, [id]: { state, detail } }
}

function playbackLabel(source: MediaSource): string {
  const state = playbackStates.value[source.id]?.state
  if (!state || state === 'idle') return healthLabel(source)
  return ({ searching: '搜索中', episodes: '读取剧集', resolving: '解析中', loading: '加载视频', ready: '可播放', playing: '本站播放', failed: '播放失败', unsupported: '不支持本站播放', idle: '未探测' } as Record<PlaybackState, string>)[state]
}

function setEpisodes(result: { items: LinkItem[]; channels?: EpisodeChannel[] }) {
  episodes.value = result.items
  episodeChannels.value = result.channels?.length ? result.channels : [{ name: '默认线路', items: result.items }]
  selectedChannel.value = episodeChannels.value[0]?.name || ''
}

async function loadSubject(signal: AbortSignal) {
  if (!Number.isFinite(props.id) || props.id <= 0) {
    subjectError.value = '无效的番剧 id，请返回搜索页重新进入。'
    return
  }
  const cached = recall(props.id)
  if (cached) {
    subject.value = normalizeSubject(cached)
    return
  }
  subjectLoading.value = true
  try {
    const s = await bangumiSubject(props.id, signal)
    if (signal.aborted || !active) return
    subject.value = normalizeSubject(s)
    remember(subject.value)
  } catch (e: any) {
    if (signal.aborted || !active) return
    subjectError.value = '读取番剧信息失败：' + (e?.message || e)
  } finally {
    subjectLoading.value = false
  }
}

async function refreshSources(signal: AbortSignal) {
  const next = await mediaSources(signal)
  if (!signal.aborted && active) sources.value = next
}

async function ensureSources(signal: AbortSignal, initialEpisode?: LinkItem) {
  try {
    await refreshSources(signal)
    if (signal.aborted || !active) return
    if (!sources.value.length) {
      error.value = '暂无可用播放源，请稍后重试或联系管理员。'
      return
    }
    if (sourceId.value == null || !sources.value.some((s) => s.id === sourceId.value)) {
      sourceId.value = sources.value[0]!.id
    }
    await openSubject(kwInput.value, { auto: true, episode: initialEpisode })
  } catch (e: any) {
    if (signal.aborted || !active) return
    error.value = '加载播放源失败：' + (e?.message || e)
  }
}

/** 本番上次成功的源优先；不再截断前 5 个，后排可播放的源也能自动尝试。 */
function orderedCandidates(from: number | null): MediaSource[] {
  return orderedSources(sources.value, preferredPlayback?.source, from, triedIds.value)
}

function cancelPlayback() {
  requestController?.abort()
  cancelAutoNext()
  saveCurrentProgress(true)
  clearVideo()
  loading.value = false
  status.value = ''
  error.value = '已停止尝试。可选择播放源或重新搜索。'
}
function beginPlayback(keepFailures = false): AbortSignal {
  cancelAutoNext()
  saveCurrentProgress(true)
  resumedAt.value = 0
  requestController?.abort()
  clearVideo()
  for (const [id, playback] of Object.entries(playbackStates.value)) {
    if (['searching', 'episodes', 'resolving', 'loading'].includes(playback.state)) setPlaybackState(Number(id), 'idle')
  }
  requestController = new AbortController()
  if (!keepFailures) failedEpisodes.clear()
  return requestController.signal
}

function isCurrent(signal: AbortSignal): boolean {
  return requestController?.signal === signal && !signal.aborted
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(40000)])
}

function rememberPlayback(source: MediaSource, episode: LinkItem) {
  preferredPlayback = { source: source.name, channel: episode.channel || selectedChannel.value }
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(preferredPlayback))
  } catch {
    // 存储不可用时，当前页面仍能记住成功线路。
  }
}

/** 下拉里显示「源名 · 健康度」，让用户一眼看出哪个源大概率能放 */
function sourceOptionLabel(s: MediaSource): string {
  const label = healthLabel(s)
  return label && label !== '未探测' ? `${s.name} · ${label}` : s.name
}

function whyOf(failureKind: string | null | undefined, fallback: string): string {
  if (failureKind === 'blocked') return '被源站反爬拦截'
  if (failureKind === 'ratelimited') return '源站限流'
  if (failureKind === 'broken') return '源站故障'
  return fallback
}

/**
 * 用某个源把「搜索 → 选集 → 取流」走通；返回是否成功播上。
 * 任一步失败就把原因记进 triedLog 并返回 false，交给外层换下一个源。
 */
async function trySource(s: MediaSource, keyword: string, signal: AbortSignal, wantedEpisode?: LinkItem): Promise<boolean> {
  lastWhy = ''
  setPlaybackState(s.id, 'searching')
  status.value = `[${s.name}] 搜索《${keyword}》…`
  let found: SourceSearchResult
  try {
    found = await sourceSearch(s.id, keyword, { signal: requestSignal(signal) })
    if (!isCurrent(signal)) return false
  } catch (e: any) {
    if (!isCurrent(signal)) return false
    lastWhy = '请求失败：' + (e?.message || e)
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }
  if (!found.items.length) {
    lastWhy = whyOf(found.debug?.failureKind, '没搜到该番')
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }
  subjects.value = found.items
  if (found.usedKeyword) usedKeyword.value = found.usedKeyword
  const catalogTitle = subject.value?.name_cn || subject.value?.name || ''
  const aliases = keyword === catalogTitle && subject.value?.name ? [subject.value.name] : []
  const matched = bestSubject(found.items, keyword, aliases)
  if (!matched) {
    lastWhy = '该源没找到这部番的对应条目，可从下方搜索结果手动选择'
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }

  status.value = `[${s.name}] 获取剧集列表…`
  setPlaybackState(s.id, 'episodes')
  let eps: LinkItem[] = []
  try {
    const result = await sourceEpisodes(s.id, matched.url, { signal: requestSignal(signal) })
    if (!isCurrent(signal)) return false
    eps = result.items
    setEpisodes(result)
  } catch (e: any) {
    if (!isCurrent(signal)) return false
    lastWhy = '选集失败：' + (e?.message || e)
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }
  if (!eps.length) {
    lastWhy = '解析不到剧集（源站改版或选集走 AJAX）'
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }
  status.value = `[${s.name}] 解析视频地址…`
  setPlaybackState(s.id, 'resolving')
  // 换源时保留集数。不同源没有该集时继续下一源，不能默默播放第一集。
  const target = wantedEpisode
    ? episodeAlternatives(episodeChannels.value, wantedEpisode).find((ep) => eps.some((item) => item.url === ep.url))
    : eps[0]!
  if (!target) {
    lastWhy = `该源没有对应的${wantedEpisode?.name || '剧集'}`
    setPlaybackState(s.id, 'failed', lastWhy)
    return false
  }
  const ok = await playEpisode(target, { signal, preferSavedChannel: true })
  if (!isCurrent(signal)) return false
  if (!ok) lastWhy = lastWhy || '取不到视频地址'
  return ok
}

/** 打开番剧：默认自动跨源重试，直到某个源真的能播 */
async function openSubject(kwOverride?: string, opts: { auto?: boolean; episode?: LinkItem; continuing?: boolean } = {}) {
  const keyword = (kwOverride ?? kwInput.value).trim()
  if (!active || !keyword || !sources.value.length) return
  const auto = opts.auto !== false
  const signal = beginPlayback(opts.continuing)
  if (!opts.continuing) triedIds.value = []
  loading.value = true
  error.value = ''
  subjects.value = []
  episodes.value = []
  episodeChannels.value = []
  selectedChannel.value = ''
  currentEp.value = null
  streamVia.value = ''
  triedLog.value = []
  usedKeyword.value = ''

  const list = auto
    ? orderedCandidates(sourceId.value)
    : sources.value.filter((s) => s.id === sourceId.value)
  if (!list.length) {
    loading.value = false
    error.value = '没有可用的播放源，请稍后重试或联系管理员。'
    return
  }

  for (let i = 0; i < list.length; i++) {
    const s = list[i]!
    sourceId.value = s.id
    const ok = await trySource(s, keyword, signal, opts.episode)
    if (!isCurrent(signal)) return
    if (ok) {
      loading.value = false
      status.value = ''
      error.value = ''
      return
    }
    triedIds.value = [...new Set([...triedIds.value, s.id])]
    triedLog.value.push({ name: s.name, why: lastWhy || '未知原因' })
  }

  loading.value = false
  status.value = ''
  const detail = triedLog.value.map((t) => `${t.name}（${t.why}）`).join('；')
  error.value =
    list.length > 1
      ? `已自动尝试 ${list.length} 个源，仍无法播放：${detail}`
      : `源「${list[0]?.name}」播放失败：${triedLog.value[0]?.why || '未知原因'}`
}

async function pickSubject(sub: LinkItem) {
  if (!sourceId.value) return
  const signal = beginPlayback()
  loading.value = true
  error.value = ''
  status.value = '正在获取剧集列表…'
  try {
    const result = await sourceEpisodes(sourceId.value, sub.url, { signal: requestSignal(signal) })
    if (!isCurrent(signal)) return
    const eps = result.items
    setEpisodes(result)
    if (eps.length) {
      const ok = await playEpisode(eps[0]!, { signal })
      if (!isCurrent(signal)) return
      if (!ok) error.value = lastWhy
    }
    else {
      error.value = '没有解析到剧集，可能该源结构有变。'
      status.value = ''
    }
  } catch (e: any) {
    if (!isCurrent(signal)) return
    error.value = '获取剧集失败：' + (e?.message || e)
    status.value = ''
  } finally {
    if (isCurrent(signal)) loading.value = false
  }
}

/** 同一集逐线路重试，只有媒体数据实际就绪才停止。 */
async function playEpisode(ep: LinkItem, opts: { signal?: AbortSignal; preferSavedChannel?: boolean; recovering?: boolean } = {}): Promise<boolean> {
  if (!active || !sourceId.value) return false
  cancelAutoNext()
  finished.value = false
  const signal = opts.signal || beginPlayback(opts.recovering)
  if (!opts.signal) {
    loading.value = true
    error.value = ''
  }
  const source = currentSource.value!
  const preferredChannel = opts.preferSavedChannel && preferredPlayback?.source === source.name
    ? preferredPlayback.channel : undefined
  const candidates = episodeAlternatives(episodeChannels.value, ep, preferredChannel)
  const failures: string[] = []
  for (const candidate of candidates) {
    if (failedEpisodes.has(candidate.url)) continue
    const ok = await tryEpisode(candidate, signal)
    if (!isCurrent(signal)) return false
    if (ok) {
      rememberPlayback(source, candidate)
      error.value = ''
      status.value = ''
      if (!opts.signal) loading.value = false
      return true
    }
    failedEpisodes.add(candidate.url)
    failures.push(`${candidate.channel || '默认线路'}（${lastWhy}）`)
  }
  lastWhy = failures.join('；') || '该集的线路均已尝试'
  status.value = ''
  if (!opts.signal) {
    loading.value = false
    error.value = lastWhy
  }
  return false
}

async function tryEpisode(ep: LinkItem, signal: AbortSignal): Promise<boolean> {
  clearVideo()
  const activeSourceId = sourceId.value
  currentEp.value = ep
  if (ep.channel) selectedChannel.value = ep.channel
  status.value = `正在解析${ep.channel || '默认线路'} · ${ep.name}…`
  if (!activeSourceId) return false
  setPlaybackState(activeSourceId, 'resolving')
  lastWhy = ''
  try {
    const r = await resolveStream(activeSourceId, ep.url, { signal: requestSignal(signal) })
    if (!isCurrent(signal)) return false
    if (!r.streamUrl) {
      lastWhy = whyOf(r.failureKind, '播不出流地址（需浏览器 / 需登录）')
      setPlaybackState(activeSourceId, 'failed', lastWhy)
      return false
    }
    error.value = ''
    streamVia.value = r.via || ''
    setPlaybackState(activeSourceId, 'loading')
    const proxyFirst = r.kind === 'hls' || Boolean(r.headers?.['User-Agent'])
    if (!['http:', 'https:'].includes(new URL(r.streamUrl).protocol)) throw new Error('不支持的视频地址')
    const errors: string[] = []
    const attempts = r.proxyUrl ? [proxyFirst, !proxyFirst] : [false]
    for (const viaProxy of attempts) {
      if (!isCurrent(signal)) return false
      if (errors.length) clearVideo()
      status.value = `正在通过${viaProxy ? '本站代理' : '视频直链'}加载${ep.channel || '默认线路'} · ${ep.name}…`
      try {
        await loadStream(r.streamUrl, ep, activeSourceId, signal, r.kind, viaProxy, r.proxyUrl)
        break
      } catch (e: any) {
        if (!isCurrent(signal)) return false
        errors.push(`${viaProxy ? '代理' : '直链'}：${e?.message || e}`)
        if (errors.length === attempts.length) throw new Error(errors.join('；'))
      }
    }
    if (!isCurrent(signal)) return false
    if (subject.value && videoEl.value) {
      const saved = recentFor(subject.value.id)
      const video = videoEl.value
      rememberEpisode(subject.value, ep)
      if (saved && sameEpisodeName(saved.episodeName, ep.name) && !saved.completed && saved.position > 5
        && (!Number.isFinite(video.duration) || saved.position < video.duration - 12)) {
        try { video.currentTime = saved.position; resumedAt.value = saved.position } catch { /* 直播流或不可定位的媒体从头开始 */ }
      }
    }
    setPlaybackState(activeSourceId, videoEl.value?.paused ? 'ready' : 'playing')
    status.value = ''
    return true
  } catch (e: any) {
    if (!isCurrent(signal)) return false
    lastWhy = e?.message || String(e)
    setPlaybackState(activeSourceId, 'failed', lastWhy)
    clearVideo()
    return false
  }
}

async function loadStream(streamUrl: string, ep: LinkItem, activeSourceId: number, signal: AbortSignal, kind: string | null | undefined, viaProxy: boolean, proxyUrl?: string | null) {
  const video = videoEl.value
  if (!video) throw new Error('播放器尚未就绪')
  const controller = new AbortController()
  mediaController = controller
  const mediaSignal = AbortSignal.any([signal, controller.signal])
  const ready = waitForMediaReady(video, mediaSignal)
  let loaded = false
  video.playbackRate = playbackRate.value
  const play = () => { void video.play().catch(() => { /* 浏览器要求点击播放时仍是可用线路。 */ }) }
  const isHls = kind ? kind === 'hls' : streamUrl.includes('.m3u8')
  if (viaProxy && !proxyUrl?.startsWith('/api/play?')) throw new Error('播放代理凭据缺失，请重试')
  const source = viaProxy ? proxyUrl! : streamUrl
  try {
    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls()
        hls.on(Hls.Events.MANIFEST_PARSED, play)
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal || !isCurrent(signal) || mediaController !== controller) return
          const reason = `播放失败：${d.details}${d.response?.code ? `（HTTP ${d.response.code}）` : ''}`
          if (!loaded) controller.abort(new Error(reason))
          else void recoverPlayback(ep, signal, reason)
        })
        hls.loadSource(source)
        hls.attachMedia(video)
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source
        play()
      } else {
        controller.abort(new Error('当前浏览器不支持 HLS 播放'))
      }
    } else {
      video.src = source
      play()
    }
  } catch (cause) {
    controller.abort(cause)
  }
  await ready
  loaded = true
}

function clearVideo() {
  mediaController?.abort()
  mediaController = null
  if (hls) {
    hls.destroy()
    hls = null
  }
  const video = videoEl.value
  if (!video) return
  video.pause()
  video.removeAttribute('src')
  video.load()
}

async function recoverPlayback(ep: LinkItem, signal: AbortSignal, reason: string) {
  if (!active || !isCurrent(signal) || loading.value) return
  failedEpisodes.add(ep.url)
  if (sourceId.value) setPlaybackState(sourceId.value, 'failed', reason)
  const recovery = playEpisode(ep, { recovering: true })
  const recoverySignal = requestController?.signal
  const ok = await recovery
  if (!ok && recoverySignal && isCurrent(recoverySignal)) await retryOtherSources(true)
}

function onVideoError() {
  if (hls || !currentEp.value || !requestController) return
  void recoverPlayback(currentEp.value, requestController.signal, '媒体加载失败')
}

function onSourceChange() {
  const episode = currentEp.value || undefined
  saveCurrentProgress(true)
  // 用户手动换源：清掉自动换源的「已试过」记录，尊重用户选择只试这一个
  triedIds.value = []
  subjects.value = []
  episodes.value = []
  episodeChannels.value = []
  selectedChannel.value = ''
  currentEp.value = null
  openSubject(kwInput.value, { auto: false, episode })
}

function sourceName(): string {
  return currentSource.value?.name || '源'
}

function backToSearch() {
  router.push({ name: 'search' })
}

/** 把当前源排到「已试过」，让自动换源从其它源重新开始 */
async function retryOtherSources(recovering = false) {
  const episode = currentEp.value || undefined
  if (sourceId.value != null) {
    triedIds.value = [...new Set([...triedIds.value, sourceId.value])]
  }
  if (!recovering && sources.value.every((source) => triedIds.value.includes(source.id))) {
    triedIds.value = []
    failedEpisodes.clear()
  }
  await openSubject(kwInput.value, { auto: true, episode, continuing: true })
}

function healthLabel(s: MediaSource | null): string {
  if (!s) return ''
  if (!s.enabled) return '已停用'
  if (s.health === 'ok') return '可访问'
  if (s.health === 'blocked') return '被反爬'
  if (s.health === 'broken') return '疑故障'
  return '未探测'
}

function timeAgo(ts: number | null): string {
  if (!ts) return '从未'
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  return Math.floor(d / 86_400_000) + ' 天前'
}

const settingsKey = 'animer:player-settings:v1'
const showSettingsKey = `animer:show-settings:${props.id}`
function readSettings(key: string): Record<string, unknown> {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {} } catch { return {} }
}
const settings = readSettings(settingsKey)
const showSettings = readSettings(showSettingsKey)
const playbackRate = ref([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(Number(settings.rate)) ? Number(settings.rate) : 1)
const autoNext = ref(settings.autoNext === true)
const opSeconds = ref(Number.isFinite(Number(showSettings.opSeconds)) ? Math.min(300, Math.max(0, Number(showSettings.opSeconds))) : 85)
const countdown = ref(0)
const resumedAt = ref(0)
let nextTimer: ReturnType<typeof setInterval> | null = null
function saveSettings() {
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ rate: playbackRate.value, autoNext: autoNext.value }))
    localStorage.setItem(showSettingsKey, JSON.stringify({ opSeconds: opSeconds.value }))
  } catch { /* Private browsing still supports in-memory preferences. */ }
  if (videoEl.value) videoEl.value.playbackRate = playbackRate.value
  if (!autoNext.value) cancelAutoNext()
}
function cancelAutoNext() {
  if (nextTimer) clearInterval(nextTimer)
  nextTimer = null
  countdown.value = 0
}
function startAutoNext() {
  cancelAutoNext()
  if (!active || !autoNext.value || !nextEpisode.value) return
  const episode = nextEpisode.value
  countdown.value = 5
  nextTimer = setInterval(() => {
    if (!active || !autoNext.value || !finished.value) { cancelAutoNext(); return }
    countdown.value -= 1
    if (countdown.value <= 0) { cancelAutoNext(); void playEpisode(episode) }
  }, 1000)
}
function seekBy(seconds: number) {
  const v = videoEl.value
  if (!v) return
  cancelAutoNext()
  try { v.currentTime = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : Infinity, v.currentTime + seconds)) } catch { /* Unseekable stream. */ }
}
function startOver() {
  const v = videoEl.value
  if (!v) return
  cancelAutoNext()
  v.currentTime = 0
  resumedAt.value = 0
  saveCurrentProgress(true)
}
function onShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (!active || event.ctrlKey || event.altKey || event.metaKey || target?.isContentEditable || target?.closest('input,textarea,select,button,a,video,[role="button"]')) return
  const v = videoEl.value
  if (!v || !currentEp.value) return
  if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); cancelAutoNext(); if (v.paused) void v.play().catch(() => {}); else v.pause() }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10) }
}

// 被 keep-alive 缓存（离开详情页）前记下播放位置与播放状态；
// 浏览器在媒体元素脱离文档时会自动暂停，所以用事件持续记录「是否在播」。
let lastTime = 0
let wasPlaying = false
let resumePending = false
let lastProgressSecond = -1

function saveCurrentProgress(force = false) {
  const video = videoEl.value
  const ep = currentEp.value
  if (!video || !ep || !subject.value || !Number.isFinite(video.currentTime)) return
  const second = Math.floor(video.currentTime)
  if (!force && second - lastProgressSecond < 5 && second >= lastProgressSecond) return
  lastProgressSecond = second
  updateRecentProgress(subject.value.id, ep.url, second, video.duration)
}

function onVideoTimeUpdate() { saveCurrentProgress() }
function onVideoEnded() {
  if (subject.value && currentEp.value && videoEl.value) {
    updateRecentProgress(subject.value.id, currentEp.value.url, videoEl.value.currentTime, videoEl.value.duration, true)
  }
  finished.value = true
  startAutoNext()
}

function onVideoPlay() {
  wasPlaying = true
}
function onVideoPlaying() {
  if (sourceId.value) setPlaybackState(sourceId.value, 'playing')
}
function onVideoPause() {
  if (active) wasPlaying = false
  saveCurrentProgress(true)
}

let active = true
let initializing = false
let initialized = false
let initController: AbortController | null = null
async function initialize() {
  if (initializing || initialized || !active) return
  initializing = true
  const controller = new AbortController()
  initController = controller
  try {
    await loadSubject(controller.signal)
    if (controller.signal.aborted || !active || !subject.value) return
    kwInput.value = subject.value.name_cn || subject.value.name || ''
    const saved = recentFor(subject.value.id)
    await ensureSources(controller.signal, saved ? { name: saved.episodeName, url: saved.episodeUrl } : undefined)
    if (!controller.signal.aborted && active) initialized = true
  } finally {
    if (initController === controller) initializing = false
  }
}
onMounted(() => { void initialize(); window.addEventListener('keydown', onShortcut) })
onDeactivated(() => {
  active = false
  cancelAutoNext()
  saveCurrentProgress(true)
  initController?.abort()
  initializing = false
  const v = videoEl.value
  wasPlaying = Boolean(v && !v.paused)
  lastTime = v?.currentTime || 0
  if (loading.value) {
    resumePending = true
    requestController?.abort()
    clearVideo()
    loading.value = false
    status.value = ''
  } else { v?.pause(); hls?.stopLoad() }
})
onActivated(() => {
  active = true
  if (!initialized) { void initialize(); return }
  if (resumePending) {
    resumePending = false
    void openSubject(kwInput.value, { episode: currentEp.value || undefined })
    return
  }
  const v = videoEl.value
  if (!v) return
  if (lastTime > 0 && Math.abs(v.currentTime - lastTime) > 1) {
    try { v.currentTime = lastTime } catch { /* media may not be seekable */ }
  }
  hls?.startLoad()
  if (wasPlaying) v.play().catch(() => {})
})
onBeforeUnmount(() => {
  active = false
  saveCurrentProgress(true)
  cancelAutoNext()
  initController?.abort()
  requestController?.abort()
  clearVideo()
  window.removeEventListener('keydown', onShortcut)
})
</script>

<template>
  <section class="watch">
    <div class="player-col">
      <p v-if="subjectLoading" class="hint">正在读取番剧信息…</p>

      <template v-if="subjectError">
        <p class="hint error">{{ subjectError }}</p>
        <button class="back" @click="backToSearch">← 返回搜索</button>
      </template>

      <div class="meta-head" v-if="subject">
        <img v-if="subject.cover" :src="subject.cover" class="poster" :alt="subject.name_cn" />
        <div class="head-text">
          <p class="detail-eyebrow">番剧详情 <span>／</span> {{ subject.air_date || '播出时间待定' }}</p>
          <h1>{{ subject.name_cn || subject.name }}</h1>
          <p v-if="subject.name_cn && subject.name && subject.name !== subject.name_cn" class="native">
            {{ subject.name }}
          </p>
          <p class="sub">{{ subject.eps ? `${subject.eps} 集` : '集数待定' }} · {{ subject.air_date || '播出时间待定' }}</p>
          <div class="subject-stats" v-if="subject.rating.score || subject.tags.length">
            <span v-if="subject.rating.score">★ {{ subject.rating.score.toFixed(1) }} <small>{{ subject.rating.total || 0 }} 人评分</small></span>
            <span v-if="subject.rank">排名 #{{ subject.rank }}</span>
          </div>
          <div v-if="subject.tags.length" class="tag-list"><span v-for="tag in subject.tags.slice(0, 8)" :key="tag">{{ tag }}</span></div>
          <p v-if="subject.summary" class="desc">{{ subject.summary }}</p>
        </div>
      </div>

      <div class="controls" v-if="subject">
        <select aria-label="选择播放源" v-model.number="sourceId" @change="onSourceChange" :disabled="!sources.length">
          <option v-for="s in sources" :key="s.id" :value="s.id">{{ sourceOptionLabel(s) }}</option>
        </select>
        <input aria-label="源站搜索关键词" v-model="kwInput" placeholder="源站搜索关键词" @keyup.enter="openSubject(kwInput)" />
        <button @click="openSubject(kwInput)" :disabled="loading">搜索</button>
        <button v-if="loading" @click="cancelPlayback">停止尝试</button>
        <button v-if="nextEpisode" class="next-button" @click="playEpisode(nextEpisode)">下一集 →</button>
      </div>

      <div v-if="subject" class="player-tools">
        <button @click="seekBy(-10)" aria-label="后退十秒">−10 秒</button>
        <button @click="seekBy(10)" aria-label="前进十秒">+10 秒</button>
        <label>倍速 <select v-model.number="playbackRate" @change="saveSettings"><option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]" :key="rate" :value="rate">{{ rate }}×</option></select></label>
        <label><input type="checkbox" v-model="autoNext" @change="saveSettings" /> 自动下一集</label>
        <label>跳过片头 <input type="number" min="0" max="300" v-model.number="opSeconds" @change="opSeconds = Math.min(300, Math.max(0, Number(opSeconds) || 0)); saveSettings()" /> 秒</label>
        <button @click="seekBy(opSeconds)">手动跳过</button>
        <span class="muted small">空格 / K 暂停，方向键快进退。记录仅保存在本机。</span>
      </div>
      <p v-if="resumedAt" class="hint">已从 {{ Math.floor(resumedAt / 60) }}:{{ String(Math.floor(resumedAt % 60)).padStart(2, '0') }} 续播 <button @click="startOver">从头播放</button></p>
      <div class="stage" v-if="subject">
        <video
          ref="videoEl"
          controls
          aria-label="番剧播放器"
          playsinline
          preload="auto"
          @error="onVideoError"
          @play="onVideoPlay"
          @playing="onVideoPlaying"
          @pause="onVideoPause"
          @timeupdate="onVideoTimeUpdate"
          @ended="onVideoEnded"
        ></video>
        <DanmakuOverlay :media="videoEl" :subject-id="subject.id" :episode-url="currentEp?.url || null" />
        <div v-if="status" class="status">{{ status }}</div>
        <div v-if="finished && nextEpisode" class="up-next"><strong>本集播放完成<span v-if="countdown"> · {{ countdown }} 秒后下一集</span></strong><button v-if="countdown" @click="cancelAutoNext">取消自动连播</button><button @click="playEpisode(nextEpisode)">播放下一集 · {{ nextEpisode.name }}</button></div>
      </div>

      <p v-if="error" class="hint error">{{ error }}</p>
      <p v-if="usedKeyword && usedKeyword !== kwInput" class="hint muted small">
        实际命中关键词：{{ usedKeyword }}
      </p>

      <p v-if="subjects.length" class="hint matches">
        选择匹配的条目：
        <button v-for="(s, i) in subjects" :key="i" @click="pickSubject(s)" class="subj">{{ s.name }}</button>
      </p>
    </div>

    <aside class="side">
      <div class="source-list">
        <div class="source-list-head"><h3>播放源</h3><button class="ghost mini" @click="retryOtherSources()" :disabled="loading">换源重试</button></div>
        <button v-for="source in sources" :key="source.id" class="source-row" :class="{ active: source.id === sourceId, failed: ['failed', 'unsupported'].includes(playbackStates[source.id]?.state || '') }" @click="sourceId = source.id; onSourceChange()">
          <span class="source-dot" :class="playbackStates[source.id]?.state || source.health"></span>
          <span class="source-name">{{ source.name }}</span>
          <span class="source-state" :title="playbackStates[source.id]?.detail">{{ playbackLabel(source) }}</span>
        </button>
      </div>
      <div class="episodes">
        <h3>选集 <small>{{ episodes.length }} 集</small></h3>
        <div v-if="episodeChannels.length > 1" class="channels" aria-label="播放线路">
          <button
            v-for="channel in episodeChannels"
            :key="channel.name"
            :class="{ active: channel.name === selectedChannel }"
            @click="selectedChannel = channel.name"
          >
            {{ channel.name }} ({{ channel.items.length }})
          </button>
        </div>
        <ul>
          <li
            v-for="(ep, i) in visibleEpisodes"
            :key="i"
            :class="{ active: currentEp && currentEp.url === ep.url }"
            role="button"
            tabindex="0"
            :aria-pressed="Boolean(currentEp && currentEp.url === ep.url)"
            @keydown.enter="playEpisode(ep)"
            @keydown.space.prevent="playEpisode(ep)"
            @click="playEpisode(ep)"
          >
            {{ ep.name || ('第' + (i + 1) + '集') }}
          </li>
        </ul>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.watch { display: grid; grid-template-columns: 1fr 320px; gap: 16px; max-width: 1100px; margin: 0 auto; }
.meta-head { display: flex; gap: 12px; margin-bottom: 12px; }
.poster { width: 80px; height: 112px; object-fit: cover; border-radius: 8px; background: #222; }
.head-text h2 { margin: 0 0 2px; font-size: 18px; }
.head-text .native { color: var(--muted); margin: 0 0 4px; font-size: 12px; }
.head-text .sub { color: var(--muted); margin: 0 0 6px; font-size: 12px; }
.subject-stats { display: flex; gap: 10px; color: #f6c35b; font-size: 12px; margin: 0 0 6px; }
.subject-stats small { color: var(--muted); font-weight: 400; }
.tag-list { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 6px; }
.tag-list span { color: #c8b7ff; background: rgba(160, 120, 255, .12); border: 1px solid rgba(160, 120, 255, .22); border-radius: 999px; padding: 2px 6px; font-size: 11px; }
.head-text .desc {
  font-size: 12px; line-height: 1.5; color: #ddd; margin: 0;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.controls { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.controls select, .controls input {
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font-size: 14px;
}
.controls input { flex: 1; min-width: 140px; }
.controls button {
  padding: 8px 16px; border: none; border-radius: 8px; background: var(--accent);
  color: #fff; font-weight: 600; cursor: pointer;
}
button.ghost {
  background: var(--surface) !important; color: var(--text) !important;
  border: 1px solid var(--border) !important; font-weight: 500 !important;
}
button:disabled { opacity: 0.6; cursor: default; }
.panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px;
}
.panel-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.panel textarea, .panel input {
  width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); font-size: 12px; font-family: inherit; resize: vertical;
}
.panel-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.panel-actions button {
  padding: 6px 12px; border: none; border-radius: 8px; background: var(--accent);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
}
.badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg);
}
.badge.ok { color: #34d399; border-color: #34d399; }
.badge.blocked { color: #ff6b6b; border-color: #ff6b6b; }
.badge.broken { color: #fbbf24; border-color: #fbbf24; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.panel code { background: var(--bg); padding: 0 4px; border-radius: 4px; }
.stage { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16/9; }
.stage video { width: 100%; height: 100%; display: block; border: 0; background: #000; }
.status {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px;
  background: rgba(0,0,0,0.6); font-size: 13px; color: #fff;
}
.source-url { margin: 8px 0 0; font-size: 11px; color: var(--muted); word-break: break-all; }
.back {
  margin-top: 8px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface); color: var(--text); cursor: pointer;
}
.hint { font-size: 13px; color: var(--muted); margin-top: 8px; }
.error { color: #ff6b6b; }
.subj { color: var(--accent); margin-right: 10px; cursor: pointer; text-decoration: underline; }
.side { display: flex; flex-direction: column; gap: 16px; }
.source-list { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px; }
.source-list-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.source-list h3 { font-size: 14px; margin: 0; }
.mini { padding: 4px 7px !important; font-size: 11px !important; }
.source-row { width: 100%; display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.source-row:hover, .source-row.active { background: var(--bg); }
.source-row.active { outline: 1px solid var(--accent); }
.source-dot { width: 7px; height: 7px; border-radius: 50%; background: #77808f; }
.source-dot.ready, .source-dot.playing { background: #34d399; }.source-dot.searching, .source-dot.episodes, .source-dot.resolving, .source-dot.loading { background: #f6c35b; }.source-dot.failed, .source-dot.unsupported, .source-dot.blocked, .source-dot.broken { background: #ff6b6b; }
.source-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.source-state { color: var(--muted); font-size: 10px; white-space: nowrap; }
.episodes {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px; height: fit-content; max-height: 70vh; overflow: auto;
}
.episodes h3 { margin: 0 0 10px; font-size: 14px; }
.channels { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.channels button { padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 12px; cursor: pointer; }
.channels button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.episodes ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.episodes li {
  padding: 6px 8px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border);
  font-size: 12px; cursor: pointer; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.episodes li:hover { border-color: var(--accent); }
.episodes li.active { background: var(--accent); color: #fff; border-color: var(--accent); }
@media (max-width: 760px) { .watch { grid-template-columns: 1fr; } .side { display: grid; grid-template-columns: 1fr; } .source-list { order: 2; } .episodes { order: 1; max-height: none; } .meta-head { align-items: flex-start; } .poster { width: 72px; height: 102px; } }

.watch { grid-template-columns: minmax(0, 1fr) 310px; max-width: 1240px; gap: 22px; align-items: start; }
.player-col { min-width: 0; }.side { display: flex; flex-direction: column; gap: 16px; }.episodes { order: 1; }.source-list { order: 2; }
.meta-head { gap: 20px; min-height: 218px; margin-bottom: 16px; padding: 20px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: var(--shadow); }
.poster { flex: none; width: 126px; height: 178px; border-radius: 11px; background: #e3f1f5; }
.head-text { min-width: 0; }.detail-eyebrow { margin: 2px 0 8px; color: #0095b2; font-size: 11px; font-weight: 700; letter-spacing: .06em; }.detail-eyebrow span { color: #a5b4bd; }
.head-text h1 { margin: 0 0 5px; color: var(--text); font-size: clamp(20px, 2.25vw, 29px); line-height: 1.25; letter-spacing: -.02em; }
.head-text .native { margin-bottom: 9px; }.head-text .sub { color: #708191; font-size: 12px; }
.head-text .desc { color: #667585; line-height: 1.6; }.subject-stats { gap: 12px; color: #d78b13; }.tag-list { margin: 9px 0; gap: 6px; }.tag-list span { padding: 4px 8px; border-color: #d8edf2; background: #eefafe; color: #29849b; }
.controls { align-items: center; gap: 8px; margin-bottom: 14px; padding: 10px; border: 1px solid var(--border); border-radius: 14px; background: white; }.controls select, .controls input { min-height: 39px; border-radius: 9px; background: #f7f9fb; }.controls select { max-width: 170px; }.controls button { min-height: 39px; border-radius: 9px; cursor: pointer; }.controls .next-button { margin-left: auto; background: #e8f9fd; color: #0089a9; border: 1px solid #cfedf3; white-space: nowrap; }
.stage { border-radius: 15px; box-shadow: 0 18px 30px rgba(22, 48, 61, .12); }.status { padding: 13px 16px; }.up-next { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: rgba(10, 21, 30, .75); color: white; font-size: 18px; }.up-next button { padding: 11px 18px; border: 0; border-radius: 9px; background: var(--accent); color: white; font-size: 14px; font-weight: 700; cursor: pointer; }
.playback-details { margin: 12px 0; padding: 0 13px; border: 1px solid var(--border); border-radius: 10px; background: white; color: var(--muted); font-size: 12px; }.playback-details summary { padding: 10px 0; cursor: pointer; }.playback-details[open] summary { color: #008eac; }.playback-details .source-url { margin: 0 0 8px; }
.matches { line-height: 1.9; }.matches .subj { display: inline-block; margin: 3px 4px 3px 0; padding: 2px 7px; border: 1px solid #dcf0f4; border-radius: 6px; background: #f2fbfd; text-decoration: none; font-size: 11px; }
.episodes, .source-list { border-radius: 15px; background: white; box-shadow: 0 6px 22px rgba(31, 63, 79, .045); }.episodes { max-height: 52vh; }.episodes h3, .source-list h3 { color: var(--text); font-size: 16px; }.episodes h3 small { margin-left: 4px; color: var(--muted); font-size: 11px; font-weight: 500; }.episodes li, .channels button { background: #f5f8fa; }.episodes li.active, .channels button.active { background: var(--accent-soft); border-color: #a5e1ed; color: #008aa8; }.source-row.active { outline-color: #a6e4ee; background: var(--accent-soft); }.source-dot.ready, .source-dot.playing { background: #28beae; }
@media (max-width: 900px) { .watch { grid-template-columns: minmax(0, 1fr) 270px; gap: 14px; }.meta-head { gap: 14px; }.poster { width: 102px; height: 144px; }.controls select { max-width: 145px; } }
@media (max-width: 760px) { .watch { grid-template-columns: minmax(0, 1fr); }.side { display: flex; }.meta-head { min-height: 0; padding: 14px; }.poster { width: 88px; height: 122px; }.head-text h1 { font-size: 20px; }.controls select { max-width: none; flex: 1; }.controls input { flex: 2; }.episodes { max-height: none; } }
@media (max-width: 460px) { .poster { width: 76px; height: 106px; }.head-text .desc { display: none; }.controls { gap: 7px; }.controls select { flex-basis: 100%; }.controls input { flex-basis: 55%; }.controls .next-button { margin-left: 0; }.meta-head { margin-bottom: 10px; } }
</style>


<style scoped>
.player-tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0; font-size:13px }
.player-tools label { display:flex; align-items:center; gap:5px }
.player-tools input[type="number"] { width:58px }
.player-tools button,.player-tools select { min-height:36px }
.stage { overflow: visible; margin-bottom: 65px; }
.stage video { position: absolute; inset: 0; border-radius: inherit; }
.stage :deep(.danmaku-bar) { position: absolute; top: 100%; left: 0; right: 0; }
@media (max-width: 560px) { .stage { margin-bottom: 85px; } }
</style>
