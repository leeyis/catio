//! Server-mode MCP (P3a). Proves the per-user token gate and owner isolation:
//!   * an invalid token is rejected (401) on both /mcp routes,
//!   * a disabled token is rejected (401) without rotating it,
//!   * user A's token, driving `list_connections` over the SSE round-trip, sees ONLY A's own live
//!     connection — never user B's (the owner-scope data gate, distinct from the cookie gate).
//!
//! The SSE stream is read over a raw TCP socket (the dev `reqwest` has no `stream` feature); the
//! cookie-gated `/api/invoke` calls go through `reqwest` as in the other server tests.

use std::net::SocketAddr;
use std::sync::Mutex;

use catio_lib::server::{build_router, AppState};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// `AppState::new` reads process-global env (`CATIO_MCP_IP_ALLOWLIST`, `CATIO_TRUST_PROXY`). The
/// allowlist test sets+clears those vars around one construction; this lock serializes every
/// `AppState::new` in this (single) test binary so a concurrent `start()` can't observe them.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Bind + serve an already-built state on an ephemeral loopback port. No `into_make_service_with_
/// connect_info`, so handlers see `Option<ConnectInfo<_>> == None` (matches the production test seam).
async fn serve_state(state: AppState) -> (String, SocketAddr) {
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let bound = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap(); });
    (format!("http://{bound}"), bound)
}

async fn start() -> (String, SocketAddr) {
    let tmp = tempfile::tempdir().unwrap();
    let state = {
        let _g = ENV_LOCK.lock().unwrap();
        AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).unwrap()
    };
    std::mem::forget(tmp);
    serve_state(state).await
}

/// Build a server whose `/mcp` routes are IP-gated by `allowlist` with `CATIO_TRUST_PROXY=1` (so the
/// client IP is taken from `X-Forwarded-For`, since the loopback peer would otherwise always pass).
/// The env is set+read+cleared under `ENV_LOCK` so it never leaks into another test's state.
async fn start_with_allowlist(allowlist: &str) -> (String, SocketAddr) {
    let tmp = tempfile::tempdir().unwrap();
    let state = {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("CATIO_MCP_IP_ALLOWLIST", allowlist);
        std::env::set_var("CATIO_TRUST_PROXY", "1");
        let s = AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).unwrap();
        std::env::remove_var("CATIO_MCP_IP_ALLOWLIST");
        std::env::remove_var("CATIO_TRUST_PROXY");
        s
    };
    std::mem::forget(tmp);
    serve_state(state).await
}

fn jar() -> reqwest::Client {
    reqwest::Client::builder().cookie_store(true).build().unwrap()
}

async fn invoke(cl: &reqwest::Client, base: &str, cmd: &str, args: Value) -> (u16, Value) {
    let res = cl.post(format!("{base}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args })).send().await.unwrap();
    let st = res.status().as_u16();
    (st, res.json::<Value>().await.unwrap_or(Value::Null))
}

/// Pull the `data:` payload of the first `event: <kind>` SSE frame out of the accumulated buffer.
/// SSE bodies use `\n` line endings and terminate an event with a blank line; the surrounding
/// chunked-transfer framing is harmless to this substring scan (one event per write).
fn parse_sse(buf: &str, kind: &str) -> Option<String> {
    let needle = format!("event: {kind}\ndata: ");
    let start = buf.find(&needle)? + needle.len();
    let rest = &buf[start..];
    let end = rest.find("\n\n")?;
    Some(rest[..end].to_string())
}

/// Open `GET /mcp/sse?token=` over raw TCP and return the live stream + the advertised endpoint
/// path (carries `sessionId` and the echoed token).
async fn open_sse(addr: &SocketAddr, token: &str) -> (TcpStream, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /mcp/sse?token={token} HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "SSE stream closed before the endpoint event");
        buf.extend_from_slice(&tmp[..n]);
        let s = String::from_utf8_lossy(&buf);
        // A 401 (invalid/disabled token) shows up as the status line, not an endpoint event.
        assert!(!s.starts_with("HTTP/1.1 401"), "expected an authorized SSE stream, got 401");
        if let Some(ep) = parse_sse(&s, "endpoint") {
            return (stream, ep);
        }
    }
}

