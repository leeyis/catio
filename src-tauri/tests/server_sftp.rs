//! M4 — SFTP over HTTP. Without a live SSH host we can't exercise a real transfer, but we prove
//! the plumbing: the request/response ops route through /api/invoke (auth-gated, erroring on a
//! bogus session), and the binary download/upload endpoints are auth-gated.

use std::net::SocketAddr;

use catio_lib::server::{build_router, AppState};
use serde_json::{json, Value};

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

fn jar() -> reqwest::Client {
    reqwest::Client::builder().cookie_store(true).build().unwrap()
}

async fn invoke(cl: &reqwest::Client, host: &str, cmd: &str, args: Value) -> (u16, Value) {
    let res = cl.post(format!("http://{host}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args })).send().await.unwrap();
    (res.status().as_u16(), res.json::<Value>().await.unwrap_or(Value::Null))
}

async fn authed(host: &str) -> reqwest::Client {
    let cl = jar();
    invoke(&cl, host, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    cl
}

#[tokio::test]
async fn sftp_ops_route_and_error_on_bogus_session() {
    let host = start().await;
    let cl = authed(&host).await;
    // Each op reaches the SFTP core and fails with "session not found" (not "command not exposed").
    for (cmd, args) in [
        ("sftp_list", json!({ "sessionId": "nope", "path": "/" })),
        ("sftp_mkdir", json!({ "sessionId": "nope", "path": "/tmp/x" })),
        ("sftp_delete", json!({ "sessionId": "nope", "path": "/tmp/x", "isDir": false })),
        ("sftp_rename", json!({ "sessionId": "nope", "from": "/a", "to": "/b" })),
    ] {
        let (st, body) = invoke(&cl, &host, cmd, args).await;
        assert_eq!(st, 400, "{cmd}: {body}");
        let err = body["error"].as_str().unwrap_or("");
        assert!(!err.contains("not exposed"), "{cmd} should be routed, got: {err}");
    }
}

#[tokio::test]
async fn sftp_delete_rejects_dangerous_paths() {
    let host = start().await;
    let cl = authed(&host).await;
    // The guard fires before any SSH work, so even with a bogus session "/" is refused as dangerous.
    let (st, body) = invoke(&cl, &host, "sftp_delete", json!({ "sessionId": "nope", "path": "/", "isDir": true })).await;
    assert_eq!(st, 400);
    assert!(body["error"].as_str().unwrap_or("").contains("危险路径"), "{body}");
}

#[tokio::test]
async fn sftp_download_requires_auth() {
    let host = start().await;
    let res = reqwest::get(format!("http://{host}/api/sftp/download?sessionId=x&path=/etc/hostname")).await.unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn sftp_upload_requires_auth() {
    let host = start().await;
    let form = reqwest::multipart::Form::new()
        .text("sessionId", "x")
        .text("remotePath", "/tmp/f")
        .part("file", reqwest::multipart::Part::bytes(b"hi".to_vec()).file_name("f.txt"));
    let res = reqwest::Client::new()
        .post(format!("http://{host}/api/sftp/upload")).multipart(form).send().await.unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn sftp_upload_body_limit_is_disabled_for_streaming() {
    // A 5 MiB body far exceeds axum's default 2 MiB body limit. The streaming upload route disables
    // that limit, so the request must REACH the handler (which then fails on the bogus SFTP session)
    // rather than being rejected at the body-size layer — proving large (multi-GB) uploads aren't
    // capped. Without `DefaultBodyLimit::disable()` this would be 413.
    let host = start().await;
    let cl = authed(&host).await;
    let big = vec![0u8; 5 * 1024 * 1024];
    let form = reqwest::multipart::Form::new()
        .text("sessionId", "nope")
        .text("remotePath", "/tmp/big.bin")
        .part("file", reqwest::multipart::Part::bytes(big).file_name("big.bin"));
    let res = cl.post(format!("http://{host}/api/sftp/upload")).multipart(form).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 400, "should reach handler, not 413");
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    let err = body["error"].as_str().unwrap_or("");
    assert!(!err.contains("too large") && !err.contains("过大"), "must not be a size-limit rejection: {err}");
}

#[tokio::test]
async fn sftp_download_authed_bogus_session_is_400() {
    let host = start().await;
    let cl = authed(&host).await;
    let res = cl.get(format!("http://{host}/api/sftp/download?sessionId=nope&path=/etc/hostname")).send().await.unwrap();
    assert_eq!(res.status(), 400);
}
