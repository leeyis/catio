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
import { storeLoad, storeUpsert, storeRemove, onStoresChanged } from '../services/userStore'

const STORE = 'groups'
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
  return storeLoad<Group>(STORE, KEY)
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
  storeUpsert(STORE, KEY, g)
  notify()
  return g
}

export function renameGroup(id: string, name: string): void {
  const g = loadGroups().find(x => x.id === id)
  if (!g) return
  storeUpsert(STORE, KEY, { ...g, name: name.trim() || g.name })
  notify()
}

export function removeGroup(id: string, ownerId?: number): void {
  storeRemove<Group>(STORE, KEY, id, ownerId)
  notify()
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
onStoresChanged(notify)

/** React hook: reactive list of user-defined groups. */
export function useGroups(): Group[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
