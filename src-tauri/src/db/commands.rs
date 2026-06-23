use crate::db::{DbError, ids::IdGen};
use crate::db::driver::{self, ConnectArgs, EditRequest, TableInfo, TableStructure, ErRelation};
use crate::db::manager::ConnManager;
use crate::db::result::QueryResult;
use crate::db::capabilities::Capabilities;
use crate::db::dml::{self, CellEdit};
use crate::db::query_explain_sql;
use crate::db::db_admin_sql::{
    self, DatabaseObjectType, DropObjectSqlOptions, DropTableChildObjectSqlOptions,
    DuplicateTableStructureSqlOptions, RenameObjectSqlOptions, TableAdminSqlOptions,
    TableChildObjectType,
};
use crate::db::object_source_sql::{
    self, EditableObjectSourceSqlInput, ObjectSourceKind,
};
use crate::db::history::{self, HistoryEntry, SnippetEntry};
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static CONN_IDS: IdGen = IdGen::new("conn");
static HISTORY_IDS: IdGen = IdGen::new("hist");
static SNIPPET_IDS: IdGen = IdGen::new("snip");

/// Resolve (and create) the app data dir — mirrors `ssh_trust_host`.
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, DbError> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| DbError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| DbError::Io(e.to_string()))?;
    Ok(dir)
}

/// Seconds since the Unix epoch as a string — best-effort `when` timestamp.
fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub conn_id: String,
    pub version: String,
    pub capabilities: Capabilities,
}

