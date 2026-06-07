import type { DbConnectArgs } from '../services/db'

const KEY = 'catio-db-connections'

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
  const all = listDbConnections().filter(x => x.id !== p.id)
  all.push(p)
  localStorage.setItem(KEY, JSON.stringify(all))
}

export function removeDbConnection(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(listDbConnections().filter(x => x.id !== id)))
}
