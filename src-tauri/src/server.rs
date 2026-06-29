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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, DefaultBodyLimit, Json, Multipart, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{new_session_token, AuthDb, User};
use crate::db::commands::{self, ConnectResult};
use crate::events::EventSink;
use crate::server_ws::WsHub;
use crate::ssh::conn::{connect_checked, test_connection, ConnectArgs as SshConnectArgs};
use crate::ssh::manager::{Session as SshSession, SessionManager};
use crate::ssh::term::{term_close_core, term_open_core, term_resize_core, term_write_core};
use crate::vncconn::{vnc_close_core, vnc_connect_core, vnc_key_core, vnc_pointer_core, VncManager};
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
static WEB_SSH_IDS: IdGen = IdGen::new("sess");

#[derive(Clone)]
pub struct AppState {
    // MULTI-USER extension point: one shared manager today. Swap for a session-keyed map.
    pub conns: Arc<ConnManager>,
    pub static_dir: Arc<PathBuf>,
    /// Persisted state dir (history/snippets + the auth DB now; connections/vault later). Maps
    /// to the Docker data volume `/app/data`.
    pub data_dir: Arc<PathBuf>,
    /// Serializes the history/snippet load-modify-save so concurrent tabs/requests can't drop
    /// entries by last-writer-wins (the file IO is sync, so a std Mutex held without `.await`
    /// across it is correct and cheap).
    pub history_lock: Arc<std::sync::Mutex<()>>,
    /// User store (argon2-hashed accounts) backing M2 access control.
    pub auth: Arc<AuthDb>,
    /// In-memory session token → (user, expiry). A restart logs everyone out (acceptable Phase
    /// 1). Expired entries are pruned on lookup and on every login, bounding growth and stopping
    /// a leaked-but-expired token from being replayed until process restart.
    pub sessions: Arc<std::sync::Mutex<HashMap<String, Session>>>,
    /// Shared SSH session manager (M3). Like `conns`, one workspace for now; the multi-user
    /// extension point swaps this for a session-keyed map.
    pub ssh: Arc<SessionManager>,
    /// WebSocket hub: topic subscriptions + the `EventSink` the terminal core emits through.
    pub ws: Arc<WsHub>,
    /// Shared VNC session manager (M5). Like `ssh`, one workspace for now.
    pub vnc: Arc<VncManager>,
}

/// A live session: which user, and when it stops being valid (server-side enforced TTL).
pub struct Session {
    pub user: User,
    pub expires_at: Instant,
}

/// Session lifetime — mirrors the cookie `Max-Age` (7 days).
const SESSION_TTL: Duration = Duration::from_secs(604_800);

impl AppState {
    /// Construct with a fresh ConnManager + locks, opening the auth DB under `data_dir`.
    pub fn new(static_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        let _ = std::fs::create_dir_all(&data_dir);
        let auth = AuthDb::open(&data_dir.join("catio.db"))?;
        Ok(AppState {
            conns: Arc::new(ConnManager::default()),
            static_dir: Arc::new(static_dir),
            data_dir: Arc::new(data_dir),
            history_lock: Arc::new(std::sync::Mutex::new(())),
            auth: Arc::new(auth),
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            ssh: Arc::new(SessionManager::default()),
            ws: Arc::new(WsHub::default()),
            vnc: Arc::new(VncManager::default()),
        })
    }
}

/// Build the router from an explicit state — the test seam (lets integration tests inject
/// throwaway static/data dirs without touching process env).
pub fn build_router(state: AppState) -> Router {
    // No CORS layer: the UI is served from this same origin, so /api/invoke is same-origin and
    // needs no CORS headers. A permissive policy would instead let ANY website a LAN user
    // visits read this server's DB responses cross-origin — exactly the exfiltration we avoid.
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/invoke", post(invoke))
        .route("/ws", get(ws_handler))
        // SFTP binary transfers can't go through JSON /api/invoke: download streams the remote
        // file to the browser, upload takes an HTML5 multipart body (M4).
        .route("/api/sftp/download", get(sftp_download_handler))
        // Raise the body limit for uploads (axum defaults to 2 MiB) to the transfer cap + margin
        // for the multipart envelope; the SFTP write itself also enforces MAX_TRANSFER_BYTES.
        .route(
            "/api/sftp/upload",
            post(sftp_upload_handler)
                .layer(DefaultBodyLimit::max(crate::ssh::sftp::MAX_TRANSFER_BYTES + 16 * 1024 * 1024)),
        )
        .fallback(spa)
        .with_state(state)
}

