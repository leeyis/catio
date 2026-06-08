import { DATA } from './mockData'
import type { HistoryItem, QueryResult, ResultColumn, Schema, Snippet } from './types'

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

/** Result of an ephemeral connectivity test — mirrors Rust `TestConnResult` (camelCase). */
export interface TestConnResult {
  version: string
  latencyMs: number
}

/**
 * Run a real, ephemeral connection test against the given args. Builds a driver,
 * pings the server for its version, and reports round-trip latency. Requires the
 * Tauri runtime; throws outside it (there is no meaningful mock for a live test).
 */
export async function testConnection(args: DbConnectArgs): Promise<TestConnResult> {
  if (!isTauri()) throw new Error('测试连接需要 Tauri 运行时')
  return tauriInvoke<TestConnResult>('db_test_connection', { args })
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

// ---- Edits (DML preview / apply) ----

/** A single row mutation. Mirrors the Rust `EditRequest` (camelCase via serde). */
export interface EditRequest {
  schema?: string
  table: string
  kind: 'update' | 'insert' | 'delete'
  /** Primary-key columns → values, used to key the WHERE clause. */
  pk: [string, unknown][]
  /** Edited columns → new values (the SET / VALUES payload). */
  cells: [string, unknown][]
}

/**
 * Render (but do not run) the SQL for a single edit — the preview "gate" the UI
 * shows before applying. Requires the Tauri runtime; outside Tauri returns a
 * stub string so the editing UI stays demoable in the browser.
 */
export async function previewDml(connId: string, req: EditRequest): Promise<string> {
  if (!isTauri()) return '-- preview requires the Tauri runtime'
  return tauriInvoke<string>('db_preview_dml', { connId, req })
}

/**
 * Apply a batch of edits in one shot, returning the number of rows affected.
 * Requires the Tauri runtime; outside Tauri it is a no-op returning 0 so the
 * mock/demo flow does not crash.
 */
export async function applyEdits(connId: string, reqs: EditRequest[]): Promise<number> {
  if (!isTauri()) return 0
  return tauriInvoke<number>('db_apply_edits', { connId, reqs })
}

/** Paginated query — same shape as runQuery but with limit/offset windowing. */
export async function queryPage(connId: string, sql: string, limit: number, offset: number): Promise<QueryResult> {
  if (!isTauri()) return mockQueryResult()
  return tauriInvoke<QueryResult>('db_query_page', { connId, sql, limit, offset })
}

/**
 * Dialect-correct paginated table preview. The backend builds a
 * `SELECT * FROM <qualified table>` with engine-aware identifier quoting and
 * pagination (so MySQL/SQLite/SQLServer/ClickHouse etc. work, not just PG).
 * `schema` is dropped server-side when the engine has no schema namespace.
 * Falls back to mock outside Tauri.
 */
export async function tablePreview(
  connId: string, schema: string | undefined, table: string, limit: number, offset: number,
): Promise<QueryResult> {
  if (!isTauri()) return mockQueryResult()
  return tauriInvoke<QueryResult>('db_table_preview', { connId, schema, table, limit, offset })
}

// ---- History & saved snippets ----

/** Execution history for a connection (most-recent first). Falls back to mock outside Tauri. */
export async function getHistory(connId: string): Promise<HistoryItem[]> {
  if (!isTauri()) return DATA.history
  return tauriInvoke<HistoryItem[]>('db_history', { connId })
}

/** Saved SQL snippets. Falls back to mock outside Tauri. */
export async function getSnippets(): Promise<Snippet[]> {
  if (!isTauri()) return DATA.snippets
  return tauriInvoke<Snippet[]>('db_snippets')
}

/** Persist a snippet (append, or update by id). No-op outside Tauri. */
export async function saveSnippet(snippet: Snippet): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('db_save_snippet', { snippet })
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
