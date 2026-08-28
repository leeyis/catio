//! External MCP client — the Agent calls third-party MCP servers as a *client*.
//!
//! Protocol: MCP Streamable HTTP (one POST endpoint), JSON-RPC 2.0, protocol
//! version `2025-03-26`. The server may answer with a single JSON object or a
//! `text/event-stream`; we tolerate both by extracting `data:` payloads.
//!
//! Encode/decode are pure functions so the whole contract is testable against
//! raw fixtures without touching the network. The async `McpClient` is a thin
//! `reqwest` wrapper on top.

use super::types::{McpAuth, McpConnection, McpTransport};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

/// Protocol version we speak. Mirrors the server-side `mcp::http` default.
const PROTOCOL_VERSION: &str = "2025-03-26";

/// A single `tools/call` result, normalized to text content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolResult {
    /// Concatenated text content blocks.
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum McpError {
    #[error("mcp auth failed")]
    Auth,
    #[error("mcp http error: {0}")]
    Http(u16),
    #[error("mcp protocol error: {0}")]
    Protocol(String),
    #[error("mcp network error: {0}")]
    Network(String),
}

// ── request encoding (pure) ─────────────────────────────────────────────────

pub fn initialize_body() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "catio", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

pub fn list_tools_body() -> Value {
    json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })
}

pub fn call_tool_body(name: &str, args: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": { "name": name, "arguments": args }
    })
}

// ── response decoding (pure) ────────────────────────────────────────────────

/// Parse the `result` of a JSON-RPC response, tolerating an SSE wrapper.
/// Returns a protocol error when the server answered with a JSON-RPC error.
fn extract_result(body: &[u8]) -> Result<Value, McpError> {
    let text = String::from_utf8_lossy(body);
    let text = if text.contains("data:") {
        // text/event-stream: take the first `data:` payload as the JSON-RPC object.
        text.lines()
            .find(|l| l.trim_start().starts_with("data:"))
            .map(|l| {
                l.trim_start()
                    .trim_start_matches("data:")
                    .trim()
                    .to_string()
            })
            .ok_or_else(|| McpError::Protocol("no data: line in SSE response".into()))?
    } else {
        text.to_string()
    };
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| McpError::Protocol(format!("invalid JSON: {e}")))?;
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown jsonrpc error");
        return Err(McpError::Protocol(msg.into()));
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| McpError::Protocol("response missing result".into()))
}

/// Parse a `tools/list` response into tool names.
pub fn parse_tools_list(body: &[u8]) -> Result<Vec<String>, McpError> {
    let result = extract_result(body)?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| McpError::Protocol("tools/list result missing tools array".into()))?;
    let mut names = Vec::with_capacity(tools.len());
    for tool in tools {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| McpError::Protocol("tool missing name".into()))?;
        names.push(name.to_string());
    }
    Ok(names)
}

/// Parse a `tools/call` response into normalized text content.
pub fn parse_call_tool(body: &[u8]) -> Result<McpToolResult, McpError> {
    let result = extract_result(body)?;
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut content = String::new();
    if let Some(blocks) = result.get("content").and_then(Value::as_array) {
        for block in blocks {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                content.push_str(text);
            }
        }
    }
    Ok(McpToolResult { content, is_error })
}

// ── async client ────────────────────────────────────────────────────────────

pub struct McpClient {
    http: reqwest::Client,
    /// Connections already `initialize`-handshaked this session, keyed by
    /// `url|credential`. The handshake happens once per connection; strictly
    /// speaking MCP allows re-init, but tools must not be listed before it.
    initialized: parking_lot::Mutex<std::collections::HashSet<String>>,
}

impl McpClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            initialized: parking_lot::Mutex::new(std::collections::HashSet::new()),
        }
    }

    fn init_key(conn: &McpConnection) -> String {
        format!("{}|{}", conn.url, conn.credential.expose())
    }

    /// POST an `initialize` request once per connection. Best-effort: a server
    /// that rejects it (e.g. permissive endpoints) still proceeds to the real
    /// call — we never block a tool on the handshake.
    async fn ensure_initialized(&self, conn: &McpConnection) {
        let key = Self::init_key(conn);
        if self.initialized.lock().contains(&key) {
            return;
        }
        if self.request(conn, initialize_body()).await.is_ok() {
            self.initialized.lock().insert(key);
        }
    }

    /// Call `tools/list` and return the discovered tool names.
    pub async fn list_tools(&self, conn: &McpConnection) -> Result<Vec<String>, McpError> {
        self.ensure_initialized(conn).await;
        let body = self.request(conn, list_tools_body()).await?;
        parse_tools_list(&body)
    }

    /// Call `tools/call` for one tool.
    pub async fn call_tool(
        &self,
        conn: &McpConnection,
        name: &str,
        args: &Value,
    ) -> Result<McpToolResult, McpError> {
        let body = self.request(conn, call_tool_body(name, args)).await?;
        parse_call_tool(&body)
    }

    async fn request(&self, conn: &McpConnection, body: Value) -> Result<Vec<u8>, McpError> {
        if conn.transport != McpTransport::Http {
            return Err(McpError::Protocol(
                "only Streamable HTTP is supported".into(),
            ));
        }
        let headers = build_headers(conn)?;
        let resp = self
            .http
            .post(&conn.url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| McpError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() >= 400 {
            return match status.as_u16() {
                401 | 403 => Err(McpError::Auth),
                code => Err(McpError::Http(code)),
            };
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| McpError::Network(e.to_string()))
    }
}

fn build_headers(conn: &McpConnection) -> Result<HeaderMap, McpError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    match conn.auth {
        McpAuth::None => {}
        McpAuth::Bearer => {
            if conn.credential.expose().is_empty() {
                return Err(McpError::Auth);
            }
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", conn.credential.expose()))
                    .map_err(|e| McpError::Network(e.to_string()))?,
            );
        }
        McpAuth::Header => {
            if conn.credential.expose().is_empty() {
                return Err(McpError::Auth);
            }
            // ponytail: P0 pins the header name to X-API-Key; add a per-connection
            // header-name field if a server needs a different one.
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(conn.credential.expose())
                    .map_err(|e| McpError::Network(e.to_string()))?,
            );
        }
    }
    Ok(headers)
}