#[tauri::command]
pub async fn db_connect(args: ConnectArgs, mgr: tauri::State<'_, ConnManager>)
    -> Result<ConnectResult, DbError> {
    let drv = driver::connect(&args).await?;
    let version = drv.test().await?;
    let caps = drv.capabilities();
    let id = CONN_IDS.next();
    mgr.insert(id.clone(), drv).await;
    Ok(ConnectResult { conn_id: id, version, capabilities: caps })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnResult {
    pub version: String,
    pub latency_ms: u64,
}

/// Ephemeral connectivity test: build a driver, run `test()` (returns the server
/// version string), and report the round-trip latency. The driver is dropped at
/// the end of this fn — it is NOT inserted into the ConnManager.
#[tauri::command]
pub async fn db_test_connection(args: ConnectArgs) -> Result<TestConnResult, DbError> {
    let started = Instant::now();
    let drv = driver::connect(&args).await?;
    let version = drv.test().await?;
    let latency_ms = started.elapsed().as_millis() as u64;
    Ok(TestConnResult { version, latency_ms })
}

#[tauri::command]
pub async fn db_disconnect(conn_id: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<(), DbError> {
    if mgr.remove(&conn_id).await { Ok(()) } else { Err(DbError::NotFound(conn_id)) }
}

#[tauri::command]
pub async fn db_query(conn_id: String, sql: String, max_rows: Option<u32>, default_namespace: Option<String>,
    conn_name: Option<String>, engine: Option<String>, profile_id: Option<String>,
    mgr: tauri::State<'_, ConnManager>, app: tauri::AppHandle) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let started = Instant::now();
    let result = drv.query_with_default_namespace(&sql, max_rows.unwrap_or(1000), default_namespace.as_deref()).await?;
    let dur = format!("{}ms", started.elapsed().as_millis());

    // Best-effort: record a history entry on success. Never fail the query if
    // history persistence has a problem. The friendly name / engine / profile id
    // are persisted so the history panel can show readable labels and filter by
    // database type even after the connection is closed.
    if let Ok(dir) = app_data_dir(&app) {
        let entry = HistoryEntry {
            id: HISTORY_IDS.next(),
            kind: "sql".into(),
            target: conn_id,
            text: sql,
            when: now_stamp(),
            dur,
            name: conn_name,
            engine,
            profile_id,
        };
        let list = history::append_capped(history::load_history(&dir), entry, history::MAX_HISTORY);
        let _ = history::save_history(&dir, &list);
    }

    Ok(result)
}

/// Read persisted execution history (most-recent first). `conn_id` is accepted
/// for API symmetry with the frontend; history is currently global.
#[tauri::command]
pub async fn db_history(app: tauri::AppHandle) -> Result<Vec<HistoryEntry>, DbError> {
    let dir = app_data_dir(&app)?;
    Ok(history::load_history(&dir))
}

/// Clear the persisted DB query history (writes an empty list).
#[tauri::command]
pub async fn db_clear_history(app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = app_data_dir(&app)?;
    history::save_history(&dir, &[]).map_err(|e| DbError::Io(e.to_string()))
}

/// Delete a single persisted DB history entry by id (no-op if not found).
#[tauri::command]
pub async fn db_delete_history(id: String, app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = app_data_dir(&app)?;
    let list: Vec<HistoryEntry> = history::load_history(&dir)
        .into_iter()
        .filter(|h| h.id != id)
        .collect();
    history::save_history(&dir, &list).map_err(|e| DbError::Io(e.to_string()))
}

/// Delete all persisted DB history entries belonging to a saved profile — invoked
/// when the connection profile itself is deleted, so its history doesn't linger.
#[tauri::command]
pub async fn db_delete_history_for_profile(profile_id: String, app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = app_data_dir(&app)?;
    let list: Vec<HistoryEntry> = history::load_history(&dir)
        .into_iter()
        .filter(|h| h.profile_id.as_deref() != Some(profile_id.as_str()))
        .collect();
    history::save_history(&dir, &list).map_err(|e| DbError::Io(e.to_string()))
}

/// Read saved SQL snippets.
#[tauri::command]
pub async fn db_snippets(app: tauri::AppHandle) -> Result<Vec<SnippetEntry>, DbError> {
    let dir = app_data_dir(&app)?;
    Ok(history::load_snippets(&dir))
}

/// Append (or update by id) a saved snippet, then persist.
#[tauri::command]
pub async fn db_save_snippet(snippet: SnippetEntry, app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = app_data_dir(&app)?;
    let mut list = history::load_snippets(&dir);
    let mut snippet = snippet;
    if snippet.id.is_empty() {
        snippet.id = SNIPPET_IDS.next();
    }
    match list.iter_mut().find(|s| s.id == snippet.id) {
        Some(existing) => *existing = snippet,
        None => list.push(snippet),
    }
    history::save_snippets(&dir, &list).map_err(|e| DbError::Io(e.to_string()))
}

#[tauri::command]
pub async fn db_schema(conn_id: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<Vec<(String, Vec<TableInfo>)>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    let mut out = Vec::new();
    // 单个 schema 的表枚举失败不应拖垮整棵库结构树：达梦/Oracle 等会把系统
    // schema（SYS/SYSDBA…）一并列出，其中某个 list_tables 抛错时跳过它即可（该
    // schema 表为空），否则整个 db_schema 报错、前端回落 mock，"默认库/Schema"
    // 下拉会因 schemaOptions 退化为 1 项而消失。
    for s in drv.list_schemas().await? {
        let tables = drv.list_tables(&s).await.unwrap_or_default();
        out.push((s, tables));
    }
    Ok(out)
}

#[tauri::command]
pub async fn db_table_structure(conn_id: String, schema: String, table: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<TableStructure, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.table_structure(&schema, &table).await
}

/// Source/DDL of a view, function, or procedure. `kind` is one of
/// "view" | "function" | "procedure". Best-effort: engines without DDL
/// introspection return "" (the UI shows a "no definition" state).
#[tauri::command]
pub async fn db_object_source(conn_id: String, schema: String, name: String, kind: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<String, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.object_source(&schema, &name, &kind).await
}

/// Bulk column names for autocomplete: for each table in `schema`, its column
/// names. Reuses the driver's default `schema_columns` (best-effort, capped).
#[tauri::command]
pub async fn db_schema_columns(conn_id: String, schema: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<Vec<(String, Vec<String>)>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.schema_columns(&schema).await
}

/// List stored functions/procedures in a schema, for the schema browser's
/// "Functions" section. Best-effort: engines without routine support return [].
#[tauri::command]
pub async fn db_schema_functions(conn_id: String, schema: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<Vec<String>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.list_functions(&schema).await
}

/// Keyspace overview (DBSIZE + sampled type distribution) for KV engines (Redis),
/// shown in the structure panel in place of a table structure.
#[tauri::command]
pub async fn db_keyspace_info(conn_id: String, schema: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<crate::db::driver::KeyspaceInfo, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.keyspace_info(&schema).await
}

#[tauri::command]
pub async fn db_er_model(conn_id: String, schema: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<Vec<ErRelation>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.er_relations(&schema).await
}

/// Translate an EditRequest into a SQL string, with guards against degenerate inputs.
fn build_sql(db: crate::db::DatabaseType, req: &EditRequest) -> Result<String, DbError> {
    let cells: Vec<CellEdit> = req.cells.iter()
        .map(|(c, v)| CellEdit { column: c.clone(), new_value: v.clone() }).collect();
    Ok(match req.kind.as_str() {
        "update" => {
            if req.cells.is_empty() || req.pk.is_empty() {
                return Err(DbError::Unsupported(
                    "update requires changed cells and a primary key".into()));
            }
            dml::build_update(db, req.schema.as_deref(), &req.table, &req.pk, &cells)
        }
        "insert" => {
            if req.cells.is_empty() {
                return Err(DbError::Unsupported(
                    "insert requires at least one cell".into()));
            }
            dml::build_insert(db, req.schema.as_deref(), &req.table, &cells)
        }
        "delete" => {
            if req.pk.is_empty() {
                return Err(DbError::Unsupported(
                    "delete requires a primary key".into()));
            }
            dml::build_delete(db, req.schema.as_deref(), &req.table, &req.pk)
        }
        other => return Err(DbError::Unsupported(format!("edit kind {other}"))),
    })
}

#[tauri::command]
pub async fn db_preview_dml(conn_id: String, req: EditRequest,
    mgr: tauri::State<'_, ConnManager>) -> Result<String, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    if !drv.capabilities().writable {
        return Err(DbError::Unsupported("read-only engine".into()));
    }
    // Mongo/ES 的网格编辑走 SQL DML 路径,这两类引擎不支持 —— 在入口明确拒绝,
    // 而不是让生成的 SQL 在 query() 里报一个误导性的语法错误。
    if matches!(drv.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Elasticsearch) {
        return Err(DbError::Unsupported("editing via SQL DML is not supported for this engine".into()));
    }
    build_sql(drv.db_type(), &req)
}

#[tauri::command]
pub async fn db_apply_edits(conn_id: String, reqs: Vec<EditRequest>,
    mgr: tauri::State<'_, ConnManager>) -> Result<u64, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    if !drv.capabilities().writable {
        return Err(DbError::Unsupported("read-only engine".into()));
    }
    // Mongo/ES 的网格编辑走 SQL DML 路径,这两类引擎不支持 —— 在入口明确拒绝,
    // 而不是让生成的 SQL 在 query() 里报一个误导性的语法错误。
    if matches!(drv.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Elasticsearch) {
        return Err(DbError::Unsupported("editing via SQL DML is not supported for this engine".into()));
    }
    let mut affected = 0u64;
    for req in &reqs {
        let sql = build_sql(drv.db_type(), req)?;
        let r = drv.query(&sql, 0).await?;
        affected += r.rows_affected.unwrap_or(0);
    }
    Ok(affected)
}

/// 危险操作的统一前置：取连接、确认可写引擎。对象管理（DROP/RENAME/TRUNCATE/复制
/// 表结构）都要改写数据库结构，只读引擎一律拒绝；具体引擎的能力差异由 db_admin_sql
/// 的纯函数兜底（返回 Unsupported）。
async fn writable_drv(conn_id: &str, mgr: &ConnManager)
    -> Result<std::sync::Arc<dyn driver::Driver>, DbError> {
    let drv = mgr.get(conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.to_string()))?;
    if !drv.capabilities().writable {
        return Err(DbError::Unsupported("read-only engine".into()));
    }
    Ok(drv)
}

/// 把 DROP/ALTER DROP 执行结果里的「对象不存在」类错误归一化为成功（Ok(0)）。
///
/// 背景：并非所有引擎/语句都支持 `IF EXISTS`（如 MySQL 的 `DROP INDEX`、
/// `ALTER TABLE ... DROP FOREIGN KEY`、`sp_rename` 都不支持），因此无法在 SQL 层统一
/// 加 IF EXISTS。删除/重试或竞态下目标已不存在时，后端会抛出裸的「does not exist」类
/// DB 错误，前端无法与真实失败区分。这里在命令层把这类错误吞掉、当作幂等成功返回，
/// 真实失败（权限/语法/连接等）仍照常上抛。
fn drop_or_absent(result: Result<QueryResult, DbError>) -> Result<u64, DbError> {
    match result {
        Ok(r) => Ok(r.rows_affected.unwrap_or(0)),
        Err(DbError::QueryFailed(msg)) if is_object_absent_error(&msg) => Ok(0),
        Err(e) => Err(e),
    }
}

/// 判定一条 DB 错误消息是否属于「对象不存在」类（跨引擎，大小写无关）。
fn is_object_absent_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    // Postgres/通用：does not exist；SQLServer：…because it does not exist；
    // SQLite：no such index/trigger/table；MySQL：Can't DROP …check that…exists /
    // Unknown table / Unknown trigger (1051/1091/…)。
    m.contains("does not exist")
        || m.contains("no such index")
        || m.contains("no such trigger")
        || m.contains("no such table")
        || m.contains("unknown table")
        || m.contains("unknown trigger")
        || (m.contains("can't drop") && m.contains("check that"))
}

