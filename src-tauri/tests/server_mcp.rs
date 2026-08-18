//! Server-mode MCP。传输是 Streamable HTTP（单 endpoint `POST /mcp`，响应即 JSON）。
//! 覆盖 per-user token 闸门与 owner 隔离：
//!   * 无效 token → 401；
//!   * 被禁用的 token → 401，且不轮换 token 值；
//!   * 用户 A 的 token 跑 `list_connections` 只看得到 A 自己的活动连接，绝不含 B 的
//!     （owner-scope 数据闸门，与 cookie 闸门相互独立）。
//!
//! cookie 闸门下的 `/api/invoke` 调用照其它 server 测试的惯例走 `reqwest`。

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

#[tokio::test]
async fn invalid_token_is_rejected() {
    let (base, _addr) = start().await;
    // 还没有任何 token → 任何值都无效 → 401，且发生在 dispatch 之前。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token=deadbeef"))
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

    // token 值没变，但 disabled 标志让端点 401。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap();
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

    // bob 的 token 跑 list_connections → 只看得到 bob 自己的连接。
    let (_, tok) = invoke(&bob, &base, "mcp_token_get", json!({})).await;
    let bob_token = tok["token"].as_str().unwrap().to_string();
    let out = mcp_tool_call(&base, &bob_token, "list_connections", json!({})).await;
    let conns = out["connections"].as_array().unwrap();
    assert_eq!(conns.len(), 1, "bob must see only his own connection: {out}");
    assert_eq!(conns[0]["connId"], bob_conn);
    assert_eq!(conns[0]["name"], "bob-db", "the captured display name is rendered");
    assert!(conns.iter().all(|c| c["name"] != "admin-db"), "bob must NOT see admin's connection: {out}");

    // bob 也不能按名字或 id 触到 admin 的连接：resolve_db 是 owner-scoped，工具直接报错
    // （isError=true 时 text 不是合法 JSON，故不走 mcp_tool_call 而直接断言原始响应）。
    let (st, reply) = post_mcp(&base, &bob_token, json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "list_schemas", "arguments": { "connection": "admin-db" } }
    })).await;
    assert_eq!(st, 200);
    assert_eq!(reply["result"]["isError"], true, "bob 触碰 admin-db 必须报错: {reply}");
    let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.contains("not found"), "owner-scope denial: {text}");
}

/// `POST /mcp` 的状态码，带指定 token 与 `X-Forwarded-For`（`CATIO_TRUST_PROXY` 下
/// 闸门据此取客户端 IP）。
async fn mcp_status(base: &str, token: &str, xff: &str) -> u16 {
    reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
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

    // 白名单内的 XFF + 有效 token → 放行（能走到 dispatch，回 200）。
    assert_eq!(mcp_status(&base, &token, "10.1.2.3").await, 200, "名单内 IP 应通过闸门");

    // 同一个有效 token，但 IP 在名单外 → 403：IP 闸门叠加在 token 之上。
    assert_eq!(mcp_status(&base, &token, "203.0.113.7").await, 403, "名单外 IP 即便 token 有效也必须 403");

    // token 仍是首要闸门：无效 token 在 IP 闸门之前就 401，哪怕 IP 在名单内。
    assert_eq!(mcp_status(&base, "deadbeef", "10.1.2.3").await, 401, "坏 token 与 IP 无关，一律 401");
}

// TODO(P3b): a WS-level test (tokio-tungstenite) that a non-admin's `sub` to `mcp-log://all` or
// another user's id is rejected while their OWN `mcp-log://<id>` receives entries, exercising the
// handle_ws sub-authorization end-to-end. Owner isolation is covered above at the route/token layer;
// the sub gate is unit-reasoned from `resolve_session` + `is_admin`.

// ─── Streamable HTTP 传输语义 ─────────────────────────────────────────────────
//
// 一次 POST 直接拿到 JSON-RPC 响应体：无需先建流、无需 sessionId，服务端也不必
// 为此维持 per-session 任务与心跳。

/// 在 `POST /mcp` 上跑一条 JSON-RPC 请求，返回 (status, body)。
async fn post_mcp(base: &str, token: &str, req: Value) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
        .header("Accept", "application/json, text/event-stream")
        .json(&req)
        .send().await.unwrap();
    let st = res.status().as_u16();
    (st, res.json::<Value>().await.unwrap_or(Value::Null))
}

/// 跑一条 `tools/call` 并把工具的文本输出按 JSON 解析（仅用于成功路径）。
async fn mcp_tool_call(base: &str, token: &str, tool: &str, arguments: Value) -> Value {
    let (st, reply) = post_mcp(base, token, json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": tool, "arguments": arguments }
    })).await;
    assert_eq!(st, 200, "tools/call 必须回 200: {reply}");
    let text = reply["result"]["content"][0]["text"].as_str().expect("tool text output");
    serde_json::from_str(text).expect("tool output must be JSON")
}

