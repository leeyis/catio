//! Server-mode Agent integration: authenticated owner isolation, owner-scoped
//! WebSocket delivery, and desktop/server event parity over the same scripted
//! fixture.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use catio_lib::agent::provider::{Provider, ProviderError, ProviderRequest, ProviderRound};
use catio_lib::agent::{
    AgentError, AgentEventEnvelope, AgentMessage, AgentRole, AgentRuntime, AnthropicAuthMode,
    ApiCredential, ContentBlock, ExecutionMode, ProviderConfig, ProviderFactory, ProviderProtocol,
    ProviderStop, StartTurnRequest,
};
use catio_lib::server::{build_router, AppState};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::COOKIE;
use tokio_tungstenite::tungstenite::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ---------------------------------------------------------------------------
// Scripted provider + factory (no network)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ScriptedRound {
    round: ProviderRound,
    deltas: Vec<String>,
}

#[derive(Clone)]
struct ScriptedProvider {
    rounds: Arc<Mutex<VecDeque<ScriptedRound>>>,
    pending_when_empty: bool,
}

impl ScriptedProvider {
    fn text(parts: &[&str]) -> Self {
        let text = parts.concat();
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([ScriptedRound {
                round: ProviderRound {
                    message: AgentMessage {
                        role: AgentRole::Assistant,
                        content: vec![ContentBlock::Text { text: text.clone() }],
                    },
                    stop: ProviderStop::Stop,
                    usage: None,
                },
                deltas: parts.iter().map(|s| s.to_string()).collect(),
            }]))),
            pending_when_empty: false,
        }
    }

    /// One sensitive tool round, then block forever: keeps the Turn alive
    /// waiting for approval so cross-user respond/cancel can be tested.
    fn tool_then_blocked() -> Self {
        let tool_round = ScriptedRound {
            round: ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::ToolUse {
                        id: "tool-1".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": "rm -rf /tmp/demo" }),
                    }],
                },
                stop: ProviderStop::ToolUse,
                usage: None,
            },
            deltas: vec![],
        };
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([tool_round]))),
            pending_when_empty: true,
        }
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        observer: &dyn catio_lib::agent::ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        let scripted = {
            let mut rounds = self.rounds.lock();
            rounds.pop_front()
        };
        let scripted = match scripted {
            Some(scripted) => scripted,
            None if self.pending_when_empty => std::future::pending().await,
            None => return Err(ProviderError::Protocol("no scripted round".into())),
        };
        for delta in &scripted.deltas {
            observer.text_delta(delta);
        }
        Ok(scripted.round)
    }
}

#[derive(Clone)]
struct ScriptedFactory {
    provider: Arc<dyn Provider>,
}

#[async_trait]
impl ProviderFactory for ScriptedFactory {
    async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        Ok(self.provider.clone())
    }
}

// ---------------------------------------------------------------------------
// Server bootstrap + WS/HTTP helpers
// ---------------------------------------------------------------------------

fn valid_request(mode: ExecutionMode) -> Value {
    json!({
        "conversationId": "conv-1",
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }],
        "systemPrompt": "sys",
        "terminalContext": "term",
        "targetRef": "target-1",
        "provider": {
            "protocol": "openai",
            "baseUrl": "https://example.test/v1",
            "model": "test-model",
            "credential": "sk-test",
            "anthropicAuthMode": "auto"
        },
        "executionMode": match mode {
            ExecutionMode::Manual => "manual",
            ExecutionMode::Ask => "ask",
            ExecutionMode::Auto => "auto",
        },
        "singleLineCommands": true,
        "roundCap": 5
    })
}

async fn start_server(factory: Arc<dyn ProviderFactory>) -> (String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let mut state = AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).unwrap();
    state.agent = Arc::new(AgentRuntime::new(factory));
    std::mem::forget(tmp);
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let bound = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });
    let host = bound.to_string();
    let cookie = invoke(
        &host,
        "",
        "auth_bootstrap",
        json!({ "username": "admin", "password": "secret123" }),
    )
    .await
    .1
    .expect("bootstrap sets cookie");
    (host, cookie)
}

