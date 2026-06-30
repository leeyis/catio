import type { HistoryItem } from '../services/types'
import { storeLoad, storeUpsert, storeRemove, storeClear } from '../services/userStore'
import { isServer } from '../services/transport'

const STORE = 'history'
const KEY = 'catio-history'
const CAP = 1000

export function loadHistory(): HistoryItem[] {
  return storeLoad<HistoryItem>(STORE, KEY)
}

export function appendHistory(h: Omit<HistoryItem, 'id'>): void {
  const item: HistoryItem = {
    ...h,
    id: 'h-' + Math.floor(performance.now() * 1000).toString(36) + '-' + Math.random().toString(36).slice(2, 7),
  }
  if (isServer()) {
    // Server mode: append per-item (the backend orders by time); no client-side cap.
    storeUpsert(STORE, KEY, item)
  } else {
    // Desktop/dev: newest-first, capped — preserves the original local-history behavior.
    localStorage.setItem(KEY, JSON.stringify([item, ...loadHistory()].slice(0, CAP)))
  }
}

export function clearHistory(): void {
  storeClear(STORE, KEY)
}

/** Delete a single (shell) history entry by id. */
export function deleteHistory(id: string): void {
  storeRemove<HistoryItem>(STORE, KEY, id)
}

/** Delete all (shell) history entries for a saved profile — used when the
 *  connection profile is deleted so its history doesn't linger. */
export function deleteHistoryForProfile(profileId: string): void {
  loadHistory().filter(h => h.profileId === profileId).forEach(h => storeRemove<HistoryItem>(STORE, KEY, h.id))
}
