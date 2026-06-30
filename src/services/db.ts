import { DATA } from './mockData'
import type { ErRelation, HistoryItem, QueryResult, ResultColumn, Schema, Snippet, TableStructure } from './types'
import type { RedisEdit } from '../components/dbviews/redisEdit'

// Transport: rpc() routes to Tauri invoke (desktop) or POST /api/invoke (server head);
// isServer() lets the mock guard stay `if (!isTauri() && !isServer())` so vitest/dev (which
// set neither flag) keep their mock path unchanged.
import { rpc, isTauri, isServer } from './transport'

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
  // Generic JDBC family (Oracle/DB2/Snowflake/…), served by the Java sidecar.
  | 'jdbc'

export interface DbConnectArgs {
  dbType: DbType
  host: string
  port: number
  user: string
  database?: string
  driverProfile?: string
  /** Advanced connection params as a URL query string (e.g.
   *  "authSource=admin&directConnection=true"). Appended by the driver to its
   *  connection URL. Non-secret; persisted in the profile. */
  options?: string
  /** 启用 SSL/TLS。默认关闭(保留无 TLS 路径)。 */
  ssl?: boolean
  /** SSL 模式细化:require / prefer / verify-ca / verify-full / disable。 */
  sslMode?: string
  /** 自定义 CA 证书 PEM 文件路径(校验私有/自签 CA 颁发的服务器证书)。非敏感,可入档案。 */
  caCertPath?: string
  /** 是否校验服务器证书。缺省/true=校验;false=接受无效证书(内网/测试)。 */
  sslRejectUnauthorized?: boolean
  secret?: string
}

export interface DbCapabilities {
  writable: boolean
  transactions: boolean
  schemas: boolean
  sqlConsole: boolean
  er: boolean
  structureEdit: boolean
  /** 引擎是否有"视图"概念 — 无则在 schema 树中隐藏 Views 节点（Redis/Mongo/ES 为 false）。 */
  views: boolean
  /** 引擎是否有"存储函数/过程"概念 — 无则隐藏 Functions 节点（SQLite/Rqlite/Mongo/ES/Redis 为 false）。 */
  functions: boolean
}

export interface DbConnectResult {
  connId: string
  version: string
  capabilities: DbCapabilities
}

// ---- Connection lifecycle ----

// `name` is the profile display name, threaded through as a top-level sibling of `args` so the
// server head can label the connection (for the per-user MCP tools' list_connections). Additive:
// desktop ignores the extra kwarg; callers (sidebar/home/modal connect) pass the display name.
export async function dbConnect(args: DbConnectArgs, name?: string): Promise<DbConnectResult> {
  if (!isTauri() && !isServer()) throw new Error('dbConnect requires the Tauri runtime')
  return rpc<DbConnectResult>('db_connect', { args, name })
}

/** The non-secret subset of DbConnectArgs a saved profile carries (id/name etc. omitted). */
export type DbConnectProfileLike = Omit<DbConnectArgs, 'secret'>

/**
 * Build the `dbConnect` args from a saved profile + an in-memory secret. Centralises
 * the field threading so EVERY connect path (sidebar/home direct-connect AND the
 * modal) carries the SAME fields — notably driverProfile/options AND the SSL/TLS
 * config (ssl/sslMode/caCertPath/sslRejectUnauthorized). Optional fields are omitted
 * when unset so the backend sees a clean payload (no `ssl: false` noise).
 */
export function dbConnectArgsFromProfile(profile: DbConnectProfileLike, secret?: string): DbConnectArgs {
  return {
    dbType: profile.dbType,
    ...(profile.driverProfile ? { driverProfile: profile.driverProfile } : {}),
    ...(profile.options ? { options: profile.options } : {}),
    host: profile.host,
    port: profile.port,
    user: profile.user,
    ...(profile.database ? { database: profile.database } : {}),
    ...(profile.ssl ? { ssl: true } : {}),
    ...(profile.sslMode ? { sslMode: profile.sslMode } : {}),
    ...(profile.caCertPath ? { caCertPath: profile.caCertPath } : {}),
    ...(profile.sslRejectUnauthorized === false ? { sslRejectUnauthorized: false } : {}),
    ...(secret ? { secret } : {}),
  }
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
  if (!isTauri() && !isServer()) throw new Error('测试连接需要 Tauri 运行时')
  return rpc<TestConnResult>('db_test_connection', { args })
}

