import { DATA } from './mockData'
import type { ErRelation, HistoryItem, QueryResult, ResultColumn, Schema, Snippet, TableStructure } from './types'

// ---- Tauri guard — function so tests can set window.__TAURI_INTERNALS__ dynamically ----
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/**
 * Extract a human-readable message from a thrown/rejected value. Tauri rejects a
 * Rust `DbError` as a plain object `{ kind, message }`, so `String(e)` yields the
 * useless "[object Object]" — pull `.message` (or stringify) instead.
 */
export function dbErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.message === 'string' && o.message) return o.message
    try { return JSON.stringify(e) } catch { return String(e) }
  }
  return String(e)
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

/**
 * Write `contents` to an absolute `path` on disk via the backend. Used by the
 * grid's CSV/JSON export (the webview `<a download>` is a no-op inside Tauri).
 * No-op outside Tauri — the caller keeps the Blob-download fallback for the demo.
 */
export async function exportFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('export_file', { path, contents })
}

// ---- History & saved snippets ----

/** Execution history for a connection (most-recent first). Falls back to mock outside Tauri. */
export async function getHistory(connId: string): Promise<HistoryItem[]> {
  if (!isTauri()) return DATA.history
  // The backend stores `when` as unix-epoch seconds (a string). Convert it to a
  // sortable `ts` and a readable time-of-day so DB rows interleave with the SSH
  // command history in the unified panel.
  const raw = await tauriInvoke<HistoryItem[]>('db_history', { connId })
  return raw.map(h => {
    const secs = Number(h.when)
    return Number.isFinite(secs) && secs > 0
      ? { ...h, ts: secs, when: new Date(secs * 1000).toLocaleTimeString() }
      : h
  })
}

/** Clear the persisted DB query history. No-op outside Tauri. */
export async function clearDbHistory(): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('db_clear_history')
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
  const schemas = raw.map(([name, tables]) => ({
    name,
    open: false,
    tables: tables.filter(t => t.kind === 'table').map(t => ({ name: t.name, rows: '', cols: 0 })),
    views: tables.filter(t => t.kind === 'view').map(t => ({ name: t.name })),
    functions: [] as { name: string }[],
  }))
  // Best-effort: fetch stored functions/procedures per schema in parallel. A
  // failed fetch leaves that schema's functions empty rather than throwing.
  await Promise.all(schemas.map(async ns => {
    ns.functions = (await schemaFunctions(connId, ns.name).catch(() => [])).map(name => ({ name }))
  }))
  return { db: connId, schemas }
}

/**
 * Real structure of a single table: columns, indexes, foreign keys (and a
 * comment) — used by the Structure tab. Mirrors the Rust `TableStructure`
 * (camelCase via serde). Outside Tauri falls back to the seeded mock structure
 * so the demo stays pixel-identical.
 */
export async function tableStructure(connId: string, schema: string, table: string): Promise<TableStructure> {
  if (!isTauri()) return DATA.tableStructures[table] ?? DATA.tableStructures['orders']
  // The Rust db_table_structure returns a slightly different shape (typeName, index
  // `columns`, fk `column`/`references`, no comment) — map it onto the frontend
  // TableStructure so StructureView renders the real data.
  const raw = await tauriInvoke<{
    columns: { name: string; typeName: string; nullable: boolean; default: string | null; key: string }[]
    indexes: { name: string; columns: string; unique: boolean; method: string }[]
    fks: { column: string; references: string; onDelete: string; onUpdate: string }[]
  }>('db_table_structure', { connId, schema, table })
  return {
    comment: '',
    columns: (raw.columns ?? []).map(c => ({
      name: c.name, type: c.typeName, nullable: c.nullable, default: c.default ?? null,
      key: (c.key === 'PK' || c.key === 'FK' || c.key === 'UNI' ? c.key : ''), extra: '',
    })),
    indexes: (raw.indexes ?? []).map(i => ({ name: i.name, cols: i.columns, unique: i.unique, method: i.method })),
    fks: (raw.fks ?? []).map(f => ({ col: f.column, ref: f.references, onDelete: f.onDelete, onUpdate: f.onUpdate })),
  }
}

/**
 * Bulk column names for a schema: `[table, columns][]`, used to feed live
 * column-name autocomplete in the SQL editor. Outside Tauri returns `[]`
 * (the mock path derives columns from DATA.tableStructures instead).
 */
export async function schemaColumns(connId: string, schema: string): Promise<[string, string[]][]> {
  if (!isTauri()) return []
  return tauriInvoke<[string, string[]][]>('db_schema_columns', { connId, schema })
}

/**
 * Stored function/procedure names in a schema, used to populate the schema
 * browser's "Functions" section. Outside Tauri returns `[]`.
 */
export async function schemaFunctions(connId: string, schema: string): Promise<string[]> {
  if (!isTauri()) return []
  return tauriInvoke<string[]>('db_schema_functions', { connId, schema })
}

/**
 * Source/DDL of a view, function, or procedure — used by the definition viewer.
 * `kind` is one of 'view' | 'function' | 'procedure'. Outside Tauri returns ''
 * (the viewer shows a "no definition" state on the mock/demo path).
 */
export async function objectSource(connId: string, schema: string, name: string, kind: 'view' | 'function' | 'procedure'): Promise<string> {
  if (!isTauri()) return ''
  return tauriInvoke<string>('db_object_source', { connId, schema, name, kind })
}

/**
 * Foreign-key relations of a schema, used to draw the ER diagram's edges.
 * Each relation is `{ from, fromCol, to, toCol }` (table + column names).
 * Outside Tauri falls back to the seeded mock ER relations so the demo stays
 * pixel-identical.
 */
export async function erRelations(connId: string, schema: string): Promise<ErRelation[]> {
  if (!isTauri()) return DATA.erModel.relations
  return tauriInvoke<ErRelation[]>('db_er_model', { connId, schema })
}