/// 删除一个数据库对象（表/视图/存储过程/函数）。生成方言正确的 DROP 后执行。
#[tauri::command]
pub async fn db_drop_object(conn_id: String, object_type: DatabaseObjectType,
    schema: Option<String>, name: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let sql = db_admin_sql::build_drop_object_sql(DropObjectSqlOptions {
        database_type: drv.db_type(), object_type, schema, name,
    }).map_err(DbError::Unsupported)?;
    drop_or_absent(drv.query(&sql, 0).await)
}

/// 删除表的子对象（索引/外键约束/触发器；列由前端 DDL 流程处理）。生成方言正确的
/// DROP / ALTER 后执行。
#[tauri::command]
pub async fn db_drop_table_child_object(conn_id: String, object_type: TableChildObjectType,
    schema: Option<String>, table: String, name: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let sql = db_admin_sql::build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
        database_type: drv.db_type(), object_type, schema, table_name: table, name,
    }).map_err(DbError::Unsupported)?;
    drop_or_absent(drv.query(&sql, 0).await)
}

/// 重命名一个数据库对象（表/视图，部分引擎支持过程/函数）。
#[tauri::command]
pub async fn db_rename_object(conn_id: String, object_type: DatabaseObjectType,
    schema: Option<String>, old_name: String, new_name: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let sql = db_admin_sql::build_rename_object_sql(RenameObjectSqlOptions {
        database_type: drv.db_type(), object_type, schema, old_name, new_name,
    }).map_err(DbError::Unsupported)?;
    let r = drv.query(&sql, 0).await?;
    Ok(r.rows_affected.unwrap_or(0))
}

/// 截断一张表（清空所有行）。SQLite/Rqlite/DuckDB 退化为 DELETE FROM。
#[tauri::command]
pub async fn db_truncate_table(conn_id: String, schema: Option<String>, table: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let sql = db_admin_sql::build_truncate_table_sql(TableAdminSqlOptions {
        database_type: drv.db_type(), schema, table_name: table,
    }).map_err(DbError::Unsupported)?;
    let r = drv.query(&sql, 0).await?;
    Ok(r.rows_affected.unwrap_or(0))
}

/// 保存编辑后的对象（视图/函数/存储过程）源码：按方言生成可执行的
/// CREATE OR REPLACE / CREATE OR ALTER 语句后执行。`kind` 取 "view"|"function"|
/// "procedure"（与 db_object_source 一致）。返回 rows_affected（DDL 多为 0）。
#[tauri::command]
pub async fn db_save_object_source(conn_id: String, schema: Option<String>, name: String,
    kind: String, source: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let object_type = ObjectSourceKind::parse(&kind)
        .ok_or_else(|| DbError::Unsupported(format!("unknown object kind: {kind}")))?;
    let sql = object_source_sql::build_executable_object_source_sql(EditableObjectSourceSqlInput {
        database_type: drv.db_type(), object_type, schema, name, source,
    }).map_err(DbError::Unsupported)?;
    let r = drv.query(&sql, 0).await?;
    Ok(r.rows_affected.unwrap_or(0))
}

/// 复制一张表的结构（不含数据），新建空表。
#[tauri::command]
pub async fn db_duplicate_table_structure(conn_id: String, schema: Option<String>,
    source: String, target: String, mgr: tauri::State<'_, ConnManager>) -> Result<u64, DbError> {
    let drv = writable_drv(&conn_id, &mgr).await?;
    let sql = db_admin_sql::build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
        database_type: drv.db_type(), schema, source_name: source, target_name: target,
    }).map_err(DbError::Unsupported)?;
    let r = drv.query(&sql, 0).await?;
    Ok(r.rows_affected.unwrap_or(0))
}

#[tauri::command]
pub async fn db_query_page(conn_id: String, sql: String, limit: u32, offset: u32, default_namespace: Option<String>,
    mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.paginated_query_with_default_namespace(&sql, limit, offset, default_namespace.as_deref()).await
}

/// 执行计划(EXPLAIN)。按连接的引擎方言拼出 EXPLAIN (FORMAT JSON) / EXPLAIN
/// FORMAT=JSON,只对只读语句放行,然后执行并把原始计划结果(单行单列 JSON)交给
/// 前端解析。仅 PG/MySQL 支持;其他引擎或不安全/空 SQL 返回 Unsupported/QueryFailed。
#[tauri::command]
pub async fn db_explain(conn_id: String, sql: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let built = query_explain_sql::build_explain_sql(drv.db_type(), &sql);
    match built.sql {
        Some(explain_sql) => drv.query(&explain_sql, 1000).await,
        None => Err(match built.reason.as_deref() {
            Some("unsupported") => DbError::Unsupported("此引擎不支持执行计划".into()),
            Some("empty") => DbError::QueryFailed("没有可解释的 SQL".into()),
            _ => DbError::QueryFailed("仅支持解释只读查询(SELECT/WITH/TABLE/VALUES)".into()),
        }),
    }
}

/// Paginated table-data preview. Delegates to the driver's `table_data`, which
/// for relational engines builds a dialect-correct `SELECT * FROM <qualified>`
/// and for non-SQL engines (MongoDB/Redis/Elasticsearch) fetches natively
/// (find/scan/_search) — so collections/keys/indices show their rows too.
#[tauri::command]
pub async fn db_table_preview(conn_id: String, schema: Option<String>, table: String,
    limit: u32, offset: u32, mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.table_data(schema.as_deref(), &table, limit, offset).await
}

/// Write `contents` to `path` on disk. Used by the grid's CSV/JSON export, which
/// picks a destination via the dialog plugin and then asks the backend to write
/// the file (the webview `<a download>` trick is a no-op inside Tauri).
#[tauri::command]
pub async fn export_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// 解析整库导出的「单表行上限」。
///
/// codex 评审阻断项修复：调用方**省略** `row_limit` 时返回 `None`（无上限，导出全部
/// 行），而不是默默截断到 10_000——后者会让还原时数据缺失却无任何报错。只有调用方
/// **显式**传入一个值（含 0：仅导结构不导行）时才按该值截断,且截断会在脚本里以
/// `(truncated)` 注释显式标注。
fn resolve_export_row_cap(row_limit: Option<u32>) -> Option<u32> {
    row_limit
}

