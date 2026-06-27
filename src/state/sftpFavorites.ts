/* SFTP path favorites + common-dir quick jumps. Stored globally in localStorage
 * (paths are not host-specific enough to bother scoping, and common ops paths
 * like /var/log repeat across hosts). */

const KEY = 'catio-sftp-favorites'

/** Common directories offered as one-click jumps alongside user favorites. */
export const COMMON_DIRS = ['~', '/', '/etc', '/var/log', '/tmp', '/home', '/opt', '/usr/local']

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

export function saveFavorites(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* localStorage unavailable */ }
}

/** Add the path if absent, remove it if present. Returns the new list. */
export function toggleFavorite(path: string): string[] {
  const list = loadFavorites()
  const next = list.includes(path) ? list.filter(p => p !== path) : [...list, path]
  saveFavorites(next)
  return next
}

export function isFavorite(path: string): boolean {
  return loadFavorites().includes(path)
}
