/* Saved RDP connections — persisted to localStorage and shown in the sidebar like
 * SSH/DB connections. Opening one launches the platform RDP client (mstsc/xfreerdp).
 * Mirrors the reactive pub/sub of dbConnections so the sidebar updates on save/remove.
 * (No password stored — the RDP client prompts for credentials.) */
import { useSyncExternalStore } from 'react'
import { storeLoad, storeUpsert, storeRemove, onStoresChanged, type StoreItem } from '../services/userStore'

export interface RdpProfile extends StoreItem {
  id: string
  name: string
  host: string
  port: number
  user?: string
  group?: string
}

const STORE = 'rdp-connections'
const KEY = 'catio-rdp-connections'

export function generateRdpId(): string {
  const rnd = Math.random().toString(36).slice(2, 8)
  return `rdp-${rnd}${(Date.now() % 100000).toString(36)}`
}

export function listRdpConnections(): RdpProfile[] {
  return storeLoad<RdpProfile>(STORE, KEY)
}

export function saveRdpConnection(p: RdpProfile): void {
  storeUpsert(STORE, KEY, p)
  notify()
}

export function removeRdpConnection(id: string, ownerId?: number): void {
  storeRemove<RdpProfile>(STORE, KEY, id, ownerId)
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
onStoresChanged(notify)

export function useRdpConnections(): RdpProfile[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
