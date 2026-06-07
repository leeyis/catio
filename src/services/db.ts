import { DATA } from './mockData'
import type { QueryResult, ResultColumn, Schema } from './types'

// ---- Tauri guard — function so tests can set window.__TAURI_INTERNALS__ dynamically ----
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ---- DB engine types ----

export type DbType =
  | 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'sqlserver'
  | 'clickhouse' | 'elasticsearch' | 'rqlite' | 'mongodb' | 'redis'

export interface DbConnectArgs {
  dbType: DbType
  host: string
  port: number
  user: string
  database?: string
  driverProfile?: string
  secret?: string
}

export interface DbCapabilities {
  writable: boolean
  transactions: boolean
  schemas: boolean
  sqlConsole: boolean
  er: boolean
  structureEdit: boolean
}

export interface DbConnectResult {
  connId: string
  version: string
  capabilities: DbCapabilities
}

// ---- Connection lifecycle ----

export async function dbConnect(args: DbConnectArgs): Promise<DbConnectResult> {
  if (!isTauri()) throw new Error('dbConnect requires the Tauri runtime')
  return tauriInvoke<DbConnectResult>('db_connect', { args })
}

export async function dbDisconnect(connId: string): Promise<void> {
  if (!isTauri()) throw new Error('dbDisconnect requires the Tauri runtime')
  return tauriInvoke('db_disconnect', { connId })
}

// ---- Query ----

function mockQueryResult(): QueryResult {
  const columns: ResultColumn[] = DATA.ordersColumns.map(c => ({
    name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon,
  }))
  const keys = DATA.ordersColumns.map(c => c.name)
  const rows: unknown[][] = DATA.ordersRows.map(
    r => keys.map(k => (r as unknown as Record<string, unknown>)[k]),
  )
  return { columns, rows }
}

export async function runQuery(connId: string, sql: string): Promise<QueryResult> {
  if (!isTauri()) return mockQueryResult()
  return tauriInvoke<QueryResult>('db_query', { connId, sql })
}

// ---- Schema introspection ----

export async function getSchema(connId: string): Promise<Schema> {
  if (!isTauri()) return DATA.schema
  // Backend returns [schemaName, tables][] — adapt to frontend Schema shape
  const raw = await tauriInvoke<Array<[string, Array<{ name: string; kind: string }>]>>('db_schema', { connId })
  return {
    db: connId,
    schemas: raw.map(([name, tables]) => ({
      name,
      open: false,
      tables: tables.filter(t => t.kind === 'table').map(t => ({ name: t.name, rows: '', cols: 0 })),
      views: tables.filter(t => t.kind === 'view').map(t => ({ name: t.name })),
      functions: [],
    })),
  }
}
