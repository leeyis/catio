// Recently-opened connections, persisted to localStorage so the home screen's
// "最近会话" surfaces what the user actually worked on (most-recent first,
// de-duped by connection id, capped). We store only the connId + timestamp; the
// display data (name/engine/status) is resolved against the live vault at render
// time so a renamed/deleted connection never shows stale info.

const KEY = 'catio-recent-sessions'
const CAP = 8

export interface RecentSession {
  connId: string
  ts: number
}

export function loadRecentSessions(): RecentSession[] {
  try {
    const r = localStorage.getItem(KEY)
    return r ? (JSON.parse(r) as RecentSession[]) : []
  } catch {
    return []
  }
}

/** Record (or bump) a connection as the most-recent session. */
export function recordRecentSession(connId: string): void {
  if (!connId) return
  const next = [{ connId, ts: Date.now() }, ...loadRecentSessions().filter(s => s.connId !== connId)].slice(0, CAP)
  localStorage.setItem(KEY, JSON.stringify(next))
}

export function clearRecentSessions(): void {
  localStorage.removeItem(KEY)
}
