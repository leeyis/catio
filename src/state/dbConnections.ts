import { useSyncExternalStore } from 'react'
import type { DbConnectArgs, DbConnectResult, DbCapabilities } from '../services/db'
import type { Connection } from '../services/types'
import { storeLoad, storeUpsert, storeRemove, onStoresChanged, type StoreItem } from '../services/userStore'

const STORE = 'db-connections'
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
export type DbProfile = Omit<DbConnectArgs, 'secret'> & StoreItem & {
  id: string
  name: string
  /** Optional vault group id; defaults to DEFAULT_DB_GROUP when rendered. */
  group?: string
  /** User-maintained non-secret notes shown in connection details. */
  notes?: string
  /** Engine-catalog id (e.g. "cockroachdb"). Distinguishes protocol-family
   *  variants that share a `dbType` so the glyph/logo and edit-mode pre-select
   *  resolve to the right brand. Falls back to `dbType` when absent (legacy
   *  profiles saved before the multi-engine catalog). */
  engineId?: string
  /** 自动扫描导入的「草稿」连接：识别到该库但凭证字典未命中，未验证可登录。
   *  侧栏标「需要认证」，首连需手动补密码；成功连接后清除。 */
  needsAuth?: boolean
}

export function listDbConnections(): DbProfile[] {
  return storeLoad<DbProfile>(STORE, KEY)
}

export function saveDbConnection(p: DbProfile): void {
  storeUpsert(STORE, KEY, p)
  notify()
}

export function removeDbConnection(id: string, ownerId?: number): void {
  storeRemove<DbProfile>(STORE, KEY, id, ownerId)
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
onStoresChanged(notify) // refresh when the server stores are (re)hydrated on login/logout

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
    // `engine` MUST stay the protocol family (dbType) — DDL dialect selection
    // (structureDdl.dialectFor) keys off it by substring, so a MySQL-wire variant
    // like "goldendb"/"tidb" must report "mysql" here or it generates wrong DDL.
    engine: p.dbType,
    // `engineId` carries the catalog variant id so the glyph shows the right
    // brand logo (CockroachDB, MariaDB, …) without affecting dialect.
    engineId: p.engineId,
    status: active ? 'up' : 'idle',
    ...(p.notes ? { notes: p.notes } : {}),
    ...(p.needsAuth ? { needsAuth: true } : {}),
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

// ---- Reactive layer for the active-connection store (pub/sub + useSyncExternalStore) ----
// Mirrors the persisted-profile reactive layer above. Needed because consumers
// (e.g. 跨库迁移的连接候选 in DbWorkbench) must re-render when a *new* live
// connection is opened while they are already mounted — otherwise a target DB
// connected after a source workbench opens is silently absent from the picker.
const _activeListeners = new Set<() => void>()

/** Cached snapshot — useSyncExternalStore requires getSnapshot to return a stable
 *  reference between notifies, so we rebuild the array only on mutation. */
let _activeSnapshot: ActiveDbConnection[] = []

function subscribeActive(fn: () => void): () => void {
  _activeListeners.add(fn)
  return () => { _activeListeners.delete(fn) }
}

function getActiveSnapshot(): ActiveDbConnection[] {
  return _activeSnapshot
}

/** Rebuild the cached snapshot and notify subscribers. Called on every write. */
function notifyActive(): void {
  _activeSnapshot = Array.from(_activeConnections.values())
  _activeListeners.forEach(fn => fn())
}

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
  notifyActive()
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
  notifyActive()
}

/** React hook: the current list of active live connections, reactive to
 *  connect/disconnect. Returns a stable array reference between mutations so
 *  components re-render only when the active set actually changes. */
export function useActiveDbConnections(): ActiveDbConnection[] {
  return useSyncExternalStore(subscribeActive, getActiveSnapshot, getActiveSnapshot)
}
