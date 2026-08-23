//! Task 7/13 integration: the composite backend router exposes BOTH task-CRUD
//! tools and external-MCP tools to the Agent in one surface.

use async_trait::async_trait;
use catio_lib::agent::engine::ToolRouter;
use catio_lib::agent::provider::{ProviderError, ProviderObserver, ProviderRequest, ProviderRound};
use catio_lib::agent::{
    AgentError, ApiCredential, Provider, ProviderConfig, ProviderFactory, ToolResultStatus,
};
use catio_lib::automation::mcp_client::McpClient;
use catio_lib::automation::task_router::TaskRouter;
use catio_lib::automation::{
    AutomationStore, CompositeRouter, McpAuth, McpConnection, McpRouter, McpTransport,
};
use serde_json::json;
use std::sync::Arc;

fn store_in(dir: &std::path::Path) -> Arc<AutomationStore> {
    let _ = std::fs::remove_dir_all(dir);
    Arc::new(AutomationStore::open(dir))
}

fn mcp(id: &str, tools: Vec<&str>) -> McpConnection {
    McpConnection {
        id: id.into(),
        name: id.into(),
        transport: McpTransport::Http,
        url: "http://127.0.0.1:1/mcp".into(),
        auth: McpAuth::None,
        credential: ApiCredential::from(format!("sk-{id}")),
        tool_allowlist: vec![],
        status: Default::default(),
        discovered_tools: tools.into_iter().map(String::from).collect(),
        owner_id: "owner-a".into(),
    }
}

struct NoopProvider;
#[async_trait]
impl Provider for NoopProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        Err(ProviderError::Auth)
    }
}
struct NoopFactory;
#[async_trait]
impl ProviderFactory for NoopFactory {
    async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        Ok(Arc::new(NoopProvider))
    }
}

#[tokio::test]
async fn composite_exposes_both_task_crud_and_mcp_tools() {
    let dir = std::env::temp_dir().join(format!("catio-comp-{}", std::process::id()));
    let store = store_in(&dir);
    store.upsert_mcp(&mcp("m1", vec!["read_file"])).unwrap();

    let client = Arc::new(McpClient::new(reqwest::Client::new()));
    let composite = Arc::new(CompositeRouter::new(vec![
        Arc::new(TaskRouter::new(store.clone())),
        Arc::new(McpRouter::new(store.clone(), client)),
    ]));

    // Both tool families are advertised.
    let specs = composite.tool_specs();
    let names: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
    for want in ["list_tasks", "create_task", "delete_task", "read_file"] {
        assert!(names.iter().any(|n| n == want), "missing {want}: {names:?}");
    }

    // Task CRUD routes to the task router (owner-scoped store operation).
    let created = composite
        .dispatch("u1", "owner-a", "create_task", json!({
            "id": "t1", "name": "备份", "trigger": { "type": "once", "at": "2026-08-23T22:30:00Z" },
            "kind": "shell", "script": "echo hi", "policy": "reject", "enabled": true
        }))
        .await
        .expect("dispatched");
    assert_eq!(created.status, ToolResultStatus::Succeeded);
    assert_eq!(store.list_tasks("owner-a").len(), 1);

    // External-MCP tool name falls through task router → handled by McpRouter
    // (unreachable URL → still returns Some with a Failed status, not None).
    let mcp_res = composite
        .dispatch("u2", "owner-a", "read_file", json!({ "path": "/a" }))
        .await
        .expect("mcp tool dispatched");
    assert_eq!(mcp_res.status, ToolResultStatus::Failed); // unreachable URL → failed, but handled

    // Unknown name → None (engine reports Unsupported).
    let unknown = composite.dispatch("u3", "owner-a", "nope", json!({})).await;
    assert!(unknown.is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