async fn admin_token(base: &str) -> String {
    let admin = jar();
    invoke(&admin, base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    let (_, tok) = invoke(&admin, base, "mcp_token_get", json!({})).await;
    tok["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn streamable_post_returns_a_json_response_body() {
    let (base, _addr) = start().await;
    let token = admin_token(&base).await;

    // 关键：没有 sessionId、不建流，响应直接在这个 POST 的 body 里。
    let (st, body) = post_mcp(&base, &token, json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list"
    })).await;
    assert_eq!(st, 200, "Streamable HTTP 必须用 200+JSON 回应: {body}");
    assert_eq!(body["jsonrpc"], "2.0");
    assert_eq!(body["id"], 1);
    let tools = body["result"]["tools"].as_array().expect("tools 数组");
    assert!(tools.iter().any(|t| t["name"] == "execute_command"), "工具目录须完整");
}

#[tokio::test]
async fn streamable_initialize_echoes_the_clients_protocol_version() {
    let (base, _addr) = start().await;
    let token = admin_token(&base).await;

    // 客户端声明受支持的版本 → 原样回它，否则握手对不上。
    for v in ["2025-03-26", "2025-06-18", "2026-07-28"] {
        let (st, body) = post_mcp(&base, &token, json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": v, "capabilities": {} }
        })).await;
        assert_eq!(st, 200);
        assert_eq!(body["result"]["protocolVersion"], v, "须回客户端声明的版本");
    }

    // 未声明 → 回落 2025-03-26（spec：缺头时假定该版本）。
    let (_, body) = post_mcp(&base, &token, json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "capabilities": {} }
    })).await;
    assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
}

#[tokio::test]
async fn streamable_notification_gets_202_with_no_body() {
    let (base, _addr) = start().await;
    let token = admin_token(&base).await;

    // 无 id = 通知，spec 要求 202 且无 body。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
        .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 202);
    assert!(res.text().await.unwrap().is_empty(), "通知不得带 body");
}

#[tokio::test]
async fn streamable_rejects_cross_origin_to_stop_dns_rebinding() {
    let (base, _addr) = start().await;
    let token = admin_token(&base).await;

    // 这是本条最重要的断言：带着有效 token 的浏览器跨源请求也必须 403，
    // 否则用户浏览器里的任意页面都能驱动其真实数据库/SSH 会话。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
        .header("Origin", "http://evil.example.com")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 403, "远端 Origin 必须被拒（DNS rebinding 防护）");

    // loopback Origin（本机 UI）仍放行。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token={token}"))
        .header("Origin", "http://localhost:5173")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 200, "loopback Origin 应放行");
}

#[tokio::test]
async fn streamable_keeps_the_token_gate() {
    let (base, _addr) = start().await;
    // 无效 token → 401，且发生在任何 dispatch 之前（与 /mcp/messages 同语义）。
    let res = reqwest::Client::new()
        .post(format!("{base}/mcp?token=deadbeef"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send().await.unwrap();
    assert_eq!(res.status().as_u16(), 401);
}

#[tokio::test]
async fn streamable_get_and_delete_are_405() {
    let (base, _addr) = start().await;
    let token = admin_token(&base).await;
    // 本实现无 server→client 主动请求、无协议级 session；spec 要求这两者 405，
    // 客户端据此不再尝试开流/销毁会话（而非误判成 404「端点不存在」去回退旧传输）。
    let cl = reqwest::Client::new();
    let g = cl.get(format!("{base}/mcp?token={token}")).send().await.unwrap();
    assert_eq!(g.status().as_u16(), 405);
    let d = cl.delete(format!("{base}/mcp?token={token}")).send().await.unwrap();
    assert_eq!(d.status().as_u16(), 405);
}

#[tokio::test]
async fn streamable_accepts_a_chunked_request_body() {
    // Node/undici 等客户端流式发送 body 时用 Transfer-Encoding: chunked（无 Content-Length）。
    // 若服务端不解分块，喂给 serde 的就是带长度前缀的原始字节 → 无故 400。
    // dev 的 reqwest 无 `stream` feature，故手写原始请求——测的正是线上的真实字节。
    let (base, addr) = start().await;
    let token = admin_token(&base).await;

    let payload = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#;
    // 故意切成两块，让分块边界落在 JSON 中间。
    let (a, b) = payload.split_at(20);
    let req = format!(
        "POST /mcp?token={token} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         Accept: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n\
         {:x}\r\n{a}\r\n{:x}\r\n{b}\r\n0\r\n\r\n",
        a.len(),
        b.len(),
    );

    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw);

    assert!(text.starts_with("HTTP/1.1 200"), "chunked body 必须被正确解码，实际响应:\n{text}");
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    // 响应体本身也可能是 chunked，取其中的 JSON 对象。
    let json_start = body.find('{').expect("响应必须含 JSON");
    let json_end = body.rfind('}').expect("响应必须含 JSON");
    let v: Value = serde_json::from_str(&body[json_start..=json_end]).expect("响应必须是合法 JSON");
    assert_eq!(v["id"], 7);
    assert!(v["result"]["tools"].is_array(), "工具目录须与非 chunked 路径一致: {v}");
}
