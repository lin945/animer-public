import { Hono, type Context } from 'hono'
import { verifyAdmin, managementRequest, accessLogin, accessLogout, authConfigured } from '../../server/admin-auth'
import { mintPlaybackUrl, verifyPlayback, createPlaybackSigner } from '../../server/playback-ticket'
import { handle } from 'hono/cloudflare-pages'

type Bindings = {
  DB: any
  CACHE: any
  ADMIN_ACCESS_TOKEN_HASH?: string
  SESSION_SECRET?: string
  APP_ORIGIN?: string
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 源站请求超时：源站挂着不返回时不能把 Worker 拖死 */
const FETCH_TIMEOUT_MS = 12000
/** 取流链路里最多抓几个页面（播放页 + 最多 2 层嵌套） */
const MAX_RESOLVE_FETCHES = 3
/** 同一源连续失败多少次后自动下线 */
const AUTO_DISABLE_AFTER = 3

const app = new Hono<{ Bindings: Bindings; Variables: { admin: { login: string; id: string; provider: 'link' } } }>()
function routes(method: 'get' | 'post' | 'patch', paths: string[], handler: (c: Context<{ Bindings: Bindings; Variables: { admin: { login: string; id: string; provider: 'link' } } }>) => Response | Promise<Response>) {
  for (const path of paths) app[method](path, handler)
}
app.use('*', async (c, next) => {
  const path = c.req.path
  if (path === '/api/play') {
    c.header('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'")
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('Cache-Control', 'no-store')
  }
  const managed = managementRequest(path, c.req.method)
  const signingIn = path === '/api/auth/access'
  if (managed || signingIn) {
    c.header('Cache-Control', 'no-store')
    if (!signingIn) {
      const identity = await verifyAdmin(c.req.raw, c.env)
      if (!identity) return c.json({ error: 'Administrator authentication required' }, 403)
      c.set('admin', identity)
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('X-Admin-Request') !== '1') {
        return c.json({ error: 'Same-origin admin request required' }, 403)
      }
      if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415)
      const bodyLimit = signingIn ? 512 : 16384
      if (Number(c.req.header('Content-Length') || 0) > bodyLimit) return c.json({ error: 'Request too large' }, 413)
      try { await boundedJson(new Response(c.req.raw.clone().body), bodyLimit) } catch { return c.json({ error: 'Valid bounded JSON body required' }, 400) }
    }
    await next()
    if (!path.startsWith('/api/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.res.status < 400) {
      // Shared cache generation makes a successful admin update invalidate public snapshots.
      try { await c.env.CACHE?.put('public:revision', crypto.randomUUID()) } catch { /* short TTL bounds stale data */ }
    }
    return
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return c.json({ error: 'Public API is read-only' }, 403)
  if (c.req.query('fresh') === '1' || c.req.query('debug') === '1') return c.json({ error: 'Administrator operation required' }, 403)
  if (c.req.url.length > (path === '/api/play' ? 24000 : 8192) || (c.req.query('keyword') || c.req.query('q') || '').length > 160) return c.json({ error: 'Request too large' }, 400)
  const cacheable = /^\/api\/(media-sources|search|episodes|bgm-search|bgm-subject|bgm-calendar|anime\/search|anime\/\d+|danmaku)$/.test(path)
  let key = ''
  if (cacheable) {
    let revision = 'initial'
    try { revision = await c.env.CACHE?.get('public:revision') || revision } catch { /* cache is optional */ }
    const url = new URL(c.req.url); url.searchParams.sort()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.pathname + url.search))
    key = `public:v1:${revision}:` + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    const cached = await cacheGet(c.env, key)
    if (cached) { c.header('X-App-Cache', 'HIT'); c.header('Cache-Control', 'public, max-age=30'); return c.json(cached) }
  }
  await next()
  if (path === '/api/play') {
    c.header('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'")
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('Cache-Control', 'no-store')
  }
  if (c.res.headers.get('Content-Type')?.includes('application/json')) {
    const data = await c.res.clone().json() as any
    for (const field of ['debug', 'health', 'health_reason', 'health_checked_at', 'fail_count', 'note', 'failureKind']) delete data[field]
    if (data.error) data.error = c.res.status >= 500 ? 'Service temporarily unavailable' : 'Unable to complete request'
    c.res = new Response(JSON.stringify(data), { status: c.res.status, headers: c.res.headers })
    if (key && c.res.status === 200 && !data.error) {
      await cachePut(c.env, key, data, 60)
      c.header('X-App-Cache', 'MISS')
      c.header('Cache-Control', 'public, max-age=30')
    } else c.header('Cache-Control', 'no-store')
  }
})
app.get('/api/admin/session', (c) => c.json({ authenticated: true, ...c.get('admin') }))
app.get('/api/auth/status', (c) => { c.header('Cache-Control', 'no-store'); return c.json({ configured: authConfigured(c.env), provider: 'link' }) })
app.post('/api/auth/access', (c) => accessLogin(c.req.raw, c.env))
app.post('/api/auth/logout', () => accessLogout())
app.onError((_, c) => c.json({ error: 'Service temporarily unavailable' }, 500))

// ============================================================
// utils
// ============================================================

function absUrl(href: string, base: string): string {
  if (!href) return href
  let h = href.trim()
  if (/^\/\//.test(h)) h = 'https:' + h // 协议相对地址
  if (/^[a-z]+:\/\//i.test(h)) return h
  try {
    return new URL(h, base).href
  } catch {
    return h
  }
}

function normalizedHref(el: any): string | null {
  const own = el?.attribs?.href
  return own && String(own).trim() ? String(own) : null
}

/**
 * 从一个匹配到的节点上取链接。
 *
 * 源配置里的选择器经常指向 `<a>` **内部的元素**，例如嘀哩嘀哩的
 * `selectEpisodesFromList: "ul.clear a span"` —— 匹配到的是 span，本身没有 href，
 * 直接读 attribs.href 就会得到 26 个节点但 0 个链接。所以按「自身 → 最近的祖先 a → 内部第一个 a」
 * 的顺序找。
 */
function nodeHref($: any, el: any): string | null {
  const own = normalizedHref(el)
  if (own) return own
  try {
    const up = $(el).closest('a')
    if (up && up.length) {
      const h = normalizedHref(up.get(0))
      if (h) return h
    }
  } catch {
    /* ignore */
  }
  try {
    const inner = $(el).find('a[href]').first()
    if (inner && inner.length) {
      const h = normalizedHref(inner.get(0))
      if (h) return h
    }
  } catch {
    /* ignore */
  }
  return null
}

function deepFind(obj: any, key: string): any {
  if (obj == null || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  for (const k of Object.keys(obj)) {
    const r = deepFind(obj[k], key)
    if (r !== undefined) return r
  }
  return undefined
}

function deepFindArray(obj: any, key: string): any[] | undefined {
  if (obj == null || typeof obj !== 'object') return undefined
  if (Array.isArray(obj[key])) return obj[key]
  for (const k of Object.keys(obj)) {
    const r = deepFindArray(obj[k], key)
    if (r !== undefined) return r
  }
  return undefined
}

// walk css1.json searchConfig to get the right selector block per format id
function subjectSelectors(sc: any) {
  const id = sc.subjectFormatId
  if (id === 'indexed') return sc.selectorSubjectFormatIndexed
  if (id === 'a') return sc.selectorSubjectFormatA
  if (id === 'jsonpath-indexed') return sc.selectorSubjectFormatJsonPathIndexed
  return sc.selectorSubjectFormatIndexed || sc.selectorSubjectFormatA || {}
}
function channelSelectors(sc: any) {
  const id = sc.channelFormatId
  if (id === 'index-grouped') return sc.selectorChannelFormatFlattened
  if (id === 'no-channel') return sc.selectorChannelFormatNoChannel
  return sc.selectorChannelFormatFlattened || sc.selectorChannelFormatNoChannel || {}
}

type EpisodeItem = { name: string; url: string; channel?: string | null }
type EpisodeChannel = { name: string; items: EpisodeItem[] }

/** `index-grouped` 源以线路 tab 与同序剧集列表配对，不能拍平成一组。 */
function channelName(text: string, pattern: any, fallback: string): string {
  const raw = (text || '').trim()
  if (!raw) return fallback
  if (typeof pattern !== 'string' || !pattern) return raw
  try {
    const match = new RegExp(pattern).exec(raw)
    return match?.groups?.ch?.trim() || match?.[0]?.trim() || raw
  } catch {
    return raw
  }
}

function groupEpisodes(items: EpisodeItem[]): EpisodeChannel[] {
  const groups = new Map<string, EpisodeItem[]>()
  for (const item of items) {
    const name = item.channel?.trim() || '默认线路'
    const group = groups.get(name)
    if (group) group.push(item)
    else groups.set(name, [item])
  }
  return [...groups].map(([name, grouped]) => ({ name, items: grouped }))
}

/**
 * 短的稳定 hash，用于 KV 缓存 key。
 * KV 的 key 有长度限制，直接把整条 subjectUrl 拼进去不安全。
 */
function hashKey(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36) + '-' + s.length.toString(36)
}

// 从源页里抠出来的流地址常常被 HTML 尾巴污染，例如：
//   https://x.com/a-1080p.mp4?secure=xx==,123" type="video/mp4" size="1080">
// 真地址到 `?secure=...,123` 为止，后面全是标签属性。URL 里不会出现空格/引号/尖括号，
// 因此在第一个这类字符处截断，再去掉尾部残余标点。
function cleanStreamUrl(raw: string): string {
  let s = (raw || '').trim()
  // JSON 里常见的转义斜杠 / Unicode 转义
  s = s.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/')
  s = s.replace(/^url=/, '')
  const cut = s.search(/[\s"'<>\\]/)
  if (cut >= 0) s = s.slice(0, cut)
  s = s.replace(/[),;}\]]+$/, '')
  return s
}

// 统一的诊断信息：搜不到时前端/脚本能直接看出卡在哪一步（源站反爬 vs 改版 vs 网络）
function pageTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim().slice(0, 120)
}

type FailureKind = 'blocked' | 'ratelimited' | 'broken' | null

/**
 * 判定一次源站响应是「被挡」「限流」还是「故障」。
 *
 * 对标 animeko `docs/dev/media/web-captcha.md` 的 PageEvaluator。**重要**：
 * 这个函数只能在「按 selector 解析不出内容」之后才调用（解析优先）。
 * 正常页面里嵌一句 reCAPTCHA / Turnstile 脚本、或正文里出现 "captcha" 字样都非常常见，
 * 先分类会造成大面积误判——本次实测就把 4 个正常源（嘀嗒影视 / hanime1 / 热播之家）
 * 误标成「反爬」了。
 *
 * 返回 kind = null 表示页面正常（只是没我们要的内容）。
 */
function classifyPage(status: number, title: string, html: string): { kind: FailureKind; reason: string | null } {
  const t = title.toLowerCase()
  // 429 单独归类：限流不是验证码，延迟重试即可，不计入失败次数
  if (status === 429) return { kind: 'ratelimited', reason: '源站限流（HTTP 429）' }
  if (status === 403 || status === 468) {
    return { kind: 'blocked', reason: `源站返回 HTTP ${status}（反爬 / 地区限制 / 空 Forbidden）` }
  }
  // Cloudflare / SafeLine 挑战页判定。
  // 只认挑战平台本体，且**必须配合「页面很小」或「状态码是错误码」**：
  // 正常站点常常在自己每张页面上都挂一个 Turnstile/reCAPTCHA 组件，
  // 这时正文动辄 16–150KB；而真正的 CF 拦截页只有 ~5.8KB。不设这道门槛就会大面积误判。
  const hasChallengeMarkers = /cf-chl|challenge-platform|__cf_chl|cf-mitigated|cdn-cgi\/challenge|sl-session/i.test(html)
  if (hasChallengeMarkers && (status >= 400 || html.length < 20000)) {
    return { kind: 'blocked', reason: '源站返回 Cloudflare / Turnstile 挑战页' }
  }
  if (/just a moment|attention required|请稍候|正在验证|安全检查|verify you are human/i.test(t)) {
    return { kind: 'blocked', reason: `源站返回反爬挑战页（标题：${title}）` }
  }
  if (/域名|domain/.test(t) && /过期|停止|出售|expired|for sale/.test(t)) {
    return { kind: 'broken', reason: `源站域名疑似失效（标题：${title}）` }
  }
  if (status === 502 || status === 503 || status === 504) {
    return { kind: 'broken', reason: `源站返回 HTTP ${status}（上游故障）` }
  }
  if (status >= 500) return { kind: 'broken', reason: `源站返回 HTTP ${status}` }
  if (status === 404) return { kind: 'broken', reason: '源站返回 HTTP 404（页面不存在）' }
  // 非标准 4xx（如 444 源站拒绝连接）且响应体为空：源站故障，不是选择器问题
  if (status >= 400 && html.length < 64) {
    return { kind: 'broken', reason: `源站返回 HTTP ${status}（响应体为空，疑似拒绝连接）` }
  }
  return { kind: null, reason: null }
}

// ============================================================
// 源凭据（UA / Cookie）—— 对标 animeko 的 WebSourceCookieJar + WebSourceIdentity
// ============================================================
// cf_clearance 绑定 User-Agent：只填 cookie 不填 UA 照样被挑战，所以两个字段成对使用。

function sourceUA(row: any): string {
  const ua = row?.ua
  return typeof ua === 'string' && ua.trim() ? ua.trim() : DEFAULT_UA
}

function sourceHeaders(row: any, referer?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': sourceUA(row) }
  if (referer) h.Referer = referer
  if (row?.cookie && String(row.cookie).trim()) h.Cookie = String(row.cookie).trim()
  if (extra) Object.assign(h, extra)
  return h
}

function safeUpstreamUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const h = u.hostname.toLowerCase()
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.port &&
      h.includes('.') && !/^[0-9.]+$/.test(h) && !h.includes(':') &&
      !/(^|\.)(localhost|local|internal)$/.test(h)
  } catch { return false }
}

