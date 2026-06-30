//! Local MCP (Model Context Protocol) server, embedded in the app.
//!
//! Exposes the user's *already-connected* databases and SSH hosts to external AI
//! coding agents (Claude Code, Cursor, …) over MCP's HTTP+SSE transport. The agent
//! opens `GET /sse?token=…` for the server→client event stream, then POSTs JSON-RPC
//! requests to the `/messages?sessionId=…&token=…` endpoint advertised on it.
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
//! The 12 tools themselves live in the transport/identity-agnostic [`core`] module so
//! the desktop (here) and server (`crate::server_mcp`) heads share ONE implementation;
//! this module keeps the desktop-specific HTTP/SSE transport, file logging, `mcp://log`
//! emit, IP whitelist, and Tauri commands, and injects a [`DesktopTargets`] visible set.

pub mod core;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use tauri::{AppHandle, Emitter, Manager, State};

const PROTOCOL_VERSION: &str = "2024-11-05";
const PREFERRED_PORT: u16 = 8765;
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const LOG_RETENTION_DAYS: i64 = 7;

// ---- IP whitelist (network-layer gate, additive to the token) ----

/// One whitelist entry: an IPv4 base address + prefix length (single IP = /32).
#[derive(Clone, Copy)]
struct WhitelistRule {
    base: u32,
    prefix: u8,
}

impl WhitelistRule {
    /// Parse "a.b.c.d" (=> /32) or "a.b.c.d/n" (n in 0..=32). None on any malformed input.
    fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let (ip_part, prefix) = match s.split_once('/') {
            Some((ip, n)) => {
                let n: u8 = n.parse().ok()?;
                if n > 32 {
                    return None;
                }
                (ip, n)
            }
            None => (s, 32u8),
        };
        let addr: Ipv4Addr = ip_part.parse().ok()?; // rejects bad octets / non-IPv4
        Some(WhitelistRule { base: u32::from(addr), prefix })
    }

    /// True if `ip` (an IPv4) falls inside this rule, comparing the high `prefix` bits.
    fn matches(&self, ip: Ipv4Addr) -> bool {
        if self.prefix == 0 {
            return true;
        }
        // Special-case 32 to avoid the `u32::MAX >> 32` (>>) overflow.
        let mask: u32 = if self.prefix == 32 { u32::MAX } else { !(u32::MAX >> self.prefix) };
        (u32::from(ip) & mask) == (self.base & mask)
    }
}

/// 127.0.0.1 and ::1 are always allowed; otherwise the IPv4 must match a rule.
/// Non-loopback IPv6 has no rules => denied. Unparseable client_ip => denied.
fn ip_allowed(client_ip: &str, rules: &[WhitelistRule]) -> bool {
    match client_ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            if v4.is_loopback() {
                return true; // 127.0.0.0/8
            }
            rules.iter().any(|r| r.matches(v4))
        }
        Ok(IpAddr::V6(v6)) => v6.is_loopback(), // ::1 only
        Err(_) => false,
    }
}

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
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            running: StdMutex::new(None),
            conns: Arc::new(StdMutex::new(Vec::new())),
            hosts: Arc::new(StdMutex::new(Vec::new())),
            whitelist: Arc::new(StdMutex::new(Vec::new())),
            live_log_enabled: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    /// True iff the running server is bound to 0.0.0.0 (LAN-exposed). UI shows a warning.
    pub exposed: bool,
}

impl McpInfo {
    fn running(addr: SocketAddr, token: &str) -> Self {
        Self {
            running: true,
            url: Some(format!("http://{addr}/sse?token={token}")),
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
    sessions: Arc<StdMutex<HashMap<String, UnboundedSender<String>>>>,
    token: String,
    /// Shared with McpState; gates each new connection's source IP in real time.
    whitelist: Arc<StdMutex<Vec<WhitelistRule>>>,
    /// Shared with McpState; gates whether live-log events are emitted.
    live_log: Arc<AtomicBool>,
}

fn gen_session_id() -> String {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}-{n:x}", rand::random::<u64>())
}

fn gen_token() -> String {
    format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
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
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }

    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }

    // Token gate (everything except health/preflight).
    let token_ok = query_param(&query, "token").as_deref() == Some(ctx.token.as_str());

    // IP whitelist gate (network-layer, additive to the token). Loopback (127.0.0.1/::1)
    // is always allowed; non-loopback must match a rule, else 403 + denied log/emit.
    // OPTIONS/health stay open (CORS preflight + liveness); everything else is gated.
    let authed_route = matches!(
        (method.as_str(), path.as_str()),
        ("GET", "/sse") | ("GET", "/") | ("POST", "/messages") | ("POST", "/message")
    );
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
        ("GET", "/sse") | ("GET", "/") => {
            if !token_ok {
                log_event("denied", &client_ip, &json!({ "path": path }));
                emit_log(&ctx, "denied", &client_ip, json!({ "path": path }));
                let _ = write_simple(&mut stream, 401, "Unauthorized", "text/plain", "invalid token").await;
                return;
            }
            handle_sse(stream, ctx, client_ip).await
        }
        ("POST", "/messages") | ("POST", "/message") => {
            if !token_ok {
                log_event("denied", &client_ip, &json!({ "path": path }));
                emit_log(&ctx, "denied", &client_ip, json!({ "path": path }));
                let _ = write_simple(&mut stream, 401, "Unauthorized", "text/plain", "invalid token").await;
                return;
            }
            handle_message(&mut stream, &ctx, &query, &body, &client_ip).await
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

async fn handle_sse(mut stream: TcpStream, ctx: ServerCtx, client_ip: String) {
    let session_id = gen_session_id();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    ctx.sessions.lock().unwrap().insert(session_id.clone(), tx);
    log_event("connect", &client_ip, &json!({ "sessionId": session_id }));
    emit_log(&ctx, "connect", &client_ip, json!({ "sessionId": session_id }));

    let headers = "HTTP/1.1 200 OK\r\n\
        Content-Type: text/event-stream\r\n\
        Cache-Control: no-cache\r\n\
        Connection: keep-alive\r\n\
        Access-Control-Allow-Origin: *\r\n\r\n";
    if stream.write_all(headers.as_bytes()).await.is_err() {
        ctx.sessions.lock().unwrap().remove(&session_id);
        return;
    }

    // Advertise the POST endpoint (token carried through so the client echoes it).
    let endpoint = format!(
        "event: endpoint\r\ndata: /messages?sessionId={session_id}&token={}\r\n\r\n",
        ctx.token
    );
    let _ = stream.write_all(endpoint.as_bytes()).await;
    let _ = stream.flush().await;

    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.tick().await;

    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(m) => {
                    let frame = format!("event: message\r\ndata: {m}\r\n\r\n");
                    if stream.write_all(frame.as_bytes()).await.is_err() { break; }
                    let _ = stream.flush().await;
                }
                None => break,
            },
            _ = ping.tick() => {
                if stream.write_all(b": ping\r\n\r\n").await.is_err() { break; }
                let _ = stream.flush().await;
            }
        }
    }
    ctx.sessions.lock().unwrap().remove(&session_id);
}

