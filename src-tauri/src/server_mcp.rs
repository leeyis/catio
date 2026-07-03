//! Server-head MCP (P3a) — per-user, token-authenticated MCP over axum.
//!
//! Unlike the desktop head (hand-rolled HTTP+SSE on 127.0.0.1, single user), the server head is
//! multi-user: every user owns a personal token (`auth.rs` `mcp_tokens`). The two routes
//! (`GET /mcp/sse`, `POST /mcp/messages`) self-authenticate on `?token=` (NO session cookie —
//! external agents send none) and bypass the `/api/invoke` cookie gate entirely.
//!
//! OWNER ISOLATION: the token identifies exactly ONE user, so [`ServerTargets`] resolves STRICTLY
//! that user's OWNED connections/sessions — NOT admin-sees-all. Even an admin's MCP token only
//! reaches the admin's own resources (the `is_admin` bypass used by `/api/invoke` deliberately
//! does NOT apply here). A crafted/guessed id outside the owned set resolves to None/Err.
//!
//! The tools are the shared [`crate::mcp::core`] implementation; this module only adds the
//! transport: an SSE session table (sessionId → sender) + a small JSON-RPC envelope. P3b adds a
//! realtime log streamed over the WS hub (`mcp-log://<user_id>` + `mcp-log://all`, gated on
//! `has_subscriber`), a [`WsSink`] that remaps SFTP progress onto it, and an optional network-layer
//! IP allowlist (`CATIO_MCP_IP_ALLOWLIST`) on the two routes. Still no file logging (spec §7 YAGNI).

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::events::EventSink;
use crate::mcp::core::{self, ConnEntry, HostEntry, McpTargets};
use crate::netmatch::ip_allowed;
use crate::server::AppState;
use crate::server_ws::WsHub;

const PROTOCOL_VERSION: &str = "2024-11-05";

// ---- server visible set: STRICTLY the calling user's OWNED resources ----

/// Server identity / visible-set. Borrows the four `AppState` maps and filters them to
/// `owner == user_id`. Resolution (`resolve_db`/`resolve_host`) only ever returns an id inside
/// that owned set, so a crafted id can't reach another user's connection.
pub struct ServerTargets<'a> {
    pub user_id: i64,
    pub conn_owners: &'a Mutex<HashMap<String, i64>>,
    pub ssh_owners: &'a Mutex<HashMap<String, i64>>,
    /// connId → (name, dbType)
    pub conn_meta: &'a Mutex<HashMap<String, (String, String)>>,
    /// sessionId → (name, host)
    pub ssh_meta: &'a Mutex<HashMap<String, (String, String)>>,
}

impl McpTargets for ServerTargets<'_> {
    fn list_connections(&self) -> Vec<ConnEntry> {
        let owners = self.conn_owners.lock().unwrap();
        let meta = self.conn_meta.lock().unwrap();
        owners
            .iter()
            .filter(|(_, &owner)| owner == self.user_id)
            .map(|(id, _)| {
                let (name, db_type) = meta.get(id).cloned().unwrap_or_else(|| (id.clone(), String::new()));
                ConnEntry { conn_id: id.clone(), name, db_type }
            })
            .collect()
    }

    fn resolve_db(&self, key: &str) -> Option<String> {
        let owners = self.conn_owners.lock().unwrap();
        let meta = self.conn_meta.lock().unwrap();
        owners
            .iter()
            .filter(|(_, &owner)| owner == self.user_id)
            .find(|(id, _)| id.as_str() == key || meta.get(*id).map(|(n, _)| n.as_str()) == Some(key))
            .map(|(id, _)| id.clone())
    }

    fn list_hosts(&self) -> Vec<HostEntry> {
        let owners = self.ssh_owners.lock().unwrap();
        let meta = self.ssh_meta.lock().unwrap();
        owners
            .iter()
            .filter(|(_, &owner)| owner == self.user_id)
            .map(|(id, _)| {
                let (name, host) = meta.get(id).cloned().unwrap_or_else(|| (id.clone(), String::new()));
                HostEntry { session_id: id.clone(), name, host }
            })
            .collect()
    }

    fn resolve_host(&self, key: Option<&str>) -> Result<String, String> {
        let owners = self.ssh_owners.lock().unwrap();
        let meta = self.ssh_meta.lock().unwrap();
        let owned: Vec<String> = owners
            .iter()
            .filter(|(_, &owner)| owner == self.user_id)
            .map(|(id, _)| id.clone())
            .collect();
        match key {
            Some(n) if !n.is_empty() && n != "default" => owned
                .into_iter()
                .find(|id| id.as_str() == n || meta.get(id).map(|(name, _)| name.as_str()) == Some(n))
                .ok_or_else(|| format!("host not found: {n}")),
            _ => {
                if owned.len() == 1 {
                    Ok(owned[0].clone())
                } else if owned.is_empty() {
                    Err("no active SSH host connections".into())
                } else {
                    Err("multiple hosts active; specify connectionName".into())
                }
            }
        }
    }
}