export async function dbDisconnect(connId: string): Promise<void> {
  if (!isTauri() && !isServer()) throw new Error('dbDisconnect requires the Tauri runtime')
  return rpc('db_disconnect', { connId })
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

/** Connection metadata recorded alongside a query's history entry. Lets the
 *  history panel show a friendly name and filter by database type even after the
 *  connection is closed. */
export interface QueryHistoryMeta {
  name?: string
  engine?: string
  profileId?: string
}

export async function runQuery(connId: string, sql: string, defaultNamespace?: string, meta?: QueryHistoryMeta, maxRows?: number): Promise<QueryResult> {
  if (!isTauri() && !isServer()) return mockQueryResult()
  const args: Record<string, unknown> = { connId, sql }
  if (defaultNamespace) args.defaultNamespace = defaultNamespace
  if (meta?.name) args.connName = meta.name
  if (meta?.engine) args.engine = meta.engine
  if (meta?.profileId) args.profileId = meta.profileId
  if (maxRows != null) args.maxRows = maxRows
  return rpc<QueryResult>('db_query', args)
}

/**
 * Execute a batch of statements (e.g. Data Compare's sync SQL) on `connId` inside one
 * transaction — any error rolls the whole batch back. Returns rows affected. Throws outside
 * Tauri and for engines without transactional batch support (Unsupported).
 */
export async function execSyncBatch(connId: string, statements: string[]): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('执行需要 Tauri 运行时')
  return rpc<number>('db_exec_batch', { connId, statements })
}

/**
 * Run EXPLAIN against the live backend and return the raw plan result (a single
 * JSON cell). The backend builds the dialect-correct `EXPLAIN (FORMAT JSON)` /
 * `EXPLAIN FORMAT=JSON`, gates to read-only statements, executes, and returns the
 * result; the frontend parses it via `parseExplainResult`. Only PG/MySQL support
 * this. Throws outside Tauri (no meaningful mock for a real plan).
 */
export async function runExplain(connId: string, sql: string, defaultNamespace?: string): Promise<QueryResult> {
  if (!isTauri() && !isServer()) throw new Error('执行计划需要 Tauri 运行时')
  const args: Record<string, unknown> = { connId, sql }
  // 沿用选中的 schema/库执行 EXPLAIN,否则后端落连接默认库,对未限定库名的查询报表不存在。
  if (defaultNamespace) args.defaultNamespace = defaultNamespace
  return rpc<QueryResult>('db_explain', args)
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
  if (!isTauri() && !isServer()) return '-- preview requires the Tauri runtime'
  return rpc<string>('db_preview_dml', { connId, req })
}

/**
 * Apply a batch of edits in one shot, returning the number of rows affected.
 * Requires the Tauri runtime; outside Tauri it is a no-op returning 0 so the
 * mock/demo flow does not crash.
 */
export async function applyEdits(connId: string, reqs: EditRequest[]): Promise<number> {
  if (!isTauri() && !isServer()) return 0
  return rpc<number>('db_apply_edits', { connId, reqs })
}

// ---- Object administration (drop / rename / truncate / duplicate) ----

/** Top-level database object kinds that can be dropped/renamed (mirrors Rust `DatabaseObjectType`). */
export type DbObjectType = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION'

/**
 * Drop a database object (table/view/procedure/function). The backend generates
 * dialect-correct `DROP <kind>` SQL and executes it, returning rows affected.
 * Destructive — the UI gates this behind a typed confirmation. Throws outside Tauri.
 */
export async function dropObject(connId: string, objectType: DbObjectType, schema: string | undefined, name: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('删除对象需要 Tauri 运行时')
  return rpc<number>('db_drop_object', { connId, objectType, schema, name })
}

/** Table child-object kinds that can be dropped (mirrors Rust `TableChildObjectType`). */
export type TableChildObjectKind = 'COLUMN' | 'INDEX' | 'FOREIGN_KEY' | 'TRIGGER'

/**
 * Drop a table's child object (index/foreign key/trigger; columns go through the
 * structure-tab DDL flow). The backend generates dialect-correct DROP/ALTER SQL and
 * executes it, returning rows affected. Destructive — the UI gates this behind a
 * typed confirmation. Throws outside Tauri.
 */
export async function dropTableChildObject(connId: string, objectType: TableChildObjectKind, schema: string | undefined, table: string, name: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('删除子对象需要 Tauri 运行时')
  return rpc<number>('db_drop_table_child_object', { connId, objectType, schema, table, name })
}

/**
 * Rename a database object (table/view; procedures/functions only on engines that
 * support it). The backend rejects unsupported engine/kind combinations. Throws
 * outside Tauri.
 */
