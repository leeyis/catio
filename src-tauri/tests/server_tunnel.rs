//! 端口转发(隧道)over HTTP。验证 /api/invoke 暴露了 tunnel_open/tunnel_close/tunnel_list,
//! 且像其它 live 资源一样按 owner 隔离:一个用户看不到、也关不掉另一个用户的隧道。
//!
//! 与 server_sftp.rs 不同,这里**确实**用 in-process 测试 SSH server 建立真实会话——隧道的
//! direct-tcpip 桥接需要一个活的 russh 会话,测试 server 的 echo 行为足够建立 L 转发。

mod common;
use common::test_server;

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
    let res = cl
        .post(format!("{base}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args }))
        .send()
        .await
        .unwrap();
    let st = res.status().as_u16();
    (st, res.json::<Value>().await.unwrap_or(Value::Null))
}

async fn admin_and_bob(base: &str) -> (reqwest::Client, reqwest::Client) {
    let admin = jar();
    invoke(&admin, base, "auth_bootstrap", json!({ "username": "admin", "password": "secret123" })).await;
    invoke(&admin, base, "user_create", json!({ "username": "bob", "password": "secret123", "isAdmin": false })).await;
    let bob = jar();
    invoke(&bob, base, "auth_login", json!({ "username": "bob", "password": "secret123" })).await;
    (admin, bob)
}

/// 用 HTTP 在测试 SSH server 上建一条真实会话,返回其 sessionId(归属该 client 对应的用户)。
async fn ssh_connect(cl: &reqwest::Client, base: &str, ssh: &SocketAddr) -> String {
    let (st, body) = invoke(
        cl,
        base,
        "ssh_connect",
        json!({ "args": {
            "host": ssh.ip().to_string(),
            "port": ssh.port(),
            "user": test_server::TEST_USER,
            "auth": { "method": "password" },
            "secret": test_server::TEST_PW,
        }}),
    )
    .await;
    assert_eq!(st, 200, "ssh_connect should succeed against test server: {body}");
    body["sessionId"].as_str().expect("sessionId").to_string()
}

/// 三个隧道命令都已 over web 暴露(不再返回 "command not exposed yet")。
#[tokio::test]
async fn tunnel_commands_are_exposed_over_web() {
    let base = start().await;
    let (admin, _bob) = admin_and_bob(&base).await;

    // tunnel_list 无 sessionId,直接到达 dispatch:已路由 → 200 + 空数组。
    let (st, body) = invoke(&admin, &base, "tunnel_list", json!({})).await;
    assert_eq!(st, 200, "{body}");
    assert!(body.is_array(), "tunnel_list should return an array: {body}");
    assert_eq!(body.as_array().unwrap().len(), 0);

    // tunnel_close 走 dispatch(无 sessionId 门控);bogus id 被 owner 校验拒绝,但绝不是 "not exposed"。
    let (_st, body) = invoke(&admin, &base, "tunnel_close", json!({ "tunnelId": "nope" })).await;
    let err = body["error"].as_str().unwrap_or("");
    assert!(!err.contains("not exposed"), "tunnel_close must be routed, got: {err}");

    // tunnel_open 带 bogus sessionId:被 owner 门控拦在 "session not found",同样不是 "not exposed"。
    let (st, body) = invoke(
        &admin,
        &base,
        "tunnel_open",
        json!({ "sessionId": "nope", "spec": { "kind": "L", "bind": "127.0.0.1:0", "target": "echo:9" } }),
    )
    .await;
    assert_eq!(st, 400, "{body}");
    let err = body["error"].as_str().unwrap_or("");
    assert!(!err.contains("not exposed"), "tunnel_open must be routed, got: {err}");
}

/// 端到端:admin 建会话 + 开 L 转发 → 列表可见;bob 看不到也关不掉;admin 自己能关。
#[tokio::test]
async fn tunnel_open_list_close_is_per_user_isolated() {
    let ssh = test_server::start().await;
    let base = start().await;
    let (admin, bob) = admin_and_bob(&base).await;

    let sid = ssh_connect(&admin, &base, &ssh).await;

    // admin 开一条 L 转发(target 任意,测试 server 一律 echo)。
    let (st, body) = invoke(
        &admin,
        &base,
        "tunnel_open",
        json!({ "sessionId": sid, "spec": { "kind": "L", "bind": "127.0.0.1:0", "target": "echo:9" } }),
    )
    .await;
    assert_eq!(st, 200, "admin tunnel_open should succeed: {body}");
    let tid = body.as_str().expect("tunnel id string").to_string();

    // admin 列表能看到这条隧道。
    let (_, body) = invoke(&admin, &base, "tunnel_list", json!({})).await;
    let arr = body.as_array().unwrap();
    assert_eq!(arr.len(), 1, "admin should see its tunnel: {body}");
    assert_eq!(arr[0]["id"], tid);
    assert_eq!(arr[0]["kind"], "L");

    // bob 看不到 admin 的隧道(owner 隔离)。
    let (_, body) = invoke(&bob, &base, "tunnel_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 0, "bob must not see admin's tunnel: {body}");

    // bob 关不掉 admin 的隧道。
    let (_, _) = invoke(&bob, &base, "tunnel_close", json!({ "tunnelId": tid })).await;
    let (_, body) = invoke(&admin, &base, "tunnel_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 1, "bob's close must not affect admin's tunnel: {body}");

    // admin 自己能关。
    let (st, _) = invoke(&admin, &base, "tunnel_close", json!({ "tunnelId": tid })).await;
    assert_eq!(st, 200);
    let (_, body) = invoke(&admin, &base, "tunnel_list", json!({})).await;
    assert_eq!(body.as_array().unwrap().len(), 0, "admin's tunnel should be gone after close: {body}");
}