/// Server-mode progress sink (P3b): remaps the core's `transfer-progress-{id}` events onto the
/// owning user's realtime-log stream. The shared SFTP core calls `emit("transfer-progress-{id}",
/// TransferProgress)`; instead of forwarding that raw topic, this builds a `kind:"transfer"`
/// [`McpLogEntry`] and DUAL-EMITs it to `mcp-log://<user_id>` + `mcp-log://all` (scoped to THIS
/// user only — never another user's topic). Gated on `has_subscriber` so an unwatched stream
/// builds nothing; the engine already throttles by `PROGRESS_STEP`, so the rate is bounded.
pub struct WsSink {
    pub ws: Arc<WsHub>,
    pub user_id: i64,
    pub username: String,
}

impl EventSink for WsSink {
    fn emit(&self, _topic: &str, payload: Value) {
        let own = format!("mcp-log://{}", self.user_id);
        if !self.ws.has_subscriber(&own) && !self.ws.has_subscriber("mcp-log://all") {
            return;
        }
        let entry = McpLogEntry {
            ts: fmt_datetime(now_epoch()),
            kind: "transfer".to_string(),
            ip: String::new(),
            session_id: None,
            tool: payload.get("filename").and_then(Value::as_str).map(String::from),
            args: None,
            output: None,
            is_error: None,
            path: None,
            transfer: Some(payload),
            user_id: self.user_id,
            username: self.username.clone(),
        };
        let p = serde_json::to_value(&entry).unwrap_or(Value::Null);
        self.ws.emit(&own, p.clone());
        self.ws.emit("mcp-log://all", p);
    }
}

// ---- realtime log (server-mode: WS hub, no file logging — see spec §7 YAGNI) ----

/// One realtime-log entry pushed over the WS hub as the `payload` of `{type:"event",topic,payload}`.
/// Mirrors the desktop `mcp::McpLogEntry` (same camelCase wire shape the frontend's `onMcpLog`
/// delivers) plus `userId`/`username` (ALWAYS, so the admin "all users" view can attribute each
/// row) and `transfer` (the SFTP `TransferProgress` object, only for `kind=="transfer"`). Optional
/// fields are skipped when absent so each kind carries only what applies.
#[derive(Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    transfer: Option<Value>,
    user_id: i64,
    username: String,
}

/// (year, month, day) from days since the Unix epoch (Howard Hinnant's algorithm). Duplicated from
/// `crate::mcp` (private there); the server head has no file logging, only this WS emit.
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

/// UTC ISO timestamp `YYYY-MM-DDTHH:MM:SSZ`.
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

/// Build ONE realtime-log entry and DUAL-EMIT it to `mcp-log://<user_id>` (owner sees own) and
/// `mcp-log://all` (admin sees everyone). HAS_SUBSCRIBER GATE: if NEITHER topic has a subscriber
/// the entry is never constructed (replaces the desktop's `live_log` AtomicBool). `detail` is a
/// loose JSON bag — only the keys relevant to `kind` are read.
fn emit_mcp_log(st: &AppState, user_id: i64, username: &str, kind: &str, ip: &str, detail: Value) {
    let own = format!("mcp-log://{user_id}");
    if !st.ws.has_subscriber(&own) && !st.ws.has_subscriber("mcp-log://all") {
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
        transfer: None,
        user_id,
        username: username.to_string(),
    };
    let payload = serde_json::to_value(&entry).unwrap_or(Value::Null);
    st.ws.emit(&own, payload.clone());
    st.ws.emit("mcp-log://all", payload);
}