export async function renameObject(connId: string, objectType: DbObjectType, schema: string | undefined, oldName: string, newName: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('重命名对象需要 Tauri 运行时')
  return rpc<number>('db_rename_object', { connId, objectType, schema, oldName, newName })
}

/**
 * Truncate a table (delete all rows). SQLite/Rqlite/DuckDB degrade to DELETE FROM.
 * Destructive — gated behind a typed confirmation in the UI. Throws outside Tauri.
 */
export async function truncateTable(connId: string, schema: string | undefined, table: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('清空表需要 Tauri 运行时')
  return rpc<number>('db_truncate_table', { connId, schema, table })
}

/**
 * Duplicate a table's structure (no data) into a new empty table. Throws outside Tauri.
 */
export async function duplicateTableStructure(connId: string, schema: string | undefined, source: string, target: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('复制表结构需要 Tauri 运行时')
  return rpc<number>('db_duplicate_table_structure', { connId, schema, source, target })
}

/** Paginated query — same shape as runQuery but with limit/offset windowing. */
export async function queryPage(connId: string, sql: string, limit: number, offset: number, defaultNamespace?: string): Promise<QueryResult> {
  if (!isTauri() && !isServer()) return mockQueryResult()
  const args: Record<string, unknown> = { connId, sql, limit, offset }
  if (defaultNamespace) args.defaultNamespace = defaultNamespace
  return rpc<QueryResult>('db_query_page', args)
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
  if (!isTauri() && !isServer()) return mockQueryResult()
  return rpc<QueryResult>('db_table_preview', { connId, schema, table, limit, offset })
}

/**
 * 服务端 WHERE / ORDER BY 的表数据查询（对齐 dbx 网格的 whereFilterInput/orderByInput）。
 * 后端用 `build_table_query_sql` 拼方言正确的 `SELECT * FROM <qualified> [WHERE] [ORDER BY]`
 * + 分页后执行（仅 SQL 引擎；非 SQL 引擎后端拒绝）。`whereClause`/`orderBy` 为用户输入的
 * SQL 片段，空白片段后端不拼对应子句。非 Tauri 回落 mock。
 */
export async function tableQuery(
  connId: string, schema: string | undefined, table: string,
  whereClause: string | undefined, orderBy: string | undefined,
  limit: number, offset: number,
): Promise<QueryResult> {
  if (!isTauri() && !isServer()) return mockQueryResult()
  return rpc<QueryResult>('db_table_query', {
    connId, schema, table, whereClause, orderBy, limit, offset,
  })
}

/**
 * Write `contents` to an absolute `path` on disk via the backend. Used by the
 * grid's CSV/JSON export (the webview `<a download>` is a no-op inside Tauri).
 * No-op outside Tauri — the caller keeps the Blob-download fallback for the demo.
 */
// Desktop-only: writes to the user's local disk. Over web the caller keeps its Blob-download
// fallback (the file belongs on the user's machine, not the server), so server mode no-ops here.
export async function exportFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) return
  return rpc('export_file', { path, contents })
}

/**
 * 把列 + 行导出为 .xlsx。二进制在后端构建并直接写盘(不把字节当字符串过 IPC):
 * 前端选好路径后把列名/行(JSON 值)传给后端 db_export_xlsx(纯函数已单测)。
 */
export async function exportXlsx(args: {
  columns: string[]; rows: unknown[][]; sheetName?: string; path: string
}): Promise<void> {
  if (!isTauri()) throw new Error('exportXlsx requires the Tauri runtime')
  return rpc('db_export_xlsx', {
    columns: args.columns, rows: args.rows, sheetName: args.sheetName, path: args.path,
  })
}

/**
 * Server mode: build the .xlsx server-side and return its bytes (base64-decoded) so the browser
 * can save it via a Blob download — the desktop path writes to a server-side path, which is
 * meaningless for a remote browser.
 */