pub async fn run_server(addr: SocketAddr, static_dir: PathBuf) -> std::io::Result<()> {
    let data_dir = std::env::var("CATIO_DATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("data"));
    let state = AppState::new(static_dir, data_dir)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    bootstrap_admin_from_env(&state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("catio-server listening on http://{addr}");
    axum::serve(listener, build_router(state)).await
}

/// First-run admin: if there are no users yet and CATIO_ADMIN_USER / CATIO_ADMIN_PASSWORD are
/// both set, create the initial admin. Otherwise the first browser visit drives `auth_bootstrap`.
fn bootstrap_admin_from_env(state: &AppState) {
    if state.auth.user_count().unwrap_or(1) != 0 {
        return;
    }
    if let (Ok(user), Ok(pass)) = (std::env::var("CATIO_ADMIN_USER"), std::env::var("CATIO_ADMIN_PASSWORD")) {
        match state.auth.create_user(&user, &pass, true) {
            Ok(_) => println!("catio-server: created initial admin '{user}' from env"),
            Err(e) => eprintln!("catio-server: failed to create initial admin: {e}"),
        }
    } else {
        println!("catio-server: no users yet — set CATIO_ADMIN_USER/PASSWORD or create the first admin in the browser");
    }
}

#[derive(Deserialize)]
struct InvokeReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn invoke(State(st): State<AppState>, headers: HeaderMap, Json(req): Json<InvokeReq>) -> Response {
    let token = session_token(&headers);
    let user = token.as_ref().and_then(|t| resolve_session(&st, t));

    // Public / cookie-managing auth commands — reachable WITHOUT a session.
    match req.cmd.as_str() {
        "auth_login" => return auth_login(&st, &req.args).await,
        "auth_logout" => return auth_logout(&st, token),
        "auth_me" => {
            // `needsBootstrap` lets the UI show the first-run "create admin" form (no users yet)
            // instead of the normal login form.
            let needs_bootstrap = st.auth.user_count().map(|n| n == 0).unwrap_or(false);
            return Json(json!({ "user": user, "needsBootstrap": needs_bootstrap })).into_response();
        }
        "auth_bootstrap" => return auth_bootstrap(&st, &req.args).await,
        _ => {}
    }

    // Gate everything else: no valid session → 401. This is the whole access-control story for
    // M2 — one boundary in front of the shared core, so /api/invoke and (M3) /ws share it.
    let Some(user) = user else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "未登录" }))).into_response();
    };

    // User administration. Listing is allowed for any logged-in user; mutations are admin-only.
    match req.cmd.as_str() {
        "user_list" => return json_or_err(st.auth.list_users()),
        "user_create" => return user_create(&st, &req.args, &user),
        "user_delete" => return user_delete(&st, &req.args, &user),
        _ => {}
    }

    match dispatch(&st, &req.cmd, req.args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Read the `catio_session` value out of the Cookie header.
fn session_token(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|p| {
        p.trim().strip_prefix("catio_session=").filter(|v| !v.is_empty()).map(str::to_string)
    })
}

/// Resolve a token to its user, enforcing the server-side TTL: an expired entry is pruned and
/// treated as logged-out (so a leaked-but-stale token stops working without a restart).
fn resolve_session(st: &AppState, token: &str) -> Option<User> {
    let mut map = st.sessions.lock().unwrap();
    match map.get(token) {
        Some(s) if s.expires_at > Instant::now() => Some(s.user.clone()),
        Some(_) => { map.remove(token); None }
        None => None,
    }
}

/// Mint a session for `user`, opportunistically pruning expired entries so the map can't grow
/// without bound across repeated logins. Returns the new token.
fn create_session(st: &AppState, user: User) -> String {
    let token = new_session_token();
    let now = Instant::now();
    let mut map = st.sessions.lock().unwrap();
    map.retain(|_, s| s.expires_at > now);
    map.insert(token.clone(), Session { user, expires_at: now + SESSION_TTL });
    token
}

/// Invalidate every session belonging to `user_id` — used when a user is deleted so their live
/// cookie stops working immediately (the session cached a clone of the user, incl. is_admin).
fn purge_user_sessions(st: &AppState, user_id: i64) {
    st.sessions.lock().unwrap().retain(|_, s| s.user.id != user_id);
}

/// Build the session cookie. `Secure` is added when CATIO_COOKIE_SECURE is truthy — set it when a
/// reverse proxy terminates TLS, but leave it off for a bare-HTTP LAN where the browser would
/// otherwise refuse to send the cookie.
fn session_cookie(token: &str, max_age: u32) -> String {
    let secure = std::env::var("CATIO_COOKIE_SECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let mut c = format!("catio_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}");
    if secure { c.push_str("; Secure"); }
    c
}

