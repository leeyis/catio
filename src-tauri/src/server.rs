//! Web-server head (Option B). Serves the built UI and exposes the same Rust core
//! (DB drivers + connection manager) over HTTP so a LAN browser can use catio without the
//! desktop app. The desktop (Tauri) binary is untouched — both heads call the same core.
//!
//! Sessions: there is ONE shared `ConnManager` today (early single-user / small-team LAN
//! use). The multi-user extension point is `AppState` — replace the single manager with a
//! map keyed by an authenticated session/user id and resolve it per request. The frontend
//! transport already sends `{cmd,args}` exactly like Tauri's `invoke`, so no UI rework is
//! needed when that lands.
//!
//! The dispatch arms mirror the *thin* Tauri command bodies in `db::commands` (which are
//! themselves glue over the drivers/manager). Shared gating logic (`writable_drv`,
//! `build_sql`, `drop_or_absent`, …) is reused from there rather than duplicated, so the
//! web and desktop heads cannot drift. Streaming / file-path / AppHandle-only commands
//! (terminals, SFTP transfer, file import/export) are not exposed here yet — they arrive
//! over a WebSocket / multipart in later milestones and fall through to a clear error.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Json, State},
    http::{header, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

use crate::db::commands::{self, ConnectResult};
use crate::db::db_admin_sql::{
    self, DatabaseObjectType, DropObjectSqlOptions, DropTableChildObjectSqlOptions,
    DuplicateTableStructureSqlOptions, RenameObjectSqlOptions, TableAdminSqlOptions,
    TableChildObjectType,
};
use crate::db::driver::{self, ConnectArgs, EditRequest};
use crate::db::history::{self, HistoryEntry, SnippetEntry};
use crate::db::ids::IdGen;
use crate::db::manager::ConnManager;
use crate::db::object_source_sql::{self, EditableObjectSourceSqlInput, ObjectSourceKind};

static WEB_CONN_IDS: IdGen = IdGen::new("conn");
static WEB_HISTORY_IDS: IdGen = IdGen::new("hist");
static WEB_SNIPPET_IDS: IdGen = IdGen::new("snip");

#[derive(Clone)]
pub struct AppState {
    // MULTI-USER extension point: one shared manager today. Swap for a session-keyed map.
    pub conns: Arc<ConnManager>,
    pub static_dir: Arc<PathBuf>,
    /// Persisted state dir (history/snippets now; users/connections/vault in M2). Maps to
    /// the Docker data volume `/app/data`.
    pub data_dir: Arc<PathBuf>,
}

/// Build the router from an explicit state — the test seam (lets integration tests inject
/// throwaway static/data dirs without touching process env).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/invoke", post(invoke))
        .fallback(spa)
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn run_server(addr: SocketAddr, static_dir: PathBuf) -> std::io::Result<()> {
    let data_dir = std::env::var("CATIO_DATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("data"));
    let _ = std::fs::create_dir_all(&data_dir);
    let state = AppState {
        conns: Arc::new(ConnManager::default()),
        static_dir: Arc::new(static_dir),
        data_dir: Arc::new(data_dir),
    };
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("catio-server listening on http://{addr}");
    axum::serve(listener, build_router(state)).await
}

#[derive(Deserialize)]
struct InvokeReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn invoke(State(st): State<AppState>, Json(req): Json<InvokeReq>) -> Response {
    match dispatch(&st, &req.cmd, req.args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

fn estr<E: std::fmt::Display>(e: E) -> String { e.to_string() }
fn require<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("`{key}` required"))
}
/// Optional string arg → `None` for missing OR JSON `null` (the frontend sends `null` for an
/// unset schema). Empty strings pass through (the SQL builders trim/treat them as default).
fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}
fn u32_or(args: &Value, key: &str, default: u32) -> u32 {
    args.get(key).and_then(Value::as_u64).map(|n| n as u32).unwrap_or(default)
}
fn from_arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(estr)
}

fn now_stamp() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default()
}

/// Best-effort: record a DB query in the persisted history (never fails the query).
fn record_history(st: &AppState, conn_id: &str, sql: &str, dur: String, args: &Value) {
    let dir: &Path = st.data_dir.as_ref();
    if std::fs::create_dir_all(dir).is_err() { return; }
    let entry = HistoryEntry {
        id: WEB_HISTORY_IDS.next(),
        kind: "sql".into(),
        target: conn_id.to_string(),
        text: sql.to_string(),
        when: now_stamp(),
        dur,
        name: opt_str(args, "connName").map(str::to_string),
        engine: opt_str(args, "engine").map(str::to_string),
        profile_id: opt_str(args, "profileId").map(str::to_string),
    };
    let list = history::append_capped(history::load_history(dir), entry, history::MAX_HISTORY);
    let _ = history::save_history(dir, &list);
}