async function fetchPublicUrl(raw: string, options: RequestInit): Promise<Response> {
  let url = raw
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!safeUpstreamUrl(url)) throw new Error('Invalid upstream URL')
    const response = await fetch(url, { ...options, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('Location')
    await response.body?.cancel()
    if (!location) throw new Error('Invalid upstream redirect')
    url = new URL(location, url).href
  }
  throw new Error('Too many upstream redirects')
}

async function fetchSource(row: any, url: string, referer?: string): Promise<Response> {
  return fetchPublicUrl(url, {
    headers: sourceHeaders(row, referer ?? row?.homepage ?? undefined),
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** 源配置里 matchVideo.addHeadersToVideo 的覆写（播放器请求最终视频/清单时用） */
function videoHeaderOverrides(sc: any): Record<string, string> {
  const mv = sc?.matchVideo || {}
  const cfg = mv.addHeadersToVideo || {}
  const out: Record<string, string> = {}
  if (typeof cfg.referer === 'string' && cfg.referer.trim()) out.Referer = cfg.referer.trim()
  if (typeof cfg.userAgent === 'string' && cfg.userAgent.trim()) out['User-Agent'] = cfg.userAgent.trim()
  return out
}

/** 源配置里写死的 cookie（animeko: matchVideo.cookies，逐行 name=value） */
function configCookies(sc: any): string {
  const raw = sc?.matchVideo?.cookies
  if (typeof raw !== 'string' || !raw.trim()) return ''
  return raw
    .split('\n')
    .map((l: string) => l.trim())
    .filter(Boolean)
    .join('; ')
}

/** 合并各处 cookie：源配置的 + 用户粘贴的（用户优先，后写的同名覆盖） */
function mergedCookie(row: any, sc: any): string {
  const map = new Map<string, string>()
  for (const part of [configCookies(sc), String(row?.cookie || '')]) {
    for (const kv of part.split(';')) {
      const t = kv.trim()
      if (!t) continue
      const name = t.split('=')[0]!.trim()
      if (!name) continue
      map.set(name, t)
    }
  }
  return [...map.values()].join('; ')
}

/**
 * 把「源配置里写死的 cookie」与「用户粘贴的 cookie」合并后放回 `row.cookie`，
 * 这样下游所有请求（搜索/选集/取流/流代理）用同一份 cookie 真相。
 */
function withCredentials(row: any): any {
  if (!row) return row
  const sc = safeJson(row.search_config) || {}
  // Viewer authentication cookies must never become shared server credentials.
  row.cookie = null
  row.ua = null
  return row
}

// ============================================================
// 关键词规整 —— 对标 animeko MediaSourceEngineHelpers.getSearchKeyword
// ============================================================
// animeko 默认 searchUseOnlyFirstWord=true（只取第一个词）+ searchRemoveSpecial=true
// （删掉「电影/剧场版/OVA/OAD/总集篇」等标记词，否则「剧场版 命运石之门」会以「剧场版」当关键词）。
//
// 我们比 animeko 更保守一点：**先试完整名字**（保持现状不回归），把规整后的词作为后续候选。
const MARKER_WORDS = ['电影', '剧场版', '劇場版', 'OVA', 'OAD', '总集篇', '總集篇', '特别篇', '特別篇', '番外篇']

function removeSpecials(name: string): string {
  let s = name
  for (const m of MARKER_WORDS) s = s.split(m).join(' ')
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ') // 去掉括号补充说明
  s = s.replace(/[～~].*$/, ' ') // 去掉「～副标题～」
  return s.replace(/\s+/g, ' ').trim()
}

function firstWord(s: string): string {
  const i = s.indexOf(' ')
  return i < 0 ? s : s.slice(0, i) || s
}

/** 按优先级生成搜索关键词候选（去重、去空） */
function keywordCandidates(name: string, sc: any): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const t = (s || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(name)
  const removeSpecial = sc?.searchRemoveSpecial !== false
  const onlyFirstWord = sc?.searchUseOnlyFirstWord !== false
  const stripped = removeSpecial ? removeSpecials(name) : name
  if (stripped !== name.trim()) push(stripped)
  if (onlyFirstWord) {
    push(firstWord(stripped))
    push(firstWord(name))
  }
  return out.slice(0, 4)
}

// ============================================================
// KV 缓存 —— 对标 animeko 的 searchCacheTtl + 剧集缓存
// ============================================================

function cacheTtlSeconds(sc: any): number {
  const raw = sc?.searchCacheTtl
  // animeko 把 Duration 序列化成毫秒；缺省 2 小时；0 表示禁用缓存
  const ms = typeof raw === 'number' && isFinite(raw) ? raw : 2 * 60 * 60 * 1000
  if (ms <= 0) return 0
  return Math.max(60, Math.round(ms / 1000))
}

async function cacheGet(env: any, key: string): Promise<any | null> {
  try {
    const v = await env?.CACHE?.get(key, 'json')
    return v || null
  } catch {
    return null
  }
}

async function cachePut(env: any, key: string, value: any, ttl: number): Promise<void> {
  if (!ttl) return
  try {
    await env?.CACHE?.put(key, JSON.stringify(value), { expirationTtl: ttl })
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

async function cacheDelete(env: any, key: string): Promise<void> {
  try {
    await env?.CACHE?.delete(key)
  } catch {
    /* cache invalidation is best-effort */
  }
}

function trustedSourcePage(row: any, raw: string): boolean {
  if (!safeUpstreamUrl(raw)) return false
  const sc = safeJson(row.search_config) || {}
  const origins = [row.homepage, sc.rawBaseUrl, sc.searchUrl].flatMap(value => {
    try { return typeof value === 'string' ? [new URL(value).origin] : [] } catch { return [] }
  })
  return origins.includes(new URL(raw).origin)
}

/** Shared source snapshot excludes historic credentials and avoids a SQL lookup per media segment. */
async function publicSource(env: Bindings, sourceId: string): Promise<any | null> {
  if (!/^\d{1,12}$/.test(sourceId)) return null
  let revision = 'initial'
  try { revision = await env.CACHE?.get('public:revision') || revision } catch { /* cache optional */ }
  const key = `source:v1:${revision}:${sourceId}`
  const cached = await cacheGet(env, key)
  if (cached) return cached.row
  const row = await env.DB.prepare('SELECT id, name, homepage, match_video_url, search_config, enabled FROM media_sources WHERE id = ? AND enabled = 1').bind(sourceId).first()
  if (!row) { await cachePut(env, key, { row: null }, 60); return null }
  const sanitized = { id: row.id, name: row.name, homepage: row.homepage, match_video_url: row.match_video_url, search_config: row.search_config, enabled: row.enabled }
  await cachePut(env, key, { row: sanitized }, 60)
  return sanitized
}

// ============================================================
// 源健康度 —— 对标 animeko「被挡就标记，站点恢复自愈」
// ============================================================

async function recordHealth(db: any, row: any, kind: FailureKind, reason: string | null): Promise<void> {
  try {
    const now = Date.now()
    if (kind === null) {
      // 成功：重置失败计数（站点恢复后自动回到「可用」）
      await db
        .prepare(
          `UPDATE media_sources SET health = 'ok', health_reason = NULL, health_checked_at = ?, fail_count = 0
           WHERE id = ? AND (health <> 'ok' OR fail_count <> 0 OR health_checked_at IS NULL)`
        )
        .bind(now, row.id)
        .run()
      return
    }
    if (kind === 'ratelimited') {
      // 限流不算失败，只更新时间
      await db
        .prepare(`UPDATE media_sources SET health_checked_at = ? WHERE id = ?`)
        .bind(now, row.id)
        .run()
      return
    }
    const failCount = Number(row.fail_count || 0) + 1
    const shouldDisable = kind === 'blocked' && failCount >= AUTO_DISABLE_AFTER && !row.manual_disabled
    await db
      .prepare(
        `UPDATE media_sources
         SET health = ?, health_reason = ?, health_checked_at = ?, fail_count = ?,
             enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END
         WHERE id = ?`
      )
      .bind(kind, reason, now, failCount, shouldDisable ? 1 : 0, row.id)
      .run()
    // 让后续请求看到最新状态
    row.health = kind
    row.health_reason = reason
    row.fail_count = failCount
    if (shouldDisable) row.enabled = 0
  } catch {
    /* 健康度是辅助信息，写失败不能影响主流程 */
  }
}

/**
 * 只读地探测一个源当前是否可用（用于「健康检查」按钮）。
 *
 * 复用 doSourceSearch（从而复用同一条「解析优先」判定链），不要自己另写一套分类：
 * 否则会出现「搜索页明明能解析、健康检查却说被反爬」的自相矛盾。
 */
async function probeSource(row: any): Promise<{ kind: FailureKind; reason: string | null; status: number }> {
  const sc = safeJson(row.search_config) || {}
  if (!sc.searchUrl) return { kind: 'broken', reason: '该源配置缺少 searchUrl', status: 0 }
  try {
    const probeKeyword = '海贼王'
    const res = await doSourceSearch(row, probeKeyword)
    return {
      kind: res.failure.kind,
      reason: res.failure.reason,
      status: Number(res.debug?.upstreamStatus || 0),
    }
  } catch (e: any) {
    return { kind: 'broken', reason: '探测失败：' + String(e?.message || e), status: 0 }
  }
}

// ============================================================
// health
// ============================================================
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// ============================================================
// 订阅源管理（Phase 1 地基）
// ============================================================
async function boundedJson(response: Response, limit = 1024 * 1024): Promise<any> {
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Subscription exceeds size limit')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function publicHttps(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      u.hostname.includes('.') && !/^([0-9.]+|.*\.(local|localhost|internal|test|invalid))$/i.test(u.hostname) && !u.hostname.includes(':')
  } catch { return false }
}

async function syncSubscription(db: any, sub: any) {
  if (!publicHttps(sub.url)) throw new Error('Public HTTPS subscription URL required')
  // Redirects are deliberately not followed: admin must specify the actual feed URL.
  const res = await fetch(sub.url, { redirect: 'error', headers: { 'User-Agent': DEFAULT_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error('fetch subscription failed: ' + res.status)
  const data = await boundedJson(res)
  const msList: any[] = deepFindArray(data, 'mediaSources') || []
  if (!msList.length || msList.length > 100) throw new Error('Subscription must contain 1–100 sources')
  // Parse and validate everything before any write. Preserve IDs and manual settings.
  const incoming = msList.map(ms => {
    const a = ms.arguments || ms
    const name = String(a.name || '').trim()
    const homepage = a.searchConfig?.rawBaseUrl || a.homepage || a.baseUrl || null
    const searchConfig = JSON.stringify(a.searchConfig || a)
    if (!name || name.length > 200 || searchConfig.length > 32768) throw new Error('Invalid source configuration')
    return { name, homepage, icon: a.iconUrl || null, match: deepFind(ms, 'matchVideoUrl') || null, config: searchConfig }
  })
  const identities = incoming.map(x => `${x.name}\n${x.homepage || ''}`)
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate source identities')
  const existing = (await db.prepare('SELECT * FROM media_sources WHERE subscription_id = ?').bind(sub.id).all()).results || []
  const statements: any[] = []
  for (const item of incoming) {
    const old = existing.find((x: any) => x.name === item.name && (x.homepage || '') === (item.homepage || ''))
    if (!old) statements.push(db.prepare(`INSERT INTO media_sources
      (subscription_id, name, icon_url, homepage, match_video_url, search_config, enabled, health, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'unknown', ?)`).bind(sub.id, item.name, item.icon, item.homepage, item.match, item.config, Date.now()))
    else if (old.icon_url !== item.icon || old.match_video_url !== item.match || old.search_config !== item.config) {
      statements.push(db.prepare('UPDATE media_sources SET icon_url = ?, match_video_url = ?, search_config = ? WHERE id = ?')
        .bind(item.icon, item.match, item.config, old.id))
    }
  }
  // Removed sources are disabled, not irreversibly deleted. No silent reset of admin choices.
  for (const old of existing) if (old.enabled && !identities.includes(`${old.name}\n${old.homepage || ''}`)) {
    statements.push(db.prepare('UPDATE media_sources SET enabled = 0 WHERE id = ?').bind(old.id))
  }
  if (statements.length > 200) throw new Error('Too many source changes in one sync')
  statements.push(db.prepare('UPDATE subscription_sources SET last_synced_at = ? WHERE id = ?').bind(Date.now(), sub.id))
  await db.batch(statements)
  return incoming.length
}

routes('get', ['/api/subscriptions', '/api/admin/subscriptions'], async (c) => {
  try {
    const rows = await c.env.DB.prepare('SELECT * FROM subscription_sources ORDER BY id DESC').all()
    return c.json({ subscriptions: rows.results || [] })
  } catch (e: any) {
    // D1 未初始化（本地空库/迁移未执行/DB 绑定缺失）时优雅降级
    return c.json({ subscriptions: [], error: String(e?.message || e) })
  }
})

routes('post', ['/api/subscriptions', '/api/admin/subscriptions'], async (c) => {
  let name: string | undefined
  let url: string | undefined
  try {
    const b = await c.req.json<{ name?: string; url?: string }>()
    name = b.name
    url = b.url
  } catch {
    /* ignore */
  }
  if (!name || name.length > 200 || !url || !publicHttps(url)) return c.json({ error: 'name and public HTTPS URL required' }, 400)
  const info = await c.env.DB
    .prepare('INSERT INTO subscription_sources (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
    .bind(name, url, Date.now())
    .run()
  const id = (info.meta as any)?.last_row_id
  try {
    const sub = await c.env.DB.prepare('SELECT * FROM subscription_sources WHERE id = ?').bind(id).first()
    const synced = await syncSubscription(c.env.DB, sub)
    return c.json({ id, synced })
  } catch (e: any) {
    return c.json({ id, syncError: String(e?.message || e) }, 207)
  }
})

routes('post', ['/api/subscriptions/:id/sync', '/api/admin/subscriptions/:id/sync'], async (c) => {
  const id = c.req.param('id')
  const sub = await c.env.DB.prepare('SELECT * FROM subscription_sources WHERE id = ?').bind(id).first()
  if (!sub) return c.json({ error: 'not found' }, 404)
  try {
    const synced = await syncSubscription(c.env.DB, sub)
    return c.json({ synced })
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// 订阅总览：便于前端首页展示「订阅是否正常」
routes('get', ['/api/subscription-status', '/api/admin/subscription-status'], async (c) => {
  try {
    const subs = await c.env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM media_sources m WHERE m.subscription_id = s.id) AS source_count
       FROM subscription_sources s ORDER BY s.id DESC`
    ).all()
    const total = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM media_sources WHERE enabled = 1').first()
    return c.json({ ok: true, subscriptions: subs.results || [], totalSources: (total?.c as number) || 0 })
  } catch (e: any) {
    // D1 未初始化 / DB 绑定缺失：返回 ok:false，前端展示「数据库未连接」
    return c.json({ ok: false, error: String(e?.message || e), subscriptions: [], totalSources: 0 })
  }
})

// 一键同步全部订阅（若还没有订阅，则自动创建 animeko 默认源）
const ANIMEKO_CSS1 = 'https://sub.creamycake.org/v1/css1.json'
routes('post', ['/api/subscriptions/sync', '/api/admin/subscriptions/sync'], async (c) => {
  try {
    const subs = await c.env.DB.prepare('SELECT * FROM subscription_sources ORDER BY id').all()
    const list: any[] = subs.results || []
    if (list.length > 10) return c.json({ error: 'Sync at most 10 subscriptions per request' }, 400)
    if (list.length === 0) {
      const info = await c.env.DB
        .prepare('INSERT INTO subscription_sources (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
        .bind('animeko', ANIMEKO_CSS1, Date.now())
        .run()
      const id = (info.meta as any)?.last_row_id
      const sub = await c.env.DB.prepare('SELECT * FROM subscription_sources WHERE id = ?').bind(id).first()
      const n = await syncSubscription(c.env.DB, sub)
      return c.json({ ok: true, created: true, synced: n, totalSources: n })
    }
    let synced = 0
    const errors: string[] = []
    for (const sub of list) {
      try {
        synced += await syncSubscription(c.env.DB, sub)
      } catch (e: any) {
        errors.push(`${sub.name}: ${e?.message || e}`)
      }
    }
    const total = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM media_sources WHERE enabled = 1').first()
    return c.json({ ok: true, synced, totalSources: (total?.c as number) || 0, errors })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) }, 200)
  }
})

// 源列表。`enabled=1` 只返回可用源；`compact=1` 精简字段（前端列表用）
routes('get', ['/api/media-sources', '/api/admin/media-sources'], async (c) => {
  try {
    const isAdmin = c.req.path.startsWith('/api/admin/')
    const enabled = !isAdmin || c.req.query('enabled')
    const sql = enabled
      ? 'SELECT * FROM media_sources WHERE enabled = 1 ORDER BY id'
      : 'SELECT * FROM media_sources ORDER BY id'
    const rows = await c.env.DB.prepare(sql).all()
    const list = (rows.results || []).map((r: any) => {
      const sc = safeJson(r.search_config) || {}
      if (!isAdmin) return { id: r.id, name: r.name, icon_url: r.icon_url, enabled: r.enabled, only_supports_players: Array.isArray(sc.onlySupportsPlayers) ? sc.onlySupportsPlayers : [] }
      return {
        id: r.id,
        name: r.name,
        homepage: r.homepage,
        icon_url: r.icon_url,
        enabled: r.enabled,
        health: r.health || 'unknown',
        health_reason: r.health_reason || null,
        health_checked_at: r.health_checked_at || null,
        fail_count: r.fail_count || 0,
        manual_disabled: r.manual_disabled || 0,
        has_credentials: Boolean((r.cookie && String(r.cookie).trim()) || (r.ua && String(r.ua).trim())),
        // animeko 的 onlySupportsPlayers：声明该源只支持某些播放器。
        // 我们不据此下线源（浏览器能放 m3u8/mp4），但透出来给前端提示。
        only_supports_players: Array.isArray(sc.onlySupportsPlayers) ? sc.onlySupportsPlayers : [],
      }
    })
    return c.json({ mediaSources: list })
  } catch (e: any) {
    // D1 未初始化（本地空库/迁移未执行）时优雅降级为空列表，前端不崩
    return c.json({ mediaSources: [], note: String(e?.message || e) })
  }
})

function safeJson(s: any): any | null {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

// 手动改源：启停 / 粘贴 cookie 与 UA
routes('patch', ['/api/media-sources/:id', '/api/admin/media-sources/:id'], async (c) => {
  const id = c.req.param('id')
  let body: any = {}
  try {
    body = await c.req.json()
  } catch {
    /* ignore */
  }
  const sets: string[] = []
  const binds: any[] = []
  if ('cookie' in body || 'ua' in body) return c.json({ error: 'Source credentials are not stored by this service' }, 400)
  if (typeof body.enabled === 'boolean' || typeof body.enabled === 'number') {
    const on = body.enabled ? 1 : 0
    sets.push('enabled = ?', 'manual_disabled = ?')
    binds.push(on, on ? 0 : 1)
    if (on) {
      // 手动启用时清掉「反爬」判定，让下一次请求重新验证
      sets.push('health = ?', 'health_reason = ?', 'fail_count = ?')
      binds.push('unknown', null, 0)
    }
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400)
  binds.push(id)
  try {
    await c.env.DB.prepare(`UPDATE media_sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
    const row = await c.env.DB.prepare('SELECT * FROM media_sources WHERE id = ?').bind(id).first()
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({
      ok: true,
      source: {
        id: row.id,
        enabled: row.enabled,
        health: row.health,
        health_reason: row.health_reason,
        manual_disabled: row.manual_disabled,
        has_credentials: Boolean((row.cookie && String(row.cookie).trim()) || (row.ua && String(row.ua).trim())),
      },
    })
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500)
  }
})

// 源健康检查：逐个探测（只探启用的），被挡/故障的写回 health，连续失败达阈值的自动下线
routes('post', ['/api/source-health/check', '/api/admin/source-health/check'], async (c) => {
  const onlyId = c.req.query('id')
  try {
    const sql = onlyId
      ? 'SELECT * FROM media_sources WHERE id = ?'
      : 'SELECT * FROM media_sources WHERE enabled = 1 ORDER BY id'
    const rows = onlyId
      ? await c.env.DB.prepare(sql).bind(onlyId).all()
      : await c.env.DB.prepare(sql).all()
    const list: any[] = (rows.results || []).map(withCredentials)
    if (list.length > 25) return c.json({ error: 'Check individual sources when more than 25 are enabled' }, 400)
    const results: any[] = []
    for (const row of list) {
      const r = await probeSource(row)
      await recordHealth(c.env.DB, row, r.kind, r.reason)
      results.push({
        id: row.id,
        name: row.name,
        status: r.status,
        health: r.kind || 'ok',
        reason: r.reason,
        enabled_after: row.enabled,
        fail_count: row.fail_count,
      })
    }
    const blocked = results.filter((r) => r.health === 'blocked').length
    const broken = results.filter((r) => r.health === 'broken').length
    const ok = results.filter((r) => r.health === 'ok').length
    return c.json({ ok: true, checked: results.length, summary: { ok, blocked, broken }, results })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) }, 200)
  }
})

routes('get', ['/api/source-health', '/api/admin/source-health'], async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id, name, enabled, health, health_reason, health_checked_at, fail_count, manual_disabled FROM media_sources ORDER BY id'
    ).all()
    return c.json({ ok: true, sources: rows.results || [] })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e), sources: [] })
  }
})