export async function exportXlsxBytes(args: { columns: string[]; rows: unknown[][]; sheetName?: string }): Promise<Uint8Array> {
  const b64 = await rpc<string>('db_export_xlsx_bytes', { columns: args.columns, rows: args.rows, sheetName: args.sheetName })
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Whole-database SQL export: DDL (supplied per table) + data INSERT batches.
 * The frontend gathers the per-table DDL (its structure-panel logic) and passes
 * it as `tableDdls`; the backend pages through rows and assembles the script.
 */
export async function exportDatabaseSql(args: {
  connId: string; database: string; schema: string; selectedTables: string[];
  tableDdls: Record<string, string>; includeStructure: boolean; includeData: boolean;
  batchSize?: number; rowLimit?: number;
}): Promise<string> {
  if (!isTauri() && !isServer()) throw new Error('exportDatabaseSql requires the Tauri runtime')
  return rpc<string>('db_export_database', args)
}

// ---- 表数据导入（CSV/TSV/JSON → 批量 INSERT）----

/** 一对源列→目标列映射（目标为空串=跳过该列）。 */
export interface ImportColumnMapping { sourceColumn: string; targetColumn: string }

/** 导入文件预览：列 + 样本行（后端按 50 行截断）+ 总行数。 */
export interface ImportPreview {
  fileName: string
  fileType: string
  sizeBytes: number
  columns: string[]
  rows: unknown[][]
  totalRows: number
  truncated: boolean
}

export interface ImportSummary { rowsImported: number; totalRows: number }

/** 读取并预览导入文件（解析在后端 table_import，纯函数已单测）。 */
export async function importPreview(filePath: string): Promise<ImportPreview> {
  if (!isTauri()) throw new Error('importPreview requires the Tauri runtime')
  return rpc<ImportPreview>('db_import_preview', { filePath })
}

/** 按列映射把文件导入目标表。mode: 'append' | 'truncate'。 */
export async function importTable(args: {
  connId: string; schema?: string; table: string; filePath: string;
  mappings: ImportColumnMapping[]; mode: 'append' | 'truncate'; batchSize?: number;
}): Promise<ImportSummary> {
  if (!isTauri()) throw new Error('importTable requires the Tauri runtime')
  return rpc<ImportSummary>('db_import_table', args)
}

// ---- 跨库/跨表数据迁移（源表 → 列映射 → 按模式写目标表）----

/** 迁移写入模式：追加 / 先清空再写 / 按键 upsert。与后端 TransferMode 一致（camelCase）。 */
export type TransferMode = 'append' | 'overwrite' | 'upsert'

/** 一对源列→目标列映射（目标为空串=跳过该列，不迁移）。 */
export interface TransferColumnMapping { sourceColumn: string; targetColumn: string }

export interface TransferSummary { rowsTransferred: number }

/**
 * 把源连接的一张表按列映射迁移到目标连接的目标表。
 * 映射 / 模式 / 写 SQL 生成在后端纯函数（transfer.rs，已单测）；编排逐批读写走驱动 I/O。
 */
export async function transferTable(args: {
  sourceConnId: string; sourceSchema?: string; sourceTable: string
  targetConnId: string; targetSchema?: string; targetTable: string
  mappings: TransferColumnMapping[]; mode: TransferMode
  upsertKeys?: string[]; batchSize?: number
  /** Overwrite（破坏性，会清空目标表）须显式确认后置 true，否则后端拒绝执行。 */
  allowDestructive?: boolean
}): Promise<TransferSummary> {
  if (!isTauri() && !isServer()) throw new Error('transferTable requires the Tauri runtime')
  return rpc<TransferSummary>('db_transfer_table', args)
}

// ---- SQL 文件批量执行（选文件 → 后端按方言切分 → 逐句执行 + 进度/错误恢复 + 取消）----

import type { SqlFileProgress } from '../components/dbviews/sqlFileRun'

/** SQL 文件预览：文件名 / 大小 / 按目标方言切分后的语句数。 */
export interface SqlFilePreview { fileName: string; sizeBytes: number; statementCount: number }

/** 读 SQL 文件并按目标连接方言切分，返回预览（文件名/大小/语句数）。 */
export async function sqlFilePreview(connId: string, filePath: string): Promise<SqlFilePreview> {
  if (!isTauri()) throw new Error('sqlFilePreview requires the Tauri runtime')
  return rpc<SqlFilePreview>('db_sql_file_preview', { connId, filePath })
}

/**
 * 执行整个 SQL 文件。进度经 `db://sql-file-progress` 事件推送（见 onSqlFileProgress）。
 * continueOnError=true 时单句失败继续，否则中止。executionId 由调用方生成，用于取消。
 */
export async function runSqlFile(args: {
  executionId: string; connId: string; filePath: string; continueOnError: boolean
}): Promise<void> {
  if (!isTauri()) throw new Error('runSqlFile requires the Tauri runtime')
  return rpc<void>('db_run_sql_file', { req: args })
}

/** 取消正在执行的 SQL 文件批量任务。 */
export async function cancelSqlFile(executionId: string): Promise<void> {
  if (!isTauri()) return // pairs with the desktop-only runSqlFile; no-op over web
  return rpc<void>('db_cancel_sql_file', { executionId })
}

/**
 * 监听 SQL 文件执行进度事件（返回 unlisten；非 Tauri 下 no-op）。
 * 仍走 Tauri `listen`：SQL 文件批量执行是 server head 暂未暴露的命令，其事件流将随
 * M3 的 `subscribe()`/WebSocket 一并迁移，故此处保持 server 模式下 no-op（仅 isTauri 放行）。
 */
export async function onSqlFileProgress(cb: (p: SqlFileProgress) => void): Promise<() => void> {
  if (!isTauri()) return () => { /* no-op outside Tauri */ }
  const { listen } = await import('@tauri-apps/api/event')
  return listen<SqlFileProgress>('db://sql-file-progress', e => cb(e.payload))
}

// ---- History & saved snippets ----

/** Execution history for a connection (most-recent first). Falls back to mock outside Tauri. */
export async function getHistory(connId: string): Promise<HistoryItem[]> {
  if (!isTauri() && !isServer()) return DATA.history
  // The backend stores `when` as unix-epoch seconds (a string). Convert it to a
  // sortable `ts` and a readable time-of-day so DB rows interleave with the SSH
  // command history in the unified panel.
  const raw = await rpc<HistoryItem[]>('db_history', { connId })
  return raw.map(h => {
    const secs = Number(h.when)
    return Number.isFinite(secs) && secs > 0
      ? { ...h, ts: secs, when: new Date(secs * 1000).toLocaleTimeString() }
      : h
  })
}

/** Clear the persisted DB query history. No-op outside Tauri. */
export async function clearDbHistory(): Promise<void> {
  if (!isTauri() && !isServer()) return
  return rpc('db_clear_history')
}

/** Delete a single persisted DB history entry by id. No-op outside Tauri. */
export async function deleteDbHistory(id: string): Promise<void> {
  if (!isTauri() && !isServer()) return
  return rpc('db_delete_history', { id })
}

/** Delete all persisted DB history for a saved profile (on profile delete). No-op outside Tauri. */
export async function deleteDbHistoryForProfile(profileId: string): Promise<void> {
  if (!isTauri() && !isServer()) return
  return rpc('db_delete_history_for_profile', { profileId })
}

/** Saved SQL snippets. Falls back to mock outside Tauri. */
export async function getSnippets(): Promise<Snippet[]> {
  if (!isTauri() && !isServer()) return DATA.snippets
  return rpc<Snippet[]>('db_snippets')
}

/** Persist a snippet (append, or update by id). No-op outside Tauri. */
export async function saveSnippet(snippet: Snippet): Promise<void> {
  if (!isTauri() && !isServer()) return
  return rpc('db_save_snippet', { snippet })
}

// ---- Schema introspection ----

export async function getSchema(connId: string): Promise<Schema> {
  if (!isTauri() && !isServer()) return DATA.schema
  // Backend returns [schemaName, tables][] — adapt to frontend Schema shape
  const raw = await rpc<Array<[string, Array<{ name: string; kind: string }>]>>('db_schema', { connId })
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
  if (!isTauri() && !isServer()) return DATA.tableStructures[table] ?? DATA.tableStructures['orders']
  // The Rust db_table_structure returns a slightly different shape (typeName, index
  // `columns`, fk `column`/`references`) — map it onto the frontend TableStructure
  // so StructureView renders the real data. The backend now carries column- and
  // table-level `comment` (empty for engines without native comments); thread it
  // through so the 备注 column and table comment actually show real values.
  const raw = await rpc<{
    comment?: string
    columns: { name: string; typeName: string; nullable: boolean; default: string | null; key: string; comment?: string }[]
    indexes: { name: string; columns: string; unique: boolean; method: string }[]
    fks: { column: string; references: string; onDelete: string; onUpdate: string; constraintName?: string | null }[]
    triggers?: { name: string; timing?: string | null; event?: string | null }[]
  }>('db_table_structure', { connId, schema, table })
  return {
    comment: raw.comment ?? '',
    columns: (raw.columns ?? []).map(c => ({
      name: c.name, type: c.typeName, nullable: c.nullable, default: c.default ?? null,
      key: (c.key === 'PK' || c.key === 'FK' || c.key === 'UNI' ? c.key : ''), extra: '', comment: c.comment ?? '',
    })),
    indexes: (raw.indexes ?? []).map(i => ({ name: i.name, cols: i.columns, unique: i.unique, method: i.method })),
    fks: (raw.fks ?? []).map(f => ({
      col: f.column, ref: f.references, onDelete: f.onDelete, onUpdate: f.onUpdate,
      name: f.constraintName ?? undefined,
    })),
    triggers: (raw.triggers ?? []).map(t => ({ name: t.name, timing: t.timing ?? undefined, event: t.event ?? undefined })),
  }
}

/**
 * Bulk column names for a schema: `[table, columns][]`, used to feed live
 * column-name autocomplete in the SQL editor. Outside Tauri returns `[]`
 * (the mock path derives columns from DATA.tableStructures instead).
 */
export async function schemaColumns(connId: string, schema: string): Promise<[string, string[]][]> {
  if (!isTauri() && !isServer()) return []
  return rpc<[string, string[]][]>('db_schema_columns', { connId, schema })
}

/**
 * Stored function/procedure names in a schema, used to populate the schema
 * browser's "Functions" section. Outside Tauri returns `[]`.
 */
export async function schemaFunctions(connId: string, schema: string): Promise<string[]> {
  if (!isTauri() && !isServer()) return []
  return rpc<string[]>('db_schema_functions', { connId, schema })
}

/** One key-type bucket in a Redis keyspace overview (mirrors Rust KeyspaceType). */
export interface KeyspaceType { name: string; count: number }
/** Redis keyspace overview shown in the structure panel (mirrors Rust KeyspaceInfo). */
export interface KeyspaceInfo { totalKeys: number; sampled: number; types: KeyspaceType[] }

/**
 * Keyspace overview (DBSIZE + sampled key-type distribution) for KV engines
 * (Redis), shown in the structure panel instead of a table structure. Outside
 * Tauri returns an empty overview.
 */
export async function keyspaceInfo(connId: string, schema: string): Promise<KeyspaceInfo> {
  if (!isTauri() && !isServer()) return { totalKeys: 0, sampled: 0, types: [] }
  return rpc<KeyspaceInfo>('db_keyspace_info', { connId, schema })
}

/**
 * 对 Redis key 执行一次原生类型编辑(string/hash/list/set/zset 增删改 + TTL)。
 * `edit` 与后端 RedisEdit(tag=kind, camelCase)对齐。返回受影响计数(尽力)。
 * `confirm` 是不可逆操作(DEL 整个 key)的确认门禁:删 key 时必须传 true,
 * 后端未确认会拒绝执行(与 dbx 的 Confirm 档对齐)。非 Tauri(mock/demo)环境下
 * 抛错——编辑需要真实连接。
 */
export async function redisEdit(connId: string, edit: RedisEdit, confirm = false): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('Redis 编辑仅在桌面应用内可用')
  return rpc<number>('db_redis_edit', { connId, edit, confirm })
}