/// Dispatch one `invoke(cmd, args)` to the shared core. Mirrors the Tauri command bodies.
async fn dispatch(st: &AppState, cmd: &str, args: Value) -> Result<Value, String> {
    let conns = st.conns.as_ref();
    match cmd {
        // ── Connection lifecycle ────────────────────────────────────────────────
        "db_connect" => {
            let a: ConnectArgs = from_arg(&args, "args")?;
            let drv = driver::connect(&a).await.map_err(estr)?;
            let version = drv.test().await.map_err(estr)?;
            let caps = drv.capabilities();
            let id = WEB_CONN_IDS.next();
            conns.insert(id.clone(), drv).await;
            serde_json::to_value(ConnectResult { conn_id: id, version, capabilities: caps }).map_err(estr)
        }
        "db_test_connection" => {
            let a: ConnectArgs = from_arg(&args, "args")?;
            let started = Instant::now();
            let drv = driver::connect(&a).await.map_err(estr)?;
            let version = drv.test().await.map_err(estr)?;
            Ok(json!({ "version": version, "latencyMs": started.elapsed().as_millis() as u64 }))
        }
        "db_disconnect" => {
            if conns.remove(require(&args, "connId")?).await { Ok(Value::Null) }
            else { Err("connection not found".into()) }
        }

        // ── Query / pagination / explain ────────────────────────────────────────
        "db_query" => {
            let conn_id = require(&args, "connId")?;
            let drv = conns.get(conn_id).await.ok_or("connection not found")?;
            let sql = require(&args, "sql")?;
            let max_rows = u32_or(&args, "maxRows", 1000);
            let ns = opt_str(&args, "defaultNamespace");
            let started = Instant::now();
            let result = drv.query_with_default_namespace(sql, max_rows, ns).await.map_err(estr)?;
            record_history(st, conn_id, sql, format!("{}ms", started.elapsed().as_millis()), &args);
            serde_json::to_value(result).map_err(estr)
        }
        "db_query_page" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let sql = require(&args, "sql")?;
            let limit = u32_or(&args, "limit", 1000);
            let offset = u32_or(&args, "offset", 0);
            let ns = opt_str(&args, "defaultNamespace");
            serde_json::to_value(drv.paginated_query_with_default_namespace(sql, limit, offset, ns).await.map_err(estr)?).map_err(estr)
        }
        "db_explain" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let sql = require(&args, "sql")?;
            let ns = opt_str(&args, "defaultNamespace");
            let built = crate::db::query_explain_sql::build_explain_sql(drv.db_type(), sql);
            match built.sql {
                Some(explain_sql) => serde_json::to_value(
                    drv.query_with_default_namespace(&explain_sql, 1000, ns).await.map_err(estr)?,
                ).map_err(estr),
                None => Err(match built.reason.as_deref() {
                    Some("unsupported") => "此引擎不支持执行计划".into(),
                    Some("empty") => "没有可解释的 SQL".into(),
                    _ => "仅支持解释只读查询(SELECT/WITH/TABLE/VALUES)".into(),
                }),
            }
        }

        // ── Schema / structure introspection ────────────────────────────────────
        "db_schema" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let mut out = Vec::new();
            for s in drv.list_schemas().await.map_err(estr)? {
                let tables = drv.list_tables(&s).await.unwrap_or_default();
                out.push((s, tables));
            }
            serde_json::to_value(out).map_err(estr)
        }
        "db_table_structure" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let schema = opt_str(&args, "schema").unwrap_or("");
            serde_json::to_value(drv.table_structure(schema, require(&args, "table")?).await.map_err(estr)?).map_err(estr)
        }
        "db_schema_columns" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            serde_json::to_value(drv.schema_columns(require(&args, "schema")?).await.map_err(estr)?).map_err(estr)
        }
        "db_schema_functions" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            serde_json::to_value(drv.list_functions(require(&args, "schema")?).await.map_err(estr)?).map_err(estr)
        }
        "db_object_source" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let src = drv.object_source(require(&args, "schema")?, require(&args, "name")?, require(&args, "kind")?).await.map_err(estr)?;
            Ok(Value::String(src))
        }
        "db_er_model" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            serde_json::to_value(drv.er_relations(require(&args, "schema")?).await.map_err(estr)?).map_err(estr)
        }
        "db_keyspace_info" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            serde_json::to_value(drv.keyspace_info(require(&args, "schema")?).await.map_err(estr)?).map_err(estr)
        }

        // ── Table data preview / filtered query ─────────────────────────────────
        "db_table_preview" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let schema = opt_str(&args, "schema");
            let table = require(&args, "table")?;
            let limit = u32_or(&args, "limit", 200);
            let offset = u32_or(&args, "offset", 0);
            serde_json::to_value(drv.table_data(schema, table, limit, offset).await.map_err(estr)?).map_err(estr)
        }
        "db_table_query" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let db = drv.db_type();
            if matches!(db, crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Redis | crate::db::DatabaseType::Elasticsearch) {
                return Err("服务端 WHERE/ORDER BY 仅支持 SQL 引擎".into());
            }
            let schema = opt_str(&args, "schema");
            let table = require(&args, "table")?;
            let where_clause = opt_str(&args, "whereClause");
            let order_by = opt_str(&args, "orderBy");
            let limit = u32_or(&args, "limit", 200);
            let offset = u32_or(&args, "offset", 0);
            let has_schemas = commands::table_query_should_qualify(schema);
            let with_ctid = db == crate::db::DatabaseType::Postgres;
            let sql = crate::db::dialect::build_table_query_sql(
                db, has_schemas, schema, table, where_clause, order_by, limit, offset, with_ctid,
            );
            serde_json::to_value(drv.query(&sql, limit).await.map_err(estr)?).map_err(estr)
        }

        // ── Grid edits (preview / apply) + Data-Compare sync batch ───────────────
        "db_preview_dml" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let req: EditRequest = from_arg(&args, "req")?;
            if !drv.capabilities().writable { return Err("read-only engine".into()); }
            if matches!(drv.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Elasticsearch) {
                return Err("editing via SQL DML is not supported for this engine".into());
            }
            Ok(Value::String(commands::build_sql(drv.db_type(), &req).map_err(estr)?))
        }
        "db_apply_edits" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            let reqs: Vec<EditRequest> = from_arg(&args, "reqs")?;
            if !drv.capabilities().writable { return Err("read-only engine".into()); }
            if matches!(drv.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Elasticsearch) {
                return Err("editing via SQL DML is not supported for this engine".into());
            }
            let mut affected = 0u64;
            for req in &reqs {
                let sql = commands::build_sql(drv.db_type(), req).map_err(estr)?;
                let r = drv.query(&sql, 0).await.map_err(estr)?;
                affected += r.rows_affected.unwrap_or(0);
            }
            Ok(json!(affected))
        }
        "db_exec_batch" => {
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            if !drv.capabilities().writable { return Err("read-only engine".into()); }
            if matches!(drv.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Elasticsearch) {
                return Err("transactional batch execution is not supported for this engine".into());
            }
            let stmts: Vec<String> = from_arg::<Vec<String>>(&args, "statements")?
                .into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            if stmts.is_empty() { return Ok(json!(0u64)); }
            Ok(json!(drv.exec_batch(&stmts).await.map_err(estr)?))
        }
        "db_redis_edit" => {
            use crate::db::drivers::redis_command::{argv_to_command_string, build_confirmed_edit_argv, rows_affected_from_result};
            let drv = conns.get(require(&args, "connId")?).await.ok_or("connection not found")?;
            if drv.db_type() != crate::db::DatabaseType::Redis {
                return Err("db_redis_edit 仅支持 Redis 引擎".into());
            }
            let edit = from_arg(&args, "edit")?;
            let confirm = args.get("confirm").and_then(Value::as_bool).unwrap_or(false);
            let argv = build_confirmed_edit_argv(&edit, confirm).map_err(estr)?;
            let r = drv.query(&argv_to_command_string(&argv), 0).await.map_err(estr)?;
            Ok(json!(rows_affected_from_result(&r).unwrap_or(0)))
        }

        // ── Object administration (drop / rename / truncate / duplicate / source) ─
        "db_drop_object" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let sql = db_admin_sql::build_drop_object_sql(DropObjectSqlOptions {
                database_type: drv.db_type(),
                object_type: from_arg::<DatabaseObjectType>(&args, "objectType")?,
                schema: opt_str(&args, "schema").map(str::to_string),
                name: require(&args, "name")?.to_string(),
            }).map_err(estr)?;
            Ok(json!(commands::drop_or_absent(drv.query(&sql, 0).await).map_err(estr)?))
        }
        "db_drop_table_child_object" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let sql = db_admin_sql::build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: drv.db_type(),
                object_type: from_arg::<TableChildObjectType>(&args, "objectType")?,
                schema: opt_str(&args, "schema").map(str::to_string),
                table_name: require(&args, "table")?.to_string(),
                name: require(&args, "name")?.to_string(),
            }).map_err(estr)?;
            Ok(json!(commands::drop_or_absent(drv.query(&sql, 0).await).map_err(estr)?))
        }
        "db_rename_object" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let sql = db_admin_sql::build_rename_object_sql(RenameObjectSqlOptions {
                database_type: drv.db_type(),
                object_type: from_arg::<DatabaseObjectType>(&args, "objectType")?,
                schema: opt_str(&args, "schema").map(str::to_string),
                old_name: require(&args, "oldName")?.to_string(),
                new_name: require(&args, "newName")?.to_string(),
            }).map_err(estr)?;
            let r = drv.query(&sql, 0).await.map_err(estr)?;
            Ok(json!(r.rows_affected.unwrap_or(0)))
        }
        "db_truncate_table" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let sql = db_admin_sql::build_truncate_table_sql(TableAdminSqlOptions {
                database_type: drv.db_type(),
                schema: opt_str(&args, "schema").map(str::to_string),
                table_name: require(&args, "table")?.to_string(),
            }).map_err(estr)?;
            let r = drv.query(&sql, 0).await.map_err(estr)?;
            Ok(json!(r.rows_affected.unwrap_or(0)))
        }
        "db_duplicate_table_structure" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let sql = db_admin_sql::build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: drv.db_type(),
                schema: opt_str(&args, "schema").map(str::to_string),
                source_name: require(&args, "source")?.to_string(),
                target_name: require(&args, "target")?.to_string(),
            }).map_err(estr)?;
            let r = drv.query(&sql, 0).await.map_err(estr)?;
            Ok(json!(r.rows_affected.unwrap_or(0)))
        }
        "db_save_object_source" => {
            let drv = commands::writable_drv(require(&args, "connId")?, conns).await.map_err(estr)?;
            let kind = require(&args, "kind")?;
            let object_type = ObjectSourceKind::parse(kind).ok_or_else(|| format!("unknown object kind: {kind}"))?;
            let sql = object_source_sql::build_executable_object_source_sql(EditableObjectSourceSqlInput {
                database_type: drv.db_type(),
                object_type,
                schema: opt_str(&args, "schema").map(str::to_string),
                name: require(&args, "name")?.to_string(),
                source: require(&args, "source")?.to_string(),
            }).map_err(estr)?;
            let r = drv.query(&sql, 0).await.map_err(estr)?;
            Ok(json!(r.rows_affected.unwrap_or(0)))
        }

        // ── History / snippets (persisted under the data volume) ─────────────────
        "db_history" => {
            Ok(serde_json::to_value(history::load_history(st.data_dir.as_ref())).map_err(estr)?)
        }
        "db_clear_history" => {
            history::save_history(st.data_dir.as_ref(), &[]).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history" => {
            let id = require(&args, "id")?;
            let list: Vec<HistoryEntry> = history::load_history(st.data_dir.as_ref())
                .into_iter().filter(|h| h.id != id).collect();
            history::save_history(st.data_dir.as_ref(), &list).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history_for_profile" => {
            let pid = require(&args, "profileId")?;
            let list: Vec<HistoryEntry> = history::load_history(st.data_dir.as_ref())
                .into_iter().filter(|h| h.profile_id.as_deref() != Some(pid)).collect();
            history::save_history(st.data_dir.as_ref(), &list).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_snippets" => {
            Ok(serde_json::to_value(history::load_snippets(st.data_dir.as_ref())).map_err(estr)?)
        }
        "db_save_snippet" => {
            let mut snippet: SnippetEntry = from_arg(&args, "snippet")?;
            if snippet.id.is_empty() { snippet.id = WEB_SNIPPET_IDS.next(); }
            let mut list = history::load_snippets(st.data_dir.as_ref());
            match list.iter_mut().find(|s| s.id == snippet.id) {
                Some(existing) => *existing = snippet,
                None => list.push(snippet),
            }
            history::save_snippets(st.data_dir.as_ref(), &list).map_err(estr)?;
            Ok(Value::Null)
        }

        // Streaming / file-path / desktop-only commands are not exposed over web yet
        // (terminals & VNC arrive over WebSocket; SFTP/import/export need multipart or a
        // server-side path). The frontend degrades on this error rather than mocking.
        other => Err(format!("command not exposed over web yet: {other}")),
    }
}

// SPA fallback: serve a dist asset if it exists, else index.html with the server flag injected
// (so the frontend routes calls over HTTP instead of falling back to mock data).
async fn spa(State(st): State<AppState>, uri: Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    if !rel.is_empty() && !rel.contains("..") {
        let file = st.static_dir.join(rel);
        if file.is_file() {
            if let Ok(bytes) = tokio::fs::read(&file).await {
                return ([(header::CONTENT_TYPE, mime_of(&file))], bytes).into_response();
            }
        }
    }
    match tokio::fs::read_to_string(st.static_dir.join("index.html")).await {
        Ok(html) => Html(inject_flag(&html)).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "UI not built — run `npm run build` first").into_response(),
    }
}

fn inject_flag(html: &str) -> String {
    let tag = "<script>window.__CATIO_SERVER__=true</script>";
    match html.find("</head>") {
        Some(i) => format!("{}{}{}", &html[..i], tag, &html[i..]),
        None => format!("{tag}{html}"),
    }
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}