// ============================================================
// 播放（Phase 1 可行性验证 + 真正实现）
// ============================================================

// 1) 搜索：用 css1.json 的 searchConfig 选择器从源站搜番
// 结果为空时默认附带 debug 诊断；也可显式传 ?debug=1
async function doSourceSearch(row: any, keyword: string, opts: { debug?: boolean } = {}) {
  const sc = safeJson(row.search_config) || {}
  const cheerio = await import('cheerio')
  const template = sc.searchUrl || ''
  let sel: any = {}
  try {
    sel = subjectSelectors(sc)
  } catch {
    sel = {}
  }
  const candidates = keywordCandidates(keyword, sc)
  const debug: any = {
    step: 'search',
    keyword,
    keywordCandidates: candidates,
    usedKeyword: null,
    searchUrl: null,
    searchUrlTemplate: template || null,
    subjectFormatId: sc.subjectFormatId ?? null,
    selectors: sel,
    selectorKeys: Object.keys(sel || {}),
    configKeys: Object.keys(sc || {}),
    upstreamStatus: null,
    contentType: null,
    finalUrl: null,
    bodyLength: 0,
    pageTitle: '',
    matchNames: 0,
    matchLinks: 0,
    bodyHead: '',
    blocked: null,
    failureKind: null,
    attempts: [] as any[],
    note: '',
  }
  if (!template) {
    debug.note = '该源配置里没有 searchUrl，无法搜索'
    return { items: [] as any[], debug, usedKeyword: null, failure: { kind: 'broken' as FailureKind, reason: '该源配置缺少 searchUrl' } }
  }

  // css1.json 里有两套字段命名，必须都支持：
  //   老格式：selectNames + selectLinks（两个选择器按位置一一对应）
  //   新格式：只有 selectLists（同一个选择器，文本当名字、href 当链接）
  // 只认老格式会让新格式的源 100% 0 命中。
  const nameSel = sel.selectNames || sel.selectLists
  const linkSel = sel.selectLinks || sel.selectLists

  let lastHtml = ''

  for (const kw of candidates) {
    const searchUrl = template.replace('{keyword}', encodeURIComponent(kw))
    if (kw === candidates[0]) debug.searchUrl = searchUrl
    let res: Response
    try {
      res = await fetchSource(row, searchUrl)
    } catch (e: any) {
      // 网络层失败不换关键词重试（换了也一样），直接结束
      const failure = { kind: 'broken' as FailureKind, reason: '请求源站失败：' + String(e?.message || e) }
      debug.attempts.push({ keyword: kw, error: String(e?.message || e) })
      debug.failureKind = failure.kind
      debug.note = failure.reason
      return { items: [], debug, usedKeyword: null, failure }
    }
    const html = await res.text()
    lastHtml = html
    debug.upstreamStatus = res.status
    debug.contentType = res.headers.get('content-type')
    debug.finalUrl = res.url || searchUrl
    debug.bodyLength = html.length
    debug.pageTitle = pageTitle(html)
    debug.bodyHead = html.replace(/\s+/g, ' ').slice(0, 300)
    const cls = classifyPage(res.status, debug.pageTitle, html)

    const $ = cheerio.load(html)
    const names = nameSel ? $(nameSel).map((_, el) => $(el).text().trim()).get() : []
    const links = linkSel ? $(linkSel).map((_, el) => nodeHref($, el)).get() : []
    const items: any[] = []
    const n = Math.min(names.length, links.length)
    for (let i = 0; i < n; i++) {
      const href = links[i]
      if (href) items.push({ name: names[i], url: absUrl(href, searchUrl) })
    }
    debug.matchNames = names.length
    debug.matchLinks = links.length
    debug.attempts.push({
      keyword: kw,
      status: res.status,
      names: names.length,
      links: links.length,
      items: items.length,
      failure: cls.kind,
    })

    // animeko PageEvaluator 的硬规则 2 —— **解析优先**：
    // selector 能解析出条目就是成功，即使状态码是 4xx、即使页面里嵌了验证码/反爬脚本。
    // 先分类再解析会把大量正常页面误判成「被反爬」。
    if (items.length) {
      debug.usedKeyword = kw
      debug.blocked = null
      debug.failureKind = null
      debug.note = ''
      return { items, debug, usedKeyword: kw, failure: { kind: null, reason: null } }
    }

    // 解析不出来，这时才看页面是不是被挡 / 故障
    if (cls.kind) {
      debug.blocked = cls.reason
      debug.failureKind = cls.kind
      debug.note = cls.reason || ''
      return { items: [], debug, usedKeyword: null, failure: { kind: cls.kind, reason: cls.reason } }
    }

    // 页面正常但这个词没结果：换下一个候选关键词继续
    debug.blocked = null
    debug.failureKind = null
  }

  // 所有候选都没命中：这不是源站的故障（页面正常、只是没这个番），只记录诊断，
  // 不写进 health（否则一个搜不到的冷门番就会把源冤枉下线）。
  // 关键时刻的判别证据：页面里到底有没有「条目链接」？用于区分
  //   (a) 选择器失配（页面有大量详情页链接，是我们的选择器不对）
  //   (b) 源站确实没搜到这个词（页面明确提示无结果）
  const $ = cheerio.load(lastHtml)
  const anchors: string[] = []
  $('a[href]').each((_, el) => {
    const h = (el as any).attribs?.href
    if (h && /detail|vod|watch|subject|play|video|\/\d+\.html?$/i.test(h)) anchors.push(h)
  })
  debug.totalAnchors = $('a[href]').length
  debug.candidateLinks = [...new Set(anchors)].slice(0, 8)
  debug.noResultHint = /没有找到|沒找到|暂无|暫無|无结果|無結果|not found|no result/i.test(lastHtml)
  debug.blocked = null
  debug.failureKind = null
  debug.note = debug.candidateLinks.length
    ? `源站有 ${debug.candidateLinks.length} 类条目链接但选择器没命中：多半是该源选择器已改版（已试 ${candidates.length} 个关键词）`
    : `源站没搜到这个词（已试 ${candidates.length} 个关键词）`
  return { items: [] as any[], debug, usedKeyword: null, failure: { kind: null, reason: null } }
}

