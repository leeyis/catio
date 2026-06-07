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