// ---- IP allowlist gate (network-layer, additive to the token) ----

/// Resolve the client IP for the `/mcp` routes (gate + log `ip` field). When `CATIO_TRUST_PROXY`
/// is set AND `X-Forwarded-For` is present, trust its leftmost entry (reverse-proxy deployments);
/// otherwise use the raw peer IP from `ConnectInfo`. `None` when neither is available — the gate
/// then fails closed.
fn client_ip(st: &AppState, peer: Option<&ConnectInfo<SocketAddr>>, headers: &HeaderMap) -> Option<String> {
    if st.mcp_trust_proxy {
        if let Some(first) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|xff| xff.split(',').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(first.to_string());
        }
    }
    peer.map(|ci| ci.0.ip().to_string())
}

/// IP allowlist gate. EMPTY allowlist ⇒ disabled (token stays the sole gate, always true). Else the
/// client IP must be determinable AND allowed (loopback `127.0.0.1`/`::1` always pass via
/// `ip_allowed`); an undeterminable IP ⇒ fail closed (`false`).
fn ip_gate_ok(st: &AppState, client_ip: Option<&str>) -> bool {
    if st.mcp_ip_allowlist.is_empty() {
        return true;
    }
    match client_ip {
        Some(ip) => ip_allowed(ip, &st.mcp_ip_allowlist),
        None => false,
    }
}

// ---- SSE session table ----

/// Removes the SSE session from the table when the stream is dropped (client disconnect / end),
/// so the sessionId → sender map can't leak entries across reconnects.
struct SessionGuard {
    sessions: Arc<Mutex<HashMap<String, UnboundedSender<String>>>>,
    id: String,
}
impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.sessions.lock().unwrap().remove(&self.id);
    }
}

fn gen_session_id() -> String {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}-{n:x}", rand::random::<u64>())
}