/// 整库导出为 SQL 脚本（DDL + 数据 INSERT 批 + 头注释）。枚举所选 schema 下的表,
/// 逐表分页取数,DDL 由前端按结构面板已有逻辑生成后随 `table_ddls` 传入（后端不重复
/// 实现各引擎 DDL 反射）。脚本拼装走 export::build_database_sql_export（纯函数,已单测）。
///
/// 真实串流取数依赖驱动 I/O,无法本地单测：行获取照搬 table_data 既有模式,逐表累计。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_export_database(conn_id: String, database: String, schema: String,
    selected_tables: Vec<String>, table_ddls: std::collections::HashMap<String, String>,
    include_structure: bool, include_data: bool, batch_size: Option<usize>, row_limit: Option<u32>,
    mgr: tauri::State<'_, ConnManager>) -> Result<String, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let has_schemas = drv.capabilities().schemas;
    let batch = batch_size.unwrap_or(crate::db::export::DEFAULT_INSERT_BATCH_SIZE);
    // None = 无上限（导出全部行）；Some(n) = 显式截断到 n 行并在脚本里标注 truncated。
    let cap = resolve_export_row_cap(row_limit);

    // 枚举要导出的表：未指定则取该 schema 下全部（排除视图，仅 kind=="table"）。
    let all = drv.list_tables(&schema).await?;
    let wanted: std::collections::HashSet<&str> = selected_tables.iter().map(String::as_str).collect();
    let tables_iter = all.iter().filter(|t| t.kind != "view"
        && (wanted.is_empty() || wanted.contains(t.name.as_str())));

    let schema_opt = if has_schemas && !schema.is_empty() { Some(schema.as_str()) } else { None };
    let mut export_tables: Vec<crate::db::export::ExportTable> = Vec::new();

    for info in tables_iter {
        let name = &info.name;
        let (mut columns, mut rows, mut truncated) = (Vec::new(), Vec::new(), false);

        if include_data {
            // 分页取数，逐批累计到内存。cap=None 时导出全部行（无上限）；cap=Some(n)
            // 时截断到 n 行并标记 truncated（对齐 dbx 的可选整库行上限,但默认不静默截断）。
            let mut offset: u32 = 0;
            loop {
                let page = match cap {
                    Some(c) => {
                        let remaining = c.saturating_sub(rows.len() as u32);
                        if remaining == 0 { truncated = true; break; }
                        remaining.min(batch as u32)
                    }
                    None => batch as u32,
                };
                let res = drv.table_data(schema_opt, name, page, offset).await?;
                if columns.is_empty() {
                    // 去掉 Postgres 注入的 __ctid 隐藏列（仅用于无主键行定位，非真实列）。
                    columns = res.columns.iter().map(|c| c.name.clone())
                        .filter(|c| c != "__ctid").collect();
                }
                let ctid_idx = res.columns.iter().position(|c| c.name == "__ctid");
                let got = res.rows.len();
                for row in res.rows {
                    let row: Vec<serde_json::Value> = match ctid_idx {
                        Some(i) => row.into_iter().enumerate()
                            .filter(|(j, _)| *j != i).map(|(_, v)| v).collect(),
                        None => row,
                    };
                    rows.push(row);
                }
                offset += got as u32;
                if (got as u32) < page { break; }
            }
        }

        export_tables.push(crate::db::export::ExportTable {
            display_name: name.clone(),
            schema: schema_opt.map(str::to_string),
            table_name: name.clone(),
            ddl: table_ddls.get(name).cloned(),
            columns,
            rows,
            truncated,
        });
    }

    // chrono 此处未启用 clock feature；用既有 now_stamp()（unix 秒）作时间戳即可。
    let exported_at = now_stamp();
    Ok(crate::db::export::build_database_sql_export(
        drv.db_type(), has_schemas, &database, &exported_at, &export_tables,
        include_structure, include_data, batch,
    ))
}

// ── 表数据导入（CSV/TSV/JSON → 批量 INSERT）────────────────────────────────────

/// 文件预览结果：文件名/类型/大小 + 列 + 样本行（受 DEFAULT_PREVIEW_LIMIT 截断）+ 总行数。
/// 供导入对话框预览数据与初始化列映射。纯解析逻辑走 table_import（已单测）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub file_name: String,
    pub file_type: String,
    pub size_bytes: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    /// 预览是否被 DEFAULT_PREVIEW_LIMIT 截断（用于 UI 提示「仅展示前 N 行」）。
    pub truncated: bool,
}

/// 读取并预览导入文件。读文件 I/O 在此接线，解析为纯函数（table_import,已单测）。
#[tauri::command]
pub async fn db_import_preview(file_path: String) -> Result<ImportPreview, DbError> {
    use crate::db::table_import as ti;
    let kind = ti::import_file_kind(&file_path).map_err(DbError::QueryFailed)?;
    // 读盘前先按元数据校验大小,超限直接拒绝（避免把过大文件读入内存导致 OOM）。
    let meta = tokio::fs::metadata(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    ti::check_import_size(meta.len() as usize).map_err(DbError::QueryFailed)?;
    let bytes = tokio::fs::read(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    let size_bytes = bytes.len() as u64;
    let parsed = ti::parse_import_bytes(kind, &bytes, ti::DEFAULT_PREVIEW_LIMIT).map_err(DbError::QueryFailed)?;
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&file_path)
        .to_string();
    let truncated = parsed.total_rows > parsed.rows.len();
    Ok(ImportPreview {
        file_name,
        file_type: kind.label().to_string(),
        size_bytes,
        columns: parsed.columns,
        rows: parsed.rows,
        total_rows: parsed.total_rows,
        truncated,
    })
}

/// 导入执行结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub rows_imported: usize,
    pub total_rows: usize,
}

