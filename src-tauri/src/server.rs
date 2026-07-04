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
    /// Network-scan cancellation registry — the scan runs on the server's network and streams
    /// `scan://*` events through the WS hub (already Arc-backed internally, so a cheap clone).
    pub scan: crate::scan::ScanState,
    /// AES-256 key derived from `CATIO_MASTER_KEY`, encrypting the per-user connection-secret
    /// vault at rest (web head). `None` when the env var is unset → secret storage is disabled
    /// (the browser falls back to prompting each connect).
    pub secret_key: Option<[u8; 32]>,
    /// Optional ceiling on a single SFTP upload (bytes), from `CATIO_MAX_UPLOAD_BYTES`. `None` =
    /// unlimited (the default; the remote host's disk is the bound). Operators on a shared host can
    /// set it to cap a single transfer.
    pub max_upload_bytes: Option<u64>,
    /// Web-only ownership maps: live resource id → owner user id. The shared managers (`conns`,
    /// `ssh`, `vnc`) stay single-workspace (so the desktop is untouched); these side maps let the
    /// web head enforce "a user may only use their OWN live connection/session (admins: any)".
    pub conn_owners: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    pub ssh_owners: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    pub vnc_owners: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    /// 端口转发隧道的 owner 映射:隧道 id → 用户 id。隧道注册表挂在共享的 `ssh`
    /// (SessionManager)上,全局可见;此 side map 让 web head 据此过滤 tunnel_list、门控
    /// tunnel_close,使一个用户看不到也关不掉别人的隧道(admin 可见可关全部)。
    pub tunnel_owners: Arc<std::sync::Mutex<HashMap<String, i64>>>,
    /// MCP display-name metadata (server-mode MCP). The owner maps above only know id→user; these
    /// add the friendly name + engine/host so `list_connections`/`list_hosts` render them. Keyed by
    /// the same live id, written on connect / removed on disconnect alongside the owner maps.
    pub conn_meta: Arc<std::sync::Mutex<HashMap<String, (String, String)>>>, // connId    -> (name, dbType)
    pub ssh_meta: Arc<std::sync::Mutex<HashMap<String, (String, String)>>>,  // sessionId -> (name, host)
    /// SSE response routing for the server-mode MCP: sessionId → sender. `/mcp/sse` registers a
    /// channel here; `/mcp/messages` pushes the JSON-RPC reply onto the matching one.
    pub mcp_sessions: Arc<std::sync::Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>>,
    /// Network-layer IP allowlist for the `/mcp` routes, parsed ONCE from `CATIO_MCP_IP_ALLOWLIST`
    /// (comma-separated IPv4/CIDR). EMPTY ⇒ gate disabled (the token stays the sole gate), so every
    /// existing `build_router`-based test — which never sets the env — is unaffected. Loopback is
    /// always allowed by `ip_allowed`.
    pub mcp_ip_allowlist: Arc<Vec<crate::netmatch::WhitelistRule>>,
    /// When true (`CATIO_TRUST_PROXY` truthy), the `/mcp` IP gate trusts the leftmost
    /// `X-Forwarded-For` entry as the client IP (reverse-proxy deployments); otherwise it uses the
    /// raw peer IP from `ConnectInfo`.
    pub mcp_trust_proxy: bool,
}