/// Read the next `event: message` frame off an open SSE stream and parse it as JSON-RPC.
async fn read_message(stream: &mut TcpStream) -> Value {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "SSE stream closed before the JSON-RPC reply");
        buf.extend_from_slice(&tmp[..n]);
        if let Some(data) = parse_sse(&String::from_utf8_lossy(&buf), "message") {
            return serde_json::from_str(&data).expect("JSON-RPC reply must be valid JSON");
        }
    }
}

/// Run one `tools/call` over the SSE round-trip (open SSE → POST → read the reply) and return the
/// tool's text output parsed as JSON.
async fn mcp_tool_call(base: &str, addr: &SocketAddr, token: &str, tool: &str, arguments: Value) -> Value {
    let (mut stream, endpoint) = open_sse(addr, token).await;
    let res = reqwest::Client::new()
        .post(format!("{base}{endpoint}"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": arguments } }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 202, "/mcp/messages must 202-accept");
    let reply = read_message(&mut stream).await;
    let text = reply["result"]["content"][0]["text"].as_str().expect("tool text output");
    serde_json::from_str(text).expect("tool output must be JSON")
}

#[tokio::test]
async fn invalid_token_is_rejected_on_both_routes() {
    let (base, _addr) = start().await;
    let cl = reqwest::Client::new();

    // No tokens exist yet → any token is invalid → 401 on the SSE route.
    let res = cl.get(format!("{base}/mcp/sse?token=deadbeef")).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 401);

    // …and 401 on the messages route (token is the primary gate, before any dispatch).
    let res = cl.post(format!("{base}/mcp/messages?token=deadbeef&sessionId=x"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 401);
}

#[tokio::test]
async fn disabled_token_is_rejected() {
    let (base, _addr) = start().await;
    let admin = jar();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;

    // Mint a token, then disable it WITHOUT rotating.
    let (_, tok) = invoke(&admin, &base, "mcp_token_get", json!({})).await;
    let token = tok["token"].as_str().unwrap().to_string();
    let (_, dis) = invoke(&admin, &base, "mcp_token_set_enabled", json!({ "enabled": false })).await;
    assert_eq!(dis["enabled"], false);

    // The token value is unchanged, but the disabled flag makes the SSE route 401.
    let res = reqwest::Client::new().get(format!("{base}/mcp/sse?token={token}")).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 401);

    // Re-enabling restores access (token still resolves to the same secret).
    invoke(&admin, &base, "mcp_token_set_enabled", json!({ "enabled": true })).await;
    let (_, tok2) = invoke(&admin, &base, "mcp_token_get", json!({})).await;
    assert_eq!(tok2["token"].as_str().unwrap(), token, "set_enabled must not rotate the token");
}

#[tokio::test]
async fn token_list_connections_sees_only_its_own_owner() {
    let (base, addr) = start().await;
    let admin = jar();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    invoke(&admin, &base, "user_create", json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;
    let bob = jar();
    invoke(&bob, &base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;

    // admin opens a SQLite :memory connection (owned by admin), passing the display name sibling.
    let sqlite = json!({ "dbType": "sqlite", "host": ":memory:", "port": 0, "user": "", "ssl": false });
    let (st, body) = invoke(&admin, &base, "db_connect", json!({ "args": sqlite, "name": "admin-db" })).await;
    assert_eq!(st, 200, "{body}");

    // bob opens his OWN connection.
    let (st, body) = invoke(&bob, &base, "db_connect", json!({ "args": sqlite, "name": "bob-db" })).await;
    assert_eq!(st, 200, "{body}");
    let bob_conn = body["connId"].as_str().unwrap().to_string();

    // bob's MCP token drives list_connections over SSE → sees ONLY bob's connection.
    let (_, tok) = invoke(&bob, &base, "mcp_token_get", json!({})).await;
    let bob_token = tok["token"].as_str().unwrap().to_string();
    let out = mcp_tool_call(&base, &addr, &bob_token, "list_connections", json!({})).await;
    let conns = out["connections"].as_array().unwrap();
    assert_eq!(conns.len(), 1, "bob must see only his own connection: {out}");
    assert_eq!(conns[0]["connId"], bob_conn);
    assert_eq!(conns[0]["name"], "bob-db", "the captured display name is rendered");
    assert!(conns.iter().all(|c| c["name"] != "admin-db"), "bob must NOT see admin's connection: {out}");

    // And bob can't reach admin's connection by name OR id: resolve_db is owner-scoped, so the tool
    // errors out (the reply's isError=true → the text isn't valid JSON, so the call would panic the
    // helper — assert via a direct round-trip instead).
    let (mut stream, endpoint) = open_sse(&addr, &bob_token).await;
    let res = reqwest::Client::new()
        .post(format!("{base}{endpoint}"))
        .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                       "params": { "name": "list_schemas", "arguments": { "connection": "admin-db" } } }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 202);
    let reply = read_message(&mut stream).await;
    assert_eq!(reply["result"]["isError"], true, "reaching admin-db must be an error for bob: {reply}");
    let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.contains("not found"), "owner-scope denial: {text}");
}