/// 把文件按列映射导入目标表：解析全部行 → 校验映射 → 生成批量 INSERT → 逐批执行。
///
/// `mode` 为 "truncate" 时先清空目标表（SQLite 用 DELETE）。语句生成为纯函数
/// （table_import,已单测）；执行走驱动 query I/O,照搬 db_export_database 的 mgr 取连接模式,
/// 需真机验证执行落库。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_import_table(
    conn_id: String,
    schema: Option<String>,
    table: String,
    file_path: String,
    mappings: Vec<crate::db::table_import::ImportColumnMapping>,
    mode: String,
    batch_size: Option<usize>,
    mgr: tauri::State<'_, ConnManager>,
) -> Result<ImportSummary, DbError> {
    use crate::db::table_import as ti;
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let db = drv.db_type();
    let has_schemas = drv.capabilities().schemas;
    let schema_opt = schema.as_deref().filter(|s| has_schemas && !s.is_empty());
    let batch = batch_size.unwrap_or(ti::DEFAULT_BATCH_SIZE);

    let kind = ti::import_file_kind(&file_path).map_err(DbError::QueryFailed)?;
    // 读盘前先按元数据校验大小,超限直接拒绝（避免整文件 + 展开行同时驻留堆 → OOM）。
    let meta = tokio::fs::metadata(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    ti::check_import_size(meta.len() as usize).map_err(DbError::QueryFailed)?;
    let bytes = tokio::fs::read(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    // usize::MAX：导入读取全部行（预览才截断）。
    let parsed = ti::parse_import_bytes(kind, &bytes, usize::MAX).map_err(DbError::QueryFailed)?;
    let total_rows = parsed.total_rows;

    let batches = ti::build_import_insert_batches(db, has_schemas, schema_opt, &table, &parsed, &mappings, batch)
        .map_err(DbError::QueryFailed)?;

    let truncate = mode.eq_ignore_ascii_case("truncate");
    // 支持事务的引擎（PG/MySQL/SQLite/SQLServer/DuckDB）在 truncate 模式下把
    // 「清表 + 所有 INSERT 批次」包进同一事务,任一步失败即 ROLLBACK,保证原子性;
    // 不支持事务的引擎（ClickHouse/Redis 等）退化为逐条执行（无回滚,见前端告警）。
    let use_txn = truncate && ti::import_supports_transaction(db);

    if use_txn {
        let (begin, commit, rollback) = ti::transaction_keywords(db);
        drv.query(begin, 0).await?;
        // 事务内任一步失败 → 先尽力 ROLLBACK,再把原始错误返回。
        let run = async {
            let sql = ti::truncate_sql(db, has_schemas, schema_opt, &table);
            drv.query(&sql, 0).await?;
            for b in &batches {
                drv.query(&b.sql, 0).await?;
            }
            Ok::<(), DbError>(())
        };
        if let Err(e) = run.await {
            let _ = drv.query(rollback, 0).await; // best-effort 回滚,保留原错误
            return Err(e);
        }
        drv.query(commit, 0).await?;
        let rows_imported = batches.iter().map(|b| b.row_count).sum::<usize>().min(total_rows);
        return Ok(ImportSummary { rows_imported, total_rows });
    }

    // 非事务路径：append 模式,或不支持事务的引擎的 truncate 模式（无回滚）。
    if truncate {
        let sql = ti::truncate_sql(db, has_schemas, schema_opt, &table);
        drv.query(&sql, 0).await?;
    }

    let mut rows_imported = 0usize;
    for b in &batches {
        drv.query(&b.sql, 0).await?;
        rows_imported = (rows_imported + b.row_count).min(total_rows);
    }

    Ok(ImportSummary { rows_imported, total_rows })
}

// ── 跨库/跨表数据迁移（源表 → 列映射 → 按模式写目标表）──────────────────────────

/// 迁移执行结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub rows_transferred: usize,
}

/// 把源连接的一张表按列映射迁移到目标连接的目标表。
///
/// 编排：分页从源表取数（照搬 db_export_database 的 table_data 分页 + 去 __ctid）→ 用源列名
/// 解析映射（transfer.rs 纯函数,已单测）→ 按模式生成目标写 SQL（Append/Overwrite/Upsert）→
/// 逐批在目标驱动执行。Overwrite 先清空目标表;支持事务的目标引擎把整个写过程包进事务。
///
/// 语句生成 + 映射 + 模式均为纯函数（transfer.rs,已单测）；真实双库执行走驱动 I/O,
/// 需真机验证（不同源/目标引擎的类型与字面量兼容性）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_transfer_table(
    source_conn_id: String,
    source_schema: Option<String>,
    source_table: String,
    target_conn_id: String,
    target_schema: Option<String>,
    target_table: String,
    mappings: Vec<crate::db::transfer::TransferColumnMapping>,
    mode: crate::db::transfer::TransferMode,
    upsert_keys: Option<Vec<String>>,
    batch_size: Option<usize>,
    allow_destructive: Option<bool>,
    mgr: tauri::State<'_, ConnManager>,
) -> Result<TransferSummary, DbError> {
    use crate::db::transfer as tr;
    use crate::db::table_import as ti;

    let src = mgr.get(&source_conn_id).await.ok_or_else(|| DbError::NotFound(source_conn_id.clone()))?;
    let dst = mgr.get(&target_conn_id).await.ok_or_else(|| DbError::NotFound(target_conn_id.clone()))?;

    let src_has_schemas = src.capabilities().schemas;
    let dst_db = dst.db_type();
    let dst_has_schemas = dst.capabilities().schemas;
    let src_schema_opt = source_schema.as_deref().filter(|s| src_has_schemas && !s.is_empty());
    let dst_schema_opt = target_schema.as_deref().filter(|s| dst_has_schemas && !s.is_empty());
    let batch = batch_size.unwrap_or(tr::DEFAULT_TRANSFER_BATCH_SIZE).max(1);
    let upsert_keys = upsert_keys.unwrap_or_default();
    let allow_destructive = allow_destructive.unwrap_or(false);

    // ── 前置校验（在任何写入/清表之前）─────────────────────────────────────────
    // Upsert: 引擎须原生支持 + 键合法;Overwrite: 必须已显式确认破坏性操作（codex 阻断项）。
    let mapped_targets =
        mappings.iter().map(|m| m.target_column.clone()).filter(|c| !c.trim().is_empty()).collect::<Vec<_>>();
    tr::check_transfer_preconditions(mode, dst_db, &mapped_targets, &upsert_keys, allow_destructive)
        .map_err(DbError::QueryFailed)?;

    // 先读源表首批,拿到真实列名解析+校验映射（在 Overwrite 清表之前!）——若映射解析失败,
    // 此时目标表尚未被动过,不会造成不可恢复的数据丢失（codex 阻断项: 清表早于映射解析）。
    let strip_ctid = |columns: &[crate::db::result::ColumnInfo], rows: Vec<Vec<serde_json::Value>>| {
        let ctid_idx = columns.iter().position(|c| c.name == "__ctid");
        rows.into_iter()
            .map(|row| match ctid_idx {
                Some(i) => row.into_iter().enumerate().filter(|(j, _)| *j != i).map(|(_, v)| v).collect(),
                None => row,
            })
            .collect::<Vec<_>>()
    };

    let first = src.table_data(src_schema_opt, &source_table, batch as u32, 0).await?;
    let source_columns =
        first.columns.iter().map(|c| c.name.clone()).filter(|c| c != "__ctid").collect::<Vec<_>>();
    let mapped = tr::resolve_transfer_mapping(&source_columns, &mappings).map_err(DbError::QueryFailed)?;

    let first_got = first.rows.len();
    let first_rows = strip_ctid(&first.columns, first.rows);

    // ── 一个「逐批写目标」的闭包：从首批开始,继续分页拉取并逐批生成写 SQL 执行 ───────────
    // Overwrite 的清表与所有写入要么都在同一事务内（支持事务的引擎,任一步失败 ROLLBACK）,
    // 要么在非事务引擎上按顺序执行（无回滚,前端已二次确认 + 告警）。
    // 用 Arc 克隆供闭包按值持有,原始 src/dst 仍可用于事务控制（BEGIN/COMMIT/ROLLBACK）。
    let src_w = src.clone();
    let dst_w = dst.clone();
    let mapped_w = mapped.clone();
    let upsert_keys_w = upsert_keys.clone();
    let target_table_w = target_table.clone();
    let do_writes = move |this_first_rows: Vec<Vec<serde_json::Value>>, this_first_got: usize| async move {
        let mut rows_transferred = 0usize;
        let mut pending = this_first_rows;
        let mut got = this_first_got;
        let mut offset = this_first_got as u32;

        loop {
            if !pending.is_empty() {
                let sql = tr::build_transfer_write_sql(
                    mode, dst_db, dst_has_schemas, dst_schema_opt, &target_table_w, &mapped_w, &pending, &upsert_keys_w,
                );
                if !sql.is_empty() {
                    dst_w.query(&sql, 0).await?;
                    rows_transferred += pending.len();
                }
            }
            if (got as u32) < batch as u32 {
                break;
            }
            let res = src_w.table_data(src_schema_opt, &source_table, batch as u32, offset).await?;
            got = res.rows.len();
            offset += got as u32;
            pending = strip_ctid(&res.columns, res.rows);
        }
        Ok::<usize, DbError>(rows_transferred)
    };

    // Overwrite 走「清表 + 写入」原子化路径;Append/Upsert 直接写。
    if mode == tr::TransferMode::Overwrite {
        let truncate_sql = tr::build_overwrite_pre_sql(dst_db, dst_has_schemas, dst_schema_opt, &target_table);
        if ti::import_supports_transaction(dst_db) {
            // 支持事务: 清表 + 全部写入包进同一事务,任一步失败即 ROLLBACK,目标表保持原状,
            // 杜绝「已清表但写入失败」的不可恢复数据丢失（codex 阻断项）。
            let (begin, commit, rollback) = ti::transaction_keywords(dst_db);
            dst.query(begin, 0).await?;
            let run = async {
                dst.query(&truncate_sql, 0).await?;
                do_writes(first_rows, first_got).await
            };
            match run.await {
                Ok(rows_transferred) => {
                    dst.query(commit, 0).await?;
                    Ok(TransferSummary { rows_transferred })
                }
                Err(e) => {
                    let _ = dst.query(rollback, 0).await; // best-effort 回滚,保留原错误
                    Err(e)
                }
            }
        } else {
            // 不支持事务的引擎: 无回滚,前端已二次确认 + 展示告警。
            dst.query(&truncate_sql, 0).await?;
            let rows_transferred = do_writes(first_rows, first_got).await?;
            Ok(TransferSummary { rows_transferred })
        }
    } else {
        let rows_transferred = do_writes(first_rows, first_got).await?;
        Ok(TransferSummary { rows_transferred })
    }
}