app.get('/api/search', async (c) => {
  const sourceId = c.req.query('sourceId')
  const keyword = c.req.query('keyword')
  if (!sourceId || !keyword) return c.json({ error: 'sourceId & keyword required' }, 400)
  const row = withCredentials(
    await publicSource(c.env, sourceId)
  )
  if (!row) return c.json({ error: 'source not found' }, 404)
  const sc = safeJson(row.search_config) || {}

  const fresh = c.req.query('fresh') === '1'
  const ttl = cacheTtlSeconds(sc)
  const ck = `sr3:${row.id}:${hashKey(row.search_config || "")}:${hashKey(keyword)}`
  if (!fresh) {
    const hit = await cacheGet(c.env, ck)
    if (hit && Array.isArray(hit.items)) {
      return c.json({ source: row.name, count: hit.items.length, items: hit.items, usedKeyword: hit.usedKeyword || null, cached: true })
    }
  }

  const { items, debug, usedKeyword, failure } = await doSourceSearch(row, keyword)
  await cachePut(c.env, ck, { items, usedKeyword }, items.length ? ttl : 60)

  const wantDebug = c.req.query('debug') === '1' || items.length === 0
  return c.json({
    source: row.name,
    count: items.length,
    items,
    usedKeyword,
    health: row.health || 'unknown',
    ...(wantDebug ? { debug } : {}),
  })
})