/// JSON `{ user }` response that (re)sets the session cookie.
fn login_response(user: &User, token: &str) -> Response {
    let mut resp = Json(json!({ "user": user })).into_response();
    if let Ok(v) = HeaderValue::from_str(&session_cookie(token, 604_800)) {
        resp.headers_mut().insert(header::SET_COOKIE, v);
    }
    resp
}

async fn auth_login(st: &AppState, args: &Value) -> Response {
    let username = args.get("username").and_then(Value::as_str).unwrap_or("");
    let password = args.get("password").and_then(Value::as_str).unwrap_or("");
    match st.auth.verify_login(username, password) {
        Ok(user) => {
            let token = create_session(st, user.clone());
            login_response(&user, &token)
        }
        Err(e) => (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    }
}

fn auth_logout(st: &AppState, token: Option<String>) -> Response {
    if let Some(t) = token {
        st.sessions.lock().unwrap().remove(&t);
    }
    let mut resp = Json(json!({ "ok": true })).into_response();
    if let Ok(v) = HeaderValue::from_str(&session_cookie("", 0)) {
        resp.headers_mut().insert(header::SET_COOKIE, v);
    }
    resp
}

/// First-run: atomically create the initial admin when no users exist, then auto-login.
async fn auth_bootstrap(st: &AppState, args: &Value) -> Response {
    let username = args.get("username").and_then(Value::as_str).unwrap_or("");
    let password = args.get("password").and_then(Value::as_str).unwrap_or("");
    match st.auth.bootstrap_admin(username, password) {
        Ok(user) => {
            let token = create_session(st, user.clone());
            login_response(&user, &token)
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

fn user_create(st: &AppState, args: &Value, actor: &User) -> Response {
    if !actor.is_admin {
        return forbidden();
    }
    let username = args.get("username").and_then(Value::as_str).unwrap_or("");
    let password = args.get("password").and_then(Value::as_str).unwrap_or("");
    let is_admin = args.get("isAdmin").and_then(Value::as_bool).unwrap_or(false);
    json_or_err(st.auth.create_user(username, password, is_admin))
}

fn user_delete(st: &AppState, args: &Value, actor: &User) -> Response {
    if !actor.is_admin {
        return forbidden();
    }
    let Some(id) = args.get("id").and_then(Value::as_i64) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "`id` required" }))).into_response();
    };
    match st.auth.delete_user(id) {
        Ok(()) => {
            // Invalidate the deleted user's live sessions so their cookie stops working now,
            // not just on next restart (the session cached their User incl. is_admin).
            purge_user_sessions(st, id);
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))).into_response()
}

/// Serialize `Ok` as JSON (200) or map `Err(String)` to a 400 `{error}`.
fn json_or_err<T: serde::Serialize>(r: Result<T, String>) -> Response {
    match r {
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
    // Saturate, don't truncate: `as u32` would wrap 4_294_967_296 → 0, and some drivers read
    // 0 as "unbounded", an accidental resource blowup. Clamp to u32::MAX instead.
    args.get(key).and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32).unwrap_or(default)
}
fn from_arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(estr)
}

fn now_stamp() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default()
}

