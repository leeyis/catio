import type { HistoryItem } from '../services/types'

const KEY = 'catio-history'
const CAP = 1000

export function loadHistory(): HistoryItem[] {
  try {
    const r = localStorage.getItem(KEY)
    return r ? (JSON.parse(r) as HistoryItem[]) : []
  } catch {
    return []
  }
}

export function appendHistory(h: Omit<HistoryItem, 'id'>): void {
  const item: HistoryItem = {
    ...h,
    id: 'h-' + Math.floor(performance.now() * 1000).toString(36) + '-' + Math.random().toString(36).slice(2, 7),
  }
  const next = [item, ...loadHistory()].slice(0, CAP)
  localStorage.setItem(KEY, JSON.stringify(next))
}

export function clearHistory(): void {
  localStorage.removeItem(KEY)
}

/** Delete a single (shell) history entry by id. */
export function deleteHistory(id: string): void {
  const next = loadHistory().filter(h => h.id !== id)
  localStorage.setItem(KEY, JSON.stringify(next))
}