/// `GET /mcp/sse` status with a given token + `X-Forwarded-For` (the gate's client IP under
/// `CATIO_TRUST_PROXY`). reqwest resolves once the response head arrives, so a 200 SSE stream
/// doesn't block — we read only the status and drop the connection.
async fn sse_status(base: &str, token: &str, xff: &str) -> u16 {
    reqwest::Client::new()
        .get(format!("{base}/mcp/sse?token={token}"))
        .header("X-Forwarded-For", xff)
        .send().await.unwrap().status().as_u16()
}

/// `POST /mcp/messages` status with a given token + `X-Forwarded-For`.
async fn msg_status(base: &str, token: &str, xff: &str) -> u16 {
    reqwest::Client::new()
        .post(format!("{base}/mcp/messages?token={token}&sessionId=x"))
        .header("X-Forwarded-For", xff)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap().status().as_u16()
}

#[tokio::test]
async fn ip_allowlist_blocks_off_list_even_with_valid_token() {
    let (base, _addr) = start_with_allowlist("10.0.0.0/8").await;
    let admin = jar();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    let (_, tok) = invoke(&admin, &base, "mcp_token_get", json!({})).await;
    let token = tok["token"].as_str().unwrap().to_string();

    // In-range XFF + valid token → allowed on both routes (SSE 200 / messages 202).
    assert_eq!(sse_status(&base, &token, "10.1.2.3").await, 200, "in-range IP must pass the gate");
    assert_eq!(msg_status(&base, &token, "10.1.2.3").await, 202, "in-range IP must reach dispatch");

    // Out-of-range XFF with the SAME valid token → 403: the IP gate is additive to the token, so a
    // correct token off the allowlist is still refused.
    assert_eq!(sse_status(&base, &token, "203.0.113.7").await, 403, "off-list IP must be 403 even with a valid token");
    assert_eq!(msg_status(&base, &token, "203.0.113.7").await, 403, "off-list IP must be 403 even with a valid token");

    // The token stays the primary gate: an invalid token is 401 BEFORE the IP gate, even in-range.
    assert_eq!(sse_status(&base, "deadbeef", "10.1.2.3").await, 401, "bad token is 401 regardless of IP");
}

// TODO(P3b): a WS-level test (tokio-tungstenite) that a non-admin's `sub` to `mcp-log://all` or
// another user's id is rejected while their OWN `mcp-log://<id>` receives entries, exercising the
// handle_ws sub-authorization end-to-end. Owner isolation is covered above at the route/token layer;
// the sub gate is unit-reasoned from `resolve_session` + `is_admin`.