/// Best-effort: record a DB query in the persisted history (never fails the query). The
/// `history_lock` serializes the load-modify-save so concurrent requests don't drop entries.
fn record_history(st: &AppState, conn_id: &str, sql: &str, dur: String, args: &Value) {
    let dir: &Path = st.data_dir.as_ref();
    if std::fs::create_dir_all(dir).is_err() { return; }
    let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
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

        // ── Whole-DB SQL export (pure request/response; returns the script string) ─
        "db_export_database" => {
            let sql = commands::export_database_core(
                conns,
                require(&args, "connId")?.to_string(),
                require(&args, "database")?.to_string(),
                require(&args, "schema")?.to_string(),
                serde_json::from_value(args.get("selectedTables").cloned().unwrap_or(json!([]))).map_err(estr)?,
                serde_json::from_value(args.get("tableDdls").cloned().unwrap_or(json!({}))).map_err(estr)?,
                args.get("includeStructure").and_then(Value::as_bool).unwrap_or(false),
                args.get("includeData").and_then(Value::as_bool).unwrap_or(false),
                args.get("batchSize").and_then(Value::as_u64).map(|n| n as usize),
                args.get("rowLimit").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32),
            ).await.map_err(estr)?;
            Ok(Value::String(sql))
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
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            history::save_history(st.data_dir.as_ref(), &[]).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history" => {
            let id = require(&args, "id")?;
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            let list: Vec<HistoryEntry> = history::load_history(st.data_dir.as_ref())
                .into_iter().filter(|h| h.id != id).collect();
            history::save_history(st.data_dir.as_ref(), &list).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history_for_profile" => {
            let pid = require(&args, "profileId")?;
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
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
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            let mut list = history::load_snippets(st.data_dir.as_ref());
            match list.iter_mut().find(|s| s.id == snippet.id) {
                Some(existing) => *existing = snippet,
                None => list.push(snippet),
            }
            history::save_snippets(st.data_dir.as_ref(), &list).map_err(estr)?;
            Ok(Value::Null)
        }

        // ── SSH connection lifecycle (HTTP request/response; terminals stream over /ws) ──
        "ssh_test" => {
            let a: SshConnectArgs = from_arg(&args, "args")?;
            serde_json::to_value(test_connection(a).await).map_err(estr)
        }
        "ssh_connect" => {
            let a: SshConnectArgs = from_arg(&args, "args")?;
            let dir = st.data_dir.as_ref();
            let _ = std::fs::create_dir_all(dir);
            let (handle, fingerprint, forwarded, jump, host_key_trusted) =
                connect_checked(&a, Some(dir.as_path())).await.map_err(estr)?;
            let session_id = WEB_SSH_IDS.next();
            st.ssh.insert(session_id.clone(), SshSession {
                handle,
                host: a.host.clone(),
                user: a.user.clone(),
                terms: std::collections::HashMap::new(),
                forwarded,
                _jump: jump,
            }).await;
            Ok(json!({
                "sessionId": session_id,
                "hostKeyFingerprint": fingerprint,
                "hostKeyTrusted": host_key_trusted,
            }))
        }
        "ssh_disconnect" => {
            let session_id = require(&args, "sessionId")?;
            st.ssh.remove_monitor(session_id).await;
            let sess = st.ssh.remove(session_id).await.ok_or("session not found")?;
            sess.lock().await.handle
                .disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
            Ok(Value::Null)
        }
        "ssh_trust_host" => {
            let host_port = require(&args, "hostPort")?.to_string();
            let fingerprint = require(&args, "fingerprint")?.to_string();
            let dir = st.data_dir.as_ref();
            let _ = std::fs::create_dir_all(dir);
            let path = dir.join("known_hosts");
            let mut map = std::fs::read_to_string(&path)
                .map(|s| crate::ssh::knownhosts::parse(&s)).unwrap_or_default();
            map.insert(host_port, fingerprint);
            std::fs::write(&path, crate::ssh::knownhosts::serialize(&map)).map_err(estr)?;
            Ok(Value::Null)
        }

        // ── SFTP browse + file ops (request/response; download/upload are separate routes) ──
        "sftp_list" => serde_json::to_value(
            crate::ssh::sftp::list_directory(&st.ssh, require(&args, "sessionId")?, require(&args, "path")?).await.map_err(estr)?,
        ).map_err(estr),
        "sftp_realpath" => Ok(Value::String(
            crate::ssh::sftp::realpath(&st.ssh, require(&args, "sessionId")?, require(&args, "path")?).await.map_err(estr)?,
        )),
        "sftp_mkdir" => {
            crate::ssh::sftp::sftp_mkdir_core(&st.ssh, require(&args, "sessionId")?, require(&args, "path")?).await.map_err(estr)?;
            Ok(Value::Null)
        }
        "sftp_rename" => {
            crate::ssh::sftp::sftp_rename_core(&st.ssh, require(&args, "sessionId")?, require(&args, "from")?, require(&args, "to")?).await.map_err(estr)?;
            Ok(Value::Null)
        }
        "sftp_delete" => {
            crate::ssh::sftp::sftp_delete_core(&st.ssh, require(&args, "sessionId")?, require(&args, "path")?).await.map_err(estr)?;
            Ok(Value::Null)
        }
        "sftp_touch" => {
            crate::ssh::sftp::sftp_touch_core(&st.ssh, require(&args, "sessionId")?, require(&args, "path")?).await.map_err(estr)?;
            Ok(Value::Null)
        }
        "sftp_read_file" => serde_json::to_value(
            crate::ssh::sftp::sftp_read_file_core(
                &st.ssh,
                require(&args, "sessionId")?.to_string(),
                require(&args, "path")?.to_string(),
                args.get("maxBytes").and_then(Value::as_u64),
            ).await.map_err(estr)?,
        ).map_err(estr),
        "sftp_write_file" => {
            let mt = crate::ssh::sftp::sftp_write_file_core(
                &st.ssh,
                require(&args, "sessionId")?.to_string(),
                require(&args, "path")?.to_string(),
                require(&args, "content")?.to_string(),
                args.get("baseModified").and_then(Value::as_i64),
                args.get("mode").and_then(Value::as_u64).map(|m| m as u32),
            ).await.map_err(estr)?;
            Ok(json!(mt))
        }

        // Not exposed over web in M1 — the frontend degrades on this error (it keeps the
        // desktop-only `if (!isTauri())` guard for these, so server mode never calls them):
        //   • terminals / VNC  → arrive over WebSocket in M3 / M5
        //   • SFTP             → M4 (browse/download + HTML5 upload)
        //   • file-path/AppHandle commands (export_file, db_export_xlsx, db_import_*,
        //     db_sql_file_*) → operate on the USER's local filesystem, meaningless server-side
        //   • db_transfer_table → deferred to M3 (its progress stream needs the WS channel)
        //   • JDBC engines      → the Docker image ships no JRE/plugin jar (documented gap)
        other => Err(format!("command not exposed over web yet: {other}")),
    }
}

