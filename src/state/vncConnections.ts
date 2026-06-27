/* Saved VNC connections — persisted to localStorage and shown in the sidebar like
 * SSH/DB/RDP connections. Opening one establishes an embedded VNC session. The
 * password is NOT stored here; it's kept in the session-secret store and (if the
 * vault is unlocked) the encrypted vault, like other connection credentials.
 * Mirrors the reactive pub/sub of dbConnections. */
import { useSyncExternalStore } from 'react'

export interface VncProfile {
  id: string
  name: string
  host: string
  port: number
  group?: string
}

const KEY = 'catio-vnc-connections'

export function generateVncId(): string {
  const rnd = Math.random().toString(36).slice(2, 8)
  return `vnc-${rnd}${(Date.now() % 100000).toString(36)}`
}

export function listVncConnections(): VncProfile[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? (list as VncProfile[]) : []
  } catch {
    return []
  }
}

export function saveVncConnection(p: VncProfile): void {
  if (typeof localStorage === 'undefined') return
  const all = listVncConnections().filter(x => x.id !== p.id)
  all.push(p)
  localStorage.setItem(KEY, JSON.stringify(all))
  notify()
}

export function removeVncConnection(id: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(listVncConnections().filter(x => x.id !== id)))
  notify()
}

// ---- Reactive layer ----
const _listeners = new Set<() => void>()
let _snapshot: VncProfile[] = listVncConnections()
function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
function getSnapshot(): VncProfile[] {
  return _snapshot
}
function notify(): void {
  _snapshot = listVncConnections()
  _listeners.forEach(fn => fn())
}

export function useVncConnections(): VncProfile[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
