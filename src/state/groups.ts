// User-defined connection groups, persisted to localStorage. Replaces the old
// hardcoded mock taxonomy (Production/Staging/Local) — the sidebar now renders
// the groups the user actually created, with ungrouped connections under a
// "未分组" section. A connection references a group by id via its profile's
// `group` field; deleting a group leaves its connections ungrouped (no cascade).
//
// Reactive layer mirrors state/dbConnections.ts (pub/sub + useSyncExternalStore)
// so sidebar / modal update immediately on create/rename/delete.

import { useSyncExternalStore } from 'react'
import type { Group } from '../services/types'

const KEY = 'catio-groups'

// Palette for new groups — cycles as the user adds more. Theme-aware CSS vars.
const PALETTE = [
  'var(--signal-rose)',
  'var(--signal-amber)',
  'var(--signal-green)',
  'var(--signal-blue)',
  'var(--signal-cyan)',
  'var(--accent-primary)',
]

export function loadGroups(): Group[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Group[]
  } catch {
    return []
  }
}

function persist(list: Group[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(list))
  notify()
}

/** Generate a collision-resistant group id. */
export function generateGroupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `g-${crypto.randomUUID()}`
  }
  return `g-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Create a group with the given name; colour auto-assigned from the palette.
 *  Returns the created group (so callers can select it immediately). */
export function addGroup(name: string): Group {
  const list = loadGroups()
  const color = PALETTE[list.length % PALETTE.length]
  const g: Group = { id: generateGroupId(), name: name.trim() || 'New group', color }
  persist([...list, g])
  return g
}

export function renameGroup(id: string, name: string): void {
  persist(loadGroups().map(g => (g.id === id ? { ...g, name: name.trim() || g.name } : g)))
}

export function removeGroup(id: string): void {
  persist(loadGroups().filter(g => g.id !== id))
}

// ---- Reactive layer ----

const _listeners = new Set<() => void>()
let _snapshot: Group[] = loadGroups()

function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

function getSnapshot(): Group[] {
  return _snapshot
}

function notify(): void {
  _snapshot = loadGroups()
  _listeners.forEach(fn => fn())
}

/** React hook: reactive list of user-defined groups. */
export function useGroups(): Group[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