// ── WebSocket streaming channel (M3) ────────────────────────────────────────────────────────

/// Cap on simultaneous WS connections — a coarse backstop against connection-flood DoS.
const MAX_WS_CONNECTIONS: usize = 128;
/// Cap on VNC sessions one WS connection may open (each spins a reader/writer/ticker + 20fps refresh).
const MAX_VNC_PER_CONN: usize = 8;

/// `GET /ws` — the single streaming channel. Gated by the SAME session cookie as `/api/invoke`
/// plus a same-origin Origin check (browsers always send Origin on a WS handshake, so this blocks
/// cross-site WebSocket hijacking; the SameSite=Strict cookie already prevents the cookie itself
/// from riding a cross-site handshake). Rejected before the upgrade when unauthenticated.
async fn ws_handler(State(st): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "bad origin").into_response();
    }
    let Some(token) = session_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    };
    if resolve_session(&st, &token).is_none() {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    }
    if st.ws.conn_count() >= MAX_WS_CONNECTIONS {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many connections").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, st, token))
}

/// Allow same-origin requests and Origin-absent ones (non-browser tools, e.g. the test client);
/// reject a present-but-mismatched Origin.
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return true };
    let origin_authority = origin.split("://").nth(1).unwrap_or("");
    matches!(headers.get(header::HOST).and_then(|v| v.to_str().ok()), Some(host) if host == origin_authority)
}

