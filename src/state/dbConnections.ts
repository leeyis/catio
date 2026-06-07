import type { DbConnectArgs, DbConnectResult, DbCapabilities } from '../services/db'

const KEY = 'catio-db-connections'

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
export type DbProfile = Omit<DbConnectArgs, 'secret'> & { id: string; name: string }

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
}

export function removeDbConnection(id: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(listDbConnections().filter(x => x.id !== id)))
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
