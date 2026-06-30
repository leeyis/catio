/* Saved port-forward connections — reusable L/R/D forwards persisted to
 * localStorage and shown in the sidebar like SSH/DB connections. Opening one
 * ensures its SSH host session, then establishes the tunnel. Mirrors the
 * reactive pub/sub of dbConnections so the sidebar updates on save/remove. */
import { useSyncExternalStore } from 'react'
import { storeLoad, storeUpsert, storeRemove, onStoresChanged, type StoreItem } from '../services/userStore'

export interface TunnelProfile extends StoreItem {
  id: string
  name: string
  /** Forward kind: Local / Remote / Dynamic SOCKS. */
  kind: 'L' | 'R' | 'D'
  /** Bind address, e.g. "127.0.0.1:8080" (local) or ":0". */
  bind: string
  /** Target "host:port" — required for L/R, absent for D. */
  target?: string
  /** SSH host connection id used to establish the session before forwarding. */
  hostProfileId: string
  group?: string
}

const STORE = 'tunnel-connections'
const KEY = 'catio-tunnel-connections'

export function generateTunnelId(): string {
  const rnd = Math.random().toString(36).slice(2, 8)
  return `tun-${rnd}${(Date.now() % 100000).toString(36)}`
}

export function listTunnelConnections(): TunnelProfile[] {
  return storeLoad<TunnelProfile>(STORE, KEY)
}

export function saveTunnelConnection(p: TunnelProfile): void {
  storeUpsert(STORE, KEY, p)
  notify()
}

export function removeTunnelConnection(id: string, ownerId?: number): void {
  storeRemove<TunnelProfile>(STORE, KEY, id, ownerId)
  notify()
}

// ---- Reactive layer (pub/sub + useSyncExternalStore) ----
const _listeners = new Set<() => void>()
let _snapshot: TunnelProfile[] = listTunnelConnections()
function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
function getSnapshot(): TunnelProfile[] {
  return _snapshot
}
function notify(): void {
  _snapshot = listTunnelConnections()
  _listeners.forEach(fn => fn())
}
onStoresChanged(notify)

export function useTunnelConnections(): TunnelProfile[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
