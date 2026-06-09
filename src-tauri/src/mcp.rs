//! Local MCP (Model Context Protocol) server, embedded in the app.
//!
//! Exposes the user's *already-connected* databases to external AI coding agents
//! (Claude Code, Cursor, Windsurf, …) over MCP's HTTP+SSE transport. The agent
//! opens `GET /sse` for the server→client event stream, then POSTs JSON-RPC
//! requests to the `/messages?sessionId=…` endpoint advertised on that stream.
//!
//! Tools: `list_connections`, `list_tables`, `run_sql`, `open_table`.
//!
//! Intentionally hand-rolled over tokio (no extra HTTP framework) to keep the
//! binary small. Bound to 127.0.0.1 only — never exposed off the machine.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use tauri::{AppHandle, Emitter, Manager, State};

const PROTOCOL_VERSION: &str = "2024-11-05";
const PREFERRED_PORT: u16 = 8765;

// ---- managed state ----

#[derive(Clone)]
struct ConnMeta {
    conn_id: String,
    name: String,
    db_type: String,
}

struct RunningServer {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
}

pub struct McpState {
    running: StdMutex<Option<RunningServer>>,
    conns: Arc<StdMutex<Vec<ConnMeta>>>,
    allow_open_window: Arc<AtomicBool>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            running: StdMutex::new(None),
            conns: Arc::new(StdMutex::new(Vec::new())),
            allow_open_window: Arc::new(AtomicBool::new(true)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

impl McpInfo {
    fn running(addr: SocketAddr) -> Self {
        Self { running: true, url: Some(format!("http://{addr}/sse")), port: Some(addr.port()) }
    }
    fn stopped() -> Self {
        Self { running: false, url: None, port: None }
    }
}

// ---- server context shared across connections ----

#[derive(Clone)]
struct ServerCtx {
    app: AppHandle,
    conns: Arc<StdMutex<Vec<ConnMeta>>>,
    allow_open_window: Arc<AtomicBool>,
    sessions: Arc<StdMutex<HashMap<String, UnboundedSender<String>>>>,
}

fn gen_session_id() -> String {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}-{n:x}")
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---- accept loop ----

async fn serve(listener: TcpListener, ctx: ServerCtx, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            accept = listener.accept() => match accept {
                Ok((stream, _)) => {
                    let c = ctx.clone();
                    tokio::spawn(handle_conn(stream, c));
                }
                Err(_) => break,
            },
        }
    }
}

async fn handle_conn(mut stream: TcpStream, ctx: ServerCtx) {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];

    // Read until the end of the HTTP headers.
    let header_end = loop {
        match stream.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    break pos;
                }
                if buf.len() > 64 * 1024 {
                    return; // header too large
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

    // Body: whatever followed the header terminator, plus any remaining bytes.
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }

    match (method.as_str(), path.as_str()) {
        ("OPTIONS", _) => {
            let _ = write_simple(&mut stream, 204, "No Content", "", "").await;
        }
        ("GET", "/sse") | ("GET", "/") => handle_sse(stream, ctx).await,
        ("POST", "/messages") | ("POST", "/message") => {
            handle_message(&mut stream, &ctx, &query, &body).await
        }
        ("GET", "/health") => {
            let _ = write_simple(&mut stream, 200, "OK", "application/json", "{\"ok\":true}").await;
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

async fn handle_sse(mut stream: TcpStream, ctx: ServerCtx) {
    let session_id = gen_session_id();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    ctx.sessions.lock().unwrap().insert(session_id.clone(), tx);

    let headers = "HTTP/1.1 200 OK\r\n\
        Content-Type: text/event-stream\r\n\
        Cache-Control: no-cache\r\n\
        Connection: keep-alive\r\n\
        Access-Control-Allow-Origin: *\r\n\r\n";
    if stream.write_all(headers.as_bytes()).await.is_err() {
        ctx.sessions.lock().unwrap().remove(&session_id);
        return;
    }

    // Advertise the POST endpoint for this session (MCP HTTP+SSE handshake).
    let endpoint = format!("event: endpoint\r\ndata: /messages?sessionId={session_id}\r\n\r\n");
    let _ = stream.write_all(endpoint.as_bytes()).await;
    let _ = stream.flush().await;

    let mut ping = tokio::time::interval(std::time::Duration::from_secs(25));
    ping.tick().await; // consume the immediate first tick

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

async fn handle_message(stream: &mut TcpStream, ctx: &ServerCtx, query: &str, body: &[u8]) {
    let session_id = query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == "sessionId" { Some(v.to_string()) } else { None }
    });

    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            let _ = write_simple(stream, 400, "Bad Request", "text/plain", &format!("invalid json: {e}")).await;
            return;
        }
    };

    let resp = dispatch(ctx, &req).await;
    // The JSON-RPC response is delivered over the SSE stream; ack the POST.
    let _ = write_simple(stream, 202, "Accepted", "text/plain", "").await;

    if let (Some(sid), Some(resp)) = (session_id, resp) {
        let line = serde_json::to_string(&resp).unwrap_or_default();
        if let Some(tx) = ctx.sessions.lock().unwrap().get(&sid) {
            let _ = tx.send(line);
        }
    }
}

