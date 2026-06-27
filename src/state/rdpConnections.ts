/* Saved RDP connections — persisted to localStorage and shown in the sidebar like
 * SSH/DB connections. Opening one launches the platform RDP client (mstsc/xfreerdp).
 * Mirrors the reactive pub/sub of dbConnections so the sidebar updates on save/remove.
 * (No password stored — the RDP client prompts for credentials.) */
import { useSyncExternalStore } from 'react'

export interface RdpProfile {
  id: string
  name: string
  host: string
  port: number
  user?: string
  group?: string
}

const KEY = 'catio-rdp-connections'

export function generateRdpId(): string {
  const rnd = Math.random().toString(36).slice(2, 8)
  return `rdp-${rnd}${(Date.now() % 100000).toString(36)}`
}

export function listRdpConnections(): RdpProfile[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? (list as RdpProfile[]) : []
  } catch {
    return []
  }
}

export function saveRdpConnection(p: RdpProfile): void {
  if (typeof localStorage === 'undefined') return
  const all = listRdpConnections().filter(x => x.id !== p.id)
  all.push(p)
  localStorage.setItem(KEY, JSON.stringify(all))
  notify()
}

export function removeRdpConnection(id: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(listRdpConnections().filter(x => x.id !== id)))
  notify()
}

// ---- Reactive layer ----
const _listeners = new Set<() => void>()
let _snapshot: RdpProfile[] = listRdpConnections()
function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
function getSnapshot(): RdpProfile[] {
  return _snapshot
}
function notify(): void {
  _snapshot = listRdpConnections()
  _listeners.forEach(fn => fn())
}

export function useRdpConnections(): RdpProfile[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