/// POST /api/invoke; returns (status, Set-Cookie pair, body).
async fn invoke(host: &str, cookie: &str, cmd: &str, args: Value) -> (u16, Option<String>, Value) {
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("http://{host}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args }));
    if !cookie.is_empty() {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    let sc = res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap().to_string());
    let body = res.json().await.unwrap();
    (status, sc, body)
}

async fn register_user(host: &str, username: &str) -> String {
    let (status, _, body) = invoke(
        host,
        "",
        "auth_register",
        json!({ "username": username, "password": "secret123" }),
    )
    .await;
    assert_eq!(status, 200, "register {username}: {body:?}");
    let (status, cookie, body) = invoke(
        host,
        "",
        "auth_login",
        json!({ "username": username, "password": "secret123" }),
    )
    .await;
    assert_eq!(status, 200, "login {username}: {body:?}");
    cookie.expect("login cookie")
}

async fn connect_ws(host: &str, cookie: &str) -> Ws {
    let mut req = format!("ws://{host}/ws").into_client_request().unwrap();
    req.headers_mut().insert(COOKIE, cookie.parse().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

async fn ws_send(ws: &mut Ws, env: Value) {
    ws.send(Message::Text(env.to_string())).await.unwrap();
}

/// Reads WS frames until an `event` on `topic` (or `timeout`), returning the payload.
async fn ws_recv_event(ws: &mut Ws, topic: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            while let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(t) = msg {
                    let env: Value = serde_json::from_str(&t).unwrap();
                    if env.get("type").and_then(Value::as_str) == Some("event")
                        && env.get("topic").and_then(Value::as_str) == Some(topic)
                    {
                        return env.get("payload").cloned().unwrap_or(Value::Null);
                    }
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ws event timeout")
}

/// Asserts no event on `topic` arrives within 300ms.
async fn ws_assert_silent(ws: &mut Ws, topic: &str) {
    tokio::time::timeout(std::time::Duration::from_millis(300), async {
        loop {
            if let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(t) = msg {
                    let env: Value = serde_json::from_str(&t).unwrap();
                    assert!(
                        !(env.get("type").and_then(Value::as_str) == Some("event")
                            && env.get("topic").and_then(Value::as_str) == Some(topic)),
                        "unexpected event on {topic}: {env:?}"
                    );
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect_err("expected silence");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn owner_scoped_ws_delivery_only_reaches_the_owner() {
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(ScriptedProvider::text(&["hello ", "world"])),
    });
    let (host, admin_cookie) = start_server(factory).await;
    let user_b_cookie = register_user(&host, "user_b").await;

    let mut ws_a = connect_ws(&host, &admin_cookie).await;
    let mut ws_b = connect_ws(&host, &user_b_cookie).await;
    ws_send(
        &mut ws_a,
        json!({ "type": "sub", "topic": "agent://events" }),
    )
    .await;
    ws_send(
        &mut ws_b,
        json!({ "type": "sub", "topic": "agent://events" }),
    )
    .await;

    let (status, _, body) = invoke(
        &host,
        &admin_cookie,
        "agent_start_turn",
        json!({ "request": valid_request(ExecutionMode::Manual) }),
    )
    .await;
    assert_eq!(status, 200, "{body:?}");
    let turn_id = body["turnId"].as_str().unwrap().to_string();
    assert!(!turn_id.is_empty());

    // A receives the ordered stream ending in turnFinished.
    let mut seen: Vec<String> = Vec::new();
    loop {
        let payload = ws_recv_event(&mut ws_a, "agent://events").await;
        seen.push(payload["event"]["type"].as_str().unwrap().to_string());
        if payload["event"]["type"] == "turnFinished" {
            break;
        }
    }
    assert_eq!(
        seen,
        [
            "turnStarted",
            "assistantMessageStarted",
            "textDelta",
            "textDelta",
            "assistantMessageFinished",
            "turnFinished"
        ]
    );
    // B (different owner, even though A is admin) must not see A's events.
    ws_assert_silent(&mut ws_b, "agent://events").await;
}

#[tokio::test]
async fn cross_user_respond_and_cancel_are_rejected() {
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(ScriptedProvider::tool_then_blocked()),
    });
    let (host, admin_cookie) = start_server(factory).await;
    let user_b_cookie = register_user(&host, "user_b").await;

    let mut ws_a = connect_ws(&host, &admin_cookie).await;
    ws_send(
        &mut ws_a,
        json!({ "type": "sub", "topic": "agent://events" }),
    )
    .await;

    let (status, _, body) = invoke(
        &host,
        &admin_cookie,
        "agent_start_turn",
        json!({ "request": valid_request(ExecutionMode::Ask) }),
    )
    .await;
    assert_eq!(status, 200, "{body:?}");
    let turn_id = body["turnId"].as_str().unwrap().to_string();
    // Wait for the approval request so the Turn is definitely alive.
    let mut seen_approval = false;
    for _ in 0..64 {
        let payload = ws_recv_event(&mut ws_a, "agent://events").await;
        if payload["event"]["type"] == "approvalRequested" {
            seen_approval = true;
            assert_eq!(payload["ownerId"], "1"); // bootstrap admin is user id 1
            break;
        }
    }
    assert!(seen_approval, "approval was never requested");

    // User B cannot respond to or cancel A's Turn.
    let (status, _, body) = invoke(
        &host,
        &user_b_cookie,
        "agent_respond",
        json!({
            "turnId": turn_id,
            "response": { "type": "approvalDecision", "toolUseId": "tool-1", "decision": "allow" }
        }),
    )
    .await;
    assert_eq!(status, 400, "B respond must be rejected: {body:?}");
    assert!(
        body["error"].as_str().unwrap().contains("owner"),
        "{body:?}"
    );
    let (status, _, body) = invoke(
        &host,
        &user_b_cookie,
        "agent_cancel",
        json!({ "turnId": turn_id }),
    )
    .await;
    assert_eq!(status, 400, "B cancel must be rejected: {body:?}");
    // A can still cancel its own turn.
    let (status, _, body) = invoke(
        &host,
        &admin_cookie,
        "agent_cancel",
        json!({ "turnId": turn_id }),
    )
    .await;
    assert_eq!(status, 200, "{body:?}");
    // The cancelled turn emits its terminal event before the test ends.
    let mut cancelled = false;
    for _ in 0..64 {
        let payload = ws_recv_event(&mut ws_a, "agent://events").await;
        if payload["event"]["type"] == "turnCancelled" {
            cancelled = true;
            break;
        }
    }
    assert!(cancelled, "turn was not cancelled");
}

#[tokio::test]
async fn desktop_and_server_emit_identical_ordered_envelopes() {
    // Desktop recording sink over the same scripted fixture.
    let desktop_provider = ScriptedProvider::text(&["hello ", "world"]);
    let desktop_sink = Arc::new(RecordingSink::default());
    let desktop_runtime = Arc::new(AgentRuntime::new(Arc::new(ScriptedFactory {
        provider: Arc::new(desktop_provider),
    })));
    let desktop_handle = desktop_runtime
        .start_turn(
            catio_lib::agent::ActorContext {
                owner_id: "local".into(),
            },
            serde_json::from_value(valid_request(ExecutionMode::Manual)).unwrap(),
            desktop_sink.clone(),
        )
        .await
        .unwrap();
    desktop_sink.wait_for_terminal().await;
    let desktop_envelopes: Vec<Value> = desktop_sink
        .envelopes()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let _ = desktop_handle;

    // Server WS delivery of the same turn.
    let (host, admin_cookie) = start_server(Arc::new(ScriptedFactory {
        provider: Arc::new(ScriptedProvider::text(&["hello ", "world"])),
    }))
    .await;
    let mut ws_a = connect_ws(&host, &admin_cookie).await;
    ws_send(
        &mut ws_a,
        json!({ "type": "sub", "topic": "agent://events" }),
    )
    .await;
    let (status, _, body) = invoke(
        &host,
        &admin_cookie,
        "agent_start_turn",
        json!({ "request": valid_request(ExecutionMode::Manual) }),
    )
    .await;
    assert_eq!(status, 200, "{body:?}");

    let mut server_envelopes: Vec<Value> = Vec::new();
    loop {
        let payload = ws_recv_event(&mut ws_a, "agent://events").await;
        let is_terminal = payload["event"]["type"] == "turnFinished";
        server_envelopes.push(payload);
        if is_terminal {
            break;
        }
    }
    // Strip turn-specific identity (owner id, turn id, message ids) and compare.
    let mut desktop_envelopes = desktop_envelopes;
    for env in desktop_envelopes
        .iter_mut()
        .chain(server_envelopes.iter_mut())
    {
        env["ownerId"] = Value::Null;
        env["turnId"] = Value::Null;
        if let Some(event) = env.get_mut("event").and_then(Value::as_object_mut) {
            for key in ["messageId", "toolUseId"] {
                if let Some(value) = event.get_mut(key) {
                    *value = Value::Null;
                }
            }
        }
    }
    assert_eq!(desktop_envelopes, server_envelopes);
    // The credential never reaches the wire.
    let wire = serde_json::to_string(&server_envelopes).unwrap();
    assert!(!wire.contains("sk-test"), "credential leaked into events");
}

#[derive(Clone, Default)]
struct RecordingSink {
    envelopes: Arc<Mutex<Vec<AgentEventEnvelope>>>,
}

impl RecordingSink {
    fn envelopes(&self) -> Vec<AgentEventEnvelope> {
        self.envelopes.lock().clone()
    }

    async fn wait_for_terminal(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let terminal = self.envelopes.lock().iter().any(|e| {
                    matches!(
                        e.event,
                        catio_lib::agent::AgentEvent::TurnFinished
                            | catio_lib::agent::AgentEvent::TurnCancelled
                            | catio_lib::agent::AgentEvent::TurnFailed { .. }
                    )
                });
                if terminal {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("desktop turn did not finish");
    }
}

#[async_trait]
impl catio_lib::agent::AgentEventSink for RecordingSink {
    async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError> {
        self.envelopes.lock().push(envelope);
        Ok(())
    }
}
