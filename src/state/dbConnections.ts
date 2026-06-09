import { useSyncExternalStore } from 'react'
import type { DbConnectArgs, DbConnectResult, DbCapabilities } from '../services/db'
import type { Connection } from '../services/types'

const KEY = 'catio-db-connections'

/** Real saved DB connections are ungrouped by default — they surface under the
 *  sidebar's "未分组" section until the user assigns a group. DbProfile.group overrides. */
const DEFAULT_DB_GROUP = ''

// ---- Profile generation ----

/** Generate a collision-resistant profile id. */
export function generateProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `db-${crypto.randomUUID()}`
  }
  return `db-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ---- Persisted connection profiles (localStorage) ----

/** Connection profile = connect args minus the secret (never persisted). */
export type DbProfile = Omit<DbConnectArgs, 'secret'> & {
  id: string
  name: string
  /** Optional vault group id; defaults to DEFAULT_DB_GROUP when rendered. */
  group?: string
  /** Engine-catalog id (e.g. "cockroachdb"). Distinguishes protocol-family
   *  variants that share a `dbType` so the glyph/logo and edit-mode pre-select
   *  resolve to the right brand. Falls back to `dbType` when absent (legacy
   *  profiles saved before the multi-engine catalog). */
  engineId?: string
}

export function listDbConnections(): DbProfile[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DbProfile[]
  } catch {
    return []
  }
}

export function saveDbConnection(p: DbProfile): void {
  if (typeof localStorage === 'undefined') return
  const all = listDbConnections().filter(x => x.id !== p.id)
  all.push(p)
  localStorage.setItem(KEY, JSON.stringify(all))
  notify()
}

export function removeDbConnection(id: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(listDbConnections().filter(x => x.id !== id)))
  notify()
}

// ---- Reactive layer (pub/sub + useSyncExternalStore) ----

const _listeners = new Set<() => void>()

/** Cached snapshot — useSyncExternalStore requires getSnapshot to return a stable
 *  reference between notifies, so we rebuild the array only on mutation. */
let _snapshot: DbProfile[] = listDbConnections()

function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

function getSnapshot(): DbProfile[] {
  return _snapshot
}

/** Rebuild the cached snapshot and notify subscribers. Called on every write. */
function notify(): void {
  _snapshot = listDbConnections()
  _listeners.forEach(fn => fn())
}

/** React hook: the current list of saved DB connection profiles, reactive to
 *  save/remove. Returns a stable array reference between mutations. */
export function useDbConnections(): DbProfile[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Map a saved DB profile to the shared Connection shape used by the sidebar / home /
 *  workbench. Includes engine + kind + icon so ConnGlyph renders identically. */
export function dbProfileToConnection(p: DbProfile, active = false): Connection {
  return {
    id: p.id,
    group: p.group ?? DEFAULT_DB_GROUP,
    kind: 'db',
    name: p.name,
    sub: `${p.engineId ?? p.dbType} · ${p.host}:${p.port}`,
    icon: 'database',
    // Prefer the catalog engine id so protocol-family variants (CockroachDB,
    // MariaDB, …) render their own brand logo rather than the family's.
    engine: p.engineId ?? p.dbType,
    status: active ? 'up' : 'idle',
  }
}

// ---- In-memory active connection store (NOT persisted — holds live backend connIds) ----

/** Metadata stored for an active live connection (secret never included). */
export interface ActiveDbConnection {
  connId: string
  capabilities: DbCapabilities
  profileId: string
  dbType: DbConnectArgs['dbType']
  name: string
}

const _activeConnections = new Map<string, ActiveDbConnection>()

/**
 * Record a successful dbConnect result alongside profile metadata.
 * The secret is never passed here — only connId, capabilities, and profile fields.
 */
export function setActiveDbConnection(
  result: DbConnectResult,
  profile: Pick<DbProfile, 'id' | 'name' | 'dbType'>,
): void {
  _activeConnections.set(result.connId, {
    connId: result.connId,
    capabilities: result.capabilities,
    profileId: profile.id,
    dbType: profile.dbType,
    name: profile.name,
  })
}

/** Retrieve an active connection by its backend connId. */
export function getActiveDbConnection(connId: string): ActiveDbConnection | undefined {
  return _activeConnections.get(connId)
}

/** List all currently active connections (in insertion order). */
export function listActiveDbConnections(): ActiveDbConnection[] {
  return Array.from(_activeConnections.values())
}

/** Remove an active connection (e.g. after dbDisconnect). */
export function removeActiveDbConnection(connId: string): void {
  _activeConnections.delete(connId)
}
