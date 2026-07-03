import { useSyncExternalStore } from 'react'
import { onStoresChanged, storeLoad, storeRemove, storeUpsert, type StoreItem } from '../services/userStore'

interface FavoriteConnection extends StoreItem {
  id: string
}

const STORE = 'connection-favorites'
const KEY = 'catio-connection-favorites'

export function loadConnectionFavorites(): string[] {
  return storeLoad<FavoriteConnection>(STORE, KEY).map(x => x.id)
}

export function isConnectionFavorite(id: string): boolean {
  return loadConnectionFavorites().includes(id)
}

export function addConnectionFavorite(id: string): void {
  storeUpsert<FavoriteConnection>(STORE, KEY, { id })
  notify()
}

export function removeConnectionFavorite(id: string): void {
  storeRemove<FavoriteConnection>(STORE, KEY, id)
  notify()
}

export function toggleConnectionFavorite(id: string): boolean {
  if (isConnectionFavorite(id)) {
    removeConnectionFavorite(id)
    return false
  }
  addConnectionFavorite(id)
  return true
}

const listeners = new Set<() => void>()
let snapshot = loadConnectionFavorites()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function getSnapshot(): string[] {
  return snapshot
}

function notify(): void {
  snapshot = loadConnectionFavorites()
  listeners.forEach(fn => fn())
}
onStoresChanged(notify)

export function useConnectionFavorites(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
