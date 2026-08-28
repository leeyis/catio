//! Local MCP (Model Context Protocol) server, embedded in the app.
//!
//! Exposes the user's *already-connected* databases and SSH hosts to external AI
//! coding agents (Claude Code, Cursor, …) over MCP's **Streamable HTTP** transport:
//! a single endpoint, `POST /mcp?token=…`, whose response body IS the JSON-RPC reply.
//! No SSE stream, so no per-session task and no keep-alive heartbeat to maintain.
//!
//! Security:
//! * Bound to 127.0.0.1 only — never exposed off the machine.
//! * A random `token`, regenerated on every start, is required on every request —
//!   so a port scan that finds the port still can't drive the server.
//! * Every connection / tool listing / tool call is logged (client IP, time,
//!   inputs, outputs) under `<install-dir>/logs/mcp-YYYY-MM-DD.log` (UTC), one
//!   file per day, ≤2 MB each (oldest lines dropped), pruned after 7 days.
//!
//! Intentionally hand-rolled over tokio (no extra HTTP framework) to keep the
//! binary small.
//!
//! The tools themselves live in the transport/identity-agnostic [`core`] module so
//! the desktop (here) and server (`crate::server_mcp`) heads share ONE implementation;
//! this module keeps the desktop-specific HTTP transport, file logging, `mcp://log`
//! emit, IP whitelist, and Tauri commands, and injects a [`DesktopTargets`] visible set.

pub mod core;
pub mod http;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use tauri::{AppHandle, Emitter, Manager, State};

const PREFERRED_PORT: u16 = 8765;
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const LOG_RETENTION_DAYS: i64 = 7;

// ---- IP whitelist (network-layer gate, additive to the token) ----
// The matcher itself lives in `crate::netmatch` so the server-mode MCP head shares ONE impl;
// imported here with identical names/signatures/public fields => desktop behavior unchanged.
use crate::netmatch::{ip_allowed, WhitelistRule};

// ---- managed state ----

#[derive(Clone)]
struct ConnMeta {
    conn_id: String,
    name: String,
    db_type: String,
}

#[derive(Clone)]
struct HostMeta {
    session_id: String,
    name: String,
    host: String,
}

struct RunningServer {
    addr: SocketAddr,
    token: String,
    shutdown: watch::Sender<bool>,
    /// serve 任务句柄。`mcp_stop` **必须 await 它**：listener 的存活期就是该任务的存活期，
    /// 只发 shutdown 信号就返回的话，紧接着的 `mcp_start` 会因端口仍被占用而 bind 失败、
    /// 回退到随机端口（端点从 :8765 变成随机值，agent 配置里的端口随之失效）。
    task: tokio::task::JoinHandle<()>,
}