// 2) 选集：用 channel 选择器从番剧页刮出各集播放页
async function doSourceEpisodes(row: any, subjectUrl: string) {
  const sc = safeJson(row.search_config) || {}
  const cheerio = await import('cheerio')
  let ch: any = {}
  try {
    ch = channelSelectors(sc)
  } catch {
    ch = {}
  }
  const container = ch.selectEpisodeLists || ch.selectEpisodes
  const item = ch.selectEpisodesFromList || ch.selectEpisodes
  const debug: any = {
    step: 'episodes',
    subjectUrl,
    channelFormatId: sc.channelFormatId ?? null,
    selectors: ch,
    combinedSelector: container && item ? `${container} ${item}` : null,
    upstreamStatus: null,
    finalUrl: null,
    bodyLength: 0,
    pageTitle: '',
    matchNodes: 0,
    matchHrefs: 0,
    bodyHead: '',
    blocked: null,
    failureKind: null,
    note: '',
  }
  if (!container || !item) {
    debug.note = '该源配置缺少选集选择器（selectEpisodeLists / selectEpisodes）'
    return { items: [] as any[], debug, failure: { kind: 'broken' as FailureKind, reason: '该源缺少选集选择器' } }
  }
  try {
    const res = await fetchSource(row, subjectUrl)
    debug.upstreamStatus = res.status
    debug.finalUrl = res.url || subjectUrl
    const html = await res.text()
    debug.bodyLength = html.length
    debug.pageTitle = pageTitle(html)
    debug.bodyHead = html.replace(/\s+/g, ' ').slice(0, 300)
    const cls = classifyPage(res.status, debug.pageTitle, html)
    // 解析优先（同 doSourceSearch）：先刮剧集，刮到了就不管页面里有没有验证码脚本
    const $ = cheerio.load(html)
    const items: EpisodeItem[] = []
    if (sc.channelFormatId === 'index-grouped') {
      const lists = $(container)
      const channelNodes = ch.selectChannelNames ? $(ch.selectChannelNames) : $([])
      const names: string[] = []
      channelNodes.each((_, el) => {
        names.push(channelName($(el).text(), ch.matchChannelName, `线路 ${names.length + 1}`))
      })
      debug.channelNames = names
      debug.listCount = lists.length
      let nodeCount = 0
      lists.each((listIndex, list) => {
        const channel = names[listIndex] || `线路 ${listIndex + 1}`
        const links = ch.selectEpisodeLinksFromList ? $(list).find(ch.selectEpisodeLinksFromList) : null
        const episodeNodes = $(list).find(item)
        nodeCount += episodeNodes.length
        episodeNodes.each((episodeIndex, el) => {
          const linked = links?.get(episodeIndex)
          const href = linked ? nodeHref($, linked) : nodeHref($, el)
          if (href) items.push({ name: $(el).text().trim(), url: absUrl(href, subjectUrl), channel })
        })
      })
      debug.matchNodes = nodeCount
    } else {
      const nodes = $(item)
      debug.channelNames = []
      debug.listCount = 1
      debug.matchNodes = nodes.length
      nodes.each((_, el) => {
        const href = nodeHref($, el)
        if (href) items.push({ name: $(el).text().trim(), url: absUrl(href, subjectUrl), channel: null })
      })
    }
    debug.matchHrefs = items.length
    if (items.length) {
      debug.blocked = null
      debug.failureKind = null
      return { items, channels: groupEpisodes(items), debug, failure: { kind: null, reason: null } }
    }
    // 刮不到才看是不是被挡 / 故障
    if (cls.kind) {
      debug.blocked = cls.reason
      debug.failureKind = cls.kind
      debug.note = cls.reason || ''
      return { items: [] as any[], debug, failure: { kind: cls.kind, reason: cls.reason } }
    }
    // 页面拿到了但选择器 0 命中：可能是源站改版，也可能是选集走 AJAX。
    // 只记录不计数（避免误判成故障）。
    debug.blocked = null
    debug.failureKind = null
    debug.note = `页面拿到了（${debug.bodyLength} 字节）但剧集选择器「${debug.combinedSelector}」没匹配到：源站改版，或选集是 JS 动态渲染/AJAX 加载`
    return { items: [] as any[], debug, failure: { kind: null, reason: null } }
  } catch (e: any) {
    debug.note = '请求源站失败：' + String(e?.message || e)
    return { items: [] as any[], debug, failure: { kind: 'broken' as FailureKind, reason: debug.note } }
  }
}

