//! Task 13 contract tests: McpRouter (external-MCP tools as ToolRouter).
//! One integration test drives a real HTTP round-trip against a loopback
//! JSON-RPC "MCP server" — no external network.

use async_trait::async_trait;
use catio_lib::agent::engine::ToolRouter;
use catio_lib::agent::{ApiCredential, ToolResultStatus};
use catio_lib::automation::mcp_client::McpClient;
use catio_lib::automation::{AutomationStore, McpAuth, McpConnection, McpRouter, McpTransport};
use serde_json::json;
use std::sync::Arc;

fn mcp(id: &str, url: &str, tools: Vec<&str>, owner: &str) -> McpConnection {
    McpConnection {
        id: id.into(),
        name: id.into(),
        transport: McpTransport::Http,
        url: url.into(),
        auth: McpAuth::None,
        credential: ApiCredential::from(format!("sk-{id}")),
        tool_allowlist: vec![],
        status: Default::default(),
        discovered_tools: tools.into_iter().map(String::from).collect(),
        owner_id: owner.into(),
    }
}

fn store_in(dir: &std::path::Path) -> Arc<AutomationStore> {
    let _ = std::fs::remove_dir_all(dir);
    Arc::new(AutomationStore::open(dir))
}

#[test]
fn tool_specs_include_configured_connections_tools() {
    let dir = std::env::temp_dir().join(format!("catio-mr-spec-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .upsert_mcp(&mcp(
            "m1",
            "http://127.0.0.1:1/mcp",
            vec!["read_file", "write_file"],
            "owner-a",
        ))
        .unwrap();
    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let router = McpRouter::new(store.clone(), client);
    let specs = router.tool_specs();
    let names: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
    assert!(names.iter().any(|n| n.as_str() == "read_file"));
    assert!(names.iter().any(|n| n.as_str() == "write_file"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn scoped_router_only_exposes_allowed_connections() {
    let dir = std::env::temp_dir().join(format!("catio-mr-scope-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .upsert_mcp(&mcp(
            "m1",
            "http://127.0.0.1:1/a",
            vec!["read_file"],
            "owner-a",
        ))
        .unwrap();
    store
        .upsert_mcp(&mcp(
            "m2",
            "http://127.0.0.1:1/b",
            vec!["github_api"],
            "owner-a",
        ))
        .unwrap();
    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let router = McpRouter::scoped(store.clone(), client, vec!["m1".into()]);
    let names: Vec<String> = router.tool_specs().iter().map(|s| s.name.clone()).collect();
    assert!(names.iter().any(|n| n.as_str() == "read_file"));
    assert!(
        !names.iter().any(|n| n.as_str() == "github_api"),
        "scoped router leaked other connection tools"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn dispatch_resolves_tool_to_owners_connection_and_calls_over_http() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("catio-mr-live-{}", std::process::id()));

    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let _ = sock.read(&mut buf).await.unwrap();
        // Respond to any request (initialize/tools/call) with a tools/call result.
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"file: hello"}],"isError":false}}"#;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(resp.as_bytes()).await;
    });

    let store = store_in(&dir);
    let url = format!("http://{addr}/mcp");
    store
        .upsert_mcp(&mcp("m1", &url, vec!["read_file"], "owner-a"))
        .unwrap();
    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let router = McpRouter::new(store.clone(), client);

    let result = router
        .dispatch("u1", "owner-a", "read_file", json!({ "path": "/a" }))
        .await
        .expect("dispatched");
    assert_eq!(result.status, ToolResultStatus::Succeeded);
    assert!(result.content.contains("hello"), "got: {}", result.content);
    handle.await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn dispatch_ignores_other_owners_connections() {
    let dir = std::env::temp_dir().join(format!("catio-mr-owner-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .upsert_mcp(&mcp(
            "m1",
            "http://127.0.0.1:1/mcp",
            vec!["read_file"],
            "owner-a",
        ))
        .unwrap();
    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let router = McpRouter::new(store.clone(), client);
    // Owner B doesn't own m1 → no match → falls through.
    let result = router
        .dispatch("u1", "owner-b", "read_file", json!({}))
        .await;
    assert!(result.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unknown_tool_falls_through() {
    let dir = std::env::temp_dir().join(format!("catio-mr-unk-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .upsert_mcp(&mcp(
            "m1",
            "http://127.0.0.1:1/mcp",
            vec!["read_file"],
            "owner-a",
        ))
        .unwrap();
    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let router = McpRouter::new(store.clone(), client);
    let result = router.dispatch("u1", "owner-a", "nope", json!({})).await;
    assert!(result.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