/**
 * Source/DDL of a view, function, or procedure — used by the definition viewer.
 * `kind` is one of 'view' | 'function' | 'procedure'. Outside Tauri returns ''
 * (the viewer shows a "no definition" state on the mock/demo path).
 */
export async function objectSource(connId: string, schema: string, name: string, kind: 'view' | 'function' | 'procedure'): Promise<string> {
  if (!isTauri() && !isServer()) return ''
  return rpc<string>('db_object_source', { connId, schema, name, kind })
}

/**
 * Save an edited object (view/function/procedure) source. The backend builds the
 * dialect-correct CREATE OR REPLACE / CREATE OR ALTER statement and executes it.
 * `kind` is one of 'view' | 'function' | 'procedure'. Returns rows affected (0 for
 * most DDL). Throws outside Tauri (save needs a live connection).
 */
export async function saveObjectSource(connId: string, schema: string, name: string, kind: 'view' | 'function' | 'procedure', source: string): Promise<number> {
  if (!isTauri() && !isServer()) throw new Error('保存对象源码需要 Tauri 运行时')
  return rpc<number>('db_save_object_source', { connId, schema, name, kind, source })
}

/**
 * Foreign-key relations of a schema, used to draw the ER diagram's edges.
 * Each relation is `{ from, fromCol, to, toCol }` (table + column names).
 * Outside Tauri falls back to the seeded mock ER relations so the demo stays
 * pixel-identical.
 */
export async function erRelations(connId: string, schema: string): Promise<ErRelation[]> {
  if (!isTauri() && !isServer()) return DATA.erModel.relations
  return rpc<ErRelation[]>('db_er_model', { connId, schema })
}
