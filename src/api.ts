// Thin wrapper around the Pages Functions backend (/api/*).

export interface AnimeItem {
  id: number
  title: string
  titleNative: string
  cover: string
  format: string
  status: string
  episodes: number | null
  year: number | null
  genres: string[]
}

export interface AnimeDetail {
  id: number
  title: string
  titleNative: string
  description: string
  cover: string
  banner: string
  format: string
  status: string
  episodes: number | null
  season: string
  year: number | null
  genres: string[]
  averageScore: number | null
}

// Bangumi（bgm.tv）目录条目：搜索层只依赖它，与播放源解耦（参考 animeko）
export interface BangumiSubject {
  id: number
  name: string // 原名（日文/英文）
  name_cn: string // 中文名
  summary: string
  eps: number | null
  air_date: string
  cover: string // https 封面地址
  tags: string[]
  rating: { score: number | null; total: number | null }
  rank: number | null
}

export interface BangumiCalendarDay {
  weekday: { en: string; cn: string; ja: string; id: number }
  items: BangumiSubject[]
}

export interface DanmakuItem {
  time_seconds: number
  text: string
  mode: 'rtl' | 'top' | 'bottom'
  color: string
}

function mapBangumiSubject(x: any): BangumiSubject {
  return {
    id: x.id,
    name: x.name || '',
    name_cn: x.name_cn || '',
    summary: x.summary || '',
    eps: x.eps ?? x.total_episodes ?? null,
    air_date: x.date || x.air_date || '',
    cover: (x.images?.large || x.images?.common || x.images?.medium || '').replace('http://', 'https://'),
    tags: (x.tags || []).map((tag: any) => typeof tag === 'string' ? tag : tag.name).filter(Boolean),
    rating: { score: Number.isFinite(Number(x.rating?.score)) ? Number(x.rating.score) : null, total: Number.isFinite(Number(x.rating?.total)) ? Number(x.rating.total) : null },
    rank: Number.isFinite(Number(x.rank)) ? Number(x.rank) : null,
  }
}

export interface MediaSource {
  id: number
  name: string
  homepage: string | null
  icon_url: string | null
  enabled: number
  /** 源健康度：ok / blocked / broken / unknown（由后端按真实请求结果记账） */
  health: string
  health_reason: string | null
  health_checked_at: number | null
  /** 连续失败次数；达到阈值后后端会自动把源 enabled=0 */
  fail_count: number
  /** 用户手动关掉的源，自动健康检查不会把它重新打开 */
  manual_disabled: number
  /** Legacy compatibility field; public results always use false. */
  has_credentials: boolean
  /** animeko 的 onlySupportsPlayers：该源声明的可用播放器（仅作提示） */
  only_supports_players: string[]
}

export interface LinkItem {
  name: string
  url: string
  /** 源站的播放线路；无线路概念的源为 null */
  channel?: string | null
}

export interface EpisodeChannel {
  name: string
  items: LinkItem[]
}

/** 源站搜索/选集失败的原因分类（后端判定，用于决定要不要自动换源） */
export type FailureKind = 'blocked' | 'ratelimited' | 'broken' | null

export interface SourceSearchResult {
  items: LinkItem[]
  /** 后端实际命中的关键词（后端会按 animeko 规则试多个候选词） */
  usedKeyword: string | null
  health: string
  debug?: any
}

export interface SourceEpisodesResult {
  items: LinkItem[]
  channels: EpisodeChannel[]
  debug?: any
}

export interface ResolveResult {
  streamUrl: string | null
  /** Exact, server-issued signed proxy capability. Never reconstruct this URL. */
  proxyUrl: string | null
  kind: 'hls' | 'file' | null
  /** 命中的策略：config.matchVideoUrl / maccms.player_aaaa.url / json.key / raw.m3u8 / iframe 嵌套 … */
  via: string | null
  /** 取流失败的原因分类；blocked/broken 会被后端计入源健康度 */
  failureKind: FailureKind
  playPageUrl: string
  /** 播放该流需要的请求头（UA/Referer），跳转播放器时用得上 */
  headers: Record<string, string>
  debug?: any
}

export interface SubscriptionInfo {
  id: number
  name: string
  url: string
  enabled: number
  last_synced_at: number | null
  created_at: number
  source_count: number
}

export interface SubscriptionStatus {
  ok: boolean
  error?: string
  subscriptions: SubscriptionInfo[]
  totalSources: number
}

export interface SyncResult {
  ok: boolean
  created?: boolean
  synced?: number
  totalSources?: number
  errors?: string[]
  error?: string
}

async function getJSON(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return r.json()
}

// ---- AniList 目录数据：浏览器直连 ----
// AniList GraphQL 开放 CORS（Access-Control-Allow-Origin: *），浏览器可直接调用。
// 这样可绕开「Cloudflare 边缘节点 → graphql.anilist.co」的出站链路故障（线上表现为裸 502）。
// 中文源抓取（搜索/选集/取流）仍走 Worker（/api/*），因为那些源站不允许浏览器跨域。
const ANILIST = 'https://graphql.anilist.co'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const SEARCH_Q = `query ($q: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
      id title { romaji native english }
      coverImage { large medium }
      format status episodes seasonYear genres
    }
  }
}`

