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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use tauri::{AppHandle, Manager, State};

const PROTOCOL_VERSION: &str = "2024-11-05";
const PREFERRED_PORT: u16 = 8765;
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const LOG_RETENTION_DAYS: i64 = 7;

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
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            running: StdMutex::new(None),
            conns: Arc::new(StdMutex::new(Vec::new())),
            hosts: Arc::new(StdMutex::new(Vec::new())),
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
    fn running(addr: SocketAddr, token: &str) -> Self {
        Self {
            running: true,
            url: Some(format!("http://{addr}/sse?token={token}")),
            port: Some(addr.port()),
        }
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
    hosts: Arc<StdMutex<Vec<HostMeta>>>,
    sessions: Arc<StdMutex<HashMap<String, UnboundedSender<String>>>>,
    token: String,
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
                let _ = write_simple(&mut stream, 401, "Unauthorized", "text/plain", "invalid token").await;
                return;
            }
            handle_sse(stream, ctx, client_ip).await
        }
        ("POST", "/messages") | ("POST", "/message") => {
            if !token_ok {
                log_event("denied", &client_ip, &json!({ "path": path }));
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

// ---- JSON-RPC dispatch ----

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
            id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_list() } }))
        }
        "tools/call" => {
            let id = id?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            log_event("tools/call", client_ip, &json!({ "tool": name, "arguments": args }));
            let (text, is_error) = match call_tool(ctx, &name, &args).await {
                Ok(t) => (t, false),
                Err(t) => (t, true),
            };
            log_event("tools/result", client_ip, &json!({ "tool": name, "isError": is_error, "output": text }));
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
            "name": "list_schemas",
            "description": "List databases/schemas available on a connected database. Use the `connection` arg (call list_connections first to get a valid name/id).",
            "inputSchema": {
                "type": "object",
                "properties": { "connection": { "type": "string", "description": "Connection name or id" } },
                "required": ["connection"]
            }
        },
        {
            "name": "list_tables",
            "description": "List tables and views in a connected database. Use the `connection` arg (call list_connections first); optionally pass a `schema` (defaults to the first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "schema": { "type": "string", "description": "Schema name (optional)" }
                },
                "required": ["connection"]
            }
        },
        {
            "name": "get_ddl",
            "description": "Get the DDL / structure of a table or view (columns, types, keys, indexes, foreign keys; or the view source). Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "table": { "type": "string", "description": "Table or view name" },
                    "schema": { "type": "string", "description": "Schema name (optional)" }
                },
                "required": ["connection", "table"]
            }
        },
        {
            "name": "query_sql",
            "description": "Execute a read query (SELECT/SHOW/…) and return rows. Use the `connection` arg (call list_connections first). `maxRows` defaults to 200. SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "Read SQL to execute" },
                    "maxRows": { "type": "number", "description": "Row cap (default 200)" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "insert_sql",
            "description": "Execute an INSERT statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "INSERT statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "update_sql",
            "description": "Execute an UPDATE statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "UPDATE statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "delete_sql",
            "description": "Execute a DELETE statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "DELETE statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "list_hosts",
            "description": "List the SSH host connections currently active in Catio (name, host, session id).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "execute_command",
            "description": "Execute a command on a connected SSH host and return the output. Use the `connectionName` arg (call list_hosts first; defaults to the only active host).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cmdString": { "type": "string", "description": "Command to execute" },
                    "directory": { "type": "string", "description": "Working directory for command execution" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional; defaults to the only active host)" },
                    "timeout": { "type": "number", "description": "Command timeout in milliseconds (optional, default 30000)" }
                },
                "required": ["cmdString"]
            }
        },
        {
            "name": "upload_file",
            "description": "Upload a local file to a connected SSH host. Use the `connectionName` arg (call list_hosts first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "localPath": { "type": "string", "description": "Local path" },
                    "remotePath": { "type": "string", "description": "Remote path" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional)" }
                },
                "required": ["localPath", "remotePath"]
            }
        },
        {
            "name": "download_file",
            "description": "Download a file from a connected SSH host. Use the `connectionName` arg (call list_hosts first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "remotePath": { "type": "string", "description": "Remote path" },
                    "localPath": { "type": "string", "description": "Local path" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional)" }
                },
                "required": ["remotePath", "localPath"]
            }
        }
    ])
}

async fn call_tool(ctx: &ServerCtx, name: &str, args: &Value) -> Result<String, String> {
    match name {
        // ---- database ----
        "list_connections" => Ok(tool_list_connections(ctx)),
        "list_schemas" => tool_list_schemas(ctx, args).await,
        "list_tables" => tool_list_tables(ctx, args).await,
        "get_ddl" => tool_get_ddl(ctx, args).await,
        "query_sql" => tool_query_sql(ctx, args).await,
        "insert_sql" => tool_write_sql(ctx, args, "INSERT").await,
        "update_sql" => tool_write_sql(ctx, args, "UPDATE").await,
        "delete_sql" => tool_write_sql(ctx, args, "DELETE").await,
        // ---- host ----
        "list_hosts" => Ok(tool_list_hosts(ctx)),
        "execute_command" => tool_execute_command(ctx, args).await,
        "upload_file" => tool_upload_file(ctx, args).await,
        "download_file" => tool_download_file(ctx, args).await,
        other => Err(format!("unknown tool: {other}")),
    }
}