app.get('/api/episodes', async (c) => {
  const sourceId = c.req.query('sourceId')
  const subjectUrl = c.req.query('subjectUrl')
  if (!sourceId || !subjectUrl) return c.json({ error: 'sourceId & subjectUrl required' }, 400)
  const row = withCredentials(
    await publicSource(c.env, sourceId)
  )
  if (!row) return c.json({ error: 'source not found' }, 404)
  if (!trustedSourcePage(row, subjectUrl)) return c.json({ error: 'Page is outside the configured source' }, 403)
  const sc = safeJson(row.search_config) || {}

  const fresh = c.req.query('fresh') === '1'
  const ttl = cacheTtlSeconds(sc)
  // v2：旧扁平缓存没有线路信息，必须换 key 才不会继续展示混集。
  const ck = `ep3:${row.id}:${hashKey(row.search_config || "")}:${hashKey(subjectUrl)}`
  if (!fresh) {
    const hit = await cacheGet(c.env, ck)
    if (hit && Array.isArray(hit.items)) {
      return c.json({ source: row.name, count: hit.items.length, items: hit.items, channels: Array.isArray(hit.channels) ? hit.channels : groupEpisodes(hit.items), cached: true })
    }
  }

  const { items, channels, debug, failure } = await doSourceEpisodes(row, subjectUrl)
  await cachePut(c.env, ck, { items, channels }, items.length ? ttl : 60)

  const wantDebug = c.req.query('debug') === '1' || items.length === 0
  return c.json({ source: row.name, count: items.length, items, channels: channels || [], ...(wantDebug ? { debug } : {}) })
})

// 3) 取流
// ============================================================
// 这是与 animeko 差距最大的一步。
//
// animeko 在**播放期**用 WebView(CEF) 加载播放页、拦截页面发出的全部网络请求，
// 再用 matchVideo.matchVideoUrl 正则挑出视频地址（matchNestedUrl 命中则继续嵌套加载）。
// Worker 没有浏览器、不能嗅探网络，所以只能把这条链路「离线化」：
//
//   ① matchVideoUrl / matchNestedUrl 正则（源配置原样用）
//   ② MacCMS 播放器配置：播放页里 `player_aaaa = {...}` 的 url / url_next
//      （大量国产番剧站都是 MacCMS，流地址就藏在这个 JSON 里）
//   ③ 通用 JS / JSON 形态：var main = "..."、player.url、"url":"xxx.m3u8"
//   ④ 页面里裸的 m3u8 / mp4
//   ⑤ iframe / 嵌套页：抓一层再重跑 ①~④（等价于 animeko 的 enableNestedUrl）
// ============================================================

const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|mkv|ts|m4s|webm)(\?|#|$)/i

function isMediaUrl(u: string): boolean {
  return MEDIA_EXT_RE.test(u || '') || /\/hls\/|\/hls\?|\/m3u8/i.test(u || '')
}

function kindOfMediaUrl(u: string): 'hls' | 'file' {
  return /\.m3u8|mpegurl|\/hls\//i.test(u) ? 'hls' : 'file'
}

/** 取 `{` 开始、按括号配平截出完整对象文本（尊重字符串内的括号与转义） */
function sliceBalancedObject(src: string, from: number): string | null {
  const start = src.indexOf('{', from)
  if (start < 0) return null
  let depth = 0
  let inStr: string | null = null
  for (let i = start; i < src.length && i < start + 20000; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/** 尽最大努力把一段类 JSON 文本解析成对象（MacCMS 偶尔用单引号 / 尾逗号） */
function looseJson(text: string): any | null {
  const attempts = [
    text,
    text.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1'),
    text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"'),
  ]
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {
      /* next */
    }
  }
  return null
}

/** MacCMS 的 url 可能被 encrypt 标记编码过：0 明文 / 1 百分号编码 / 2 base64 */
function macUrlVariants(raw: string, encrypt: any): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const t = cleanStreamUrl(s)
    if (t && !out.includes(t)) out.push(t)
  }
  push(raw)
  const e = Number(encrypt)
  if (e === 1 || e === 2 || Number.isNaN(e)) {
    try {
      push(decodeURIComponent(raw))
    } catch {
      /* ignore */
    }
  }
  if (e === 2 || Number.isNaN(e)) {
    try {
      // Workers 运行时提供 atob
      push(atob(raw))
    } catch {
      /* ignore */
    }
  }
  return out
}

/** 从播放页 HTML 里抽出 MacCMS `player_aaaa` / `MacPlayer` 配置里的流地址 */
function extractMacCms(html: string): { url: string; via: string; raw: any } | null {
  const anchors = ['player_aaaa', 'MacPlayerConfig', 'var MacPlayer', 'player_data']
  for (const a of anchors) {
    let idx = html.indexOf(a)
    while (idx >= 0) {
      const objText = sliceBalancedObject(html, idx)
      if (objText) {
        const obj = looseJson(objText)
        if (obj) {
          for (const key of ['url', 'url_next', 'urlNext', 'video', 'playurl']) {
            const v = obj[key]
            if (typeof v === 'string' && v.trim()) {
              for (const cand of macUrlVariants(v, obj.encrypt ?? obj.encryptUrl)) {
                if (/^https?:\/\//i.test(cand) || /^\/\//.test(cand)) {
                  return { url: cand, via: `maccms.${a}.${key}`, raw: obj }
                }
              }
            }
          }
        }
      }
      idx = html.indexOf(a, idx + 1)
    }
  }
  return null
}

/** 通用 JS / JSON 形态：var main = "..."、player.url、"url":"xxx.m3u8"、"playurl":"..." */
function extractGenericJs(html: string): { url: string; via: string } | null {
  const patterns: Array<[RegExp, string]> = [
    [/(?:var\s+)?(?:main|videoUrl|playUrl|play_url|source|src)\s*[:=]\s*["']([^"']*?(?:m3u8|mp4)[^"']*)["']/gi, 'js.var'],
    [/["'](?:url|playurl|play_url|video|src|file|source)["']\s*:\s*["']([^"']*?(?:m3u8|mp4)[^"']*)["']/gi, 'json.key'],
  ]
  for (const [re, via] of patterns) {
    const m = re.exec(html)
    if (m && m[1]) {
      const u = cleanStreamUrl(m[1])
      if (u) return { url: u, via }
    }
  }
  return null
}

/** 页面里裸的 m3u8 / mp4（优先级最低，容易撞到广告或预览片段） */
function extractRawMedia(html: string): { url: string; via: string } | null {
  const all = html.match(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)[^\s"'<>\\]*/gi) || []
  const cleaned = all.map(cleanStreamUrl).filter(Boolean)
  const hls = cleaned.find((u) => /\.m3u8/i.test(u))
  const file = cleaned.find((u) => /\.mp4/i.test(u))
  const pick = hls || file
  return pick ? { url: pick, via: hls ? 'raw.m3u8' : 'raw.mp4' } : null
}

function extractIframes(html: string): string[] {
  const out: string[] = []
  const re = /<iframe[^>]*\bsrc=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1]) out.push(m[1])
  }
  return out
}

/**
 * 页面里像「播放器 / 取流配置」的 script src。
 * MacCMS 有的模板把 player_aaaa 放在单独 js 里（有时再挂一个 ajax 配置接口），
 * 这时播放页 HTML 里只有脚本引用，流地址要再抓一层才有。
 */
function extractPlayerScripts(html: string): string[] {
  const out: string[] = []
  const re = /<script[^>]*\bsrc=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const s = m[1] || ''
    // 只认「配置文件」，排除播放器库本身：
    // dplayer.min.js / hls.min.js / ckplayer.js 这些是播放器代码，永远不含流地址，抓了纯属浪费。
    if (/playerconfig|player_config|player\.js|config.*player|player.*config|\/urls?\.js/i.test(s)) out.push(s)
  }
  return out
}

function regexHit(html: string, pattern: string): string | null {
  if (!pattern) return null
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return null // 源配置里的正则写错了：跳过，不要炸掉整个取流
  }
  const m = re.exec(html)
  if (!m) return null
  // 优先命名组 `(?<v>...)`（animeko 约定），其次第 1 个捕获组，最后整个匹配。
  // 有些源的正则里第 1 个捕获组是 `(m3u8)` 这种碎片，所以要挑真正像 URL 的那个。
  const cands = [(m.groups as any)?.v, m[1], m[0]].filter((x: any) => typeof x === 'string' && x.trim())
  for (const cand of cands) {
    const u = cleanStreamUrl(cand)
    if (/^(https?:)?\/\//i.test(u) || /\.[a-z]{2,}\//i.test(u)) return u
  }
  return cleanStreamUrl(m[0]) || null
}

type StreamHit = { url: string; via: string; kind: 'hls' | 'file' }

/** 单页内的全部取流策略（不含嵌套页） */
function extractStreamFromHtml(html: string, baseUrl: string, row: any, sc: any): StreamHit | null {
  const mv = sc?.matchVideo || {}
  const tries: Array<[string, string]> = [
    ['config.matchVideoUrl', String(mv.matchVideoUrl || '')],
    ['db.matchVideoUrl', String(row.match_video_url || '')],
  ]
  for (const [via, pat] of tries) {
    const u = regexHit(html, pat)
    if (u) return { url: absUrl(u, baseUrl), via, kind: kindOfMediaUrl(u) }
  }
  const mac = extractMacCms(html)
  if (mac) return { url: absUrl(mac.url, baseUrl), via: mac.via, kind: kindOfMediaUrl(mac.url) }

  const js = extractGenericJs(html)
  if (js) return { url: absUrl(js.url, baseUrl), via: js.via, kind: kindOfMediaUrl(js.url) }

  const raw = extractRawMedia(html)
  if (raw) return { url: absUrl(raw.url, baseUrl), via: raw.via, kind: kindOfMediaUrl(raw.url) }
  return null
}

