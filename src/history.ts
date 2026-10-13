export interface RecentWatch {
  subjectId: number
  title: string
  cover: string
  episodeName: string
  episodeUrl: string
  position: number
  duration: number
  completed: boolean
  updatedAt: number
}

const STORAGE_KEY = 'animer:recent:v1'
const MAX_RECENT = 12

export function recentWatches(): RecentWatch[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is RecentWatch =>
      row !== null && typeof row === 'object'
      && Number.isInteger(row.subjectId) && row.subjectId > 0
      && typeof row.title === 'string' && typeof row.cover === 'string'
      && typeof row.episodeName === 'string' && typeof row.episodeUrl === 'string'
      && Number.isFinite(row.position) && Number.isFinite(row.duration)
      && typeof row.completed === 'boolean' && Number.isFinite(row.updatedAt)
    ).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function recentFor(subjectId: number): RecentWatch | undefined {
  return recentWatches().find((row) => row.subjectId === subjectId)
}

function write(rows: RecentWatch[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX_RECENT)))
  } catch {
    // 浏览器禁止本地存储时，播放本身不受影响。
  }
}

export function rememberEpisode(subject: { id: number; name_cn: string; name: string; cover: string }, episode: { name: string; url: string }): RecentWatch {
  const rows = recentWatches()
  const previous = rows.find((row) => row.subjectId === subject.id)
  const episodeKey = (name: string) => {
    const value = name.normalize('NFKC').trim()
    const number = value.match(/^(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*(?:集|话|話)|$)/)?.[1]
    return number ? `episode:${Number(number)}` : value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  }
  const sameEpisode = previous && episodeKey(previous.episodeName) === episodeKey(episode.name)
  const row: RecentWatch = {
    subjectId: subject.id,
    title: subject.name_cn || subject.name,
    cover: subject.cover,
    episodeName: episode.name,
    episodeUrl: episode.url,
    position: sameEpisode ? previous.position : 0,
    duration: sameEpisode ? previous.duration : 0,
    completed: sameEpisode ? previous.completed : false,
    updatedAt: Date.now(),
  }
  write([row, ...rows.filter((item) => item.subjectId !== subject.id)])
  return row
}

export function updateRecentProgress(subjectId: number, episodeUrl: string, position: number, duration: number, ended = false): void {
  if (!Number.isFinite(position) || position < 0) return
  const rows = recentWatches()
  const row = rows.find((item) => item.subjectId === subjectId && item.episodeUrl === episodeUrl)
  if (!row) return
  row.position = Math.floor(position)
  row.duration = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : row.duration
  row.completed = ended || (row.duration > 30 && row.position / row.duration >= 0.95)
  row.updatedAt = Date.now()
  write([row, ...rows.filter((item) => item.subjectId !== subjectId)])
}

export function formatWatchTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}


/** Explicit local-only clear; never sends viewing history to the service. */
export function clearRecentWatches(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be unavailable. */ }
}
