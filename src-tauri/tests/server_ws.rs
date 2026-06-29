//! M3 — WebSocket streaming channel integration tests. Proves the /ws plumbing without a real
//! SSH server: the upgrade is auth-gated, ping/pong works, and `cmd` envelopes route to the
//! terminal core and reply. (Full interactive I/O needs a live SSH host and is covered by the
//! browser e2e at deploy-verification time.)

use std::net::SocketAddr;

use catio_lib::server::{build_router, AppState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::COOKIE;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> String {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).unwrap();
    std::mem::forget(tmp);
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let bound = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap(); });
    bound.to_string()
}

/// Bootstrap an admin over HTTP and return the raw `catio_session=...` cookie pair.
async fn bootstrap_cookie(host: &str) -> String {
    let res = reqwest::Client::new()
        .post(format!("http://{host}/api/invoke"))
        .json(&json!({ "cmd": "auth_bootstrap", "args": { "username": "admin", "password": "secret123" } }))
        .send().await.unwrap();
    let sc = res.headers().get(reqwest::header::SET_COOKIE).expect("set-cookie").to_str().unwrap();
    sc.split(';').next().unwrap().to_string() // "catio_session=XXX"
}

async fn recv_json(ws: &mut Ws) -> Value {
    while let Some(msg) = ws.next().await {
        if let Ok(Message::Text(t)) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
    panic!("ws closed without a text message");
}

#[tokio::test]
async fn ws_upgrade_requires_auth() {
    let host = start().await;
    let req = format!("ws://{host}/ws").into_client_request().unwrap();
    assert!(tokio_tungstenite::connect_async(req).await.is_err(), "unauthenticated /ws must be rejected");
}

#[tokio::test]
async fn ws_ping_pong_and_cmd_reply() {
    let host = start().await;
    let cookie = bootstrap_cookie(&host).await;
    let mut req = format!("ws://{host}/ws").into_client_request().unwrap();
    req.headers_mut().insert(COOKIE, cookie.parse().unwrap());
    let (mut ws, _resp) = tokio_tungstenite::connect_async(req).await.expect("authed ws connects");

    // Heartbeat.
    ws.send(Message::Text(json!({ "type": "ping" }).to_string())).await.unwrap();
    assert_eq!(recv_json(&mut ws).await["type"], "pong");

    // A cmd against a bogus SSH session routes to the terminal core and replies with the error —
    // proving envelope parsing, cmd dispatch, and the reply path all work end to end.
    ws.send(Message::Text(json!({
        "type": "cmd", "id": "c1", "cmd": "term_open",
        "args": { "sessionId": "nope", "cols": 80, "rows": 24 }
    }).to_string())).await.unwrap();
    let reply = recv_json(&mut ws).await;
    assert_eq!(reply["type"], "reply");
    assert_eq!(reply["id"], "c1");
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].is_string());
}

#[tokio::test]
async fn ws_unknown_cmd_replies_error() {
    let host = start().await;
    let cookie = bootstrap_cookie(&host).await;
    let mut req = format!("ws://{host}/ws").into_client_request().unwrap();
    req.headers_mut().insert(COOKIE, cookie.parse().unwrap());
    let (mut ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();

    ws.send(Message::Text(json!({ "type": "cmd", "id": 7, "cmd": "bogus_cmd", "args": {} }).to_string())).await.unwrap();
    let reply = recv_json(&mut ws).await;
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("bogus_cmd"));
}