pub struct McpState {
    running: StdMutex<Option<RunningServer>>,
    conns: Arc<StdMutex<Vec<ConnMeta>>>,
    hosts: Arc<StdMutex<Vec<HostMeta>>>,
    /// Allowed non-loopback sources. Shared (Arc) so running ServerCtx tasks gate
    /// new connections against the latest list without a restart.
    whitelist: Arc<StdMutex<Vec<WhitelistRule>>>,
    /// Whether to emit the `mcp://log` live-log event. File logging is unaffected.
    live_log_enabled: Arc<AtomicBool>,
    /// Persisted token: stable across restarts unless the user explicitly refreshes it.
    /// Protected by a mutex so `mcp_start` can read and `mcp_token_refresh` can write atomically.
    persisted_token: StdMutex<Option<String>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            running: StdMutex::new(None),
            conns: Arc::new(StdMutex::new(Vec::new())),
            hosts: Arc::new(StdMutex::new(Vec::new())),
            whitelist: Arc::new(StdMutex::new(Vec::new())),
            live_log_enabled: Arc::new(AtomicBool::new(false)),
            persisted_token: StdMutex::new(load_persisted_token()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub running: bool,
    /// MCP endpoint（`POST /mcp?token=`）。
    pub url: Option<String>,
    pub port: Option<u16>,
    /// True iff the running server is bound to 0.0.0.0 (LAN-exposed). UI shows a warning.
    pub exposed: bool,
}

impl McpInfo {
    fn running(addr: SocketAddr, token: &str) -> Self {
        Self {
            running: true,
            url: Some(format!("http://{addr}/mcp?token={token}")),
            port: Some(addr.port()),
            exposed: addr.ip().is_unspecified(), // true iff bound to 0.0.0.0
        }
    }
    fn stopped() -> Self {
        Self { running: false, url: None, port: None, exposed: false }
    }
}

// ---- server context shared across connections ----

#[derive(Clone)]
struct ServerCtx {
    app: AppHandle,
    conns: Arc<StdMutex<Vec<ConnMeta>>>,
    hosts: Arc<StdMutex<Vec<HostMeta>>>,
    token: String,
    /// Shared with McpState; gates each new connection's source IP in real time.
    whitelist: Arc<StdMutex<Vec<WhitelistRule>>>,
    /// Shared with McpState; gates whether live-log events are emitted.
    live_log: Arc<AtomicBool>,
    /// JSON-RPC request id → cooperative cancellation flag. A cancellation notification or
    /// vanished HTTP client sets the same flag consumed by SSH exec/SFTP cleanup paths.
    inflight: Arc<StdMutex<HashMap<String, Arc<AtomicBool>>>>,
}

fn request_key(id: &Value) -> Option<String> {
    if id.is_null() {
        None
    } else {
        serde_json::to_string(id).ok()
    }
}

fn cancel_request(ctx: &ServerCtx, id: &Value) {
    let Some(key) = request_key(id) else { return };
    if let Some(flag) = ctx.inflight.lock().unwrap().get(&key) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn gen_token() -> String {
    format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// chunked body 的上限，防不回终止分块的客户端把内存吃满。
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// chunked body 是否已收到终止分块（`0\r\n\r\n`，容忍带 trailer 的 `0\r\n`）。
fn ends_chunked_body(buf: &[u8]) -> bool {
    find_subsequence(buf, b"\r\n0\r\n").is_some() || buf.starts_with(b"0\r\n")
}

/// 解 `Transfer-Encoding: chunked`。容错优先：任何畸形处即停并返回已解出的部分，
/// 让上层的 JSON 解析给出 400，而不是在这里 panic。
fn decode_chunked(buf: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0usize;
    // 分块头：十六进制长度，可带 `;ext`，以 CRLF 结束。
    while let Some(nl) = find_subsequence(&buf[i..], b"\r\n") {
        let line = &buf[i..i + nl];
        let hex = line.split(|&b| b == b';').next().unwrap_or(line);
        let hex = String::from_utf8_lossy(hex).trim().to_string();
        let Ok(len) = usize::from_str_radix(&hex, 16) else { break };
        i += nl + 2;
        if len == 0 {
            break; // 终止分块（后面可能有 trailer，不关心）。
        }
        let end = i.saturating_add(len);
        if end > buf.len() {
            out.extend_from_slice(&buf[i..]); // 被截断：带回已有部分。
            break;
        }
        out.extend_from_slice(&buf[i..end]);
        i = end;
        // 分块数据后跟 CRLF。
        if buf[i..].starts_with(b"\r\n") {
            i += 2;
        }
    }
    out
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == key { Some(v.to_string()) } else { None }
    })
}

// ---- accept loop ----

async fn serve(listener: TcpListener, ctx: ServerCtx, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            accept = listener.accept() => match accept {
                Ok((stream, peer)) => {
                    let c = ctx.clone();
                    tokio::spawn(handle_conn(stream, c, peer.ip().to_string()));
                }
                Err(_) => break,
            },
        }
    }
}