const DETAIL_Q = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id title { romaji native english } description(asHtml: false)
    coverImage { large extraLarge } bannerImage
    format status episodes season seasonYear genres averageScore
  }
}`

function normTitle(t: any): string {
  if (!t) return ''
  return t.romaji || t.english || t.native || ''
}

async function anilistGraphQL(query: string, variables: any): Promise<any> {
  const r = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!r.ok) throw new Error(`anilist HTTP ${r.status}`)
  const j = await r.json()
  if (j.errors) throw new Error(j.errors[0]?.message || 'anilist error')
  return j.data
}

export async function animeSearch(q: string): Promise<AnimeItem[]> {
  const data = await anilistGraphQL(SEARCH_Q, { q, page: 1, perPage: 24 })
  return (data?.Page?.media || []).map((m: any) => ({
    id: m.id,
    title: normTitle(m.title),
    titleNative: m.title?.native || '',
    cover: m.coverImage?.large || m.coverImage?.medium || '',
    format: m.format,
    status: m.status,
    episodes: m.episodes,
    year: m.seasonYear,
    genres: m.genres || [],
  }))
}

export async function animeDetail(id: number): Promise<AnimeDetail> {
  const data = await anilistGraphQL(DETAIL_Q, { id })
  const m = data?.Media
  if (!m) throw new Error('not found')
  return {
    id: m.id,
    title: normTitle(m.title),
    titleNative: m.title?.native || '',
    description: m.description || '',
    cover: m.coverImage?.extraLarge || m.coverImage?.large || '',
    banner: m.bannerImage || '',
    format: m.format,
    status: m.status,
    episodes: m.episodes,
    season: m.season,
    year: m.seasonYear,
    genres: m.genres || [],
    averageScore: m.averageScore,
  }
}

// ---- Bangumi 目录层（服务端代理，参考 animeko 用 bgm.tv 做搜索）----
// 不再浏览器直连：api.bgm.tv 对带 Content-Type:application/json 的请求触发 preflight，
// 但其对 OPTIONS 未返回 Access-Control-Allow-Headers，导致浏览器 CORS 失败。
// 改为前端调 /api/bgm-search，由 Worker 代理请求 Bangumi（见 functions/api/[[route]].ts）。
export async function bangumiSearch(q: string, signal?: AbortSignal): Promise<BangumiSubject[]> {
  const r = await fetch(`/api/bgm-search?q=${encodeURIComponent(q)}`, { signal })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const j = await r.json()
  return (j.list || []).map(mapBangumiSubject)
}

// Bangumi 条目详情（服务端代理 /api/bgm-subject）：
// 详情页直链/刷新时，本地缓存（store + sessionStorage）拿不到元信息，用 id 回源补。
export async function bangumiSubject(id: number, signal?: AbortSignal): Promise<BangumiSubject> {
  const data = await getJSON(`/api/bgm-subject?id=${encodeURIComponent(String(id))}`, signal)
  return mapBangumiSubject(data)
}

export async function bangumiCalendar(signal?: AbortSignal): Promise<BangumiCalendarDay[]> {
  const data = await getJSON('/api/bgm-calendar', signal)
  return (Array.isArray(data) ? data : []).map((day: any) => ({
    weekday: day.weekday || { en: '', cn: '每日', ja: '', id: 0 },
    items: (day.items || []).map(mapBangumiSubject),
  }))
}

export async function getDanmaku(subjectId: number, episodeUrl: string, signal?: AbortSignal): Promise<DanmakuItem[]> {
  const data = await getJSON(`/api/danmaku?subjectId=${subjectId}&episodeUrl=${encodeURIComponent(episodeUrl)}`, signal)
  return data.items || []
}

export async function sendDanmaku(payload: { subjectId: number; episodeUrl: string; timeSeconds: number; text: string; mode: 'rtl' | 'top' | 'bottom'; color: string }): Promise<void> {
  const r = await fetch('/api/danmaku', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${r.status}`)
  }
}