async fn handle_message(stream: &mut TcpStream, ctx: &ServerCtx, query: &str, body: &[u8], client_ip: &str) {
    let session_id = query_param(query, "sessionId");

    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            let _ = write_simple(stream, 400, "Bad Request", "text/plain", &format!("invalid json: {e}")).await;
            return;
        }
    };

    let resp = dispatch(ctx, &req, client_ip).await;
    let _ = write_simple(stream, 202, "Accepted", "text/plain", "").await;

    if let (Some(sid), Some(resp)) = (session_id, resp) {
        let line = serde_json::to_string(&resp).unwrap_or_default();
        if let Some(tx) = ctx.sessions.lock().unwrap().get(&sid) {
            let _ = tx.send(line);
        }
    }
}

// ---- JSON-RPC dispatch (desktop-specific: file log + mcp://log emit gate) ----

async fn dispatch(ctx: &ServerCtx, req: &Value, client_ip: &str) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => id.map(|id| {
            json!({
                "jsonrpc": "2.0", "id": id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "catio", "version": env!("CARGO_PKG_VERSION") }
                }
            })
        }),
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => {
            log_event("tools/list", client_ip, &json!({}));
            emit_log(ctx, "tools/list", client_ip, json!({}));
            id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": core::tools_list() } }))
        }
        "tools/call" => {
            let id = id?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            log_event("tools/call", client_ip, &json!({ "tool": name, "arguments": args }));
            // Event payload uses `args` (per contract); the file log keeps `arguments`.
            emit_log(ctx, "tools/call", client_ip, json!({ "tool": name, "args": args }));
            let (text, is_error) = match call_tool(ctx, &name, &args).await {
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

// ---- desktop McpTargets + tool entry (delegates the 12 tools to the shared core) ----

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
/// frontend-synced visible set, then hand off to the shared `core::call_tool`. Behavior is
/// byte-identical to the pre-core desktop path — the SFTP id stays "mcp" → `transfer-progress-mcp`
/// (verified UNCONSUMED by the frontend, which only listens on the returned xfer-N id).
async fn call_tool(ctx: &ServerCtx, name: &str, args: &Value) -> Result<String, String> {
    let cm = ctx.app.state::<crate::db::manager::ConnManager>();
    let sm = ctx.app.state::<crate::ssh::manager::SessionManager>();
    let targets = DesktopTargets { conns: ctx.conns.clone(), hosts: ctx.hosts.clone() };
    let sink: Arc<dyn crate::events::EventSink> = Arc::new(crate::events::TauriSink(ctx.app.clone()));
    core::call_tool(&targets, cm.inner(), sm.inner(), &sink, name, args).await
}

// ---- logging (UTC, per-day file, ≤2MB rolling, 7-day retention) ----

fn log_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("logs")
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
    session_id: Option<String>,
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
        session_id: detail.get("sessionId").and_then(Value::as_str).map(String::from),
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
    let token = gen_token();
    prune_old(&log_dir(), now_epoch());

    let (sh_tx, sh_rx) = watch::channel(false);
    let ctx = ServerCtx {
        app: app.clone(),
        conns: state.conns.clone(),
        hosts: state.hosts.clone(),
        sessions: Arc::new(StdMutex::new(HashMap::new())),
        token: token.clone(),
        whitelist: state.whitelist.clone(),
        live_log: state.live_log_enabled.clone(),
    };
    tokio::spawn(serve(listener, ctx, sh_rx));

    *state.running.lock().unwrap() = Some(RunningServer { addr, token: token.clone(), shutdown: sh_tx });
    Ok(McpInfo::running(addr, &token))
}

#[tauri::command]
pub fn mcp_stop(state: State<'_, McpState>) -> McpInfo {
    if let Some(rs) = state.running.lock().unwrap().take() {
        let _ = rs.shutdown.send(true);
    }
    McpInfo::stopped()
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