// ── JDBC driver management (DBeaver-style one-click download) ─────────────────

/// Resolve the directory where JDBC driver JARs live: `CATIO_JDBC_DRIVERS_DIR`
/// if set (dev/test + the value the app sets at startup), else
/// `<app_data>/jdbc/drivers`. Created if missing.
fn jdbc_drivers_dir(app: &tauri::AppHandle) -> Result<PathBuf, DbError> {
    if let Some(d) = std::env::var_os("CATIO_JDBC_DRIVERS_DIR") {
        let p = PathBuf::from(d);
        std::fs::create_dir_all(&p).map_err(|e| DbError::Io(e.to_string()))?;
        return Ok(p);
    }
    let dir = app_data_dir(app)?.join("jdbc").join("drivers");
    std::fs::create_dir_all(&dir).map_err(|e| DbError::Io(e.to_string()))?;
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdbcDriverStatus {
    /// engine profile (e.g. "oracle").
    pub profile: String,
    /// the expected driver JAR is present in the drivers dir.
    pub installed: bool,
    /// expected JAR filename (when there is a known download), else None.
    pub file_name: Option<String>,
    /// has a one-click Maven download (false → user must supply the JAR).
    pub downloadable: bool,
    /// JDBC driver class, shown as a hint for manual installs.
    pub driver_class: Option<String>,
    /// directory the user can drop a manual JAR into.
    pub drivers_dir: String,
    /// 驱动目录下现有的全部 `*.jar` 文件名（让用户确认 jar 是否放对位置）。
    pub jars: Vec<String>,
}

fn jdbc_status(profile: &str, dir: &std::path::Path) -> JdbcDriverStatus {
    use crate::db::drivers::jdbc_config;
    let spec = jdbc_config::download_spec(profile);
    let (installed, file_name) = match &spec {
        Some(s) => (dir.join(&s.file_name).exists(), Some(s.file_name.clone())),
        None => (false, None),
    };
    let mut jars: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("jar")) == Some(true))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    jars.sort();
    JdbcDriverStatus {
        profile: profile.to_string(),
        installed,
        file_name,
        downloadable: spec.is_some(),
        driver_class: jdbc_config::driver_class(profile),
        drivers_dir: dir.to_string_lossy().into_owned(),
        jars,
    }
}

/// Report whether the JDBC driver for `profile` is installed + downloadable.
#[tauri::command]
pub async fn jdbc_driver_status(profile: String, app: tauri::AppHandle)
    -> Result<JdbcDriverStatus, DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    Ok(jdbc_status(&profile, &dir))
}

/// Download the JDBC driver JAR for `profile` from Maven Central into the drivers
/// dir (streamed to a `.part` file then renamed). No-op if already present.
#[tauri::command]
pub async fn jdbc_download_driver(profile: String, app: tauri::AppHandle)
    -> Result<JdbcDriverStatus, DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    download_driver_to_dir(&profile, &dir).await
}

/// Core (AppHandle-free) driver download — testable directly. Streams the Maven
/// JAR to `<dir>/<file>.part` then renames it into place; no-op if present.
pub async fn download_driver_to_dir(profile: &str, dir: &std::path::Path)
    -> Result<JdbcDriverStatus, DbError> {
    use crate::db::drivers::jdbc_config;
    use futures_util::StreamExt;
    use std::io::Write;

    let spec = jdbc_config::download_spec(profile).ok_or_else(|| {
        DbError::Unsupported(format!(
            "'{profile}' has no auto-download — place its driver JAR in {}",
            dir.to_string_lossy()
        ))
    })?;
    let target = dir.join(&spec.file_name);
    if !target.exists() {
        let resp = reqwest::Client::new()
            .get(&spec.url)
            .send().await
            .map_err(|e| DbError::Io(format!("driver download failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(DbError::Io(format!("driver download failed: HTTP {}", resp.status())));
        }
        let tmp = dir.join(format!("{}.part", spec.file_name));
        {
            let mut file = std::fs::File::create(&tmp).map_err(|e| DbError::Io(e.to_string()))?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| DbError::Io(format!("driver download interrupted: {e}")))?;
                file.write_all(&chunk).map_err(|e| DbError::Io(e.to_string()))?;
            }
            file.flush().map_err(|e| DbError::Io(e.to_string()))?;
        }
        std::fs::rename(&tmp, &target).map_err(|e| DbError::Io(e.to_string()))?;
    }
    Ok(jdbc_status(profile, dir))
}

