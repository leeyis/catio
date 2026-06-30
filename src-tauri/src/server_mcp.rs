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
//! The 12 tools are the shared [`crate::mcp::core`] implementation; this module only adds the
//! transport: an SSE session table (sessionId → sender) + a small JSON-RPC envelope. No file
//! logging in P3a (admin/global logging is P3b); the progress sink is a no-op (P3b streams it).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::events::EventSink;
use crate::mcp::core::{self, ConnEntry, HostEntry, McpTargets};
use crate::server::AppState;

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

/// No-op byte-progress sink (P3a). SFTP upload/download still works; only the per-byte
/// `transfer-progress-*` event is dropped. P3b swaps this for `st.ws` to stream to the browser.
pub struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _: &str, _: Value) {}
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
pub async fn mcp_sse_handler(State(st): State<AppState>, Query(q): Query<SseQuery>) -> Response {
    if !token_enabled(&st, &q.token) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }

    let session_id = gen_session_id();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    st.mcp_sessions.lock().unwrap().insert(session_id.clone(), tx);
    let guard = SessionGuard { sessions: st.mcp_sessions.clone(), id: session_id.clone() };

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
pub async fn mcp_messages_handler(State(st): State<AppState>, Query(q): Query<MsgQuery>, body: Bytes) -> Response {
    let user_id = match st.auth.mcp_token_resolve(&q.token) {
        Ok(Some((uid, true))) => uid,
        _ => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("invalid json: {e}")).into_response(),
    };

    let resp = dispatch(&st, user_id, &req).await;
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

/// True iff the token resolves AND is enabled.
fn token_enabled(st: &AppState, token: &str) -> bool {
    matches!(st.auth.mcp_token_resolve(token), Ok(Some((_, true))))
}

// ---- JSON-RPC dispatch (server-specific: no file logging in P3a) ----

/// The JSON-RPC envelope. `tools/list`/`tools/call` delegate to the shared core; `tools/call`
/// runs over a [`ServerTargets`] owner-scoped to `user_id` and a no-op progress sink.
async fn dispatch(st: &AppState, user_id: i64, req: &Value) -> Option<Value> {
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
        "tools/list" => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": core::tools_list() } })),
        "tools/call" => {
            let id = id?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let targets = ServerTargets {
                user_id,
                conn_owners: &st.conn_owners,
                ssh_owners: &st.ssh_owners,
                conn_meta: &st.conn_meta,
                ssh_meta: &st.ssh_meta,
            };
            let sink: Arc<dyn EventSink> = Arc::new(NoopSink);
            let (text, is_error) = match core::call_tool(&targets, st.conns.as_ref(), st.ssh.as_ref(), &sink, &name, &args).await {
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
