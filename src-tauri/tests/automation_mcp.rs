//! Task 2 contract tests: external MCP client over Streamable HTTP.
//!
//! Pure parse/encode functions are tested against raw fixtures (no network). One
//! integration test drives a real `McpClient::list_tools` against a local
//! loopback listener to prove the full request/parse chain — still no external
//! network.

use catio_lib::agent::ApiCredential;
use catio_lib::automation::mcp_client::{
    call_tool_body, initialize_body, list_tools_body, parse_call_tool, parse_tools_list, McpClient,
};
use catio_lib::automation::{McpAuth, McpConnection, McpTransport};

fn conn(url: &str) -> McpConnection {
    McpConnection {
        id: "m1".into(),
        name: "Filesystem".into(),
        transport: McpTransport::Http,
        url: url.into(),
        auth: McpAuth::None,
        credential: ApiCredential::from(String::new()),
        tool_allowlist: vec![],
        status: Default::default(),
        discovered_tools: vec![],
        owner_id: "owner-a".into(),
    }
}

// ── request encoding ────────────────────────────────────────────────────────

#[test]
fn initialize_body_is_jsonrpc_with_protocol_version() {
    let v = initialize_body();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["method"], "initialize");
    assert_eq!(v["params"]["protocolVersion"], "2025-03-26");
    assert!(v["params"]["clientInfo"]["name"].as_str().unwrap().len() > 0);
    assert!(v.get("id").is_some());
}

#[test]
fn list_tools_body_is_jsonrpc() {
    let v = list_tools_body();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["method"], "tools/list");
}

#[test]
fn call_tool_body_includes_name_and_arguments() {
    let args = serde_json::json!({ "path": "/tmp/a" });
    let v = call_tool_body("read_file", &args);
    assert_eq!(v["method"], "tools/call");
    assert_eq!(v["params"]["name"], "read_file");
    assert_eq!(v["params"]["arguments"]["path"], "/tmp/a");
}

// ── response decoding (raw fixtures, no network) ────────────────────────────

#[test]
fn parses_tools_list_from_fixture() {
    let body = include_bytes!("fixtures/automation/mcp_list_tools.json");
    let tools = parse_tools_list(body).unwrap();
    assert_eq!(tools, vec!["read_file", "write_file", "list_directory"]);
}

#[test]
fn parses_call_tool_result_concatenating_text_content() {
    let body = include_bytes!("fixtures/automation/mcp_call_tool.json");
    let res = parse_call_tool(body).unwrap();
    assert!(res.content.contains("file.txt 2048 bytes"));
    assert!(res.content.contains("modified 2h ago"));
    assert!(!res.is_error);
}

#[test]
fn rejects_jsonrpc_error() {
    let body = include_bytes!("fixtures/automation/mcp_error.json");
    let err = parse_tools_list(body).unwrap_err();
    assert!(err.to_string().contains("Method not found"));
    let err2 = parse_call_tool(body).unwrap_err();
    assert!(err2.to_string().contains("Method not found"));
}

#[test]
fn rejects_response_without_tools_field() {
    let body = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
    assert!(parse_tools_list(body).is_err());
}

#[test]
fn rejects_non_json_body() {
    assert!(parse_tools_list(b"<html>oops</html>").is_err());
}

#[test]
fn parses_sse_wrapped_data_line() {
    // A server may respond `text/event-stream`; the data line holds the JSON-RPC
    // object. We tolerate it by extracting `data:` payloads.
    let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"ping\"}]}}\n\n";
    let tools = parse_tools_list(sse.as_bytes()).unwrap();
    assert_eq!(tools, vec!["ping"]);
}

// ── integration: full list_tools against a local loopback listener ──────────

#[tokio::test]
async fn list_tools_round_trips_over_local_http() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        // Two sequential POSTs per call: the best-effort `initialize`
        // handshake, then the real `tools/list`.
        for _ in 0..2 {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await.unwrap();
            // Assert the client sent the auth/accept headers we expect.
            let req = String::from_utf8_lossy(&buf);
            assert!(
                req.to_lowercase()
                    .contains("accept: application/json, text/event-stream"),
                "missing accept header: {req}"
            );
            let body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ping"}]}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });

    // no_proxy: loopback requests must never traverse a system proxy (macOS
    // system-configuration support in reqwest routes them through e.g. Clash).
    let client = McpClient::new(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("loopback http client"),
    );
    let tools = client
        .list_tools(&conn(&format!("http://{addr}")))
        .await
        .unwrap();
    assert_eq!(tools, vec!["ping"]);
    handle.await.unwrap();
}

#[tokio::test]
async fn list_tools_sends_bearer_credential() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        // Two sequential POSTs per call: the best-effort `initialize`
        // handshake, then the real `tools/list`.
        for _ in 0..2 {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf);
            assert!(
                req.to_lowercase()
                    .contains("authorization: bearer sk-secret"),
                "missing bearer auth: {req}"
            );
            let body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });

    let mut c = conn(&format!("http://{addr}"));
    c.auth = McpAuth::Bearer;
    c.credential = ApiCredential::from("sk-secret".to_string());
    let client = McpClient::new(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("loopback http client"),
    );
    let _ = client.list_tools(&c).await.unwrap();
    handle.await.unwrap();
}