#[derive(Deserialize)]
pub struct SseQuery {
    #[serde(default)]
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsgQuery {
    #[serde(default)]
    token: String,
    #[serde(default)]
    session_id: String,
}

/// `GET /mcp/sse?token=` — SSE event stream. Self-authenticates on the token (must resolve AND be
/// enabled; else 401). Mints a sessionId, registers its sender, advertises the `endpoint` event
/// (token echoed through so the client carries it on POSTs), then streams `message` events pushed
/// by `/mcp/messages`. A 25s keep-alive ping holds the connection open; the [`SessionGuard`]
/// unregisters on disconnect.
pub async fn mcp_sse_handler(
    State(st): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Query(q): Query<SseQuery>,
) -> Response {
    // Resolve the token to (user_id, username) up front: the realtime-log connect/denied entries
    // need both, and re-resolving would just double the query.
    let (user_id, username) = match st.auth.mcp_token_resolve(&q.token) {
        Ok(Some((uid, true, name))) => (uid, name),
        _ => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    // IP allowlist gate (network-layer, additive to the token). Disabled when the allowlist is
    // empty; loopback always passes; an undeterminable IP under an engaged gate fails closed.
    let cip = client_ip(&st, connect_info.as_ref(), &headers);
    if !ip_gate_ok(&st, cip.as_deref()) {
        emit_mcp_log(&st, user_id, &username, "denied", cip.as_deref().unwrap_or(""), json!({ "path": "/mcp/sse" }));
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let ip = cip.unwrap_or_default();

    let session_id = gen_session_id();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    st.mcp_sessions.lock().unwrap().insert(session_id.clone(), tx);
    let guard = SessionGuard { sessions: st.mcp_sessions.clone(), id: session_id.clone() };

    emit_mcp_log(&st, user_id, &username, "connect", &ip, json!({ "sessionId": session_id }));

    // Echo the token through so the client carries it on its POSTs to /mcp/messages.
    let endpoint = format!("/mcp/messages?sessionId={session_id}&token={}", q.token);
    let stream = futures_util::stream::unfold(
        (Some(endpoint), rx, guard),
        |(mut first, mut rx, guard)| async move {
            if let Some(ep) = first.take() {
                let ev = Event::default().event("endpoint").data(ep);
                return Some((Ok::<Event, Infallible>(ev), (None, rx, guard)));
            }
            match rx.recv().await {
                Some(line) => Some((Ok(Event::default().event("message").data(line)), (None, rx, guard))),
                None => None,
            }
        },
    );

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response()
}

/// `POST /mcp/messages?sessionId=&token=` — JSON-RPC endpoint. Self-authenticates on the token and
/// re-resolves the user on EVERY POST (stateless; the sessionId only routes the response). Builds
/// a [`ServerTargets`] owner-scoped to that user, runs the shared core, replies 202, then pushes
/// the JSON-RPC response onto the matching SSE stream. Token = primary gate; owner-scope = data gate.
pub async fn mcp_messages_handler(
    State(st): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Query(q): Query<MsgQuery>,
    body: Bytes,
) -> Response {
    let (user_id, username) = match st.auth.mcp_token_resolve(&q.token) {
        Ok(Some((uid, true, name))) => (uid, name),
        _ => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    // IP allowlist gate — same point as the token check, additive (token stays the primary gate).
    let cip = client_ip(&st, connect_info.as_ref(), &headers);
    if !ip_gate_ok(&st, cip.as_deref()) {
        emit_mcp_log(&st, user_id, &username, "denied", cip.as_deref().unwrap_or(""), json!({ "path": "/mcp/messages" }));
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let ip = cip.unwrap_or_default();

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("invalid json: {e}")).into_response(),
    };

    let resp = dispatch(&st, user_id, &username, &ip, &req).await;
    if let Some(resp) = resp {
        if !q.session_id.is_empty() {
            let line = serde_json::to_string(&resp).unwrap_or_default();
            if let Some(tx) = st.mcp_sessions.lock().unwrap().get(&q.session_id) {
                let _ = tx.send(line);
            }
        }
    }
    (StatusCode::ACCEPTED, "").into_response()
}

// ---- JSON-RPC dispatch (server-specific: realtime WS log, no file logging — spec §7 YAGNI) ----

/// The JSON-RPC envelope. `tools/list`/`tools/call` delegate to the shared core; `tools/call`
/// runs over a [`ServerTargets`] owner-scoped to `user_id` and a [`WsSink`] that streams SFTP
/// progress to the user's realtime-log topic. `ip`/`username` come from the caller so every emit
/// can attribute the activity. Emits mirror the desktop dispatch: tools/list, tools/call, tools/result.
async fn dispatch(st: &AppState, user_id: i64, username: &str, ip: &str, req: &Value) -> Option<Value> {
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
            emit_mcp_log(st, user_id, username, "tools/list", ip, json!({}));
            id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": core::tools_list() } }))
        }
        "tools/call" => {
            let id = id?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            emit_mcp_log(st, user_id, username, "tools/call", ip, json!({ "tool": name, "args": args }));
            let targets = ServerTargets {
                user_id,
                conn_owners: &st.conn_owners,
                ssh_owners: &st.ssh_owners,
                conn_meta: &st.conn_meta,
                ssh_meta: &st.ssh_meta,
            };
            // WsSink remaps SFTP `transfer-progress-{id}` events onto THIS user's realtime-log
            // stream (gated on has_subscriber); scoped to the user, never another's topic.
            let sink: Arc<dyn EventSink> = Arc::new(WsSink {
                ws: st.ws.clone(),
                user_id,
                username: username.to_string(),
            });
            let (text, is_error) = match core::call_tool(&targets, st.conns.as_ref(), st.ssh.as_ref(), &sink, &name, &args).await {
                Ok(t) => (t, false),
                Err(t) => (t, true),
            };
            emit_mcp_log(st, user_id, username, "tools/result", ip, json!({ "tool": name, "isError": is_error, "output": text }));
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