/// True if `actor` may use the live resource `id`: admins may use any; others only their own.
/// An id absent from the map (never connected, or someone else's that they're guessing) → denied
/// for non-admins, so a crafted `connId: "conn-1"` can't reach another user's connection.
fn owns_resource(map: &std::sync::Mutex<HashMap<String, i64>>, id: &str, actor: &User) -> bool {
    if actor.is_admin {
        return true;
    }
    map.lock().unwrap().get(id).is_some_and(|&owner| owner == actor.id)
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
            scan: crate::scan::ScanState::default(),
            secret_key: std::env::var("CATIO_MASTER_KEY").ok()
                .filter(|k| !k.is_empty())
                .map(|k| crate::secrets::derive_key(&k)),
            max_upload_bytes: std::env::var("CATIO_MAX_UPLOAD_BYTES").ok()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|&n| n > 0),
            conn_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            ssh_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            vnc_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            tunnel_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            conn_meta: Arc::new(std::sync::Mutex::new(HashMap::new())),
            ssh_meta: Arc::new(std::sync::Mutex::new(HashMap::new())),
            mcp_sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            mcp_ip_allowlist: Arc::new(
                std::env::var("CATIO_MCP_IP_ALLOWLIST").ok().unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .filter_map(crate::netmatch::WhitelistRule::parse)
                    .collect(),
            ),
            mcp_trust_proxy: std::env::var("CATIO_TRUST_PROXY")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
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
        // Disable axum's 2 MiB body limit for uploads: the handler STREAMS the multipart field to
        // SFTP chunk-by-chunk (never buffering the whole file), so multi-GB uploads work without a
        // cap or OOM. The session gate + the remote host's own disk are the real bounds.
        .route(
            "/api/sftp/upload",
            post(sftp_upload_handler).layer(DefaultBodyLimit::disable()),
        )
        // Server-mode MCP (P3a): external agents self-authenticate on `?token=` (NO cookie gate),
        // so these are NOT part of /api/invoke. The per-user token scopes them to the user's own
        // live connections/sessions (see server_mcp::ServerTargets).
        .route("/mcp/sse", get(crate::server_mcp::mcp_sse_handler))
        .route("/mcp/messages", post(crate::server_mcp::mcp_messages_handler))
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
    // `with_connect_info` makes the peer `SocketAddr` available to the `/mcp` handlers (via
    // `ConnectInfo<SocketAddr>`) for the IP allowlist gate. Integration tests call
    // `axum::serve(listener, build_router(state))` directly (no connect-info), so their handlers
    // see `Option<ConnectInfo<_>> == None` — fine, since they never set the allowlist env.
    axum::serve(listener, build_router(state).into_make_service_with_connect_info::<SocketAddr>()).await
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
        "auth_register" => return auth_register(&st, &req.args).await,
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

    // User administration. Listing is allowed for any logged-in user; mutations are admin-only;
    // changing your OWN password is self-service (any role).
    match req.cmd.as_str() {
        "user_list" => return json_or_err(st.auth.list_users()),
        "user_create" => return user_create(&st, &req.args, &user),
        "user_delete" => return user_delete(&st, &req.args, &user),
        "auth_change_password" => {
            let old = req.args.get("oldPassword").and_then(Value::as_str).unwrap_or("");
            let new = req.args.get("newPassword").and_then(Value::as_str).unwrap_or("");
            return match st.auth.change_password(user.id, old, new) {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
            };
        }
        // Per-user connection-secret vault (server-side, AES-GCM under CATIO_MASTER_KEY). Lets a
        // browser remember saved-connection passwords without WebCrypto (unavailable over plain
        // HTTP). All keyed by the SESSION user, so users can't read each other's secrets.
        "secret_remember" => return secret_remember(&st, &req.args, &user),
        "secret_recall" => return secret_recall(&st, &req.args, &user),
        "secret_forget" => return secret_forget(&st, &req.args, &user),
        // Per-user data layer (connections / groups / snippets / history / tunnels). A normal user
        // only ever touches their own items; an admin sees + can target any user's (via ownerId).
        "store_list" => return store_list(&st, &req.args, &user),
        "store_set" => return store_set(&st, &req.args, &user),
        "store_delete" => return store_delete(&st, &req.args, &user),
        "store_clear" => return store_clear(&st, &req.args, &user),
        // Per-user MCP access token (server-mode). Owner-scoped to the SESSION user; desktop never
        // calls these. `get` lazily mints one so the settings page always has a token to show.
        "mcp_token_get" => return mcp_token_get(&st, &user),
        "mcp_token_regenerate" => return mcp_token_regenerate(&st, &user),
        "mcp_token_set_enabled" => return mcp_token_set_enabled(&st, &req.args, &user),
        _ => {}
    }

    match dispatch(&st, &user, &req.cmd, req.args).await {
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

/// Self-service signup for the web deploy. It is intentionally NOT a bootstrap path: the first
/// account must still be an admin created by `auth_bootstrap` or CATIO_ADMIN_* env vars. Every
/// self-registered account is a normal user; admins can still create admin accounts via
/// `user_create`.
async fn auth_register(st: &AppState, args: &Value) -> Response {
    if st.auth.user_count().map(|n| n == 0).unwrap_or(true) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "请先创建管理员账户" })),
        )
            .into_response();
    }
    let username = args.get("username").and_then(Value::as_str).unwrap_or("");
    let password = args.get("password").and_then(Value::as_str).unwrap_or("");
    match st.auth.create_user(username, password, false) {
        Ok(user) => {
            let token = create_session(st, user.clone());
            login_response(&user, &token)
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
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

/// Encrypt + store a connection secret for the CURRENT user (keyed by their session id).
fn secret_remember(st: &AppState, args: &Value, actor: &User) -> Response {
    let Some(key) = st.secret_key.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "服务器未配置 CATIO_MASTER_KEY,无法保存连接密码" }))).into_response();
    };
    let profile_id = args.get("profileId").and_then(Value::as_str).unwrap_or("");
    let secret = args.get("secret").and_then(Value::as_str).unwrap_or("");
    if profile_id.is_empty() || secret.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "profileId 与 secret 必填" }))).into_response();
    }
    let aad = crate::secrets::secret_aad(actor.id, profile_id);
    match crate::secrets::encrypt(key, &aad, secret.as_bytes()) {
        Ok((nonce, ct)) => json_or_err(st.auth.store_secret(actor.id, profile_id, &nonce, &ct).map(|_| true)),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// Recall + decrypt the CURRENT user's secret for a profile → `{ secret: string|null }`.
fn secret_recall(st: &AppState, args: &Value, actor: &User) -> Response {
    let profile_id = args.get("profileId").and_then(Value::as_str).unwrap_or("");
    let Some(key) = st.secret_key.as_ref() else {
        return Json(json!({ "secret": Value::Null })).into_response();
    };
    match st.auth.load_secret(actor.id, profile_id) {
        Ok(Some((nonce, ct))) => {
            let aad = crate::secrets::secret_aad(actor.id, profile_id);
            let secret = crate::secrets::decrypt(key, &aad, &nonce, &ct);
            Json(json!({ "secret": secret })).into_response()
        }
        Ok(None) => Json(json!({ "secret": Value::Null })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// Forget the CURRENT user's stored secret for a profile.
fn secret_forget(st: &AppState, args: &Value, actor: &User) -> Response {
    let profile_id = args.get("profileId").and_then(Value::as_str).unwrap_or("");
    json_or_err(st.auth.delete_secret(actor.id, profile_id).map(|_| true))
}

// ── Per-user data store handlers (connections / groups / snippets / history / tunnels) ──

/// Which user a write targets: a normal user always writes their OWN items; an admin may target
/// any user's row by passing `ownerId` (so admins can manage everyone's connections).
fn store_owner(args: &Value, actor: &User) -> i64 {
    if actor.is_admin {
        args.get("ownerId").and_then(Value::as_i64).unwrap_or(actor.id)
    } else {
        actor.id
    }
}

fn store_list(st: &AppState, args: &Value, actor: &User) -> Response {
    let store = args.get("store").and_then(Value::as_str).unwrap_or("");
    if store.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "store 必填" }))).into_response();
    }
    json_or_err(st.auth.store_list(store, actor.id, actor.is_admin))
}

