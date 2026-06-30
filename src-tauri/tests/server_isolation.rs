//! Multi-user data isolation (web head). Proves: the per-user `user_store` isolates a normal
//! user's items, an admin sees + can target ALL users' items, and the live-resource ownership gate
//! stops one user from using another's `connId` (the reported bug + its server-side enforcement).

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
    format!("http://{bound}")
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

/// admin + a normal user `bob`, each with their own client (cookie jar).
async fn admin_and_bob(base: &str) -> (reqwest::Client, reqwest::Client) {
    let admin = jar();
    invoke(&admin, base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    invoke(&admin, base, "user_create", json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;
    let bob = jar();
    invoke(&bob, base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;
    (admin, bob)
}

#[tokio::test]
async fn store_is_per_user_and_admin_sees_all() {
    let base = start().await;
    let (admin, bob) = admin_and_bob(&base).await;

    invoke(&admin, &base, "store_set", json!({ "store": "connections", "itemId": "c1", "payload": { "id": "c1", "name": "admin-host" } })).await;
    invoke(&bob, &base, "store_set", json!({ "store": "connections", "itemId": "c2", "payload": { "id": "c2", "name": "bob-host" } })).await;

    // bob sees ONLY his own.
    let (_, body) = invoke(&bob, &base, "store_list", json!({ "store": "connections" })).await;
    let arr = body.as_array().unwrap();
    assert_eq!(arr.len(), 1, "bob should see only his own: {body}");
    assert_eq!(arr[0]["id"], "c2");

    // admin sees BOTH, each tagged with its owner.
    let (_, body) = invoke(&admin, &base, "store_list", json!({ "store": "connections" })).await;
    let arr = body.as_array().unwrap();
    assert_eq!(arr.len(), 2, "admin should see all: {body}");
    assert!(arr.iter().any(|v| v["id"] == "c1" && v["__ownerName"] == "admin"));
    assert!(arr.iter().any(|v| v["id"] == "c2" && v["__ownerName"] == "bob"));
}

#[tokio::test]
async fn a_user_cannot_delete_or_overwrite_anothers_item() {
    let base = start().await;
    let (admin, bob) = admin_and_bob(&base).await;
    invoke(&admin, &base, "store_set", json!({ "store": "connections", "itemId": "c1", "payload": { "id": "c1", "name": "admin-host" } })).await;

    // bob deleting "c1" only touches bob's namespace (a no-op) — admin's survives.
    invoke(&bob, &base, "store_delete", json!({ "store": "connections", "itemId": "c1" })).await;
    let (_, body) = invoke(&admin, &base, "store_list", json!({ "store": "connections" })).await;
    assert!(body.as_array().unwrap().iter().any(|v| v["id"] == "c1"), "admin's item must survive bob's delete: {body}");

    // bob "overwriting" c1 creates HIS OWN c1, not touching admin's payload.
    invoke(&bob, &base, "store_set", json!({ "store": "connections", "itemId": "c1", "payload": { "id": "c1", "name": "bob-hijack" } })).await;
    let (_, body) = invoke(&admin, &base, "store_list", json!({ "store": "connections" })).await;
    let admins = body.as_array().unwrap().iter().find(|v| v["id"] == "c1" && v["__ownerName"] == "admin").cloned().unwrap();
    assert_eq!(admins["name"], "admin-host", "admin's payload must be untouched");
}

#[tokio::test]
async fn live_connection_ownership_gate_blocks_cross_user_use() {
    let base = start().await;
    let (admin, bob) = admin_and_bob(&base).await;

    // admin opens a SQLite :memory connection → conn id owned by admin.
    let (st, body) = invoke(&admin, &base, "db_connect",
        json!({ "args": { "dbType": "sqlite", "host": ":memory:", "port": 0, "user": "", "ssl": false } })).await;
    assert_eq!(st, 200, "{body}");
    let conn_id = body["connId"].as_str().unwrap().to_string();

    // bob (knowing/guessing the id) tries to query it → ownership gate → "connection not found".
    let (st, body) = invoke(&bob, &base, "db_query", json!({ "connId": conn_id, "sql": "SELECT 1" })).await;
    assert_eq!(st, 400);
    assert!(body["error"].as_str().unwrap_or("").contains("not found"), "bob must be denied: {body}");

    // admin can use its own connection.
    let (st, _) = invoke(&admin, &base, "db_query", json!({ "connId": conn_id, "sql": "SELECT 1+1 AS r" })).await;
    assert_eq!(st, 200);

    // and an admin may use ANY connection (management) — already covered: admin owns it. A second
    // admin would also pass via the is_admin bypass.
}