async fn handle_conn(mut stream: TcpStream, ctx: ServerCtx, client_ip: String) {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];

    let header_end = loop {
        match stream.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    break pos;
                }
                if buf.len() > 64 * 1024 {
                    return;
                }
            }
            Err(_) => return,
        }
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    let mut content_length = 0usize;
    // Origin/Accept 供 Streamable HTTP 的 `POST /mcp` 用：Origin 做 DNS rebinding
    // 防护（spec MUST），Accept 决定能否用单个 JSON 对象回应。
    let mut origin: Option<String> = None;
    let mut accept: Option<String> = None;
    // chunked：Node/undici 等在流式发送 body 时不带 Content-Length，此时必须按分块解码，
    // 否则拿到的是带长度前缀的原始分块、JSON 解析必失败。
    let mut chunked = false;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("origin") {
                origin = Some(v.trim().to_string());
            } else if k.eq_ignore_ascii_case("accept") {
                accept = Some(v.trim().to_string());
            } else if k.eq_ignore_ascii_case("transfer-encoding") {
                chunked = v.to_ascii_lowercase().contains("chunked");
            }
        }
    }

    let mut body = buf[header_end + 4..].to_vec();
    if chunked {
        // 读到终止分块（`0\r\n\r\n`）为止，再解码。
        while !ends_chunked_body(&body) {
            match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
            if body.len() > MAX_BODY_BYTES {
                let _ = write_simple(&mut stream, 413, "Payload Too Large", "text/plain", "body too large").await;
                return;
            }
        }
        body = decode_chunked(&body);
    } else {
        while body.len() < content_length {
            match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
        }
    }

    // Token gate (everything except health/preflight).
    let token_ok = query_param(&query, "token").as_deref() == Some(ctx.token.as_str());

    // IP whitelist gate (network-layer, additive to the token). Loopback (127.0.0.1/::1)
    // is always allowed; non-loopback must match a rule, else 403 + denied log/emit.
    // OPTIONS/health stay open (CORS preflight + liveness); everything else is gated.
    let authed_route = matches!((method.as_str(), path.as_str()), ("POST", "/mcp"));
    if authed_route {
        let allowed = {
            let rules = ctx.whitelist.lock().unwrap();
            ip_allowed(&client_ip, &rules)
        };
        if !allowed {
            log_event("denied", &client_ip, &json!({ "path": path }));
            emit_log(&ctx, "denied", &client_ip, json!({ "path": path }));
            let _ = write_simple(&mut stream, 403, "Forbidden", "text/plain", "forbidden").await;
            return;
        }
    }

    match (method.as_str(), path.as_str()) {
        ("OPTIONS", _) => {
            let _ = write_simple(&mut stream, 204, "No Content", "", "").await;
        }
        ("GET", "/health") => {
            let _ = write_simple(&mut stream, 200, "OK", "application/json", "{\"ok\":true}").await;
        }
        // Streamable HTTP：唯一的 MCP endpoint，响应直接是 JSON。
        ("POST", "/mcp") => {
            if !token_ok {
                log_event("denied", &client_ip, &json!({ "path": path }));
                emit_log(&ctx, "denied", &client_ip, json!({ "path": path }));
                let _ = write_simple(&mut stream, 401, "Unauthorized", "text/plain", "invalid token").await;
                return;
            }
            handle_streamable(&mut stream, &ctx, origin.as_deref(), accept.as_deref(), &body, &client_ip).await
        }
        // GET/DELETE /mcp：本实现只支持 POST（无 server→client 主动请求，也无协议级
        // session）。spec 对这两者明确要求 405，客户端据此不再尝试开流。
        ("GET", "/mcp") | ("DELETE", "/mcp") => {
            let _ = write_simple(&mut stream, 405, "Method Not Allowed", "text/plain", "method not allowed").await;
        }
        _ => {
            let _ = write_simple(&mut stream, 404, "Not Found", "text/plain", "not found").await;
        }
    }
}

async fn write_simple(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    ctype: &str,
    body: &str,
) -> std::io::Result<()> {
    let mut resp = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Access-Control-Allow-Methods: *\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if !ctype.is_empty() {
        resp.push_str(&format!("Content-Type: {ctype}\r\n"));
    }
    resp.push_str("Connection: close\r\n\r\n");
    resp.push_str(body);
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
}