fn store_set(st: &AppState, args: &Value, actor: &User) -> Response {
    let store = args.get("store").and_then(Value::as_str).unwrap_or("");
    let item_id = args.get("itemId").and_then(Value::as_str).unwrap_or("");
    if store.is_empty() || item_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "store/itemId 必填" }))).into_response();
    }
    // Strip the server-injected owner tags before persisting; they're re-added on list.
    let mut payload = args.get("payload").cloned().unwrap_or(Value::Null);
    if let Value::Object(ref mut m) = payload {
        m.remove("__ownerId");
        m.remove("__ownerName");
    }
    let payload_str = serde_json::to_string(&payload).unwrap_or_else(|_| "null".into());
    json_or_err(st.auth.store_set(store_owner(args, actor), store, item_id, &payload_str).map(|_| true))
}

fn store_delete(st: &AppState, args: &Value, actor: &User) -> Response {
    let store = args.get("store").and_then(Value::as_str).unwrap_or("");
    let item_id = args.get("itemId").and_then(Value::as_str).unwrap_or("");
    json_or_err(st.auth.store_delete(store_owner(args, actor), store, item_id).map(|_| true))
}

fn store_clear(st: &AppState, args: &Value, actor: &User) -> Response {
    let store = args.get("store").and_then(Value::as_str).unwrap_or("");
    json_or_err(st.auth.store_clear(store_owner(args, actor), store).map(|_| true))
}

// ── Per-user MCP access token (server-mode MCP) ──
// All owner-scoped to the SESSION user; the SSE routes self-authenticate on the resulting token.

