#!/usr/bin/env node
/**
 * 播放链路分阶段测试（把「搜索不到剧集」拆成 7 个可独立判定的阶段）
 *
 *   S0 后端连通        GET /api/health
 *   S1 数据层          GET /api/subscription-status + /api/media-sources（D1 绑定 + 订阅源）
 *   S2 目录层          GET /api/bgm-search（中文名/原名）+ /api/bgm-subject（详情兜底）
 *   S3 源站搜索        GET /api/search?debug=1   ← 多关键词逐个试，看是"词不对"还是"源不对"
 *   S4 源站选集        GET /api/episodes?debug=1
 *   S5 源站取流        GET /api/resolve?debug=1
 *   S6 播放代理        GET /api/play（Range 请求，看状态码/Content-Type）
 *
 * 用法：
 *   npm run test:pipeline                      # 本地 http://127.0.0.1:8788
 *   npm run test:pipeline -- 鬼灭之刃            # 指定番剧
 *   BASE=https://anime.bilibili.asia npm run test:pipeline 鬼灭之刃
 *
 * 产出：控制台简报 + log/pipeline-report.json（完整证据，UTF-8）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 项目规则：临时报告/日志一律落在 log/，不往根目录丢
const LOG_DIR = path.resolve(process.cwd(), 'log')
const REPORT_PATH = path.join(LOG_DIR, 'pipeline-report.json')
mkdirSync(LOG_DIR, { recursive: true })

const BASE = (process.env.BASE || 'http://127.0.0.1:8788').replace(/\/$/, '')
const TERM = process.argv[2] || process.env.TERM || '鬼灭之刃'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000)
const ONLY = process.env.ONLY ? String(process.env.ONLY).split(',').map((s) => s.trim()) : null

const report = { base: BASE, term: TERM, at: new Date().toISOString(), stages: {}, sources: [], summary: {} }

function mark(ok, detail) {
  return { ok: !!ok, detail }
}

async function req(path, ms = TIMEOUT_MS) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(ms) })
    const text = await r.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { __raw: text.slice(0, 400) }
    }
    return { status: r.status, ok: r.ok, body }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { status: 0, ok: false, error: timedOut ? `TIMEOUT>${ms}ms` : String(e?.message || e) }
  }
}

// 关键词变体：源站标题常常是日文原名或简称，中文全名反而不命中
function keywordVariants(s) {
  const out = []
  const push = (v) => {
    const t = (v || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(s.name_cn)
  push(s.name)
  push((s.name_cn || '').replace(/[\s:：·]/g, ''))
  push((s.name_cn || '').split(/[ 　:：—-]/)[0]) // 取冒号/横线前的主标题
  push((s.name_cn || '').slice(0, 4))
  push((s.name_cn || '').slice(0, 2))
  return out
}

// ---------- S0 后端连通 ----------
{
  const r = await req('/api/health')
  report.stages.S0_backend = mark(r.ok && r.body?.ok, `HTTP ${r.status || r.error}`)
}

// ---------- S1 数据层 ----------
{
  const st = await req('/api/subscription-status')
  const ms = await req('/api/media-sources?enabled=1')
  const sources = ms.body?.mediaSources || []
  const subs = st.body?.subscriptions || []
  const ok = st.ok && st.body?.ok === true && sources.length > 0
  report.stages.S1_data = {
    ...mark(ok, `订阅源 ${subs.length} 个 / 可用播放源 ${sources.length} 个`),
    dbOk: st.body?.ok,
    dbError: st.body?.error || null,
    note: ms.body?.note || null,
    subscriptions: subs.map((s) => ({ id: s.id, name: s.name, source_count: s.source_count })),
    // 源健康度（被反爬挡过几次的源会被自动 enabled=0，不再出现在这里的 enabled=1 列表里）
    health: sources.map((s) => ({ id: s.id, name: s.name, health: s.health || 'unknown', fail_count: s.fail_count || 0 })),
  }
}

// ---------- S2 目录层 ----------
{
  const s = await req(`/api/bgm-search?q=${encodeURIComponent(TERM)}`)
  const list = s.body?.list || []
  const first = list[0]
  let detailRet = null
  if (first) {
    const d = await req(`/api/bgm-subject?id=${first.id}`)
    detailRet = mark(d.ok && d.body?.id, `HTTP ${d.status || d.error}`)
  }
  report.stages.S2_catalog = {
    ...mark(list.length > 0, `bgm-search 「${TERM}」→ ${list.length} 条；bgm-subject ${detailRet?.detail}`),
    firstSubject: first
      ? { id: first.id, name_cn: first.name_cn, name: first.name, eps: first.eps, cover: !!first.images }
      : null,
    subjectDetail: detailRet,
  }
}

const subject = report.stages.S2_catalog?.firstSubject
if (!subject) {
  console.error(`✖ S2 失败：Bangumi 搜不到「${TERM}」，后面阶段无法继续`)
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  process.exit(1)
}
const variants = keywordVariants(subject)

// ---------- S3~S6 逐源 ----------
let sources = []
try {
  const ms = await req('/api/media-sources?enabled=1')
  sources = ms.body?.mediaSources || []
} catch {
  /* ignore */
}
if (ONLY) sources = sources.filter((s) => ONLY.includes(String(s.id)))

