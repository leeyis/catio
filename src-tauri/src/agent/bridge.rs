//! Client bridge port: approval decisions and tool execution are brokered
//! through this seam so the engine never touches UI or transport directly.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::agent::types::{
    AgentError, ApprovalDecision, ClientTurnResponse, ExpectedResponse, ToolExecutionOutcome,
    ToolExecutionStatus,
};

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

/// Production bridge for an active Turn: waits on the `AgentRuntime` response
/// channel and honours the cancel token.
pub struct RuntimeBridge {
    receiver: Arc<Mutex<mpsc::UnboundedReceiver<ClientTurnResponse>>>,
    cancel_token: CancellationToken,
}

impl RuntimeBridge {
    pub fn new(
        receiver: mpsc::UnboundedReceiver<ClientTurnResponse>,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            receiver: Arc::new(Mutex::new(receiver)),
            cancel_token,
        }
    }

    async fn recv_matching(
        &self,
        expected: &ExpectedResponse,
    ) -> Result<ClientTurnResponse, AgentError> {
        loop {
            let response = self
                .receiver
                .lock()
                .await
                .recv()
                .await
                .ok_or(AgentError::TurnNotFound)?;
            if expected.matches(&response) {
                return Ok(response);
            }
            // Defensive: a mismatched response was already rejected by
            // `AgentRuntime::respond`; skip anything unexpected.
        }
    }
}

#[async_trait]
impl ClientBridge for RuntimeBridge {
    async fn request_approval(
        &self,
        tool_use_id: &str,
        _reason: &str,
    ) -> Result<ApprovalDecision, AgentError> {
        let expected = ExpectedResponse::Approval {
            tool_use_id: tool_use_id.to_string(),
        };
        tokio::select! {
            response = self.recv_matching(&expected) => match response? {
                ClientTurnResponse::ApprovalDecision { decision, .. } => Ok(decision),
                _ => Err(AgentError::TurnStateConflict("wrong response kind".into())),
            },
            _ = self.cancel_token.cancelled() => Err(AgentError::TurnCancelled),
        }
    }

    async fn execute_tool(
        &self,
        tool_use_id: &str,
        _target: &str,
        _input: Value,
    ) -> Result<ToolExecutionOutcome, AgentError> {
        let expected = ExpectedResponse::ToolResult {
            tool_use_id: tool_use_id.to_string(),
        };
        tokio::select! {
            response = self.recv_matching(&expected) => match response? {
                ClientTurnResponse::ToolExecutionResult { outcome, .. } => Ok(outcome),
                _ => Err(AgentError::TurnStateConflict("wrong response kind".into())),
            },
            // The dispatch already happened; cancellation cannot prove the
            // target stopped, so the outcome stays unknown.
            _ = self.cancel_token.cancelled() => Ok(ToolExecutionOutcome {
                content: "cancelled; outcome unknown".into(),
                status: ToolExecutionStatus::OutcomeUnknown,
            }),
        }
    }
}