/// Drive one WS connection: a writer task drains the per-connection BOUNDED channel to the socket
/// while the reader loop handles sub/unsub/cmd/ping. Every `cmd` re-validates the session, so a
/// logout/deletion/expiry severs an established socket. On close the connection is unregistered
/// and any terminals it opened are closed (so a dropped browser tab doesn't leak remote shells).
async fn handle_ws(socket: WebSocket, st: AppState, token: String) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(2048);
    let conn_id = st.ws.register(tx.clone());
    // Terminals (session_id, chan_id) and VNC sessions opened on THIS connection — closed on
    // disconnect so a dropped browser tab doesn't leak remote shells / VNC streams.
    let opened: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let opened_vnc: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

    let writer = tokio::spawn(async move {
        while let Some(env) = rx.recv().await {
            if ws_tx.send(Message::Text(env.to_string())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(t) => {
                let Ok(env) = serde_json::from_str::<Value>(&t) else { continue };
                match env.get("type").and_then(Value::as_str) {
                    Some("sub") => if let Some(topic) = env.get("topic").and_then(Value::as_str) {
                        st.ws.subscribe(conn_id, topic);
                    },
                    Some("unsub") => if let Some(topic) = env.get("topic").and_then(Value::as_str) {
                        st.ws.unsubscribe(conn_id, topic);
                    },
                    Some("ping") => { let _ = tx.try_send(json!({ "type": "pong" })); }
                    Some("cmd") => {
                        // Re-validate on every command — an upgrade-time check alone would leave an
                        // established socket as a long-lived SSH control channel after logout.
                        if resolve_session(&st, &token).is_none() {
                            let _ = tx.try_send(json!({ "type": "reply", "id": env.get("id").cloned().unwrap_or(Value::Null), "ok": false, "error": "会话已失效,请重新登录" }));
                            break;
                        }
                        let cmd = env.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
                        let id = env.get("id").cloned().unwrap_or(Value::Null);
                        let cmd_args = env.get("args").cloned().unwrap_or_else(|| json!({}));
                        // Slow connect commands do blocking network I/O (TCP + handshake, up to
                        // ~25s) — run them OFF the reader loop so other cmds / ping / close on this
                        // same (singleton) socket aren't frozen while a host connects.
                        if matches!(cmd.as_str(), "vnc_connect" | "term_open") {
                            let (st2, tx2, op2, opv2) = (st.clone(), tx.clone(), opened.clone(), opened_vnc.clone());
                            tokio::spawn(async move {
                                handle_ws_cmd(&st2, conn_id, &tx2, &cmd, id, &cmd_args, &op2, &opv2).await;
                            });
                        } else {
                            handle_ws_cmd(&st, conn_id, &tx, &cmd, id, &cmd_args, &opened, &opened_vnc).await;
                        }
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer.abort();
    st.ws.unregister(conn_id);
    let terms = opened.lock().unwrap().clone();
    for (sid, cid) in terms {
        let _ = term_close_core(&st.ssh, &sid, &cid).await;
    }
    let vncs = opened_vnc.lock().unwrap().clone();
    for sid in vncs {
        let _ = vnc_close_core(&st.vnc, &sid);
    }
}

/// Handle a `cmd` envelope (the streaming commands that don't fit request/response), replying
/// `{type:"reply", id, ok, result|error}`. term_open subscribes the originating connection to
/// `term://{chanId}` via the core's `on_open` hook — BEFORE the owner task can emit — so no early
/// output is lost, and to `history://{sessionId}` for the command-audit stream.
#[allow(clippy::too_many_arguments)]
async fn handle_ws_cmd(
    st: &AppState,
    conn_id: u64,
    tx: &tokio::sync::mpsc::Sender<Value>,
    cmd: &str,
    id: Value,
    args: &Value,
    opened: &std::sync::Mutex<Vec<(String, String)>>,
    opened_vnc: &std::sync::Mutex<Vec<String>>,
) {
    let sid = || args.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let cid = || args.get("chanId").and_then(Value::as_str).unwrap_or("").to_string();
    let result: Result<Value, String> = match cmd {
        "term_open" => {
            let session_id = sid();
            let cols = u32_or(args, "cols", 80);
            let rows = u32_or(args, "rows", 24);
            st.ws.subscribe(conn_id, &format!("history://{session_id}"));
            let sink: Arc<dyn EventSink> = st.ws.clone();
            let hub = st.ws.clone();
            match term_open_core(session_id.clone(), cols, rows, sink, &st.ssh, |chan_id| {
                hub.subscribe(conn_id, &format!("term://{chan_id}"));
            }).await {
                Ok(chan_id) => {
                    opened.lock().unwrap().push((session_id, chan_id.clone()));
                    Ok(json!({ "chanId": chan_id }))
                }
                Err(e) => Err(e.to_string()),
            }
        }
        "term_write" => term_write_core(&st.ssh, &sid(), &cid(),
            args.get("dataBase64").and_then(Value::as_str).unwrap_or(""))
            .await.map(|_| Value::Null).map_err(|e| e.to_string()),
        "term_resize" => term_resize_core(&st.ssh, &sid(), &cid(),
            u32_or(args, "cols", 80), u32_or(args, "rows", 24))
            .await.map(|_| Value::Null).map_err(|e| e.to_string()),
        "term_close" => {
            let (s, c) = (sid(), cid());
            opened.lock().unwrap().retain(|(os, oc)| !(os == &s && oc == &c));
            st.ws.unsubscribe(conn_id, &format!("term://{c}"));
            term_close_core(&st.ssh, &s, &c).await.map(|_| Value::Null).map_err(|e| e.to_string())
        }

        // ── VNC over WS (M5): connect streams vnc-init/rect/closed; pointer/key drive input ──
        "vnc_connect" if opened_vnc.lock().unwrap().len() >= MAX_VNC_PER_CONN => {
            Err("VNC 会话数已达上限".to_string())
        }
        "vnc_connect" => {
            let host = args.get("host").and_then(Value::as_str).unwrap_or("").to_string();
            let port = args.get("port").and_then(Value::as_u64).unwrap_or(5900) as u16;
            let password = args.get("password").and_then(Value::as_str).unwrap_or("").to_string();
            let sink: Arc<dyn EventSink> = st.ws.clone();
            let hub = st.ws.clone();
            match vnc_connect_core(host, port, password, sink, st.vnc.clone(), |vid| {
                hub.subscribe(conn_id, &format!("vnc-init://{vid}"));
                hub.subscribe(conn_id, &format!("vnc-rect://{vid}"));
                hub.subscribe(conn_id, &format!("vnc-closed://{vid}"));
            }).await {
                Ok(vid) => {
                    opened_vnc.lock().unwrap().push(vid.clone());
                    Ok(json!({ "sessionId": vid }))
                }
                Err(e) => Err(e.to_string()),
            }
        }
        "vnc_pointer" => vnc_pointer_core(
            &st.vnc, &sid(),
            args.get("mask").and_then(Value::as_u64).unwrap_or(0) as u8,
            args.get("x").and_then(Value::as_u64).unwrap_or(0) as u16,
            args.get("y").and_then(Value::as_u64).unwrap_or(0) as u16,
        ).map(|_| Value::Null).map_err(|e| e.to_string()),
        "vnc_key" => vnc_key_core(
            &st.vnc, &sid(),
            args.get("down").and_then(Value::as_bool).unwrap_or(false),
            args.get("keysym").and_then(Value::as_u64).unwrap_or(0) as u32,
        ).map(|_| Value::Null).map_err(|e| e.to_string()),
        "vnc_close" => {
            let s = sid();
            opened_vnc.lock().unwrap().retain(|x| x != &s);
            st.ws.unsubscribe(conn_id, &format!("vnc-init://{s}"));
            st.ws.unsubscribe(conn_id, &format!("vnc-rect://{s}"));
            st.ws.unsubscribe(conn_id, &format!("vnc-closed://{s}"));
            vnc_close_core(&st.vnc, &s).map(|_| Value::Null).map_err(|e| e.to_string())
        }

        other => Err(format!("ws command not supported: {other}")),
    };
    // Fire-and-forget commands carry no `id` (vnc_pointer/key) — don't generate reply traffic for
    // every mouse event. Commands with an id always get a reply.
    if !id.is_null() {
        let reply = match result {
            Ok(v) => json!({ "type": "reply", "id": id, "ok": true, "result": v }),
            Err(e) => json!({ "type": "reply", "id": id, "ok": false, "error": e }),
        };
        let _ = tx.try_send(reply);
    }
}

// ── SFTP binary transfer endpoints (M4) ──────────────────────────────────────────────────────

/// True when the request carries a valid session cookie. Shared by the SFTP routes (which, like
/// /api/invoke, must be gated).
fn authed(st: &AppState, headers: &HeaderMap) -> bool {
    session_token(headers).as_deref().and_then(|t| resolve_session(st, t)).is_some()
}

/// Build an RFC 6266 `Content-Disposition: attachment` value with both an ASCII `filename=`
/// fallback (control/quote/non-ASCII → `_`) and a UTF-8 `filename*=` (RFC 5987 percent-encoded),
/// so non-ASCII names (中文/emoji) download correctly and no control char can inject a header.
fn content_disposition_attachment(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii() && !c.is_control() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    let ascii = if ascii.trim().is_empty() { "download".to_string() } else { ascii };
    let mut enc = String::new();
    for &b in name.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => enc.push(b as char),
            _ => enc.push_str(&format!("%{b:02X}")),
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadQuery {
    session_id: String,
    path: String,
}

/// `GET /api/sftp/download?sessionId=&path=` — read the remote file and stream it to the browser
/// as an attachment (the browser's own download UI shows progress). Buffers fully (Phase-1 LAN).
async fn sftp_download_handler(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<DownloadQuery>) -> Response {
    if !authed(&st, &headers) {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    }
    match crate::ssh::sftp::read_remote_bytes(&st.ssh, &q.session_id, &q.path).await {
        Ok(bytes) => {
            let cd = content_disposition_attachment(q.path.rsplit('/').next().unwrap_or("download"));
            (
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::CONTENT_DISPOSITION, cd),
                ],
                bytes,
            ).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

fn upload_field_err(e: axum::extract::multipart::MultipartError) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("读取上传字段失败: {e}") }))).into_response()
}

/// `POST /api/sftp/upload` (multipart: sessionId, remotePath, file) — receive the browser-picked
/// file and write it to the remote path over SFTP (the HTML5 upload that replaces Tauri's native
/// drag-drop / local-path upload).
async fn sftp_upload_handler(State(st): State<AppState>, headers: HeaderMap, mut multipart: Multipart) -> Response {
    if !authed(&st, &headers) {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    }
    let (mut session_id, mut remote_path, mut file_bytes) = (String::new(), String::new(), None::<Vec<u8>>);
    loop {
        // Surface a multipart parse error as 400 rather than silently stopping with a half-read
        // body (which could otherwise write a truncated file).
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("multipart 解析失败: {e}") }))).into_response(),
        };
        match field.name() {
            Some("sessionId") => match field.text().await { Ok(v) => session_id = v, Err(e) => return upload_field_err(e) },
            Some("remotePath") => match field.text().await { Ok(v) => remote_path = v, Err(e) => return upload_field_err(e) },
            Some("file") => match field.bytes().await { Ok(b) => file_bytes = Some(b.to_vec()), Err(e) => return upload_field_err(e) },
            _ => {}
        }
    }
    let Some(bytes) = file_bytes else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "缺少文件" }))).into_response();
    };
    if session_id.is_empty() || remote_path.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "缺少 sessionId/remotePath" }))).into_response();
    }
    match crate::ssh::sftp::write_remote_bytes(&st.ssh, &session_id, &remote_path, &bytes).await {
        Ok(()) => Json(json!({ "ok": true, "bytes": bytes.len() })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// SPA fallback: serve a dist asset if it exists, else index.html with the server flag injected
// (so the frontend routes calls over HTTP instead of falling back to mock data).
async fn spa(State(st): State<AppState>, uri: Uri) -> Response {
    if let Some(file) = safe_asset_path(st.static_dir.as_ref(), uri.path()) {
        if let Ok(bytes) = tokio::fs::read(&file).await {
            return ([(header::CONTENT_TYPE, mime_of(&file))], bytes).into_response();
        }
    }
    match tokio::fs::read_to_string(st.static_dir.join("index.html")).await {
        Ok(html) => Html(inject_flag(&html)).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "UI not built — run `npm run build` first").into_response(),
    }
}

/// Resolve a request path to a real file STRICTLY inside `static_dir`, or `None`.
///
/// A `contains("..")` check is not enough: on Windows `dir.join("C:/Windows/x")` *replaces*
/// `dir` (absolute joins win), and a symlink inside `dist` can point outside. So we canonicalize
/// both the base and the candidate and require true prefix containment — the only robust guard
/// against path traversal. Non-existent paths (SPA client routes like `/vault`) canonicalize to
/// an error and fall through to index.html, which is the correct SPA behavior.
fn safe_asset_path(static_dir: &Path, req_path: &str) -> Option<PathBuf> {
    let rel = req_path.trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") || rel.contains('\\') { return None; }
    let base = std::fs::canonicalize(static_dir).ok()?;
    let full = std::fs::canonicalize(base.join(rel)).ok()?;
    if full.starts_with(&base) && full.is_file() { Some(full) } else { None }
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

#[cfg(test)]
mod tests {
    use super::{content_disposition_attachment, safe_asset_path};
    use std::fs;

    #[test]
    fn content_disposition_handles_ascii_and_unicode() {
        // ASCII stays as filename=, no filename* surprises break it.
        let cd = content_disposition_attachment("report.csv");
        assert!(cd.starts_with("attachment; filename=\"report.csv\""));
        assert!(cd.contains("filename*=UTF-8''report.csv"));

        // Non-ASCII → underscore fallback + percent-encoded UTF-8 filename*.
        let cd = content_disposition_attachment("报告.csv");
        assert!(cd.contains("filename=\"__.csv\""), "ascii fallback: {cd}");
        assert!(cd.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A.csv"), "utf8: {cd}");

        // Control chars / quotes can't inject a header.
        let cd = content_disposition_attachment("a\"b\r\n.txt");
        assert!(!cd.contains('\r') && !cd.contains('\n'));
        assert!(cd.contains("filename=\"a_b__.txt\""), "{cd}");
    }

    #[test]
    fn safe_asset_path_serves_real_assets_but_blocks_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        fs::create_dir_all(dist.join("assets")).unwrap();
        fs::write(dist.join("app.js"), "x").unwrap();
        fs::write(dist.join("assets/i.js"), "y").unwrap();
        // A secret sibling OUTSIDE dist — a successful traversal would leak it.
        fs::write(tmp.path().join("secret.txt"), "SECRET").unwrap();

        // Legit assets resolve inside dist.
        assert!(safe_asset_path(&dist, "/app.js").is_some());
        assert!(safe_asset_path(&dist, "/assets/i.js").is_some());

        // dotdot, backslash, percent-encoded dots, and missing files are all rejected.
        assert!(safe_asset_path(&dist, "/../secret.txt").is_none());
        assert!(safe_asset_path(&dist, "/..\\secret.txt").is_none());
        assert!(safe_asset_path(&dist, "/%2e%2e/secret.txt").is_none());
        assert!(safe_asset_path(&dist, "/nope.js").is_none());

        // An absolute path that canonicalizes OUTSIDE dist (the Windows `/C:/...` / unix `/etc`
        // escape that `contains("..")` misses) must be rejected by the containment check.
        let abs = tmp.path().join("secret.txt");
        let abs_req = format!("/{}", abs.to_string_lossy().replace('\\', "/"));
        assert!(safe_asset_path(&dist, &abs_req).is_none(), "leaked via absolute path: {abs_req}");
    }
}