/** 取流主流程：播放页 → （正则 / MacCMS / JS / 裸链接）→ 必要时嵌套一层再试 */
async function resolveStream(row: any, sc: any, playPageUrl: string, debug: any): Promise<StreamHit | null> {
  const mv = sc?.matchVideo || {}
  const enableNestedUrl = mv.enableNestedUrl !== false
  const tried = new Set<string>()
  const attempts: any[] = []
  debug.attempts = attempts

  // 播放页本身就是直链的情况（少数源选集页直接给 m3u8）
  if (isMediaUrl(playPageUrl)) {
    attempts.push({ url: playPageUrl, via: 'episode-url-is-media', ok: true })
    debug.via = 'episode-url-is-media'
    debug.viaDepth = 0
    return { url: playPageUrl, via: 'episode-url-is-media', kind: kindOfMediaUrl(playPageUrl) }
  }

  const queue: Array<{ url: string; depth: number }> = [{ url: playPageUrl, depth: 0 }]
  let fetches = 0
  // 只把「首层页面」的失败算作源健康度依据；嵌套页失败不计（可能只是那一层挂了）
  let primary: { status: number; kind: FailureKind; reason: string | null } | null = null

  while (queue.length) {
    const cur = queue.shift()!
    if (tried.has(cur.url) || cur.depth > 2) continue
    tried.add(cur.url)
    if (fetches >= MAX_RESOLVE_FETCHES) {
      attempts.push({ url: cur.url, skipped: `达到最大抓取次数 ${MAX_RESOLVE_FETCHES}` })
      break
    }
    fetches++

    let html = ''
    let status = 0
    let finalUrl = cur.url
    try {
      const res = await fetchSource(row, cur.url, playPageUrl)
      status = res.status
      finalUrl = res.url || cur.url
      html = await res.text()
    } catch (e: any) {
      const reason = '请求源站失败：' + String(e?.message || e)
      attempts.push({ url: cur.url, depth: cur.depth, error: String(e?.message || e) })
      if (cur.depth === 0) {
        primary = { status: 0, kind: 'broken', reason }
        debug.note = reason
      }
      continue
    }

    const title = pageTitle(html)
    const cls = classifyPage(status, title, html)
    if (cur.depth === 0) {
      primary = { status, kind: cls.kind, reason: cls.reason }
      debug.upstreamStatus = status
      debug.finalUrl = finalUrl
      debug.bodyLength = html.length
      debug.pageTitle = title
      debug.bodyHead = html.replace(/\s+/g, ' ').slice(0, 300)
      debug.blocked = cls.reason
      debug.iframes = extractIframes(html).slice(0, 3)
      debug.mediaCandidates = [
        ...new Set(html.match(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)[^\s"'<>\\]*/gi) || []),
      ].slice(0, 5)
      debug.playerHint = /player_aaaa|MacPlayerConfig|"url"\s*:\s*"|var\s+player|video\/m3u8/i.test(html)
    }

    // 解析优先：先抽流。挑战页/正常页里都可能嵌 cf 脚本，不能因为 classify 命中就跳过抽流。
    const hit = extractStreamFromHtml(html, finalUrl, row, sc)
    attempts.push({
      url: cur.url,
      depth: cur.depth,
      status,
      title,
      // 命中时不再记失败标记，避免报告里出现「blocked 但又 ok:true」的自相矛盾
      failure: hit ? null : cls.kind,
      via: hit?.via || null,
      ok: Boolean(hit),
    })

    if (hit) {
      debug.blocked = null
      debug.via = hit.via
      debug.viaDepth = cur.depth
      return hit
    }
    // 首层就被挡 / 限流：嵌套也不会有意义
    if (cls.kind) continue

    // 收集可嵌套的候选：matchNestedUrl 命中的地址 + 页面里的 iframe + 播放器配置脚本
    if (enableNestedUrl && cur.depth < 2) {
      const nested: string[] = []
      const byRegex = mv.matchNestedUrl ? regexHit(html, String(mv.matchNestedUrl)) : null
      if (byRegex) nested.push(byRegex)
      for (const iframe of extractIframes(html)) nested.push(iframe)
      // iframe / matchNestedUrl 都没有时，再赌一把播放器配置脚本
      if (!nested.length) {
        for (const js of extractPlayerScripts(html).slice(0, 2)) nested.push(js)
      }
      for (const n of nested) {
        const abs = absUrl(n, finalUrl)
        if (abs && !tried.has(abs)) queue.push({ url: abs, depth: cur.depth + 1 })
      }
    }
  }

  debug.primaryStatus = primary ? primary.status : null
  debug.primaryFailureKind = primary ? primary.kind : null
  debug.primaryFailureReason = primary ? primary.reason : null
  return null
}

app.get('/api/resolve', async (c) => {
  const sourceId = c.req.query('sourceId')
  const episodeUrl = c.req.query('episodeUrl') || c.req.query('subjectUrl')
  if (!sourceId || !episodeUrl) return c.json({ error: 'sourceId & episodeUrl required' }, 400)
  const row = withCredentials(
    await publicSource(c.env, sourceId)
  )
  if (!row) return c.json({ error: 'source not found' }, 404)
  if (!trustedSourcePage(row, episodeUrl)) return c.json({ error: 'Page is outside the configured source' }, 403)
  const sc = safeJson(row.search_config) || {}
  const debug: any = {
    step: 'resolve',
    episodeUrl,
    matchVideoUrl: row.match_video_url || null,
    /** animeko 原生的取流规则对象（我们已完整实现 matchVideoUrl / matchNestedUrl / enableNestedUrl） */
    matchVideo: sc.matchVideo ?? null,
    selectMedia: sc.selectMedia ?? null,
    onlySupportsPlayers: sc.onlySupportsPlayers ?? null,
    upstreamStatus: null,
    finalUrl: null,
    bodyLength: 0,
    pageTitle: '',
    bodyHead: '',
    blocked: null,
    failureKind: null,
    via: null,
    viaDepth: null,
    iframes: [],
    mediaCandidates: [],
    playerHint: false,
    attempts: [],
    note: '',
  }
  try {
    const hit = await resolveStream(row, sc, episodeUrl, debug)

    if (hit) {
      const overrides = videoHeaderOverrides(sc)
      if (!safeUpstreamUrl(hit.url)) return c.json({ error: 'Invalid media target' }, 502)
      let proxyUrl: string | null = null
      // An unconfigured proxy must fail closed without disabling safe direct media playback.
      if (new URL(c.req.url).origin === c.env.APP_ORIGIN) {
        try { proxyUrl = await mintPlaybackUrl(c.env, { sourceId, url: hit.url, referer: overrides.Referer || row.homepage || episodeUrl }) } catch { /* direct-only mode until signing is configured */ }
      }
      return c.json({
        proxyUrl,
        streamUrl: hit.url,
        kind: hit.kind,
        via: hit.via,
        viaDepth: debug.viaDepth,
        playPageUrl: episodeUrl,
        headers: { ...overrides, Referer: overrides.Referer || row.homepage || episodeUrl },
        ...(c.req.query('debug') === '1' ? { debug } : {}),
      })
    }

    // 首层页面的失败类型决定源健康度；「200 但解析不出流」不记为失败（可能只是我们正则没覆盖）
    const kind: FailureKind = debug.primaryFailureKind || null
    debug.failureKind = kind
    debug.note = kind
      ? kind === 'blocked'
        ? '源站反爬拦截，取不到播放页'
        : kind === 'ratelimited'
          ? '源站限流，稍后重试'
          : '源站故障，取不到播放页'
      : `播放页拿到了（${debug.bodyLength} 字节）但所有策略都没匹配到流地址：正则失配 / 需要额外跳转 / 需要登录`
    return c.json({
      streamUrl: null,
      kind: null,
      playPageUrl: episodeUrl,
      failureKind: kind,
      debug,
    })
  } catch (e: any) {
    debug.note = '请求源站失败：' + String(e?.message || e)
    return c.json({ error: String(e?.message || e), streamUrl: null, debug }, 200)
  }
})

// ---------- Bangumi 目录搜索（服务端代理，规避浏览器 CORS） ----------
// 浏览器直连 api.bgm.tv 时，请求带 Content-Type:application/json 触发 preflight，
// 而 bangumi 对 OPTIONS 未返回 Access-Control-Allow-Headers，导致 CORS 失败。
// 改为后端代理：前端只调自己的 /api/bgm-search，由 Worker 去打 Bangumi。
app.get('/api/bgm-search', async (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q required' }, 400)
  const cacheKey = `bgm:search:${hashKey(q)}`
  const cached = await cacheGet(c.env, cacheKey)
  if (cached) return c.json(cached)
  const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(q)}?type=2&responseGroup=medium`
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!upstream.ok) {
      // 429 限流 / 5xx 上游故障，原样透出状态码
      return c.json({ error: `bgm ${upstream.status}` }, upstream.status === 429 ? 429 : 502)
    }
    const body = await upstream.json()
    await cachePut(c.env, cacheKey, body, 15 * 60)
    return c.json(body)
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// 单条目详情：详情页（/watch/:id）直链或刷新时，前端本地缓存拿不到元信息，用它回源补齐。
// 走 Bangumi v0 公开接口（无需 token），仅需带 UA。
app.get('/api/bgm-subject', async (c) => {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'id required' }, 400)
  const cacheKey = `bgm:subject:${id}`
  const cached = await cacheGet(c.env, cacheKey)
  if (cached) return c.json(cached)
  const url = `https://api.bgm.tv/v0/subjects/${encodeURIComponent(id)}`
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!upstream.ok) {
      return c.json(
        { error: `bgm ${upstream.status}` },
        upstream.status === 404 ? 404 : upstream.status === 429 ? 429 : 502
      )
    }
    const body = await upstream.json()
    await cachePut(c.env, cacheKey, body, 6 * 60 * 60)
    return c.json(body)
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// Bangumi 的每日放送。日历几乎只在新番更新时变化，放 KV 一小时，避免每个访客都回源。
app.get('/api/bgm-calendar', async (c) => {
  const cacheKey = 'bgm:calendar:v1'
  const cached = await cacheGet(c.env, cacheKey)
  if (cached) return c.json(cached)
  try {
    const upstream = await fetch('https://api.bgm.tv/calendar', {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!upstream.ok) return c.json({ error: `bgm ${upstream.status}` }, upstream.status === 429 ? 429 : 502)
    const body = await upstream.json()
    await cachePut(c.env, cacheKey, body, 60 * 60)
    return c.json(body)
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// 自建弹幕池：D1 保证写入持久化，KV 缓存同一集的高频读取；不承担源站视频或第三方弹幕数据。
app.get('/api/danmaku', async (c) => {
  const subjectId = Number(c.req.query('subjectId'))
  const episodeUrl = c.req.query('episodeUrl') || ''
  if (!Number.isInteger(subjectId) || subjectId <= 0 || !episodeUrl) return c.json({ error: 'subjectId & episodeUrl required' }, 400)
  const cacheKey = `dm:${subjectId}:${hashKey(episodeUrl)}`
  const cached = await cacheGet(c.env, cacheKey)
  if (cached) return c.json(cached)
  try {
    const rows = await c.env.DB.prepare(
      'SELECT time_seconds, text, mode, color FROM danmaku WHERE subject_id = ? AND episode_url = ? ORDER BY time_seconds, id LIMIT 3000'
    ).bind(subjectId, episodeUrl).all()
    const body = { items: rows.results || [] }
    await cachePut(c.env, cacheKey, body, 10 * 60)
    return c.json(body)
  } catch (e: any) {
    return c.json({ error: '弹幕表尚未初始化，请先执行最新 D1 migration：' + String(e?.message || e) }, 503)
  }
})

// Anonymous posting is disabled by the read-only API middleware.

// ---------- AniList 目录层（Phase 2） ----------
const ANILIST = 'https://graphql.anilist.co'
async function anilist(query: string, variables: any) {
  const r = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error('anilist ' + r.status)
  const j = await r.json<{ errors?: Array<{ message?: string }>; data?: any }>()
  if (j.errors) throw new Error(j.errors[0]?.message || 'anilist error')
  return j.data
}

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

// 搜索（标题/封面），不走 D1 缓存（结果随关键词变化）
app.get('/api/anime/search', async (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q required' }, 400)
  try {
    const data = await anilist(SEARCH_Q, { q, page: 1, perPage: 24 })
    const list = (data?.Page?.media || []).map((m: any) => ({
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
    return c.json({ count: list.length, items: list })
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// 详情（含简介/类型/集数），并写回 D1 缓存（anilist_id 去重）
app.get('/api/anime/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'id required' }, 400)
  try {
    const data = await anilist(DETAIL_Q, { id })
    const m = data?.Media
    if (!m) return c.json({ error: 'not found' }, 404)
    const detail = {
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
    return c.json({ anime: detail })
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502)
  }
})

// 4) 流代理 + HLS manifest 改写（带 CORS，绕开防盗链/跨域）
// 带上 sourceId 时，代理会复用该源的 UA / Cookie（cf_clearance 那类必须与 UA 成对）。
app.get('/api/play', async (c) => {
  const grant = await verifyPlayback(c.req.raw, c.env)
  if (!grant) return c.json({ error: 'Valid playback capability required' }, 403)
  const url = c.req.query('url')
  if (!url || !safeUpstreamUrl(url)) return c.json({ error: 'Valid public media URL required' }, 400)
  const sourceId = c.req.query('sourceId')
  if (!sourceId) return c.json({ error: 'Configured source required' }, 400)
  const refererQ = c.req.query('referer') || url
  let row: any = null
  let sc: any = {}
  if (sourceId) {
    try {
      row = withCredentials(
        await publicSource(c.env, sourceId)
      )
      sc = safeJson(row?.search_config) || {}
    } catch {
      /* 拿不到就当通用代理 */
    }
  }
  if (!row) return c.json({ error: 'Enabled source required' }, 404)
  const overrides = videoHeaderOverrides(sc)
  const headers = sourceHeaders(row, overrides.Referer || refererQ, overrides)
  const range = c.req.header('range')
  if (range) headers.Range = range

  const refererForRewrite = overrides.Referer || refererQ

  const doFetch = async (h: Record<string, string>) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetchPublicUrl(url, { headers: h, signal: controller.signal })
    } finally {
      // 请求头已到达；媒体响应体仍需继续流向播放器。
      clearTimeout(timeout)
    }
  }

  let upstream: Response | null = null
  let upstreamErr = ''
  try {
    upstream = await doFetch(headers)
    if (!upstream.ok) {
      upstreamErr = `upstream HTTP ${upstream.status}`
      await upstream.body?.cancel()
      // 防盗链 CDN 的策略五花八门：有的要求特定 Referer，有的恰恰要求「不带 Referer」。
      // 第一次失败就再试一次裸请求（去掉 Referer / Origin），成本低、覆盖面广。
      const bare = { ...headers }
      delete bare.Referer
      delete bare.Origin
      const retry = await doFetch(bare)
      if (retry.ok) upstream = retry
      else upstreamErr += ` / 无 Referer 重试 ${retry.status}`
    }
  } catch (e: any) {
    upstreamErr = String(e?.message || e)
  }
  if (!upstream || !upstream.ok) {
    // 把常见的「源站自己坏了」说得清楚点，免得看起来像我们的 bug
    const msg = upstreamErr || '取流失败'
    const hint = /certificate|TLS|SSL/i.test(msg)
      ? `源站 CDN 的 TLS 证书已过期/无效，Worker 与浏览器都连不上：${msg}`
      : /internal error/i.test(msg)
        ? `无法连接到流媒体服务器（DNS/网络不可达）：${msg}`
        : msg
    return c.json({ error: hint, url }, 502)
  }

  try {
    const contentType = (upstream.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    if (/html|svg|xml|javascript/.test(contentType)) { await upstream.body?.cancel(); return c.json({ error: 'Unsupported upstream media type' }, 415) }
    const isHls = contentType.includes('mpegurl') || contentType.includes('vnd.apple') || /\.m3u8(?:$|\?)/i.test(url)
    if (isHls) {
      const text = await boundedText(upstream, 2 * 1024 * 1024)
      if (!text.trimStart().startsWith('#EXTM3U')) return c.json({ error: '上游未返回有效 HLS 清单', url }, 502)
      const rewritten = await rewriteM3u8(text, upstream.url || url, { sourceId, referer: refererForRewrite, expires: grant.expires, env: c.env })
      return new Response(rewritten, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    }
    const mediaType = /^(video|audio)\/[a-z0-9.+-]+$/.test(contentType) || ['application/octet-stream', 'binary/octet-stream', 'application/mp4', 'application/mp2t', 'text/vtt'].includes(contentType)
    const mislabeledBinary = ['', 'text/plain'].includes(contentType)
    if (!mediaType && !mislabeledBinary) { await upstream.body?.cancel(); return c.json({ error: 'Unsupported upstream media type' }, 415) }
    const responseHeaders = new Headers()
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(key)
      if (value) responseHeaders.set(key, value)
    }
    if (mislabeledBinary || contentType === 'binary/octet-stream') responseHeaders.set('content-type', 'application/octet-stream')
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (e: any) {
    return c.json({ error: '读取上游响应失败：' + String(e?.message || e), url }, 502)
  }
})

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > limit) throw new Error('Manifest too large'); chunks.push(value) } }
  finally { void reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size); let offset=0; for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length }
  return new TextDecoder().decode(bytes)
}

async function rewriteM3u8(text: string, baseUrl: string, ctx: { sourceId: string; referer: string; expires: number; env: Bindings }): Promise<string> {
  const lines = text.split('\n')
  if (lines.length > 20000) throw new Error('Manifest has too many entries')
  const urls = new Map<string,string>()
  const sign = await createPlaybackSigner(ctx.env)
  const proxyUrl = async (value: string): Promise<string> => {
    const abs = new URL(value, baseUrl).href
    if (!safeUpstreamUrl(abs)) throw new Error('Invalid manifest media URL')
    if (!urls.has(abs)) urls.set(abs,await sign({sourceId:ctx.sourceId,url:abs,referer:ctx.referer,expires:ctx.expires}))
    return urls.get(abs)!
  }
  const output: string[] = []
  for(const line of lines) {
    const t=line.trim()
    if(!t) { output.push(line); continue }
    if(t.startsWith('#')) {
      let changed=line
      for(const match of line.matchAll(/URI=(['"])(.*?)\1/gi)) changed=changed.replace(match[0],`URI=${match[1]}${await proxyUrl(match[2]!)}${match[1]}`)
      output.push(changed)
    } else output.push(await proxyUrl(t))
  }
  return output.join('\n')
}

export const onRequest = handle(app)