/// `POST /mcp`：一次 POST → 一个 JSON 响应。
///
/// 顺序：Origin（DNS rebinding，spec MUST）→ Accept → 解析 → dispatch。
/// 通知（无 `id`）按 spec 回 `202 Accepted` 且无 body。
async fn handle_streamable(
    stream: &mut TcpStream,
    ctx: &ServerCtx,
    origin: Option<&str>,
    accept: Option<&str>,
    body: &[u8],
    client_ip: &str,
) {
    // Origin 校验先于一切：桌面端绑 127.0.0.1，若放行任意 Origin，用户浏览器里的
    // 恶意页面即可用 DNS rebinding 驱动本机的真实数据库/SSH 会话。
    if !http::origin_allowed(origin) {
        let detail = json!({ "path": "/mcp", "origin": origin.unwrap_or("") });
        log_event("denied", client_ip, &detail);
        emit_log(ctx, "denied", client_ip, detail);
        let body = http::error_body(http::CODE_PARSE_ERROR, "origin not allowed").to_string();
        let _ = write_json(stream, 403, "Forbidden", &body).await;
        return;
    }
    if !http::accepts_json(accept) {
        // 我们只会用 JSON 回应；对方声明只收 SSE 就没有可用的交集。
        let body = http::error_body(http::CODE_PARSE_ERROR, "client must accept application/json").to_string();
        let _ = write_json(stream, 406, "Not Acceptable", &body).await;
        return;
    }

    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            let body = http::error_body(http::CODE_PARSE_ERROR, &format!("invalid json: {e}")).to_string();
            let _ = write_json(stream, 400, "Bad Request", &body).await;
            return;
        }
    };

    // 同时观察客户端是否在长操作期间消失。连接断开不是“操作超时”，但继续留下无主
    // 的 SSH channel 会占用 MaxSessions 并反压同一物理连接，因此要协作取消并给清理路径
    // 足够时间发送 CHANNEL_CLOSE/删除半成品。
    let mut dispatch_future = Box::pin(dispatch(ctx, &req, client_ip));
    let mut disconnect_probe = [0u8; 1];
    let response = tokio::select! {
        biased;
        // 先 poll dispatch 一次，让 tools/call 在检查 socket 前完成 inflight 注册。
        response = &mut dispatch_future => response,
        read = stream.read(&mut disconnect_probe) => {
            match read {
                Ok(0) | Err(_) => {
                    if let Some(id) = req.get("id") {
                        cancel_request(ctx, id);
                    }
                    // 客户端已经离开，无需再返回响应；但必须等协作取消把 SSH channel
                    // 和传输半成品真正收好。这里也不设置总时限，避免再次制造孤儿任务。
                    let _ = dispatch_future.await;
                    return;
                }
                Ok(_) => dispatch_future.await,
            }
        }
    };

    match response {
        Some(resp) => {
            let body = serde_json::to_string(&resp).unwrap_or_default();
            let _ = write_json(stream, 200, "OK", &body).await;
        }
        // 通知：spec 要求 202 且无 body。
        None => {
            let _ = write_simple(stream, 202, "Accepted", "", "").await;
        }
    }
}

/// 写一个 `application/json` 响应体。
async fn write_json(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    body: &str,
) -> std::io::Result<()> {
    write_simple(stream, code, reason, "application/json", body).await
}

// ---- JSON-RPC dispatch (desktop-specific: file log + mcp://log emit gate) ----

async fn dispatch(ctx: &ServerCtx, req: &Value, client_ip: &str) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => id.map(|id| {
            // 回客户端声明的版本（若受支持），而非硬编码常量——Streamable HTTP 客户端
            // 声明 2025-03-26+，旧 SSE 客户端声明 2024-11-05，两者都要能对上握手。
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str);
            json!({
                "jsonrpc": "2.0", "id": id,
                "result": {
                    "protocolVersion": http::negotiate_version(requested),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "catio", "version": env!("CARGO_PKG_VERSION") }
                }
            })
        }),
        "notifications/initialized" => None,
        "notifications/cancelled" => {
            if let Some(request_id) = params.get("requestId") {
                cancel_request(ctx, request_id);
            }
            None
        }
        "ping" => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => {
            log_event("tools/list", client_ip, &json!({}));
            emit_log(ctx, "tools/list", client_ip, json!({}));
            id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": core::tools_list() } }))
        }
        "tools/call" => {
            let id = id?;
            let inflight_key = request_key(&id);
            let cancel = Arc::new(AtomicBool::new(false));
            if let Some(key) = inflight_key.as_ref() {
                ctx.inflight.lock().unwrap().insert(key.clone(), cancel.clone());
            }
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            log_event("tools/call", client_ip, &json!({ "tool": name, "arguments": args }));
            // Event payload uses `args` (per contract); the file log keeps `arguments`.
            emit_log(ctx, "tools/call", client_ip, json!({ "tool": name, "args": args }));
            let result = call_tool(ctx, &name, &args, cancel.clone()).await;
            if let Some(key) = inflight_key.as_ref() {
                let mut inflight = ctx.inflight.lock().unwrap();
                if inflight
                    .get(key)
                    .is_some_and(|current| Arc::ptr_eq(current, &cancel))
                {
                    inflight.remove(key);
                }
            }
            let (text, is_error) = match result {
                Ok(t) => (t, false),
                Err(t) => (t, true),
            };
            log_event("tools/result", client_ip, &json!({ "tool": name, "isError": is_error, "output": text }));
            emit_log(ctx, "tools/result", client_ip, json!({ "tool": name, "isError": is_error, "output": text }));
            Some(json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "content": [{ "type": "text", "text": text }], "isError": is_error }
            }))
        }
        _ => id.map(|id| {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } })
        }),
    }
}