// ---- JSON-RPC dispatch ----

async fn dispatch(ctx: &ServerCtx, req: &Value) -> Option<Value> {
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
        "tools/list" => id.map(|id| {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_list() } })
        }),
        "tools/call" => {
            let id = id?;
            let (text, is_error) = match call_tool(ctx, &params).await {
                Ok(t) => (t, false),
                Err(t) => (t, true),
            };
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

fn tools_list() -> Value {
    json!([
        {
            "name": "list_connections",
            "description": "List the database connections currently active in Catio (name, engine, id).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_tables",
            "description": "List tables in a connected database. Pass the connection name (or id) from list_connections; optionally a schema.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "schema": { "type": "string", "description": "Schema name (optional; defaults to the first schema)" }
                },
                "required": ["connection"]
            }
        },
        {
            "name": "run_sql",
            "description": "Execute a SQL statement against a connected database and return the result rows.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "SQL to execute" },
                    "maxRows": { "type": "number", "description": "Row cap (default 200)" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "open_table",
            "description": "Open a table in the Catio UI for the given connection (requires the open-window permission).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "table": { "type": "string", "description": "Table name" },
                    "schema": { "type": "string", "description": "Schema name (optional)" }
                },
                "required": ["connection", "table"]
            }
        }
    ])
}

async fn call_tool(ctx: &ServerCtx, params: &Value) -> Result<String, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match name {
        "list_connections" => Ok(tool_list_connections(ctx)),
        "list_tables" => tool_list_tables(ctx, &args).await,
        "run_sql" => tool_run_sql(ctx, &args).await,
        "open_table" => tool_open_table(ctx, &args),
        other => Err(format!("unknown tool: {other}")),
    }
}

fn resolve_conn_id(ctx: &ServerCtx, key: &str) -> Option<String> {
    let conns = ctx.conns.lock().unwrap();
    conns
        .iter()
        .find(|c| c.name == key || c.conn_id == key)
        .map(|c| c.conn_id.clone())
}

fn tool_list_connections(ctx: &ServerCtx) -> String {
    let conns = ctx.conns.lock().unwrap();
    let arr: Vec<Value> = conns
        .iter()
        .map(|c| json!({ "name": c.name, "connId": c.conn_id, "dbType": c.db_type }))
        .collect();
    serde_json::to_string_pretty(&json!({ "connections": arr })).unwrap_or_default()
}

async fn driver_for(
    ctx: &ServerCtx,
    conn: &str,
) -> Result<std::sync::Arc<dyn crate::db::driver::Driver>, String> {
    let conn_id = resolve_conn_id(ctx, conn).ok_or_else(|| format!("connection not found: {conn}"))?;
    ctx.app
        .state::<crate::db::manager::ConnManager>()
        .get(&conn_id)
        .await
        .ok_or_else(|| format!("no active connection: {conn}"))
}

