//! M2 — web-head authentication over HTTP. Proves the access-control story end to end:
//! unauthenticated calls are 401, the first browser visit bootstraps an admin, login sets a
//! session cookie, user management is admin-gated, and logout invalidates the session.

use std::net::SocketAddr;

use catio_lib::server::{build_router, AppState};
use serde_json::{json, Value};

async fn start() -> String {
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
async fn unauthenticated_command_is_401() {
    let base = start().await;
    let cl = jar_client();
    let (st, body) = invoke(&cl, &base, "db_schema", json!({ "connId": "x" })).await;
    assert_eq!(st, 401, "{body}");
    // auth_me reports "no user" (200, null) so the UI can decide to show the login screen.
    let (st, body) = invoke(&cl, &base, "auth_me", json!({})).await;
    assert_eq!(st, 200);
    assert!(body["user"].is_null(), "{body}");
}

#[tokio::test]
async fn bootstrap_then_authenticated_then_second_bootstrap_fails() {
    let base = start().await;
    let cl = jar_client();

    // First visit creates the admin and auto-logs-in (cookie in the jar).
    let (st, body) = invoke(&cl, &base, "auth_bootstrap",
        json!({ "username": "admin", "password": "secret123" })).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["user"]["username"], "admin");
    assert_eq!(body["user"]["isAdmin"], true);

    // Now authenticated: auth_me returns the user, and a gated command passes the gate.
    let (st, body) = invoke(&cl, &base, "auth_me", json!({})).await;
    assert_eq!(st, 200);
    assert_eq!(body["user"]["username"], "admin");

    // A second bootstrap is refused once a user exists.
    let (st, _) = invoke(&cl, &base, "auth_bootstrap",
        json!({ "username": "evil", "password": "secret123" })).await;
    assert_eq!(st, 400);
}

#[tokio::test]
async fn login_wrong_password_401_correct_200_and_cookie_gates_access() {
    let base = start().await;
    let setup = jar_client();
    invoke(&setup, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;

    // A fresh client (no cookie) is unauthenticated.
    let cl = jar_client();
    let (st, _) = invoke(&cl, &base, "auth_me", json!({})).await;
    assert!(st == 200);
    // Wrong password → 401.
    let (st, _) = invoke(&cl, &base, "auth_login", json!({ "username": "admin", "password": "nope" })).await;
    assert_eq!(st, 401);
    // Correct password → 200 + cookie; subsequent gated call now succeeds.
    let (st, body) = invoke(&cl, &base, "auth_login", json!({ "username": "admin", "password": "secret123" })).await;
    assert_eq!(st, 200, "{body}");
    let (st, _) = invoke(&cl, &base, "user_list", json!({})).await;
    assert_eq!(st, 200);

    // Logout invalidates the session → gated calls are 401 again.
    let (st, _) = invoke(&cl, &base, "auth_logout", json!({})).await;
    assert_eq!(st, 200);
    let (st, _) = invoke(&cl, &base, "user_list", json!({})).await;
    assert_eq!(st, 401);
}

#[tokio::test]
async fn change_password_is_self_service_and_gated() {
    let base = start().await;
    let cl = jar_client();
    invoke(&cl, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;

    // Wrong old password → 400 (rejected).
    let (st, _) = invoke(&cl, &base, "auth_change_password",
        json!({ "oldPassword": "wrong", "newPassword": "newsecret" })).await;
    assert_eq!(st, 400);

    // Correct old password → 200; re-login with the new password works, old no longer does.
    let (st, body) = invoke(&cl, &base, "auth_change_password",
        json!({ "oldPassword": "secret123", "newPassword": "newsecret" })).await;
    assert_eq!(st, 200, "{body}");
    invoke(&cl, &base, "auth_logout", json!({})).await;
    let (st, _) = invoke(&cl, &base, "auth_login", json!({ "username": "admin", "password": "secret123" })).await;
    assert_eq!(st, 401);
    let (st, body) = invoke(&cl, &base, "auth_login", json!({ "username": "admin", "password": "newsecret" })).await;
    assert_eq!(st, 200, "{body}");

    // Unauthenticated change is rejected at the gate (401).
    let anon = jar_client();
    let (st, _) = invoke(&anon, &base, "auth_change_password",
        json!({ "oldPassword": "x", "newPassword": "yyyyyy" })).await;
    assert_eq!(st, 401);
}

#[tokio::test]
async fn user_management_is_admin_gated() {
    let base = start().await;
    let admin = jar_client();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;

    // Admin creates a normal user.
    let (st, body) = invoke(&admin, &base, "user_create",
        json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;
    assert_eq!(st, 200, "{body}");
    let bob_id = body["id"].as_i64().expect("id");

    // user_list shows both.
    let (_, body) = invoke(&admin, &base, "user_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 2);

    // Bob logs in on his own client and is NOT allowed to create/delete users.
    let bob = jar_client();
    invoke(&bob, &base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;
    let (st, _) = invoke(&bob, &base, "user_create",
        json!({ "username": "eve", "password": "secret123" })).await;
    assert_eq!(st, 403, "non-admin must not create users");
    let (st, _) = invoke(&bob, &base, "user_delete", json!({ "id": 1 })).await;
    assert_eq!(st, 403);

    // Admin deletes Bob.
    let (st, _) = invoke(&admin, &base, "user_delete", json!({ "id": bob_id })).await;
    assert_eq!(st, 200);
    let (_, body) = invoke(&admin, &base, "user_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn concurrent_bootstrap_creates_exactly_one_admin() {
    let base = start().await;
    let cl1 = jar_client();
    let cl2 = jar_client();
    // Two first-run requests race with DIFFERENT usernames (UNIQUE(username) cannot save us).
    let f1 = invoke(&cl1, &base, "auth_bootstrap", json!({ "username": "admin1", "password": "secret123" }));
    let f2 = invoke(&cl2, &base, "auth_bootstrap", json!({ "username": "admin2", "password": "secret123" }));
    let ((s1, _), (s2, _)) = tokio::join!(f1, f2);
    // Exactly one wins; the other is rejected.
    assert!((s1 == 200) ^ (s2 == 200), "exactly one bootstrap must succeed, got {s1}/{s2}");
    // The winner sees exactly ONE user — no "double first admin".
    let winner = if s1 == 200 { &cl1 } else { &cl2 };
    let (_, body) = invoke(winner, &base, "user_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deleting_a_user_invalidates_their_live_session() {
    let base = start().await;
    let admin = jar_client();
    invoke(&admin, &base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    let (_, body) = invoke(&admin, &base, "user_create",
        json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;
    let bob_id = body["id"].as_i64().expect("id");

    // Bob logs in on his own client and can use a gated command.
    let bob = jar_client();
    invoke(&bob, &base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;
    let (st, _) = invoke(&bob, &base, "user_list", json!({})).await;
    assert_eq!(st, 200);

    // Admin deletes Bob — his existing cookie must stop working immediately, not at restart.
    invoke(&admin, &base, "user_delete", json!({ "id": bob_id })).await;
    let (st, _) = invoke(&bob, &base, "user_list", json!({})).await;
    assert_eq!(st, 401, "deleted user's session must be invalidated");
}