// ---- desktop McpTargets + tool entry (delegates tools to the shared core) ----

/// Desktop visible set — backs the frontend-synced `conns`/`hosts` registries (single user),
/// mirroring the old `resolve_conn_id`/`resolve_host` + list helpers verbatim.
struct DesktopTargets {
    conns: Arc<StdMutex<Vec<ConnMeta>>>,
    hosts: Arc<StdMutex<Vec<HostMeta>>>,
}

impl core::McpTargets for DesktopTargets {
    fn list_connections(&self) -> Vec<core::ConnEntry> {
        self.conns
            .lock()
            .unwrap()
            .iter()
            .map(|c| core::ConnEntry { conn_id: c.conn_id.clone(), name: c.name.clone(), db_type: c.db_type.clone() })
            .collect()
    }
    fn resolve_db(&self, key: &str) -> Option<String> {
        let conns = self.conns.lock().unwrap();
        conns.iter().find(|c| c.name == key || c.conn_id == key).map(|c| c.conn_id.clone())
    }
    fn list_hosts(&self) -> Vec<core::HostEntry> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .map(|h| core::HostEntry { session_id: h.session_id.clone(), name: h.name.clone(), host: h.host.clone() })
            .collect()
    }
    fn resolve_host(&self, key: Option<&str>) -> Result<String, String> {
        let hosts = self.hosts.lock().unwrap();
        match key {
            Some(n) if !n.is_empty() && n != "default" => hosts
                .iter()
                .find(|h| h.name == n || h.session_id == n)
                .map(|h| h.session_id.clone())
                .ok_or_else(|| format!("host not found: {n}")),
            _ => {
                if hosts.len() == 1 {
                    Ok(hosts[0].session_id.clone())
                } else if hosts.is_empty() {
                    Err("no active SSH host connections".into())
                } else {
                    Err("multiple hosts active; specify connectionName".into())
                }
            }
        }
    }
}

/// Desktop tool entry: assemble the live managers + a Tauri progress sink over this server's
/// frontend-synced visible set, then hand off to the shared cancellable core.
async fn call_tool(
    ctx: &ServerCtx,
    name: &str,
    args: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let cm = ctx.app.state::<crate::db::manager::ConnManager>();
    let sm = ctx.app.state::<crate::ssh::manager::SessionManager>();
    let targets = DesktopTargets { conns: ctx.conns.clone(), hosts: ctx.hosts.clone() };
    let sink: Arc<dyn crate::events::EventSink> = Arc::new(crate::events::TauriSink(ctx.app.clone()));
    core::call_tool_cancellable(
        &targets,
        cm.inner(),
        sm.inner(),
        &sink,
        name,
        args,
        Some(cancel),
    )
    .await
}

// ---- logging (UTC, per-day file, ≤2MB rolling, 7-day retention) ----

fn log_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("logs")
}

fn token_file() -> PathBuf {
    log_dir().join("mcp_token")
}

/// Load the persisted token (if it exists and is a valid 32-hex string).
fn load_persisted_token() -> Option<String> {
    let path = token_file();
    std::fs::read_to_string(&path).ok().and_then(|s| {
        let trimmed = s.trim();
        if trimmed.len() == 32 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

/// Persist the token to disk (best-effort; failure is silent).
fn save_token(token: &str) {
    let path = token_file();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::write(&path, token);
}

/// (year, month, day) from days since the Unix epoch (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn fmt_date(epoch: i64) -> String {
    let (y, m, d) = civil_from_days(epoch.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

fn fmt_datetime(epoch: i64) -> String {
    let (y, mo, d) = civil_from_days(epoch.div_euclid(86_400));
    let s = epoch.rem_euclid(86_400);
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s % 3600) / 60, s % 60)
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Serializes log writes and remembers the last date pruned.
fn log_guard() -> &'static StdMutex<String> {
    static G: OnceLock<StdMutex<String>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(String::new()))
}

/// One live-log entry pushed to the frontend over the `mcp://log` Tauri event.
/// Optional fields are omitted when absent so each kind only carries what applies.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpLogEntry {
    ts: String,
    kind: String,
    ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// Emit one structured live-log entry to the frontend — gated on live_log.
/// File logging is separate and unconditional (done by log_event).
fn emit_log(ctx: &ServerCtx, kind: &str, ip: &str, detail: Value) {
    if !ctx.live_log.load(Ordering::Relaxed) {
        return;
    }
    let entry = McpLogEntry {
        ts: fmt_datetime(now_epoch()),
        kind: kind.to_string(),
        ip: ip.to_string(),
        tool: detail.get("tool").and_then(Value::as_str).map(String::from),
        args: detail.get("args").cloned(),
        output: detail.get("output").and_then(Value::as_str).map(String::from),
        is_error: detail.get("isError").and_then(Value::as_bool),
        path: detail.get("path").and_then(Value::as_str).map(String::from),
    };
    let _ = ctx.app.emit("mcp://log", entry);
}

fn log_event(kind: &str, client_ip: &str, detail: &Value) {
    let now = now_epoch();
    let date = fmt_date(now);
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("mcp-{date}.log"));
    let line = format!(
        "{} [{kind}] ip={client_ip} {}\n",
        fmt_datetime(now),
        serde_json::to_string(detail).unwrap_or_default()
    );

    let mut last = match log_guard().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if *last != date {
        prune_old(&dir, now);
        *last = date;
    }
    append_capped(&file, line.as_bytes());
}