const stageFail = { S3_search: 0, S4_episodes: 0, S5_resolve: 0, S6_play: 0 }
const stageOk = { S3_search: 0, S4_episodes: 0, S5_resolve: 0, S6_play: 0 }

for (const src of sources) {
  const row = {
    id: src.id,
    name: src.name,
    homepage: src.homepage,
    searchUrlTemplate: null,
    searchTries: [],
    hitKeyword: null,
    episodes: { count: 0 },
    resolve: { streamUrl: null },
    play: null,
    failedAt: null,
    evidence: {},
  }

  // S3 源站搜索：多关键词逐个试
  let items = []
  for (const kw of variants) {
    const r = await req(`/api/search?sourceId=${src.id}&keyword=${encodeURIComponent(kw)}&debug=1`)
    const d = r.body?.debug || {}
    row.searchTries.push({
      keyword: kw,
      http: r.status,
      count: r.body?.count ?? null,
      error: r.body?.error || r.error || null,
      upstreamStatus: d.upstreamStatus ?? null,
      bodyLength: d.bodyLength ?? null,
      pageTitle: d.pageTitle ?? null,
      matchNames: d.matchNames ?? null,
      matchLinks: d.matchLinks ?? null,
      blocked: d.blocked ?? null,
      failureKind: d.failureKind ?? null,
      note: d.note ?? null,
      // 判别证据：选择器失配 vs 源站确实无结果
      selectors: d.selectors ?? null,
      selectorKeys: d.selectorKeys ?? null,
      configKeys: d.configKeys ?? null,
      totalAnchors: d.totalAnchors ?? null,
      candidateLinks: d.candidateLinks ?? null,
      noResultHint: d.noResultHint ?? null,
    })
    if (d.searchUrlTemplate && !row.searchUrlTemplate) row.searchUrlTemplate = d.searchUrlTemplate
    if ((r.body?.count || 0) > 0) {
      items = r.body.items
      row.hitKeyword = kw
      // 后端自己也会按 animeko 规则生成关键词候选（searchRemoveSpecial / searchUseOnlyFirstWord）
      row.usedKeyword = r.body?.usedKeyword ?? null
      break
    }
    // 硬失败（反爬 / 限流 / 故障）：换关键词也不会有结果，直接跳出，别白刷失败计数把源刷下线
    if (d.failureKind) break
  }
  if (!items.length) {
    row.failedAt = 'S3_search'
    stageFail.S3_search++
    const last = row.searchTries[row.searchTries.length - 1] || {}
    row.evidence.S3 = {
      triedKeywords: row.searchTries.map((t) => t.keyword),
      upstreamStatus: last.upstreamStatus,
      pageTitle: last.pageTitle,
      bodyLength: last.bodyLength,
      matchNames: last.matchNames,
      matchLinks: last.matchLinks,
      blocked: last.blocked,
      note: last.note,
      verdict: last.failureKind === 'blocked'
        ? '反爬'
        : last.failureKind === 'broken'
          ? '源站故障'
          : last.failureKind === 'ratelimited'
            ? '限流'
            : last.upstreamStatus == null
              ? '请求源站失败'
              : last.bodyLength > 0
                ? '页面拿到了但 0 命中（改版/选择器失配/搜索无结果）'
                : '源站返回空内容',
    }
    report.sources.push(row)
    continue
  }
  stageOk.S3_search++

  // S4 选集
  const ep = await req(
    `/api/episodes?sourceId=${src.id}&subjectUrl=${encodeURIComponent(items[0].url)}&debug=1`
  )
  const ed = ep.body?.debug || {}
  row.episodes = {
    subjectName: items[0].name,
    subjectUrl: items[0].url,
    count: ep.body?.count ?? 0,
    combinedSelector: ed.combinedSelector ?? null,
    upstreamStatus: ed.upstreamStatus ?? null,
    bodyLength: ed.bodyLength ?? null,
    pageTitle: ed.pageTitle ?? null,
    matchNodes: ed.matchNodes ?? null,
    blocked: ed.blocked ?? null,
    note: ed.note ?? null,
    error: ep.body?.error || ep.error || null,
  }
  if (!row.episodes.count) {
    row.failedAt = 'S4_episodes'
    stageFail.S4_episodes++
    report.sources.push(row)
    continue
  }
  stageOk.S4_episodes++

  // S5 取流
  const epUrl = ep.body.items[0]?.url
  row.episodes.firstEpisode = ep.body.items[0]?.name
  const rs = await req(`/api/resolve?sourceId=${src.id}&episodeUrl=${encodeURIComponent(epUrl)}&debug=1`)
  const rd = rs.body?.debug || {}
  row.resolve = {
    streamUrl: rs.body?.streamUrl || null,
    kind: rs.body?.kind || null,
    // via 说明是哪个策略命中的（maccms.* / json.key / raw.m3u8 / iframe 嵌套 …）
    via: rs.body?.via || null,
    viaDepth: rs.body?.viaDepth ?? null,
    headers: rs.body?.headers || null,
    failureKind: rs.body?.failureKind || rd.failureKind || null,
    upstreamStatus: rd.upstreamStatus ?? null,
    bodyLength: rd.bodyLength ?? null,
    pageTitle: rd.pageTitle ?? null,
    matchVideoUrl: rd.matchVideoUrl ?? null,
    blocked: rd.blocked ?? null,
    note: rd.note ?? null,
    iframes: rd.iframes ?? null,
    mediaCandidates: rd.mediaCandidates ?? null,
    playerHint: rd.playerHint ?? null,
    attempts: rd.attempts ?? null,
    error: rs.body?.error || rs.error || null,
  }
  if (!row.resolve.streamUrl) {
    row.failedAt = 'S5_resolve'
    stageFail.S5_resolve++
    report.sources.push(row)
    continue
  }
  stageOk.S5_resolve++

  // S6 播放代理：仅对 m3u8 走代理的源有意义；mp4 直链前端是浏览器直连
  if (row.resolve.streamUrl.includes('.m3u8')) {
    // 带 sourceId：代理会复用该源的 UA / Cookie（cf_clearance 那类必须与 UA 成对）
    const p = await req(
      `/api/play?url=${encodeURIComponent(row.resolve.streamUrl)}&sourceId=${src.id}&referer=${encodeURIComponent(epUrl)}`
    )
    row.play = {
      status: p.status,
      contentType: p.body?.__raw ? '(非 JSON 流)' : null,
      // 502 时后端会把上游原因写在 body.error 里（upstream HTTP xxx / 无 Referer 重试 xxx）
      upstreamError: p.body?.error || null,
      error: p.error || null,
    }
    if (p.status !== 200) {
      row.failedAt = 'S6_play'
      stageFail.S6_play++
    } else stageOk.S6_play++
  } else {
    // 直链：Cloudflare fetch 只允许标准端口白名单，非标端口由浏览器直连（前端逻辑）
    const isStdPort = /^https?:\/\/[^/]+?(:\d+)?\//.test(row.resolve.streamUrl)
    row.play = { skipped: true, reason: `直链媒体，浏览器原生播放（前端不走代理）`, isStdPort }
    stageOk.S6_play++
  }

  report.sources.push(row)
}

report.summary = {
  total: sources.length,
  endToEnd: report.sources.filter((s) => !s.failedAt).length,
  ok: stageOk,
  fail: stageFail,
  bottleneck: Object.entries(stageFail)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v})`)
    .join(' > '),
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')

const line = (id, name, r) =>
  `#${String(id).padEnd(3)} ${String(name).slice(0, 14).padEnd(16)} ${r.failedAt ? 'FAIL@' + r.failedAt : 'OK'}` +
  `  kw=${r.usedKeyword || r.hitKeyword || '-'}  eps=${r.episodes.count}` +
  (r.resolve?.via ? `  via=${r.resolve.via}` : '') +
  (r.resolve?.failureKind ? `  [${r.resolve.failureKind}]` : '')
console.log(`\n${BASE}  「${TERM}」\n${'-'.repeat(72)}`)
for (const r of report.sources) if (r.failedAt) console.log(line(r.id, r.name, r))
for (const r of report.sources) if (!r.failedAt) console.log(line(r.id, r.name, r))
console.log(
  `\n端到端可用 ${report.summary.endToEnd}/${report.summary.total}；卡点分布 ${report.summary.bottleneck || '无'}` +
    `\n完整证据 → log/pipeline-report.json\n`
)

