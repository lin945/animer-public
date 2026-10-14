// One-use in-memory handoff from the URL bootstrap to the admin view.
// Never put a capability in router state, storage, logs, or an outbound URL.
let pendingToken: string | null = null
let pendingLink = false

export function captureAdminAccess(path: string, hash: string): boolean {
  if (path !== '/admin' || !hash.startsWith('#access=')) return false
  pendingToken = null
  pendingLink = true
  const candidate = hash.slice('#access='.length)
  // Canonical base64url encoding of exactly 32 bytes (no padding).
  if (/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(candidate)) pendingToken = candidate
  return true
}

export function takeAdminAccess(): { present: boolean; token: string | null } {
  const result = { present: pendingLink, token: pendingToken }
  clearAdminAccess()
  return result
}

export function clearAdminAccess(): void {
  pendingToken = null
  pendingLink = false
}

export const ADMIN_ACCESS_EVENT = 'animer-admin-access'

// Installed before Vue Router's listeners: bookmarks/hash changes are scrubbed
// synchronously before router history, currentRoute, or view keys can retain them.
function captureLocation(): void {
  if (!captureAdminAccess(window.location.pathname, window.location.hash)) return
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    clearAdminAccess()
    window.location.replace(window.location.pathname + window.location.search)
    return
  }
  window.dispatchEvent(new Event(ADMIN_ACCESS_EVENT))
}
if (typeof window !== 'undefined') {
  captureLocation()
  window.addEventListener('popstate', captureLocation)
  window.addEventListener('hashchange', captureLocation)
}
