/* Persist & restore open workbench tabs across app restarts. Only tabs backed by a
 * saved profile are restorable: SSH terminal tabs (connId = SSH host profile id) and
 * DB SQL tabs (connId = DB profile id). On restore they reconnect with cached
 * credentials. Transient terminals (local/serial/telnet/mosh/VNC) and remote-file
 * tabs are not restored (no persistent profile / session-linkage to rebuild). */
import type { Tab } from '../services/types'
import { loadProfiles } from './connections'
import { listDbConnections } from './dbConnections'

const KEY = 'catio-open-tabs'

type SlimTab = Pick<Tab, 'id' | 'kind' | 'connId' | 'title'> & { path?: string }
interface Persisted {
  tabs: SlimTab[]
  activeTab: string
}

export function saveOpenTabs(tabs: Tab[], activeTab: string): void {
  try {
    const data: Persisted = {
      tabs: tabs.map(t => ({ id: t.id, kind: t.kind, connId: t.connId, title: t.title, ...(t.path ? { path: t.path } : {}) })),
      activeTab,
    }
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch { /* localStorage unavailable */ }
}

function loadRaw(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!d || !Array.isArray(d.tabs)) return null
    return d as Persisted
  } catch {
    return null
  }
}

/** Restore the subset of persisted tabs that map to a saved SSH/DB profile. Returns
 *  null when nothing restorable. */
export function restoreOpenTabs(): { tabs: Tab[]; activeTab: string } | null {
  const r = loadRaw()
  if (!r) return null
  const sshIds = new Set(loadProfiles().map(p => p.id))
  const dbIds = new Set(listDbConnections().map(p => p.id))
  const valid = r.tabs.filter(t =>
    (t.kind === 'terminal' && sshIds.has(t.connId)) ||
    (t.kind === 'sql' && dbIds.has(t.connId)),
  )
  if (valid.length === 0) return null
  const tabs: Tab[] = valid.map(t => ({ id: t.id, kind: t.kind, connId: t.connId, title: t.title, ...(t.path ? { path: t.path } : {}) }))
  const activeTab = valid.some(t => t.id === r.activeTab) ? r.activeTab : tabs[tabs.length - 1].id
  return { tabs, activeTab }
}