/** Public source metadata contains no operational health or credential details. */
export async function mediaSources(signal?: AbortSignal): Promise<MediaSource[]> {
  const data = await getJSON('/api/media-sources?enabled=1', signal)
  return (data.mediaSources || []).map((source: Partial<MediaSource>) => ({
    id: source.id, name: source.name, homepage: source.homepage ?? null,
    icon_url: source.icon_url ?? null, enabled: source.enabled ?? 1,
    health: 'unknown', health_reason: null, health_checked_at: null,
    fail_count: 0, manual_disabled: 0, has_credentials: false,
    only_supports_players: source.only_supports_players || [],
  }))
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

// HttpOnly session cookies stay in the browser's protected cookie jar. Never store tokens.
async function adminJSON(path: string, init: RequestInit = {}): Promise<any> {
  const mutation = init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase())
  const response = await fetch(`/api/admin/${path}`, {
    ...init,
    ...(mutation ? { headers: { ...init.headers, 'X-Admin-Request': '1', 'Content-Type': 'application/json' }, body: init.body ?? '{}' } : {}),
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.error || `HTTP ${response.status}`)
  if (!data) throw new ApiError(502, '管理服务返回了无效响应')
  return data
}

export interface AdminSession { authenticated: true; login: string; provider: string }

export async function adminSession(signal?: AbortSignal): Promise<AdminSession> {
  const data = await adminJSON('session', { signal })
  if (data.authenticated !== true) throw new ApiError(403, '管理员身份尚未验证')
  return data
}

export async function adminLogout(signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { 'X-Admin-Request': '1', 'Content-Type': 'application/json' }, body: '{}',
  })
  if (!response.ok) throw new ApiError(response.status, '退出登录未完成，请重试。')
}

export async function adminMediaSources(signal?: AbortSignal): Promise<MediaSource[]> {
  const data = await adminJSON('media-sources', { signal })
  return data.mediaSources || []
}

export async function subscriptionStatus(signal?: AbortSignal): Promise<SubscriptionStatus> {
  return adminJSON('subscription-status', { signal })
}

export async function syncSubscriptions(signal?: AbortSignal): Promise<SyncResult> {
  return adminJSON('subscriptions/sync', { method: 'POST', signal })
}

export async function sourceSearch(
  sourceId: number,
  keyword: string,
  opts: { fresh?: boolean; signal?: AbortSignal } = {}
): Promise<SourceSearchResult> {
  const q = `sourceId=${sourceId}&keyword=${encodeURIComponent(keyword)}${opts.fresh ? '&fresh=1' : ''}`
  const data = await getJSON(`/api/search?${q}`, opts.signal)
  return {
    items: data.items || [],
    usedKeyword: data.usedKeyword ?? null,
    health: data.health || 'unknown',
    debug: data.debug,
  }
}

export async function sourceEpisodes(
  sourceId: number,
  subjectUrl: string,
  opts: { fresh?: boolean; signal?: AbortSignal } = {}
): Promise<SourceEpisodesResult> {
  const q = `sourceId=${sourceId}&subjectUrl=${encodeURIComponent(subjectUrl)}${opts.fresh ? '&fresh=1' : ''}`
  const data = await getJSON(`/api/episodes?${q}`, opts.signal)
  return { items: data.items || [], channels: data.channels || [], debug: data.debug }
}

/**
 * 取流。后端会把播放页里的流地址「离线化」抽出来：
 * matchVideoUrl 正则 → MacCMS player_aaaa → 通用 JS/JSON → 裸 m3u8/mp4 → iframe 嵌套一层再试。
 * 拿不到时返回 streamUrl: null（不抛错），由前端决定换源还是交给浏览器兜底。
 */
export async function resolveStream(
  sourceId: number,
  episodeUrl: string,
  opts: { debug?: boolean; signal?: AbortSignal } = {}
): Promise<ResolveResult> {
  const q = `sourceId=${sourceId}&episodeUrl=${encodeURIComponent(episodeUrl)}${opts.debug ? '&debug=1' : ''}`
  const data = await getJSON(`/api/resolve?${q}`, opts.signal)
  return {
    streamUrl: data.streamUrl || null,
    proxyUrl: typeof data.proxyUrl === 'string' && data.proxyUrl.startsWith('/api/play?') ? data.proxyUrl : null,
    kind: data.kind || null,
    via: data.via || null,
    failureKind: data.failureKind ?? null,
    playPageUrl: data.playPageUrl || episodeUrl,
    headers: data.headers || {},
    debug: data.debug,
  }
}

// ---- 源健康度 / 源凭据 ----

export interface SourceHealthPatch {
  enabled?: boolean
}

/** Administrator-only source activation; site credentials are never collected. */
export async function updateSource(id: number, patch: SourceHealthPatch, signal?: AbortSignal): Promise<any> {
  return adminJSON(`media-sources/${id}`, {
    method: 'PATCH', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export interface SourceHealthRow {
  id: number
  name: string
  enabled: number
  health: string
  health_reason: string | null
  health_checked_at: number | null
  fail_count: number
  manual_disabled: number
}

export interface HealthCheckSummary {
  ok: boolean
  checked?: number
  summary?: { ok: number; blocked: number; broken: number }
  results?: Array<{ id: number; name: string; status: number; health: string; reason: string | null }>
  error?: string
}

/** 让后端逐个探测源，写回 health 并把被反爬挡住的源自动下线 */
export async function checkSourceHealth(id?: number, signal?: AbortSignal): Promise<HealthCheckSummary> {
  return adminJSON(`source-health/check${id ? `?id=${id}` : ''}`, { method: 'POST', signal })
}

export async function sourceHealthList(signal?: AbortSignal): Promise<SourceHealthRow[]> {
  return adminMediaSources(signal)
}
