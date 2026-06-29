//! Server-side connection-secret vault (web head). Proves: secrets are gated behind a session,
//! a remembered secret round-trips (encrypt at rest → decrypt on recall), forget clears it, and
//! one user can never read another user's stored secret (per-user isolation).

use std::net::SocketAddr;

use catio_lib::server::{build_router, AppState};
use serde_json::{json, Value};

async fn start() -> String {
    // The vault is keyed by CATIO_MASTER_KEY; set it before constructing AppState (read once there).
    std::env::set_var("CATIO_MASTER_KEY", "integration-test-master-key");
    let tmp = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).expect("state");
    std::mem::forget(tmp);
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    let bound = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap(); });
    format!("http://{bound}")
}

fn jar_client() -> reqwest::Client {
    reqwest::Client::builder().cookie_store(true).build().unwrap()
}

async fn invoke(cl: &reqwest::Client, base: &str, cmd: &str, args: Value) -> (u16, Value) {
    let res = cl.post(format!("{base}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args })).send().await.expect("send");
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn secret_recall_requires_auth() {
    let base = start().await;
    let cl = jar_client();
    let (st, _) = invoke(&cl, &base, "secret_recall", json!({ "profileId": "p1" })).await;
    assert_eq!(st, 401);
}

#[tokio::test]
async fn remember_recall_forget_roundtrip() {
    let base = start().await;
    let cl = jar_client();
    invoke(&cl, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;

    // No secret yet → null.
    let (st, body) = invoke(&cl, &base, "secret_recall", json!({ "profileId": "live-h:22-root" })).await;
    assert_eq!(st, 200, "{body}");
    assert!(body["secret"].is_null());

    // Remember → recall returns the plaintext (decrypted from the AES-GCM blob).
    let (st, _) = invoke(&cl, &base, "secret_remember", json!({ "profileId": "live-h:22-root", "secret": "hunter2" })).await;
    assert_eq!(st, 200);
    let (_, body) = invoke(&cl, &base, "secret_recall", json!({ "profileId": "live-h:22-root" })).await;
    assert_eq!(body["secret"], "hunter2");

    // Overwrite is an upsert.
    invoke(&cl, &base, "secret_remember", json!({ "profileId": "live-h:22-root", "secret": "newpass" })).await;
    let (_, body) = invoke(&cl, &base, "secret_recall", json!({ "profileId": "live-h:22-root" })).await;
    assert_eq!(body["secret"], "newpass");

    // Forget → back to null.
    invoke(&cl, &base, "secret_forget", json!({ "profileId": "live-h:22-root" })).await;
    let (_, body) = invoke(&cl, &base, "secret_recall", json!({ "profileId": "live-h:22-root" })).await;
    assert!(body["secret"].is_null());
}

#[tokio::test]
async fn secrets_are_isolated_per_user() {
    let base = start().await;
    let admin = jar_client();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    invoke(&admin, &base, "user_create", json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;

    // Admin stores a secret under profile "shared".
    invoke(&admin, &base, "secret_remember", json!({ "profileId": "shared", "secret": "admins-password" })).await;

    // Bob logs in on a fresh client and CANNOT read admin's secret (keyed by user id).
    let bob = jar_client();
    invoke(&bob, &base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;
    let (st, body) = invoke(&bob, &base, "secret_recall", json!({ "profileId": "shared" })).await;
    assert_eq!(st, 200, "{body}");
    assert!(body["secret"].is_null(), "bob must not see admin's secret: {body}");

    // Admin still reads their own.
    let (_, body) = invoke(&admin, &base, "secret_recall", json!({ "profileId": "shared" })).await;
    assert_eq!(body["secret"], "admins-password");
}
