//! External-MCP tools as a `ToolRouter`: the built-in Catio Agent can call the
//! tools of configured MCP connections.
//!
//! The router is *live* — every `tool_specs`/`dispatch` reads the store, so
//! adding/removing MCP connections (or re-testing a connection and refreshing
//! its discovered tools) is reflected on the next turn without restarting.
//!
//! Owner scoping happens in `dispatch`: a tool name only resolves to a
//! connection the turn's owner owns. `tool_specs` has no owner context (it only
//! advertises names for the provider), so on a multi-user server it advertises
//! the union; P0 desktop is single-user (`local`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::agent::engine::ToolRouter;
use crate::agent::types::{ToolResult, ToolResultStatus, ToolSpec};

use super::mcp_client::McpClient;
use super::repo::AutomationStore;

pub struct McpRouter {
    repo: Arc<AutomationStore>,
    client: Arc<McpClient>,
    /// Optional connection-id allowlist; `None` = all of the owner's
    /// connections. Used for task-scoped prompt runs.
    ids: Option<Vec<String>>,
}

impl McpRouter {
    pub fn new(repo: Arc<AutomationStore>, client: Arc<McpClient>) -> Self {
        Self {
            repo,
            client,
            ids: None,
        }
    }

    /// Router restricted to a fixed set of connection ids (scheduled task).
    pub fn scoped(repo: Arc<AutomationStore>, client: Arc<McpClient>, ids: Vec<String>) -> Self {
        Self {
            repo,
            client,
            ids: Some(ids),
        }
    }

    fn allowed_connections(&self, owner: &str) -> Vec<crate::automation::McpConnection> {
        let allow_ids = self.ids.clone();
        self.repo
            .list_mcps(owner)
            .into_iter()
            .filter(|m| allow_ids.as_ref().is_none_or(|ids| ids.contains(&m.id)))
            .collect()
    }
}

#[async_trait]
impl ToolRouter for McpRouter {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        // Advertise every configured connection's tools (the provider may
        // propose any name); `dispatch` enforces the owner + allowlist. On a
        // multi-user server this advertises the union — P0 desktop is
        // single-user.
        let allow_ids = self.ids.clone();
        let mut specs = Vec::new();
        for conn in self
            .repo
            .all_mcps()
            .into_iter()
            .filter(|m| allow_ids.as_ref().is_none_or(|ids| ids.contains(&m.id)))
        {
            for tool in &conn.discovered_tools {
                specs.push(ToolSpec {
                    name: tool.clone(),
                    description: format!("external MCP tool ({})", conn.name),
                    input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                });
            }
        }
        specs
    }

    async fn dispatch(
        &self,
        tool_use_id: &str,
        owner_id: &str,
        name: &str,
        input: Value,
    ) -> Option<ToolResult> {
        // Find the owner's connection that discovered this tool.
        let conns = self.allowed_connections(owner_id);
        let mut conn = conns
            .into_iter()
            .find(|c| c.discovered_tools.iter().any(|t| t == name))?;

        // Attach the session-only credential, then call the tool. A connection
        // with no credential this session is a real failure (tool exists but
        // can't be called), not an "unknown tool".
        let credential = match self.repo.mcp_credential(owner_id, &conn.id) {
            Some(c) => c,
            None => {
                return Some(ToolResult {
                    tool_use_id: tool_use_id.to_string(),
                    content: "mcp tool unavailable: connection credential not set this session"
                        .into(),
                    status: ToolResultStatus::Failed,
                });
            }
        };
        conn.credential = credential;

        match self.client.call_tool(&conn, name, &input).await {
            Ok(result) => Some(ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: if result.content.trim().is_empty() {
                    if result.is_error {
                        "mcp tool returned an error (no content)".to_string()
                    } else {
                        "mcp tool returned empty".to_string()
                    }
                } else {
                    result.content
                },
                status: if result.is_error {
                    ToolResultStatus::Failed
                } else {
                    ToolResultStatus::Succeeded
                },
            }),
            Err(e) => Some(ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: format!("mcp tool failed: {e}"),
                status: ToolResultStatus::Failed,
            }),
        }
    }
}
