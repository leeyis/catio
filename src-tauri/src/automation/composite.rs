//! A `ToolRouter` that fans out to several backend routers (task-CRUD tools,
//! external-MCP tools, …). The first router that handles a tool name wins;
//! otherwise the composite falls through (`None` → engine reports
//! `Unsupported`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::agent::engine::ToolRouter;
use crate::agent::types::{ToolResult, ToolSpec};

pub struct CompositeRouter {
    routers: Vec<Arc<dyn ToolRouter>>,
}

impl CompositeRouter {
    pub fn new(routers: Vec<Arc<dyn ToolRouter>>) -> Self {
        Self { routers }
    }
}

#[async_trait]
impl ToolRouter for CompositeRouter {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.routers.iter().flat_map(|r| r.tool_specs()).collect()
    }

    async fn dispatch(
        &self,
        tool_use_id: &str,
        owner_id: &str,
        name: &str,
        input: Value,
    ) -> Option<ToolResult> {
        for router in &self.routers {
            if let Some(result) = router
                .dispatch(tool_use_id, owner_id, name, input.clone())
                .await
            {
                return Some(result);
            }
        }
        None
    }
}