// ---- database tools ----

fn resolve_conn_id(ctx: &ServerCtx, key: &str) -> Option<String> {
    let conns = ctx.conns.lock().unwrap();
    conns.iter().find(|c| c.name == key || c.conn_id == key).map(|c| c.conn_id.clone())
}

// Reads the in-memory ctx.conns registry (synced from the frontend via mcp_sync_targets). No driver call.
fn tool_list_connections(ctx: &ServerCtx) -> String {
    let conns = ctx.conns.lock().unwrap();
    let arr: Vec<Value> = conns
        .iter()
        .map(|c| json!({ "name": c.name, "connId": c.conn_id, "dbType": c.db_type }))
        .collect();
    serde_json::to_string_pretty(&json!({ "connections": arr })).unwrap_or_default()
}

async fn driver_for(ctx: &ServerCtx, conn: &str) -> Result<Arc<dyn crate::db::driver::Driver>, String> {
    let conn_id = resolve_conn_id(ctx, conn).ok_or_else(|| format!("connection not found: {conn}"))?;
    ctx.app
        .state::<crate::db::manager::ConnManager>()
        .get(&conn_id)
        .await
        .ok_or_else(|| format!("no active connection: {conn}"))
}

fn conn_arg<'a>(args: &'a Value) -> Result<&'a str, String> {
    args.get("connection").and_then(Value::as_str).ok_or_else(|| "missing 'connection'".to_string())
}

async fn first_schema(driver: &Arc<dyn crate::db::driver::Driver>, args: &Value) -> Result<String, String> {
    match args.get("schema").and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => Ok(driver
            .list_schemas()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .unwrap_or_default()),
    }
}

// → driver.list_schemas(). All engines (non-SQL return their database/keyspace list).
async fn tool_list_schemas(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let driver = driver_for(ctx, conn_arg(args)?).await?;
    let schemas = driver.list_schemas().await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({ "schemas": schemas })).unwrap_or_default())
}

// → driver.list_tables(schema); schema defaults to the first via first_schema().
//   All engines (non-SQL return collections/indices/keyspaces).
async fn tool_list_tables(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let driver = driver_for(ctx, conn_arg(args)?).await?;
    let schema = first_schema(&driver, args).await?;
    let tables = driver.list_tables(&schema).await.map_err(|e| e.to_string())?;
    let arr: Vec<Value> = tables
        .iter()
        .map(|t| json!({ "name": t.name, "kind": t.kind, "rowsEstimate": t.rows_estimate }))
        .collect();
    Ok(serde_json::to_string_pretty(&json!({ "schema": schema, "tables": arr })).unwrap_or_default())
}

// → heuristic: driver.object_source(schema, table, "view") (empty string when the
//   engine has no DDL introspection, never errors), else driver.table_structure().
//   SQL engines only — MongoDB/Redis/Elasticsearch have no DDL/view concept.
async fn tool_get_ddl(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let driver = driver_for(ctx, conn_arg(args)?).await?;
    if matches!(driver.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Redis | crate::db::DatabaseType::Elasticsearch) {
        return Err("get_ddl 仅支持 SQL 引擎".into());
    }
    let table = args.get("table").and_then(Value::as_str).ok_or("missing 'table'")?;
    let schema = first_schema(&driver, args).await?;
    // View-detection heuristic: a non-empty object_source(…, "view") means it's a view;
    // object_source returns "" for engines/objects without source, so stored procedures
    // and functions fall through to the table-structure branch below (known limitation).
    if let Ok(src) = driver.object_source(&schema, table, "view").await {
        if !src.trim().is_empty() {
            return Ok(serde_json::to_string_pretty(&json!({ "schema": schema, "name": table, "kind": "view", "ddl": src })).unwrap_or_default());
        }
    }
    let st = driver.table_structure(&schema, table).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({
        "schema": schema, "name": table, "kind": "table",
        "columns": st.columns, "indexes": st.indexes, "foreignKeys": st.fks
    })).unwrap_or_default())
}

