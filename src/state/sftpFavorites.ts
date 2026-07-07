/* SFTP path favorites + common-dir quick jumps.
 * Favorites are scoped by connection id so paths from one host do not appear on another. */

const LEGACY_KEY = 'catio-sftp-favorites'
const KEY = 'catio-sftp-favorites-v2'

export const FAVORITES_STORAGE_KEYS = [LEGACY_KEY, KEY] as const

/** Common directories offered as one-click jumps alongside user favorites. */
export const COMMON_DIRS = ['~', '/', '/etc', '/var/log', '/tmp', '/home', '/opt', '/usr/local']

function cleanList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
}

function scopedKey(scope?: string | null): string | null {
  const key = scope?.trim()
  return key || null
}

function loadScopedMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [scope, list] of Object.entries(parsed)) out[scope] = cleanList(list)
    return out
  } catch {
    return {}
  }
}

function loadLegacyFavorites(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    return cleanList(raw ? JSON.parse(raw) : [])
  } catch {
    return []
  }
}

export function loadFavorites(scope?: string | null): string[] {
  const scopeKey = scopedKey(scope)
  if (!scopeKey) return loadLegacyFavorites()
  return loadScopedMap()[scopeKey] ?? []
}

export function saveFavorites(list: string[], scope?: string | null): void {
  const nextList = cleanList(list)
  try {
    const scopeKey = scopedKey(scope)
    if (!scopeKey) {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(nextList))
      return
    }
    const map = loadScopedMap()
    map[scopeKey] = nextList
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch { /* localStorage unavailable */ }
}

/** Add the path if absent, remove it if present. Returns the new list. */
export function toggleFavorite(path: string, scope?: string | null): string[] {
  const list = loadFavorites(scope)
  const next = list.includes(path) ? list.filter(p => p !== path) : [...list, path]
  saveFavorites(next, scope)
  return next
}

export function isFavorite(path: string, scope?: string | null): boolean {
  return loadFavorites(scope).includes(path)
}