/// 核心（AppHandle-free）驱动导入：把用户选中的 `src` jar 复制进驱动目录。
/// 非 `.jar` 后缀直接拒绝；同名覆盖（用户主动选择即视为意图替换）。
pub fn import_driver_to_dir(profile: &str, src: &std::path::Path, dir: &std::path::Path)
    -> Result<JdbcDriverStatus, DbError> {
    let is_jar = src.extension().and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("jar")) == Some(true);
    if !is_jar {
        return Err(DbError::Unsupported("只能导入 .jar 驱动文件".into()));
    }
    let file_name = src.file_name()
        .ok_or_else(|| DbError::Io("无效的文件名".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| DbError::Io(e.to_string()))?;
    let target = dir.join(file_name);
    // 用户可能选中的就是驱动目录里已有的同一个 jar（如先下载再点"选择 JAR"）。
    // 此时 fs::copy 自我复制会报 OS 错误甚至截断文件——视为已就位，直接返回。
    let same_file = std::fs::canonicalize(src).ok()
        .zip(std::fs::canonicalize(&target).ok())
        .map(|(a, b)| a == b)
        .unwrap_or(false);
    if !same_file {
        std::fs::copy(src, &target).map_err(|e| DbError::Io(e.to_string()))?;
    }
    Ok(jdbc_status(profile, dir))
}

/// 把用户选中的驱动 jar 复制进驱动目录，返回刷新后的状态。
#[tauri::command]
pub async fn jdbc_import_driver(profile: String, path: String, app: tauri::AppHandle)
    -> Result<JdbcDriverStatus, DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    import_driver_to_dir(&profile, std::path::Path::new(&path), &dir)
}

/// 在系统文件管理器中打开驱动目录（Windows explorer / macOS open / Linux xdg-open）。
#[tauri::command]
pub async fn jdbc_open_drivers_dir(app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| DbError::Io(format!("打开驱动目录失败: {e}")))?;
    Ok(())
}

// ── SQL 文件批量执行（选文件 → 按方言切分 → 逐句执行 + 进度/错误恢复 + 取消）─────────
//
// 语句切分为纯函数（sql_file.rs,已单测）；本处为 I/O 编排（照搬 scan 的
// CancellationToken + app.emit 进度、db_import_table 的逐句驱动执行）,需真机验证落库。

/// SQL 文件预览（选文件后展示文件名/大小/语句数,执行前确认）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub size_bytes: u64,
    pub statement_count: usize,
}

/// 读 SQL 文件并按目标连接的方言切分,返回预览（文件名/大小/语句数）。
#[tauri::command]
pub async fn db_sql_file_preview(
    conn_id: String,
    file_path: String,
    mgr: tauri::State<'_, ConnManager>,
) -> Result<SqlFilePreview, DbError> {
    use crate::db::sql_file as sf;
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let db = drv.db_type();
    let meta = tokio::fs::metadata(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    // 读盘前先按元数据校验大小,超限直接拒绝（避免把整个 dump 文件读入内存导致 OOM）。
    sf::check_sql_file_size(meta.len() as usize).map_err(DbError::Io)?;
    let bytes = tokio::fs::read(&file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    let content = decode_sql_file_bytes(&bytes)?;
    let statements = sf::split_sql_statements_for_database(&content, db);
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&file_path)
        .to_string();
    Ok(SqlFilePreview { file_name, size_bytes: meta.len(), statement_count: statements.len() })
}

/// 解码 SQL 文件字节为 UTF-8 文本（处理 UTF-8 BOM；其余按 UTF-8 解释）。
fn decode_sql_file_bytes(bytes: &[u8]) -> Result<String, DbError> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..])
            .map(|t| t.to_string())
            .map_err(|_| DbError::Io("SQL 文件不是有效的 UTF-8 编码".into()));
    }
    std::str::from_utf8(bytes)
        .map(|t| t.strip_prefix('\u{feff}').unwrap_or(t).to_string())
        .map_err(|_| DbError::Io("SQL 文件不是有效的 UTF-8 编码,请另存为 UTF-8".into()))
}