// → driver.query(sql, maxRows) (maxRows default 200). SQL engines only —
//   guarded against MongoDB/Redis/Elasticsearch (no raw-SQL query path).
async fn tool_query_sql(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let sql = args.get("sql").and_then(Value::as_str).ok_or("missing 'sql'")?;
    let max_rows = args.get("maxRows").and_then(Value::as_u64).unwrap_or(200) as u32;
    let driver = driver_for(ctx, conn_arg(args)?).await?;
    if matches!(driver.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Redis | crate::db::DatabaseType::Elasticsearch) {
        return Err("query_sql 仅支持 SQL 引擎".into());
    }
    let res = driver.query(sql, max_rows).await.map_err(|e| e.to_string())?;
    let cols: Vec<&str> = res.columns.iter().map(|c| c.name.as_str()).collect();
    Ok(serde_json::to_string_pretty(&json!({
        "columns": cols, "rows": res.rows, "rowsAffected": res.rows_affected, "truncated": res.truncated
    })).unwrap_or_default())
}

// insert_sql / update_sql / delete_sql → keyword-checks the first token, then
// driver.query(sql, 0); returns rowsAffected. Guarded: read-only engine
// (capabilities().writable) + non-SQL engines (MongoDB/Redis/Elasticsearch) rejected —
// Redis edits go through web head's db_redis_edit, not SQL DML.
async fn tool_write_sql(ctx: &ServerCtx, args: &Value, keyword: &str) -> Result<String, String> {
    let sql = args.get("sql").and_then(Value::as_str).ok_or("missing 'sql'")?;
    let first = sql.trim_start().split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    if first != keyword {
        return Err(format!("this tool only runs {keyword} statements (got '{first}')"));
    }
    let driver = driver_for(ctx, conn_arg(args)?).await?;
    if !driver.capabilities().writable {
        return Err("read-only engine".into());
    }
    if matches!(driver.db_type(), crate::db::DatabaseType::Mongodb | crate::db::DatabaseType::Redis | crate::db::DatabaseType::Elasticsearch) {
        return Err("editing via SQL DML is not supported for this engine".into());
    }
    let res = driver.query(sql, 0).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({ "rowsAffected": res.rows_affected })).unwrap_or_default())
}

// ---- host tools ----

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn resolve_host(ctx: &ServerCtx, name: Option<&str>) -> Result<String, String> {
    let hosts = ctx.hosts.lock().unwrap();
    match name {
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

// Reads the in-memory ctx.hosts registry (synced via mcp_sync_targets). No SSH call.
fn tool_list_hosts(ctx: &ServerCtx) -> String {
    let hosts = ctx.hosts.lock().unwrap();
    let arr: Vec<Value> = hosts
        .iter()
        .map(|h| json!({ "name": h.name, "host": h.host, "sessionId": h.session_id }))
        .collect();
    serde_json::to_string_pretty(&json!({ "hosts": arr })).unwrap_or_default()
}

// → ssh::multiexec::run_on; optional `directory` runs as `cd <dir> && <cmd>`;
//   `timeout` default 30000ms; host picked via `connectionName` (defaults to sole active host).
async fn tool_execute_command(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let cmd = args.get("cmdString").and_then(Value::as_str).ok_or("missing 'cmdString'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let directory = args.get("directory").and_then(Value::as_str);
    let timeout_ms = args.get("timeout").and_then(Value::as_u64).unwrap_or(30_000);
    let sid = resolve_host(ctx, conn)?;
    let sess = ctx
        .app
        .state::<crate::ssh::manager::SessionManager>()
        .get(&sid)
        .await
        .ok_or_else(|| format!("session not found: {sid}"))?;
    let full = match directory {
        Some(d) if !d.is_empty() => format!("cd {} && {}", shell_quote(d), cmd),
        _ => cmd.to_string(),
    };
    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), crate::ssh::multiexec::run_on(sess, &full))
        .await
        .map_err(|_| "command timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// → ssh::sftp::upload_blocking. Host picked via `connectionName` (defaults to sole active host).
async fn tool_upload_file(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let local = args.get("localPath").and_then(Value::as_str).ok_or("missing 'localPath'")?;
    let remote = args.get("remotePath").and_then(Value::as_str).ok_or("missing 'remotePath'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let sid = resolve_host(ctx, conn)?;
    let mgr = ctx.app.state::<crate::ssh::manager::SessionManager>();
    let n = crate::ssh::sftp::upload_blocking(mgr.inner(), &sid, local, remote, &ctx.app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Uploaded {n} bytes to {remote}"))
}

// → ssh::sftp::download_blocking. Host picked via `connectionName` (defaults to sole active host).
async fn tool_download_file(ctx: &ServerCtx, args: &Value) -> Result<String, String> {
    let remote = args.get("remotePath").and_then(Value::as_str).ok_or("missing 'remotePath'")?;
    let local = args.get("localPath").and_then(Value::as_str).ok_or("missing 'localPath'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let sid = resolve_host(ctx, conn)?;
    let mgr = ctx.app.state::<crate::ssh::manager::SessionManager>();
    let n = crate::ssh::sftp::download_blocking(mgr.inner(), &sid, remote, local, &ctx.app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Downloaded {n} bytes to {local}"))
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

    let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?,
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
