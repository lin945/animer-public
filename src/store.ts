import type { BangumiSubject } from './api'

// 目录层（Bangumi）与播放层（源站）解耦：
// 搜索得到 Bangumi subject；详情页（/watch/:id）用 id 取回元信息，再选源取流。
//
// 状态保持策略（配合 App.vue 的 <keep-alive>）：
//   1. 内存 Map  —— 前端路由跳转（搜索 ⇄ 详情）之间不丢，刷新即失效；
//   2. sessionStorage —— 刷新/直链仍能恢复，按 LRU 最多保留 MAX_CACHE 条；
//   3. 都没有时由详情页回退请求后端 /api/bgm-subject。

const SS_PREFIX = 'animer:subject:'
const SS_INDEX = 'animer:subject-index'
const MAX_CACHE = 30

const cache = new Map<number, BangumiSubject>()

function readIndex(): number[] {
  try {
    const raw = sessionStorage.getItem(SS_INDEX)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : []
  } catch {
    return []
  }
}

function writeIndex(ids: number[]) {
  try {
    sessionStorage.setItem(SS_INDEX, JSON.stringify(ids))
  } catch {
    /* 忽略：不可写时退化为纯内存缓存 */
  }
}

/** 记住一个 subject：进详情页前调用（搜索结果点击） */
export function remember(subject: BangumiSubject | null | undefined): void {
  if (!subject || typeof subject.id !== 'number') return
  cache.set(subject.id, subject)
  try {
    sessionStorage.setItem(SS_PREFIX + subject.id, JSON.stringify(subject))
    const prev = readIndex().filter((id) => id !== subject.id)
    const next = [subject.id, ...prev]
    for (const dropped of next.slice(MAX_CACHE)) sessionStorage.removeItem(SS_PREFIX + dropped)
    writeIndex(next.slice(0, MAX_CACHE))
  } catch {
    /* sessionStorage 不可用（隐私模式 / 配额满）：只留内存缓存 */
  }
}

/** 取回 subject：内存 → sessionStorage；都没有返回 null（由调用方回退后端） */
export function recall(id: number): BangumiSubject | null {
  if (!Number.isFinite(id)) return null
  const hit = cache.get(id)
  if (hit) return hit
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as BangumiSubject
    if (parsed && typeof parsed.id === 'number') {
      cache.set(parsed.id, parsed)
      return parsed
    }
  } catch {
    /* 解析失败当作未缓存 */
  }
  return null
}

