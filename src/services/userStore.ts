//! Per-user data persistence abstraction (web multi-user).
//!
//! DESKTOP / dev: each collection lives in its own localStorage key (single user) — unchanged.
//! SERVER (browser deploy): collections live ON THE SERVER, owned per user (admins see all). To
//! keep the existing SYNCHRONOUS store APIs (components read arrays synchronously), server mode
//! keeps an in-memory cache that is HYDRATED from the server on login and WRITTEN THROUGH on every
//! change. The cache is cleared on logout so the next user starts clean.

import { rpc, isServer } from './transport'

/** An item must have a stable string `id` (used as the server item key + dedup key). Items loaded
 *  for an admin also carry `__ownerId`/`__ownerName` so the UI can show + target the owner. */
export interface StoreItem {
  id: string
  __ownerId?: number
  __ownerName?: string
}

// Server-mode in-memory caches, keyed by store name. Hydrated on login.
const mem: Record<string, StoreItem[]> = {}
let hydrated = false

// Reactive stores register a refresh fn (their `notify`) so a hydrate/clear rebuilds their cached
// snapshots and re-renders subscribers — the module-level snapshots were built (empty) at import,
// before login, so they must be refreshed once the user's data arrives.
const refreshers = new Set<() => void>()
export function onStoresChanged(fn: () => void): void { refreshers.add(fn) }
function fireRefreshers(): void { refreshers.forEach(f => { try { f() } catch { /* ignore */ } }) }

/** True once the server stores are loaded (always true in desktop/dev). Gates UI that must not
 *  render a connection list before the user's data has arrived. */
export function storesReady(): boolean {
  return !isServer() || hydrated
}

/** Synchronous read of a collection: in-memory cache (server) or localStorage (desktop/dev). */
export function storeLoad<T extends StoreItem>(store: string, lsKey: string): T[] {
  if (isServer()) return ((mem[store] as T[] | undefined) ?? []).slice()
  try { return JSON.parse(localStorage.getItem(lsKey) ?? '[]') as T[] } catch { return [] }
}

/** The owner of an already-cached item (server mode), so edit/delete preserve ownership without
 *  every caller threading it — an ADMIN editing another user's item auto-targets that user; a
 *  normal user only has their own items, so it resolves to themselves. */
function cachedOwner(store: string, id: string): { id?: number; name?: string } {
  const it = (mem[store] ?? []).find(x => x.id === id)
  return { id: it?.__ownerId, name: it?.__ownerName }
}

/** Insert/replace one item by id. Server mode writes through to the OWNER's row (the item's
 *  `__ownerId`, or the cached item's owner for an edit) and keeps the owner tags on the cache so an
 *  admin's list keeps showing whose item it is. */
export function storeUpsert<T extends StoreItem>(store: string, lsKey: string, item: T): void {
  if (isServer()) {
    const prev = cachedOwner(store, item.id)
    const ownerId = item.__ownerId ?? prev.id
    const ownerName = item.__ownerName ?? prev.name
    const cached = { ...item, ...(ownerId !== undefined ? { __ownerId: ownerId } : {}), ...(ownerName ? { __ownerName: ownerName } : {}) }
    mem[store] = [...((mem[store] as T[] | undefined) ?? []).filter(x => x.id !== item.id), cached as unknown as StoreItem]
    void rpc('store_set', { store, itemId: item.id, payload: item, ...(ownerId !== undefined ? { ownerId } : {}) })
      .catch(e => console.warn(`[userStore] 保存到服务器失败(${store}):`, e))
  } else {
    const list = storeLoad<T>(store, lsKey).filter(x => x.id !== item.id)
    list.push(item)
    localStorage.setItem(lsKey, JSON.stringify(list))
  }
}

/** Remove one item by id. The owner is taken from `ownerId` or the cached item, so an admin can
 *  delete another user's item and a normal user only ever deletes their own. */
export function storeRemove<T extends StoreItem>(store: string, lsKey: string, id: string, ownerId?: number): void {
  if (isServer()) {
    const oid = ownerId ?? cachedOwner(store, id).id
    mem[store] = ((mem[store] as T[] | undefined) ?? []).filter(x => x.id !== id)
    void rpc('store_delete', { store, itemId: id, ...(oid !== undefined ? { ownerId: oid } : {}) })
      .catch(e => console.warn(`[userStore] 删除失败(${store}):`, e))
  } else {
    localStorage.setItem(lsKey, JSON.stringify(storeLoad<T>(store, lsKey).filter(x => x.id !== id)))
  }
}

/** Remove ALL of the caller's items in a store (e.g. "clear history"). */
export function storeClear(store: string, lsKey: string): void {
  if (isServer()) {
    mem[store] = []
    void rpc('store_clear', { store }).catch(e => console.warn(`[userStore] 清空失败(${store}):`, e))
  } else {
    localStorage.removeItem(lsKey)
  }
}

/** Hydrate every server store for the just-logged-in user (admins get all users' items). Call on
 *  login BEFORE rendering the workbench, and on a cookie-resumed session. No-op in desktop. */
export async function hydrateUserStores(stores: string[]): Promise<void> {
  if (!isServer()) return
  await Promise.all(stores.map(async s => {
    try { mem[s] = await rpc<StoreItem[]>('store_list', { store: s }) }
    catch { mem[s] = [] }
  }))
  hydrated = true
  fireRefreshers() // rebuild reactive snapshots with the freshly-loaded data
}

/** Drop all server caches (on logout) so the next user can't read the previous user's data. */
export function clearUserStores(): void {
  for (const k of Object.keys(mem)) delete mem[k]
  hydrated = false
  fireRefreshers()
}

/** The canonical list of per-user collections (must match the backend `store` strings + modules). */
export const USER_STORES = [
  'connections', 'db-connections', 'vnc-connections', 'rdp-connections',
  'tunnel-connections', 'groups', 'snippets', 'history', 'conversations',
] as const

/** Ephemeral per-browser UI blobs (open tabs, recent sessions) that are NOT per-item collections.
 *  In server mode they must be wiped on user switch so the next user can't see the previous user's
 *  open-tab / recent-connection metadata. */
const EPHEMERAL_LS_KEYS = ['catio-open-tabs', 'catio-recent-sessions']
export function clearEphemeralServerState(): void {
  if (!isServer() || typeof localStorage === 'undefined') return
  for (const k of EPHEMERAL_LS_KEYS) { try { localStorage.removeItem(k) } catch { /* ignore */ } }
}