/// Current `{ token, enabled }` for the user, lazily minting one (enabled) on first call so the
/// settings page always has a token to display. The endpoint URL is built client-side.
fn mcp_token_get(st: &AppState, actor: &User) -> Response {
    match st.auth.mcp_token_get(actor.id) {
        Ok(Some((token, enabled))) => Json(json!({ "token": token, "enabled": enabled })).into_response(),
        Ok(None) => {
            let token = new_session_token();
            match st.auth.mcp_token_upsert(actor.id, &token) {
                Ok(()) => Json(json!({ "token": token, "enabled": true })).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// Rotate the token (fresh secret), PRESERVING the enabled flag. The OLD token immediately fails
/// `mcp_token_resolve`, so existing SSE URLs 401 at once.
fn mcp_token_regenerate(st: &AppState, actor: &User) -> Response {
    let token = new_session_token();
    match st.auth.mcp_token_upsert(actor.id, &token) {
        Ok(()) => {
            let enabled = st.auth.mcp_token_get(actor.id).ok().flatten().map(|(_, e)| e).unwrap_or(true);
            Json(json!({ "token": token, "enabled": enabled })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

/// Enable/disable the token WITHOUT rotating it. Disabled → `mcp_token_resolve` reports
/// `enabled=false` → the /mcp routes 401, while the token value is preserved.
fn mcp_token_set_enabled(st: &AppState, args: &Value, actor: &User) -> Response {
    let enabled = args.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    match st.auth.mcp_token_set_enabled(actor.id, enabled) {
        Ok(()) => Json(json!({ "enabled": enabled })).into_response(),
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
/// Per-user data subdir (web multi-user): query history / snippets / known_hosts live here, keyed
/// by the owner's user id, so one user can't see or clear another's. Admins still call with their
/// own id for these (per-user history is personal); cross-user visibility is only for connections.
fn user_data_dir(st: &AppState, actor: &User) -> PathBuf {
    st.data_dir.join("users").join(actor.id.to_string())
}

fn record_history(st: &AppState, actor: &User, conn_id: &str, sql: &str, dur: String, args: &Value) {
    let dir = user_data_dir(st, actor);
    let dir: &Path = dir.as_ref();
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
async fn dispatch(st: &AppState, actor: &User, cmd: &str, args: Value) -> Result<Value, String> {
    let conns = st.conns.as_ref();
    // ── Ownership gate ──────────────────────────────────────────────────────────────
    // Any command that references a live `connId`/`sessionId` must be issued by the OWNER of that
    // resource (admins may use any). Centralized here so every db/ssh/sftp op is covered uniformly
    // and a crafted id (the ids are guessable counters) can't reach another user's connection.
    if let Some(conn_id) = args.get("connId").and_then(Value::as_str) {
        if !owns_resource(&st.conn_owners, conn_id, actor) {
            return Err("connection not found".into());
        }
    }
    if let Some(session_id) = args.get("sessionId").and_then(Value::as_str) {
        if !owns_resource(&st.ssh_owners, session_id, actor) {
            return Err("session not found".into());
        }
    }
    match cmd {
        // ── Connection lifecycle ────────────────────────────────────────────────
        "db_connect" => {
            let a: ConnectArgs = from_arg(&args, "args")?;
            let drv = driver::connect(&a).await.map_err(estr)?;
            let version = drv.test().await.map_err(estr)?;
            let caps = drv.capabilities();
            let id = WEB_CONN_IDS.next();
            conns.insert(id.clone(), drv).await;
            st.conn_owners.lock().unwrap().insert(id.clone(), actor.id); // record owner for the gate
            // MCP meta: the display name is a top-level sibling of `args` (sent only by the server
            // frontend; desktop ignores it); the engine string comes from the inner ConnectArgs.
            let name = args.get("name").and_then(Value::as_str).unwrap_or("");
            let db_type = args.get("args").and_then(|a| a.get("dbType")).and_then(Value::as_str).unwrap_or("");
            st.conn_meta.lock().unwrap().insert(id.clone(), (name.to_string(), db_type.to_string()));
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
            let conn_id = require(&args, "connId")?;
            st.conn_owners.lock().unwrap().remove(conn_id);
            st.conn_meta.lock().unwrap().remove(conn_id);
            if conns.remove(conn_id).await { Ok(Value::Null) }
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
            record_history(st, actor, conn_id, sql, format!("{}ms", started.elapsed().as_millis()), &args);
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

        // ── Whole-grid .xlsx export → bytes (server mode downloads in the browser) ───
        "db_export_xlsx_bytes" => {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            let columns: Vec<String> = serde_json::from_value(args.get("columns").cloned().unwrap_or(json!([]))).map_err(estr)?;
            let rows: Vec<Vec<Value>> = serde_json::from_value(args.get("rows").cloned().unwrap_or(json!([]))).map_err(estr)?;
            // Bound the in-memory workbook build (whole sheet held in RAM + base64'd into JSON).
            const MAX_XLSX_CELLS: usize = 5_000_000;
            if rows.len().saturating_mul(columns.len().max(1)) > MAX_XLSX_CELLS {
                return Err("导出数据过大,请缩小范围后重试".into());
            }
            let sheet_name = args.get("sheetName").and_then(Value::as_str).map(str::to_string);
            let bytes = crate::db::xlsx_export::build_xlsx_workbook(&crate::db::xlsx_export::XlsxWorksheetData {
                sheet_name, columns, rows,
            }).map_err(estr)?;
            Ok(Value::String(B64.encode(&bytes)))
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

        // ── History / snippets (per-user under the data volume: users/{id}/) ──────
        "db_history" => {
            Ok(serde_json::to_value(history::load_history(&user_data_dir(st, actor))).map_err(estr)?)
        }
        "db_clear_history" => {
            let dir = user_data_dir(st, actor);
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            history::save_history(&dir, &[]).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history" => {
            let id = require(&args, "id")?;
            let dir = user_data_dir(st, actor);
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            let list: Vec<HistoryEntry> = history::load_history(&dir)
                .into_iter().filter(|h| h.id != id).collect();
            history::save_history(&dir, &list).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_delete_history_for_profile" => {
            let pid = require(&args, "profileId")?;
            let dir = user_data_dir(st, actor);
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            let list: Vec<HistoryEntry> = history::load_history(&dir)
                .into_iter().filter(|h| h.profile_id.as_deref() != Some(pid)).collect();
            history::save_history(&dir, &list).map_err(estr)?;
            Ok(Value::Null)
        }
        "db_snippets" => {
            Ok(serde_json::to_value(history::load_snippets(&user_data_dir(st, actor))).map_err(estr)?)
        }
        "db_save_snippet" => {
            let mut snippet: SnippetEntry = from_arg(&args, "snippet")?;
            if snippet.id.is_empty() { snippet.id = WEB_SNIPPET_IDS.next(); }
            let dir = user_data_dir(st, actor);
            let _guard = st.history_lock.lock().unwrap_or_else(|e| e.into_inner());
            let mut list = history::load_snippets(&dir);
            match list.iter_mut().find(|s| s.id == snippet.id) {
                Some(existing) => *existing = snippet,
                None => list.push(snippet),
            }
            history::save_snippets(&dir, &list).map_err(estr)?;
            Ok(Value::Null)
        }

        // ── SSH connection lifecycle (HTTP request/response; terminals stream over /ws) ──
        "ssh_test" => {
            let a: SshConnectArgs = from_arg(&args, "args")?;
            serde_json::to_value(test_connection(a).await).map_err(estr)
        }
        "ssh_connect" => {
            let a: SshConnectArgs = from_arg(&args, "args")?;
            let dir = user_data_dir(st, actor); // per-user known_hosts
            let _ = std::fs::create_dir_all(&dir);
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
            st.ssh_owners.lock().unwrap().insert(session_id.clone(), actor.id); // record owner
            // MCP meta: display name is the top-level sibling of `args`; host from the ConnectArgs.
            let name = args.get("name").and_then(Value::as_str).unwrap_or("");
            st.ssh_meta.lock().unwrap().insert(session_id.clone(), (name.to_string(), a.host.clone()));
            Ok(json!({
                "sessionId": session_id,
                "hostKeyFingerprint": fingerprint,
                "hostKeyTrusted": host_key_trusted,
            }))
        }
        "ssh_disconnect" => {
            let session_id = require(&args, "sessionId")?;
            st.ssh_owners.lock().unwrap().remove(session_id);
            st.ssh_meta.lock().unwrap().remove(session_id);
            st.ssh.remove_monitor(session_id).await;
            let sess = st.ssh.remove(session_id).await.ok_or("session not found")?;
            sess.lock().await.handle
                .disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
            Ok(Value::Null)
        }
        "ssh_trust_host" => {
            let host_port = require(&args, "hostPort")?.to_string();
            let fingerprint = require(&args, "fingerprint")?.to_string();
            let dir = user_data_dir(st, actor); // per-user known_hosts
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("known_hosts");
            let mut map = std::fs::read_to_string(&path)
                .map(|s| crate::ssh::knownhosts::parse(&s)).unwrap_or_default();
            map.insert(host_port, fingerprint);
            std::fs::write(&path, crate::ssh::knownhosts::serialize(&map)).map_err(estr)?;
            Ok(Value::Null)
        }

        // ── Host info (request/response): live monitor frames ride the WS, but these one-shot
        //    queries (host summary + OS glyph) go over /api/invoke. ──
        "ssh_sysinfo" => Ok(Value::String(
            crate::ssh::monitor::ssh_sysinfo_core(require(&args, "sessionId")?.to_string(), &st.ssh).await.map_err(estr)?,
        )),
        "ssh_detect_os" => Ok(Value::String(
            crate::ssh::monitor::ssh_detect_os_core(require(&args, "sessionId")?.to_string(), &st.ssh).await.map_err(estr)?,
        )),

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

        // ── 端口转发 / 隧道(L/R/D)。隧道注册表挂在共享 SessionManager 上;字节计数经 WS
        //    hub 以 `tunnel://{id}` 广播给订阅者。owner 隔离:tunnel_open 记录 owner、
        //    tunnel_list 按 owner 过滤、tunnel_close 校验 owner。tunnel_open 的 sessionId 已被
        //    顶部 owner 门控覆盖。 ──
        "tunnel_open" => {
            let session_id = require(&args, "sessionId")?.to_string();
            let spec: crate::ssh::tunnel::TunnelSpec = from_arg(&args, "spec")?;
            let sink: Arc<dyn EventSink> = st.ws.clone();
            let id = crate::ssh::tunnel::tunnel_open_core(session_id, spec, sink, &st.ssh)
                .await
                .map_err(estr)?;
            st.tunnel_owners.lock().unwrap().insert(id.clone(), actor.id); // record owner for the gate
            Ok(Value::String(id))
        }
        "tunnel_close" => {
            let tunnel_id = require(&args, "tunnelId")?.to_string();
            if !owns_resource(&st.tunnel_owners, &tunnel_id, actor) {
                return Err("tunnel not found".into());
            }
            st.ssh.remove_tunnel(&tunnel_id).await;
            st.tunnel_owners.lock().unwrap().remove(&tunnel_id);
            Ok(Value::Null)
        }
        "tunnel_list" => {
            let all = st.ssh.tunnel_status_list().await;
            let owners = st.tunnel_owners.lock().unwrap();
            // 非 admin 只见自己的隧道;admin 见全部(管理视角)。
            let visible: Vec<_> = all
                .into_iter()
                .filter(|t| actor.is_admin || owners.get(&t.id).is_some_and(|&o| o == actor.id))
                .collect();
            serde_json::to_value(visible).map_err(estr)
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
/// Cap on concurrent network scans one WS connection may run (each spins a bounded task pool).
const MAX_SCANS_PER_CONN: usize = 2;
/// Upper bound on a scan's requested concurrency (0 still means "use the default"); stops a client
/// from asking the server to open thousands of simultaneous sockets.
const MAX_SCAN_CONCURRENCY: u32 = 256;

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

/// Topics that carry per-session/per-user data (terminal output, VNC frames, host monitor, scan
/// results with hit credentials, command history). The server subscribes the owning connection to
/// these inside the relevant cmd handler; clients must not be able to `sub` to them directly.
fn is_protected_topic(topic: &str) -> bool {
    const PREFIXES: [&str; 7] = [
        "term://", "history://", "vnc-init://", "vnc-rect://", "vnc-closed://", "monitor://", "scan://",
    ];
    PREFIXES.iter().any(|p| topic.starts_with(p))
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
    // Scan ids + monitor session_ids started on THIS connection — cancelled/stopped on disconnect
    // so a dropped tab doesn't leave the server scanning the LAN or polling a host forever.
    let opened_scans: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let opened_monitors: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

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
                        // `mcp-log://<scope>` realtime-log streams are client-subscribable but
                        // AUTHORIZED here (not by client trust): resolve the session and allow only
                        // the owner to sub their OWN id, or an admin to sub `all` / any user's id.
                        // A non-admin thus can't eavesdrop on `mcp-log://all` or another user's id.
                        if let Some(scope) = topic.strip_prefix("mcp-log://") {
                            if let Some(actor) = resolve_session(&st, &token) {
                                if actor.is_admin || scope == actor.id.to_string() {
                                    st.ws.subscribe(conn_id, topic);
                                }
                            }
                        } else if !is_protected_topic(topic) {
                            // Sensitive streams (terminal output, VNC framebuffer, host monitor, scan
                            // results incl. hit credentials, command history) are subscribed SERVER-side
                            // by their cmd handlers for the originating connection only. Refusing
                            // client-driven `sub` to these prefixes stops one logged-in user from
                            // eavesdropping on another's session by guessing/replaying a topic id.
                            st.ws.subscribe(conn_id, topic);
                        }
                    },
                    Some("unsub") => if let Some(topic) = env.get("topic").and_then(Value::as_str) {
                        st.ws.unsubscribe(conn_id, topic);
                    },
                    Some("ping") => { let _ = tx.try_send(json!({ "type": "pong" })); }
                    Some("cmd") => {
                        // Re-validate on every command — an upgrade-time check alone would leave an
                        // established socket as a long-lived SSH control channel after logout.
                        let Some(actor) = resolve_session(&st, &token) else {
                            let _ = tx.try_send(json!({ "type": "reply", "id": env.get("id").cloned().unwrap_or(Value::Null), "ok": false, "error": "会话已失效,请重新登录" }));
                            break;
                        };
                        let cmd = env.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
                        let id = env.get("id").cloned().unwrap_or(Value::Null);
                        let cmd_args = env.get("args").cloned().unwrap_or_else(|| json!({}));
                        // Slow connect commands do blocking network I/O (TCP + handshake, up to
                        // ~25s) — run them OFF the reader loop so other cmds / ping / close on this
                        // same (singleton) socket aren't frozen while a host connects.
                        if matches!(cmd.as_str(), "vnc_connect" | "term_open") {
                            let (st2, tx2, op2, opv2, ops2, opm2, actor2) = (st.clone(), tx.clone(), opened.clone(), opened_vnc.clone(), opened_scans.clone(), opened_monitors.clone(), actor.clone());
                            tokio::spawn(async move {
                                handle_ws_cmd(&st2, conn_id, &actor2, &tx2, &cmd, id, &cmd_args, &op2, &opv2, &ops2, &opm2).await;
                            });
                        } else {
                            handle_ws_cmd(&st, conn_id, &actor, &tx, &cmd, id, &cmd_args, &opened, &opened_vnc, &opened_scans, &opened_monitors).await;
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
        st.vnc_owners.lock().unwrap().remove(&sid);
        let _ = vnc_close_core(&st.vnc, &sid);
    }
    // Cancel any scans this connection started, and stop any host monitors it was driving.
    let scans = opened_scans.lock().unwrap().clone();
    for scan_id in scans {
        st.scan.cancel(&scan_id).await;
    }
    let monitors = opened_monitors.lock().unwrap().clone();
    for session_id in monitors {
        st.ssh.remove_monitor(&session_id).await;
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
    actor: &User,
    tx: &tokio::sync::mpsc::Sender<Value>,
    cmd: &str,
    id: Value,
    args: &Value,
    opened: &std::sync::Mutex<Vec<(String, String)>>,
    opened_vnc: &std::sync::Mutex<Vec<String>>,
    opened_scans: &std::sync::Mutex<Vec<String>>,
    opened_monitors: &std::sync::Mutex<Vec<String>>,
) {
    let actor_admin = actor.is_admin;
    let sid = || args.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let cid = || args.get("chanId").and_then(Value::as_str).unwrap_or("").to_string();
    // Ownership gate (WS): terminal/monitor commands act on an SSH `sessionId`; vnc pointer/key/close
    // act on a VNC `sessionId`. The owner (or an admin) only — same rule as the HTTP dispatch gate.
    let ws_owned = match cmd {
        "term_open" | "term_write" | "term_resize" | "term_close" | "monitor_start" | "monitor_stop" =>
            owns_resource(&st.ssh_owners, &sid(), actor),
        "vnc_pointer" | "vnc_key" | "vnc_close" => owns_resource(&st.vnc_owners, &sid(), actor),
        _ => true,
    };
    let result: Result<Value, String> = if !ws_owned {
        Err("资源不存在或无权访问".to_string())
    } else { match cmd {
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
                    st.vnc_owners.lock().unwrap().insert(vid.clone(), actor.id); // record owner
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
            st.vnc_owners.lock().unwrap().remove(&s);
            st.ws.unsubscribe(conn_id, &format!("vnc-init://{s}"));
            st.ws.unsubscribe(conn_id, &format!("vnc-rect://{s}"));
            st.ws.unsubscribe(conn_id, &format!("vnc-closed://{s}"));
            vnc_close_core(&st.vnc, &s).map(|_| Value::Null).map_err(|e| e.to_string())
        }

        // ── System monitor over WS (M3+): subscribe the live frames topic, then start the loop ──
        "monitor_start" => {
            let session_id = sid();
            let interval_ms = args.get("intervalMs").and_then(Value::as_u64).unwrap_or(2000);
            st.ws.subscribe(conn_id, &format!("monitor://{session_id}"));
            // Track so a dropped tab's monitor loop is stopped on disconnect (no orphan polling).
            { let mut m = opened_monitors.lock().unwrap(); if !m.contains(&session_id) { m.push(session_id.clone()); } }
            let sink: Arc<dyn EventSink> = st.ws.clone();
            crate::ssh::monitor::monitor_start_core(session_id, interval_ms, sink, &st.ssh)
                .await.map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "monitor_stop" => {
            let session_id = sid();
            st.ws.unsubscribe(conn_id, &format!("monitor://{session_id}"));
            opened_monitors.lock().unwrap().retain(|s| s != &session_id);
            st.ssh.remove_monitor(&session_id).await;
            Ok(Value::Null)
        }

        // ── Network scan over WS (admin-only): scanning the server's LAN + brute-forcing creds is
        //    a privileged server-side network operation, so a non-admin must not start it. ──
        "scan_start" if !actor_admin => Err("仅管理员可发起网络扫描".to_string()),
        "scan_start" if opened_scans.lock().unwrap().len() >= MAX_SCANS_PER_CONN =>
            Err("并发扫描数已达上限".to_string()),
        "scan_start" => {
            for topic in ["scan://progress", "scan://found", "scan://log", "scan://done"] {
                st.ws.subscribe(conn_id, topic);
            }
            let sink: Arc<dyn EventSink> = st.ws.clone();
            match serde_json::from_value::<crate::scan::commands::ScanArgs>(args.get("args").cloned().unwrap_or(Value::Null)) {
                Ok(mut a) => {
                    a.concurrency = a.concurrency.min(MAX_SCAN_CONCURRENCY); // 0 = default; clamp the upper bound
                    match crate::scan::commands::scan_start_core(a, sink, st.scan.clone()).await {
                        Ok(scan_id) => {
                            opened_scans.lock().unwrap().push(scan_id.clone());
                            Ok(Value::String(scan_id))
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                Err(e) => Err(e.to_string()),
            }
        }
        "scan_cancel" if !actor_admin => Err("仅管理员可操作网络扫描".to_string()),
        "scan_cancel" => {
            let scan_id = args.get("scanId").and_then(Value::as_str).unwrap_or("");
            st.scan.cancel(scan_id).await;
            opened_scans.lock().unwrap().retain(|s| s != scan_id);
            Ok(Value::Null)
        }

        other => Err(format!("ws command not supported: {other}")),
    } };
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

/// Resolve the caller's user from the session cookie, or None. Shared by the SFTP binary routes
/// (which, like /api/invoke, must be gated AND ownership-checked against the SSH session).
fn authed_user(st: &AppState, headers: &HeaderMap) -> Option<User> {
    session_token(headers).as_deref().and_then(|t| resolve_session(st, t))
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
    let Some(user) = authed_user(&st, &headers) else {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    };
    if !owns_resource(&st.ssh_owners, &q.session_id, &user) {
        return (StatusCode::BAD_REQUEST, "session not found").into_response();
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
    let Some(user) = authed_user(&st, &headers) else {
        return (StatusCode::UNAUTHORIZED, "未登录").into_response();
    };
    let (mut session_id, mut remote_path) = (String::new(), String::new());
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
            // STREAM the file straight to SFTP chunk-by-chunk — never buffer the whole file in
            // memory, so multi-GB uploads work without OOM or a size cap. The frontend appends the
            // fields in order (sessionId, remotePath, file), so the path is known by now.
            Some("file") => {
                if session_id.is_empty() || remote_path.is_empty() {
                    return (StatusCode::BAD_REQUEST, Json(json!({ "error": "file 字段需在 sessionId/remotePath 之后" }))).into_response();
                }
                if !owns_resource(&st.ssh_owners, &session_id, &user) {
                    return (StatusCode::BAD_REQUEST, Json(json!({ "error": "session not found" }))).into_response();
                }
                use futures_util::StreamExt;
                let stream = field.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())));
                return match crate::ssh::sftp::write_remote_stream(&st.ssh, &session_id, &remote_path, stream, st.max_upload_bytes).await {
                    Ok(n) => Json(json!({ "ok": true, "bytes": n })).into_response(),
                    Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
                };
            }
            _ => {}
        }
    }
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "缺少文件" }))).into_response()
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