fn append_capped(path: &std::path::Path, line: &[u8]) {
    let existing = std::fs::read(path).unwrap_or_default();
    if existing.len() + line.len() <= MAX_LOG_BYTES {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line);
        }
        return;
    }
    // Drop whole lines from the front until the new line fits within the cap.
    let mut start = 0usize;
    while existing.len() - start + line.len() > MAX_LOG_BYTES {
        match existing[start..].iter().position(|&b| b == b'\n') {
            Some(nl) => start += nl + 1,
            None => {
                start = existing.len();
                break;
            }
        }
    }
    let mut out = Vec::with_capacity(existing.len() - start + line.len());
    out.extend_from_slice(&existing[start..]);
    out.extend_from_slice(line);
    let _ = std::fs::write(path, &out);
}

fn prune_old(dir: &std::path::Path, now: i64) {
    let cutoff = fmt_date(now - LOG_RETENTION_DAYS * 86_400);
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // mcp-YYYY-MM-DD.log — lexicographic date compare is valid for this format.
        if let Some(date) = name.strip_prefix("mcp-").and_then(|s| s.strip_suffix(".log")) {
            if date < cutoff.as_str() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// ---- Tauri commands ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnMetaWire {
    pub conn_id: String,
    pub name: String,
    pub db_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetaWire {
    pub session_id: String,
    pub name: String,
    pub host: String,
}

#[tauri::command]
pub async fn mcp_start(app: AppHandle, state: State<'_, McpState>) -> Result<McpInfo, String> {
    {
        let g = state.running.lock().unwrap();
        if let Some(rs) = g.as_ref() {
            return Ok(McpInfo::running(rs.addr, &rs.token));
        }
    }

    // Bind 0.0.0.0 iff the whitelist contains any non-loopback rule; else stay 127.0.0.1.
    // A rule is "loopback-only" when it sits inside 127.0.0.0/8 (prefix >= 8, first octet 127).
    let expose = {
        let wl = state.whitelist.lock().unwrap();
        wl.iter().any(|r| !(r.prefix >= 8 && (r.base >> 24) == 127))
    };
    let bind_ip: Ipv4Addr = if expose {
        Ipv4Addr::UNSPECIFIED // 0.0.0.0 — exposed to the LAN
    } else {
        Ipv4Addr::LOCALHOST // 127.0.0.1 — loopback only
    };
    let listener = match TcpListener::bind((bind_ip, PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind((bind_ip, 0)).await.map_err(|e| e.to_string())?,
    };
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    // Use the persisted token if available; otherwise generate a new one and persist it.
    let token = {
        let mut pt = state.persisted_token.lock().unwrap();
        if let Some(existing) = pt.as_ref() {
            existing.clone()
        } else {
            let new_token = gen_token();
            save_token(&new_token);
            *pt = Some(new_token.clone());
            new_token
        }
    };
    prune_old(&log_dir(), now_epoch());

    let (sh_tx, sh_rx) = watch::channel(false);
    let ctx = ServerCtx {
        app: app.clone(),
        conns: state.conns.clone(),
        hosts: state.hosts.clone(),
        token: token.clone(),
        whitelist: state.whitelist.clone(),
        live_log: state.live_log_enabled.clone(),
        inflight: Arc::new(StdMutex::new(HashMap::new())),
    };
    let task = tokio::spawn(serve(listener, ctx, sh_rx));

    *state.running.lock().unwrap() =
        Some(RunningServer { addr, token: token.clone(), shutdown: sh_tx, task });
    Ok(McpInfo::running(addr, &token))
}

/// 停止服务。**等 serve 任务真正结束**后才返回，使端口立即可重绑——
/// 「更新 Token」的 stop→start 依赖这一点（详见 [`RunningServer::task`]）。
#[tauri::command]
pub async fn mcp_stop(state: State<'_, McpState>) -> Result<McpInfo, String> {
    // 先在锁内取出，再在锁外 await：StdMutex 的 guard 不可跨 await 持有。
    let running = state.running.lock().unwrap().take();
    if let Some(rs) = running {
        let _ = rs.shutdown.send(true);
        // accept() 正阻塞在 select! 上，收到信号即 break 并 drop listener。
        let _ = rs.task.await;
    }
    Ok(McpInfo::stopped())
}

#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>) -> McpInfo {
    match state.running.lock().unwrap().as_ref() {
        Some(rs) => McpInfo::running(rs.addr, &rs.token),
        None => McpInfo::stopped(),
    }
}

#[tauri::command]
pub fn mcp_sync_targets(
    state: State<'_, McpState>,
    databases: Vec<ConnMetaWire>,
    hosts: Vec<HostMetaWire>,
) {
    *state.conns.lock().unwrap() = databases
        .into_iter()
        .map(|c| ConnMeta { conn_id: c.conn_id, name: c.name, db_type: c.db_type })
        .collect();
    *state.hosts.lock().unwrap() = hosts
        .into_iter()
        .map(|h| HostMeta { session_id: h.session_id, name: h.name, host: h.host })
        .collect();
}

/// Replace the IP whitelist wholesale. Entries that fail to parse are silently
/// dropped (non-fatal — the UI already validated). Mutates the shared Arc, so a
/// running server gates new connections against the new rules immediately; only
/// the 0.0.0.0-vs-127.0.0.1 listen address waits for the next mcp_start.
#[tauri::command]
pub fn mcp_set_whitelist(state: State<'_, McpState>, entries: Vec<String>) {
    let rules: Vec<WhitelistRule> = entries.iter().filter_map(|e| WhitelistRule::parse(e)).collect();
    *state.whitelist.lock().unwrap() = rules;
}

/// Toggle whether `mcp://log` live-log events are emitted. File logging is
/// unconditional and unaffected; takes effect on the next emit, no restart.
#[tauri::command]
pub fn mcp_set_live_log(state: State<'_, McpState>, enabled: bool) {
    state.live_log_enabled.store(enabled, Ordering::Relaxed);
}

/// Generate a fresh token and persist it. If the server is running, the new token takes effect
/// only after the next `mcp_start` — the running server keeps its current token until stopped.
/// Returns the new token value (for display) and whether the server is currently running.
#[tauri::command]
pub fn mcp_token_refresh(state: State<'_, McpState>) -> (String, bool) {
    let new_token = gen_token();
    save_token(&new_token);
    *state.persisted_token.lock().unwrap() = Some(new_token.clone());
    let running = state.running.lock().unwrap().is_some();
    (new_token, running)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Transfer-Encoding: chunked —— Node/undici 等流式发送 body 时不带 Content-Length。
    // 不解码就会把带长度前缀的原始分块喂给 serde，JSON 解析必失败（表现为无故 400）。
    //
    // 覆盖边界：以下测的是解码逻辑本身。桌面 `handle_conn` 的装配（解 header → 循环
    // 读到终止分块 → 调 decode_chunked）无法在此单测——`ServerCtx` 持有 `AppHandle`，
    // 需要真实 Tauri runtime。server head 的同一行为有端到端覆盖，见
    // `tests/server_mcp.rs::streamable_accepts_a_chunked_request_body`。

    #[test]
    fn decodes_a_single_chunk() {
        // 分块长度是十六进制：{"jsonrpc":"2.0","id":1} 共 24 字节 = 0x18。
        let payload = br#"{"jsonrpc":"2.0","id":1}"#;
        assert_eq!(payload.len(), 0x18);
        let body = b"18\r\n{\"jsonrpc\":\"2.0\",\"id\":1}\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), payload.to_vec());
    }

    #[test]
    fn decodes_multiple_chunks_into_one_body() {
        // 分块边界可以落在 JSON 中间——解码后必须重新拼成完整文档。
        // `{"a":` = 5 字节，`1}` = 2 字节。
        let body = b"5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), br#"{"a":1}"#.to_vec());
    }

    #[test]
    fn tolerates_chunk_extensions() {
        let body = b"7;foo=bar\r\n{\"a\":1}\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), br#"{"a":1}"#.to_vec());
    }

    #[test]
    fn truncated_chunk_returns_what_it_has_without_panicking() {
        // 声明 100 字节却只给了 4 个：必须返回已有部分，交给上层报 400。
        let body = b"64\r\nabcd";
        assert_eq!(decode_chunked(body), b"abcd".to_vec());
    }

    #[test]
    fn malformed_length_stops_cleanly() {
        assert!(decode_chunked(b"zz\r\nabcd\r\n0\r\n\r\n").is_empty());
        assert!(decode_chunked(b"").is_empty());
    }

    // ── 停止后端口必须立即可重绑 ────────────────────────────────────────
    //
    // 「更新 Token」在服务运行时要 stop→start 让新 token 生效。若 stop 只发信号就返回，
    // 旧 listener 可能还占着 8765，紧接着的 start 就会 bind 失败并回退到随机端口——
    // 端点从 :8765 变成 :54321，agent 配置里的端口也失效，比 token 变化更糟。

    /// 按 `mcp_start` 的方式起一个真 serve 任务，返回可用于停止它的 `RunningServer` 片段。
    /// 不构造 `ServerCtx`（需要 AppHandle），只复用 listener + shutdown + JoinHandle 三者的
    /// 时序——这正是端口能否立即重绑的决定因素。
    async fn spawn_serve_like(port: u16) -> (watch::Sender<bool>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let (tx, mut rx) = watch::channel(false);
        // 与 serve() 同构：select! 在 accept 与 shutdown 间等待，break 后 listener 随任务 drop。
        let h = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    accept = listener.accept() => match accept {
                        Ok(_) => {}
                        Err(_) => break,
                    },
                }
            }
        });
        (tx, h)
    }

    /// 复刻 `mcp_stop` 的收尾语义：发信号 **并等任务结束**。
    async fn stop_like(tx: watch::Sender<bool>, task: tokio::task::JoinHandle<()>) {
        let _ = tx.send(true);
        let _ = task.await;
    }

    #[tokio::test]
    async fn stop_that_awaits_the_task_frees_the_port_immediately() {
        let port = {
            let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            probe.local_addr().unwrap().port()
        };

        let (tx, task) = spawn_serve_like(port).await;
        assert!(
            TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.is_err(),
            "serve 运行期间同端口不应可绑"
        );

        stop_like(tx, task).await;

        // 这是「更新 Token」里 stop→start 能守住 8765 的前提。
        assert!(
            TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.is_ok(),
            "mcp_stop await 任务后,同端口必须可立即重绑"
        );
    }

    // ── token 持久化 ──────────────────────────────────────────────────────
    //
    // 用户反馈的问题：每次启停服务都换 token，导致 agent 客户端配置得跟着改。
    // 现在 token 落盘，启动时复用；只有用户点「更新 Token」才轮换。

    #[test]
    fn accepts_a_well_formed_persisted_token() {
        // 32 位十六进制 = gen_token 的输出格式。
        let tok = "0123456789abcdef0123456789abcdef";
        assert_eq!(tok.len(), 32);
        assert!(tok.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn gen_token_is_32_hex_chars() {
        // load_persisted_token 按此格式校验，两者必须对齐，否则存进去的读不回来。
        let t = gen_token();
        assert_eq!(t.len(), 32, "token 必须是 32 字符: {t}");
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()), "token 必须全为十六进制: {t}");
    }

    #[test]
    fn gen_token_is_not_constant() {
        // 「固定 token」指的是跨重启复用落盘值，不是生成器退化成常量——
        // 点「更新 Token」必须真的换一个。
        assert_ne!(gen_token(), gen_token());
    }

    #[test]
    fn detects_the_terminating_chunk() {
        assert!(ends_chunked_body(b"5\r\nhello\r\n0\r\n\r\n"));
        assert!(ends_chunked_body(b"0\r\n\r\n"), "空 body 的终止分块在首位");
        // 还没收完就不能当作结束，否则会把半个 body 交给解析器。
        assert!(!ends_chunked_body(b"5\r\nhel"));
        assert!(!ends_chunked_body(b"5\r\nhello\r\n"));
    }
}
