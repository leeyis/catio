use crate::db::{DbError, ids::IdGen};
use crate::db::driver::{self, ConnectArgs, EditRequest, TableInfo, TableStructure, ErRelation};
use crate::db::manager::ConnManager;
use crate::db::result::QueryResult;
use crate::db::capabilities::Capabilities;
use crate::db::dml::{self, CellEdit};
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
pub async fn db_query(conn_id: String, sql: String, max_rows: Option<u32>,
    mgr: tauri::State<'_, ConnManager>, app: tauri::AppHandle) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or_else(|| DbError::NotFound(conn_id.clone()))?;
    let started = Instant::now();
    let result = drv.query(&sql, max_rows.unwrap_or(1000)).await?;
    let dur = format!("{}ms", started.elapsed().as_millis());

    // Best-effort: record a history entry on success. Never fail the query if
    // history persistence has a problem.
    if let Ok(dir) = app_data_dir(&app) {
        let entry = HistoryEntry {
            id: HISTORY_IDS.next(),
            kind: "sql".into(),
            target: conn_id,
            text: sql,
            when: now_stamp(),
            dur,
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
    for s in drv.list_schemas().await? {
        let tables = drv.list_tables(&s).await?;
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
    build_sql(drv.db_type(), &req)
}

#[tauri::command]
pub async fn db_apply_edits(conn_id: String, reqs: Vec<EditRequest>,
    mgr: tauri::State<'_, ConnManager>) -> Result<u64, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    if !drv.capabilities().writable {
        return Err(DbError::Unsupported("read-only engine".into()));
    }
    let mut affected = 0u64;
    for req in &reqs {
        let sql = build_sql(drv.db_type(), req)?;
        let r = drv.query(&sql, 0).await?;
        affected += r.rows_affected.unwrap_or(0);
    }
    Ok(affected)
}

#[tauri::command]
pub async fn db_query_page(conn_id: String, sql: String, limit: u32, offset: u32,
    mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.paginated_query(&sql, limit, offset).await
}

/// Build a dialect-correct, identifier-quoted qualified table name.
///
/// Mirrors dml.rs's `qualified`, but only qualifies with a schema when the
/// engine actually has schema namespaces (`has_schemas`) AND a non-empty
/// schema was supplied. Engines without schemas (MySQL/SQLite/ClickHouse/...)
/// always get the bare quoted table name.
fn qualified_name(
    db: crate::db::DatabaseType, has_schemas: bool, schema: Option<&str>, table: &str,
) -> String {
    use crate::db::dialect::quote_ident;
    match schema {
        Some(s) if has_schemas && !s.is_empty() =>
            format!("{}.{}", quote_ident(db, s), quote_ident(db, table)),
        _ => quote_ident(db, table),
    }
}

/// Dialect-correct, paginated `SELECT * FROM <qualified table>`.
///
/// Qualification respects the engine's schema capability so non-Postgres
/// engines (MySQL/SQLite/SQLServer/ClickHouse/...) get correct quoting and
/// no bogus `public.` prefix. Pagination is dialect-aware via
/// `paginated_query` (SQLServer OFFSET/FETCH vs LIMIT/OFFSET).
#[tauri::command]
pub async fn db_table_preview(conn_id: String, schema: Option<String>, table: String,
    limit: u32, offset: u32, mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    let has_schemas = drv.capabilities().schemas;
    let qualified = qualified_name(drv.db_type(), has_schemas, schema.as_deref(), &table);
    // On Postgres, prepend the `ctid` system column (aliased to `__ctid`) so each
    // row carries a stable physical identity. This lets the grid edit/delete rows
    // in tables that have NO primary key (the frontend strips `__ctid` from the
    // display and uses it as the row key). Other engines are unchanged.
    let select = if drv.db_type() == crate::db::DatabaseType::Postgres {
        format!("SELECT ctid AS __ctid, * FROM {}", qualified)
    } else {
        format!("SELECT * FROM {}", qualified)
    };
    drv.paginated_query(&select, limit, offset).await
}

/// Write `contents` to `path` on disk. Used by the grid's CSV/JSON export, which
/// picks a destination via the dialog plugin and then asks the backend to write
/// the file (the webview `<a download>` trick is a no-op inside Tauri).
#[tauri::command]
pub async fn export_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::qualified_name;
    use crate::db::DatabaseType;

    #[test]
    fn pg_with_schema_is_quoted_and_qualified() {
        let q = qualified_name(DatabaseType::Postgres, true, Some("public"), "orders");
        assert_eq!(q, r#""public"."orders""#);
    }

    #[test]
    fn mysql_no_schema_is_bare_backtick() {
        // MySQL has no schema namespace: even if a schema is passed, drop it.
        let q = qualified_name(DatabaseType::Mysql, false, Some("ignored"), "orders");
        assert_eq!(q, "`orders`");
    }

    #[test]
    fn sqlserver_with_schema_uses_brackets() {
        let q = qualified_name(DatabaseType::Sqlserver, true, Some("dbo"), "orders");
        assert_eq!(q, "[dbo].[orders]");
    }

    #[test]
    fn pg_empty_schema_falls_back_to_bare() {
        let q = qualified_name(DatabaseType::Postgres, true, Some(""), "orders");
        assert_eq!(q, r#""orders""#);
    }
}