async fn tool_list_tables(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let conn = args.get("connection").and_then(Value::as_str).ok_or("missing 'connection'")?;
    let driver = driver_for(ctx, conn).await?;
    let schema = match args.get("schema").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => driver
            .list_schemas()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .unwrap_or_default(),
    };
    let tables = driver.list_tables(&schema).await.map_err(|e| e.to_string())?;
    let arr: Vec<Value> = tables
        .iter()
        .map(|t| json!({ "name": t.name, "kind": t.kind, "rowsEstimate": t.rows_estimate }))
        .collect();
    Ok(serde_json::to_string_pretty(&json!({ "schema": schema, "tables": arr })).unwrap_or_default())
}

async fn tool_run_sql(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let conn = args.get("connection").and_then(Value::as_str).ok_or("missing 'connection'")?;
    let sql = args.get("sql").and_then(Value::as_str).ok_or("missing 'sql'")?;
    let max_rows = args.get("maxRows").and_then(Value::as_u64).unwrap_or(200) as u32;
    let driver = driver_for(ctx, conn).await?;
    let res = driver.query(sql, max_rows).await.map_err(|e| e.to_string())?;
    let cols: Vec<&str> = res.columns.iter().map(|c| c.name.as_str()).collect();
    let out = json!({
        "columns": cols,
        "rows": res.rows,
        "rowsAffected": res.rows_affected,
        "truncated": res.truncated,
    });
    Ok(serde_json::to_string_pretty(&out).unwrap_or_default())
}

fn tool_open_table(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    if !ctx.allow_open_window.load(Ordering::Relaxed) {
        return Err("open_table is disabled in Catio settings".into());
    }
    let conn = args.get("connection").and_then(Value::as_str).ok_or("missing 'connection'")?;
    let table = args.get("table").and_then(Value::as_str).ok_or("missing 'table'")?;
    let schema = args.get("schema").and_then(Value::as_str);
    let conn_id = resolve_conn_id(ctx, conn).ok_or_else(|| format!("connection not found: {conn}"))?;
    ctx.app
        .emit("mcp://open-table", json!({ "connId": conn_id, "table": table, "schema": schema }))
        .map_err(|e| e.to_string())?;
    Ok(format!("Opened table '{table}' in Catio."))
}

// ---- Tauri commands ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnMetaWire {
    pub conn_id: String,
    pub name: String,
    pub db_type: String,
}

#[tauri::command]
pub async fn mcp_start(
    app: AppHandle,
    state: State<'_, McpState>,
    allow_open_window: bool,
) -> Result<McpInfo, String> {
    {
        let g = state.running.lock().unwrap();
        if let Some(rs) = g.as_ref() {
            return Ok(McpInfo::running(rs.addr));
        }
    }
    state.allow_open_window.store(allow_open_window, Ordering::Relaxed);

    // Prefer a stable port so the agent config stays valid; fall back to ephemeral.
    let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?,
    };
    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    let (sh_tx, sh_rx) = watch::channel(false);
    let ctx = ServerCtx {
        app: app.clone(),
        conns: state.conns.clone(),
        allow_open_window: state.allow_open_window.clone(),
        sessions: Arc::new(StdMutex::new(HashMap::new())),
    };
    tokio::spawn(serve(listener, ctx, sh_rx));

    *state.running.lock().unwrap() = Some(RunningServer { addr, shutdown: sh_tx });
    Ok(McpInfo::running(addr))
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
        Some(rs) => McpInfo::running(rs.addr),
        None => McpInfo::stopped(),
    }
}

#[tauri::command]
pub fn mcp_set_allow_open_window(state: State<'_, McpState>, allow: bool) {
    state.allow_open_window.store(allow, Ordering::Relaxed);
}

#[tauri::command]
pub fn mcp_sync_connections(state: State<'_, McpState>, conns: Vec<ConnMetaWire>) {
    let mut g = state.conns.lock().unwrap();
    *g = conns
        .into_iter()
        .map(|c| ConnMeta { conn_id: c.conn_id, name: c.name, db_type: c.db_type })
        .collect();
}
