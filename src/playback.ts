import type { EpisodeChannel, LinkItem, MediaSource } from './api'

function normalizedTitle(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function season(name: string): string | null {
  const value = name.normalize('NFKC').match(/第([一二三四五六七八九十\d]+)季/)?.[1]
  if (!value) return null
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'].indexOf(value)
  return chinese >= 0 ? String(chinese + 1) : String(Number(value) || value)
}

function part(name: string): string | null {
  return normalizedTitle(name).match(/第[一二三四五六七八九十\d]+季(.+篇)$/)?.[1] || null
}

/** 自动播放只接受同一作品；同季分篇允许退回整季条目。 */
export function bestSubject(items: LinkItem[], keyword: string, aliases: string[] = []): LinkItem | undefined {
  const wanted = normalizedTitle(keyword)
  const wantedSeason = season(keyword)
  const wantedPart = part(keyword)
  const candidates = items.filter((item) => (!wantedSeason || !season(item.name) || season(item.name) === wantedSeason)
    && (!wantedPart || !part(item.name) || part(item.name) === wantedPart))
  const names = [wanted, ...aliases.map(normalizedTitle)]
  const exact = candidates.find((item) => names.includes(normalizedTitle(item.name)))
  if (exact) return exact
  const equivalent = candidates.find((item) => names.some((name) => normalizedTitle(item.name).replace(/的/g, '') === name.replace(/的/g, '')))
  if (equivalent) return equivalent
  if (wantedSeason) return candidates.find((item) => season(item.name) === wantedSeason && wanted.startsWith(normalizedTitle(item.name)))
  return undefined
}

function episodeKey(name: string): string {
  const normalized = name.normalize('NFKC').trim()
  const number = normalized.match(/^(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*(?:集|话|話)|$)/)?.[1]
  return number ? `episode:${Number(number)}` : normalizedTitle(name)
}

export function sameEpisodeName(a: string, b: string): boolean {
  return episodeKey(a) === episodeKey(b)
}

/** 只重试各线路的同一集，不回到第一集，也不把 SP 与正片混用。 */
export function episodeAlternatives(channels: EpisodeChannel[], episode: LinkItem, preferredChannel?: string): LinkItem[] {
  const key = episodeKey(episode.name)
  const matches = channels.flatMap((channel) => {
    const item = channel.items.find((candidate) => episodeKey(candidate.name) === key)
    return item ? [{ ...item, channel: channel.name }] : []
  })
  const preferred = matches.find((item) => item.channel === preferredChannel)
  return [...new Map([...(preferred ? [preferred] : []), episode, ...matches].map((item) => [item.url, item])).values()]
}

export function orderedSources(sources: MediaSource[], preferredName: string | undefined, currentId: number | null, tried: number[]): MediaSource[] {
  const rank = (source: MediaSource) => {
    if (source.name === preferredName) return 0
    if (source.id === currentId) return 1
    if (source.health === 'ok') return 2
    if (source.health === 'unknown') return 3
    return 4
  }
  return sources.filter((source) => !tried.includes(source.id)).sort((a, b) => rank(a) - rank(b) || a.id - b.id)
}

/** URL/清单解析成功不等于能播，至少等到媒体数据到达并可解码。 */
export function waitForMediaReady(video: HTMLVideoElement, signal: AbortSignal, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      clearTimeout(timer)
      video.removeEventListener('loadeddata', ready)
      video.removeEventListener('canplay', ready)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      error ? reject(error) : resolve()
    }
    const ready = () => { if (video.readyState >= 2) finish() }
    const failed = () => finish(new Error(`媒体加载失败（${video.error?.code || '未知错误'}）`))
    const aborted = () => finish(signal.reason || new DOMException('播放已取消', 'AbortError'))
    timer = setTimeout(() => finish(new Error('视频加载超时')), timeoutMs)
    video.addEventListener('loadeddata', ready)
    video.addEventListener('canplay', ready)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else ready()
  })
}

