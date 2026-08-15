//! Client bridge port: approval decisions and tool execution are brokered
//! through this seam so the engine never touches UI or transport directly.

use async_trait::async_trait;
use serde_json::Value;

use crate::agent::types::{AgentError, ApprovalDecision, ToolExecutionOutcome};

/// Broker for human decisions and client `ToolHost` outcomes.
#[async_trait]
pub trait ClientBridge: Send + Sync {
    async fn request_approval(
        &self,
        tool_use_id: &str,
        reason: &str,
    ) -> Result<ApprovalDecision, AgentError>;

    async fn execute_tool(
        &self,
        tool_use_id: &str,
        target: &str,
        input: Value,
    ) -> Result<ToolExecutionOutcome, AgentError>;
}

/// Bridge that never executes; used where a turn has no tool path.
pub struct NoopBridge;

#[async_trait]
impl ClientBridge for NoopBridge {
    async fn request_approval(
        &self,
        _tool_use_id: &str,
        _reason: &str,
    ) -> Result<ApprovalDecision, AgentError> {
        Ok(ApprovalDecision::Allow)
    }

    async fn execute_tool(
        &self,
        _tool_use_id: &str,
        _target: &str,
        _input: Value,
    ) -> Result<ToolExecutionOutcome, AgentError> {
        Err(AgentError::Internal(
            "noop bridge cannot execute tools".into(),
        ))
    }
}