/// 取消正在执行的 SQL 文件批量任务（按 executionId）。
#[tauri::command]
pub async fn db_cancel_sql_file(execution_id: String, state: tauri::State<'_, crate::db::SqlFileState>)
    -> Result<(), DbError> {
    state.cancel(&execution_id).await;
    Ok(())
}

/// 执行整个 SQL 文件：按方言切分 → 逐句走驱动执行 → 每句开始/完成/失败、整体完成/出错/取消
/// 各 emit 一次 `db://sql-file-progress`。`continue_on_error=true` 时单句失败继续,否则中止。
/// 取消由 `SqlFileState` 的令牌驱动（在每句执行前检查）。
#[tauri::command]
pub async fn db_run_sql_file(
    req: crate::db::sql_file::SqlFileRequest,
    mgr: tauri::State<'_, ConnManager>,
    state: tauri::State<'_, crate::db::SqlFileState>,
    app: tauri::AppHandle,
) -> Result<(), DbError> {
    use crate::db::sql_file as sf;
    use tauri::Emitter;

    let drv = mgr.get(&req.conn_id).await.ok_or_else(|| DbError::NotFound(req.conn_id.clone()))?;
    let db = drv.db_type();

    // 读盘前先按元数据校验大小,超限直接拒绝（避免把整个 dump 文件读入内存导致 OOM）。
    let meta = tokio::fs::metadata(&req.file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    sf::check_sql_file_size(meta.len() as usize).map_err(DbError::Io)?;
    let bytes = tokio::fs::read(&req.file_path).await.map_err(|e| DbError::Io(e.to_string()))?;
    let content = decode_sql_file_bytes(&bytes)?;
    let statements = sf::split_sql_statements_for_database(&content, db);
    let total = statements.len();

    let token = state.register(req.execution_id.clone()).await;
    let started = Instant::now();

    let mut success_count = 0usize;
    let mut failure_count = 0usize;
    let mut affected_rows = 0u64;

    let emit = |status: sf::SqlFileStatus,
                statement_index: usize,
                success_count: usize,
                failure_count: usize,
                affected_rows: u64,
                summary: &str,
                error: Option<String>| {
        let _ = app.emit(
            "db://sql-file-progress",
            sf::SqlFileProgress {
                execution_id: req.execution_id.clone(),
                status,
                statement_index,
                total,
                success_count,
                failure_count,
                affected_rows,
                elapsed_ms: started.elapsed().as_millis(),
                statement_summary: summary.to_string(),
                error,
            },
        );
    };

    emit(sf::SqlFileStatus::Started, 0, 0, 0, 0, "", None);

    for (idx, statement) in statements.iter().enumerate() {
        let statement_index = idx + 1;
        if token.is_cancelled() {
            emit(sf::SqlFileStatus::Cancelled, statement_index, success_count, failure_count, affected_rows, "", None);
            state.remove(&req.execution_id).await;
            return Ok(());
        }
        let summary = sf::statement_summary(statement);
        emit(sf::SqlFileStatus::Running, statement_index, success_count, failure_count, affected_rows, &summary, None);

        match drv.query(statement, 0).await {
            Ok(result) => {
                success_count += 1;
                affected_rows += result.rows_affected.unwrap_or(0);
                emit(
                    sf::SqlFileStatus::StatementDone,
                    statement_index,
                    success_count,
                    failure_count,
                    affected_rows,
                    &summary,
                    None,
                );
            }
            Err(err) => {
                let message = err.to_string();
                let decision = sf::decide_statement_error(failure_count, req.continue_on_error);
                failure_count = decision.failure_count;
                emit(
                    sf::SqlFileStatus::StatementFailed,
                    statement_index,
                    success_count,
                    failure_count,
                    affected_rows,
                    &summary,
                    Some(message.clone()),
                );
                if decision.abort {
                    emit(
                        sf::SqlFileStatus::Error,
                        statement_index,
                        success_count,
                        failure_count,
                        affected_rows,
                        &summary,
                        Some(message),
                    );
                    state.remove(&req.execution_id).await;
                    return Ok(());
                }
            }
        }
    }

    emit(sf::SqlFileStatus::Done, total, success_count, failure_count, affected_rows, "", None);
    state.remove(&req.execution_id).await;
    Ok(())
}

// qualified-table tests moved to dialect.rs (`qualified_table`).

#[cfg(test)]
mod drop_absent_tests {
    use super::is_object_absent_error;

    #[test]
    fn detects_postgres_does_not_exist() {
        assert!(is_object_absent_error("ERROR: table \"orders\" does not exist"));
        assert!(is_object_absent_error("trigger \"t\" for table \"orders\" does not exist"));
    }

    #[test]
    fn detects_mysql_unknown_or_cant_drop() {
        // MySQL DROP INDEX / DROP FOREIGN KEY 不支持 IF EXISTS，重试/竞态时报这些。
        assert!(is_object_absent_error("Error 1091: Can't DROP 'idx_status'; check that column/key exists"));
        assert!(is_object_absent_error("Error 1051: Unknown table 'mydb.orders'"));
        assert!(is_object_absent_error("Unknown trigger 'trg_audit'"));
    }

    #[test]
    fn detects_sqlserver_and_sqlite() {
        assert!(is_object_absent_error("Cannot drop the index 'ix_status', because it does not exist"));
        assert!(is_object_absent_error("no such index: idx_status"));
        assert!(is_object_absent_error("no such trigger: trg_audit"));
    }

    #[test]
    fn does_not_match_real_failures() {
        assert!(!is_object_absent_error("permission denied for table orders"));
        assert!(!is_object_absent_error("syntax error at or near \"DROP\""));
        assert!(!is_object_absent_error("connection reset by peer"));
    }
}

#[cfg(test)]
mod jdbc_status_tests {
    use super::jdbc_status;
    use std::fs;

    #[test]
    fn lists_jars_present_in_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("DmJdbcDriver18-8.1.3.62.jar"), b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let s = jdbc_status("dameng", dir.path());
        assert_eq!(s.jars, vec!["DmJdbcDriver18-8.1.3.62.jar".to_string()]);
    }

    #[test]
    fn empty_dir_yields_no_jars() {
        let dir = tempfile::tempdir().unwrap();
        let s = jdbc_status("yashandb", dir.path());
        assert!(s.jars.is_empty());
    }

    #[test]
    fn import_copies_jar_into_dir() {
        let src = tempfile::tempdir().unwrap();
        let jar = src.path().join("DmJdbcDriver18-8.1.3.62.jar");
        fs::write(&jar, b"JARBYTES").unwrap();
        let dst = tempfile::tempdir().unwrap();

        let status = super::import_driver_to_dir("dameng", &jar, dst.path()).unwrap();
        assert!(dst.path().join("DmJdbcDriver18-8.1.3.62.jar").exists());
        assert!(status.jars.contains(&"DmJdbcDriver18-8.1.3.62.jar".to_string()));
    }

    #[test]
    fn import_rejects_non_jar() {
        let src = tempfile::tempdir().unwrap();
        let txt = src.path().join("driver.txt");
        fs::write(&txt, b"x").unwrap();
        let dst = tempfile::tempdir().unwrap();
        assert!(super::import_driver_to_dir("dameng", &txt, dst.path()).is_err());
    }

    #[test]
    fn import_of_jar_already_in_dir_is_a_noop_success() {
        // 用户选中的就是驱动目录里已有的 jar：不应自我复制报错或截断文件。
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("DmJdbcDriver18-8.1.3.62.jar");
        fs::write(&jar, b"JARBYTES").unwrap();
        let status = super::import_driver_to_dir("dameng", &jar, dir.path()).unwrap();
        assert!(status.jars.contains(&"DmJdbcDriver18-8.1.3.62.jar".to_string()));
        assert_eq!(fs::read(&jar).unwrap(), b"JARBYTES", "原文件内容未被破坏");
    }
}

#[cfg(test)]
mod export_row_cap_tests {
    use super::resolve_export_row_cap;

    #[test]
    fn omitted_limit_means_unlimited_not_silent_10k_cap() {
        // codex 阻断项：调用方省略 row_limit 时,整库导出必须导出全部行（无上限），
        // 而不是默默截断到 10_000 导致还原数据缺失。
        assert_eq!(resolve_export_row_cap(None), None);
    }

    #[test]
    fn explicit_limit_is_respected() {
        // 调用方显式传入上限时,按该上限截断（用于预览/抽样导出）。
        assert_eq!(resolve_export_row_cap(Some(500)), Some(500));
        assert_eq!(resolve_export_row_cap(Some(10_000)), Some(10_000));
    }

    #[test]
    fn explicit_zero_limit_is_respected_not_treated_as_unlimited() {
        // 显式 0 与「省略」语义不同：0 表示只导结构不导行,不应被当成无上限。
        assert_eq!(resolve_export_row_cap(Some(0)), Some(0));
    }
}
