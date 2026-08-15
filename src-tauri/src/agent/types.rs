//! Provider-neutral agent runtime contracts.
//!
//! These types are the stable seam between the Rust `AgentRuntime` and every
//! consumer (React projector, desktop adapter, server adapter, tests). Wire
//! provider formats never leak into this module.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A provider credential that exists only for the duration of a single Turn.
///
/// - `Debug` is redacted so credentials never reach logs.
/// - `Serialize` is deliberately not implemented: credentials must not enter
///   events, persistence, or wire responses.
#[derive(Clone, Deserialize)]
pub struct ApiCredential(String);

impl From<String> for ApiCredential {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl ApiCredential {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ApiCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiCredential([REDACTED])")
    }
}

/// Stable owner of a Turn; injected by the trusted transport adapter only.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActorContext {
    pub owner_id: String,
}

/// Role of a provider-neutral message.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRole {
    User,
    Assistant,
}

/// A typed, provider-neutral content block.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        status: ToolResultStatus,
    },
}

/// Terminal status of a `ToolResult` as seen by the engine.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolResultStatus {
    Succeeded,
    Failed,
    Denied,
    Blocked,
    Cancelled,
    OutcomeUnknown,
    Unsupported,
}

/// Status of a tool execution as reported by the client `ToolHost`.
///
/// The client can never construct `Denied`; denials are produced by the engine
/// only.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionStatus {
    Succeeded,
    Failed,
    Blocked,
    Cancelled,
    OutcomeUnknown,
    Unsupported,
}

/// Factual outcome of a tool execution reported by the client `ToolHost`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionOutcome {
    pub content: String,
    pub status: ToolExecutionStatus,
}

/// A structured tool intent that has not yet produced side effects.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// The unique terminal result paired with one `ToolUse`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub status: ToolResultStatus,
}

/// A message in the conversation, provider-neutral.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub role: AgentRole,
    pub content: Vec<ContentBlock>,
}

/// Tool advertisement sent to the provider.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Human decision or client fact submitted for a waiting Turn.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientTurnResponse {
    ApprovalDecision {
        tool_use_id: String,
        decision: ApprovalDecision,
    },
    ToolExecutionResult {
        tool_use_id: String,
        outcome: ToolExecutionOutcome,
    },
}

/// Approval decision for one `ToolUse`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

/// Provider wire protocol.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderProtocol {
    Openai,
    Anthropic,
    Ollama,
}

/// Authentication mode for Anthropic-compatible endpoints.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnthropicAuthMode {
    Auto,
    ApiKey,
    AuthToken,
}

/// Tool execution mode; mirrors the current product semantics.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    Manual,
    Ask,
    Auto,
}

/// Provider configuration for a single Turn.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub model: String,
    pub credential: ApiCredential,
    pub anthropic_auth_mode: AnthropicAuthMode,
}

/// A single user submission and everything it triggers.
///
/// `owner_id` is transport-owned and must never appear here; unknown fields
/// are rejected so injecting `ownerId` fails deserialization.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTurnRequest {
    pub conversation_id: String,
    /// Text-only prior user/assistant messages snapshot.
    pub messages: Vec<AgentMessage>,
    pub system_prompt: String,
    pub terminal_context: String,
    pub target_ref: String,
    pub provider: ProviderConfig,
    pub execution_mode: ExecutionMode,
    pub single_line_commands: bool,
    pub round_cap: u32,
}

impl StartTurnRequest {
    /// Validates request invariants. `round_cap` is clamped to `1..=20`;
    /// empty conversation id / model / base URL are rejected.
    pub fn validate(&self) -> Result<(), AgentError> {
        if self.conversation_id.is_empty() {
            return Err(AgentError::InvalidRequest(
                "conversation_id is required".into(),
            ));
        }
        if self.provider.model.is_empty() {
            return Err(AgentError::InvalidRequest(
                "provider.model is required".into(),
            ));
        }
        if self.provider.base_url.is_empty() {
            return Err(AgentError::InvalidRequest(
                "provider.base_url is required".into(),
            ));
        }
        if !(1..=20).contains(&self.round_cap) {
            return Err(AgentError::InvalidRequest(
                "round_cap must be in 1..=20".into(),
            ));
        }
        Ok(())
    }
}

/// Opaque handle returned to the caller of `start_turn`; never leaks internal
/// channels or provider types.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnHandle {
    pub turn_id: String,
}

/// Stable UI-facing event; provider wire events never cross this boundary.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    TurnStarted,
    AssistantMessageStarted {
        message_id: String,
        round: u32,
    },
    TextDelta {
        message_id: String,
        delta: String,
    },
    ThinkingDelta {
        message_id: String,
        delta: String,
    },
    AssistantMessageFinished {
        message_id: String,
    },
    ToolProposed {
        tool_use_id: String,
        name: String,
        input: Value,
        risk: Vec<String>,
    },
    ApprovalRequested {
        tool_use_id: String,
        reason: String,
    },
    ToolExecutionRequested {
        tool_use_id: String,
        target: String,
        input: Value,
    },
    ToolStarted {
        tool_use_id: String,
    },
    ToolOutputDelta {
        tool_use_id: String,
        delta: String,
    },
    ToolFinished {
        tool_use_id: String,
        result: ToolResult,
    },
    UsageUpdated {
        input_tokens: u64,
        output_tokens: u64,
    },
    CompatibilityFallbackActivated {
        provider: String,
        reason: String,
    },
    TurnFinished,
    TurnCancelled,
    TurnFailed {
        code: String,
        message: String,
    },
}

/// Ordered envelope for every event emitted within a Turn.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub owner_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub sequence: u64,
    pub event: AgentEvent,
}

/// Stable error codes; `code()` returns the wire-facing identifier.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum AgentError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("owner mismatch for turn")]
    OwnerMismatch,
    #[error("turn not found")]
    TurnNotFound,
    #[error("turn already completed")]
    TurnCompleted,
    #[error("response conflicts with already-consumed response")]
    ResponseConflict,
    #[error("turn state conflict: {0}")]
    TurnStateConflict(String),
    #[error("provider authentication failed")]
    ProviderAuth,
    #[error("provider rate limited")]
    ProviderRateLimit,
    #[error("provider http error: {0}")]
    ProviderHttp(String),
    #[error("provider protocol error: {0}")]
    ProviderProtocol(String),
    #[error("provider stream ended unexpectedly")]
    ProviderUnexpectedEof,
    #[error("provider does not support tools")]
    ToolsUnsupported,
    #[error("approval unavailable: {0}")]
    ApprovalUnavailable(String),
    #[error("approval timed out")]
    ApprovalTimeout,
    #[error("approval denied")]
    ApprovalDenied,
    #[error("tool bridge timed out")]
    ToolBridgeTimeout,
    #[error("tool bridge disconnected: {0}")]
    ToolBridgeDisconnected(String),
    #[error("target blocked: {0}")]
    TargetBlocked(String),
    #[error("target unsupported: {0}")]
    TargetUnsupported(String),
    #[error("turn cancelled")]
    TurnCancelled,
    #[error("tools-disabled synthesis violated: {0}")]
    ToolsDisabledSynthesisViolated(String),
    #[error("round cap synthesis failed: {0}")]
    RoundCapSynthesisFailed(String),
    #[error("event sink failed: {0}")]
    EventSink(String),
    #[error("internal engine error: {0}")]
    Internal(String),
}

impl AgentError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "invalidRequest",
            Self::OwnerMismatch => "ownerMismatch",
            Self::TurnNotFound => "turnNotFound",
            Self::TurnCompleted => "turnCompleted",
            Self::ResponseConflict => "responseConflict",
            Self::TurnStateConflict(_) => "turnStateConflict",
            Self::ProviderAuth => "providerAuth",
            Self::ProviderRateLimit => "providerRateLimit",
            Self::ProviderHttp(_) => "providerHttp",
            Self::ProviderProtocol(_) => "providerProtocol",
            Self::ProviderUnexpectedEof => "providerUnexpectedEof",
            Self::ToolsUnsupported => "toolsUnsupported",
            Self::ApprovalUnavailable(_) => "approvalUnavailable",
            Self::ApprovalTimeout => "approvalTimeout",
            Self::ApprovalDenied => "approvalDenied",
            Self::ToolBridgeTimeout => "toolBridgeTimeout",
            Self::ToolBridgeDisconnected(_) => "toolBridgeDisconnected",
            Self::TargetBlocked(_) => "targetBlocked",
            Self::TargetUnsupported(_) => "targetUnsupported",
            Self::TurnCancelled => "turnCancelled",
            Self::ToolsDisabledSynthesisViolated(_) => "toolsDisabledSynthesisViolated",
            Self::RoundCapSynthesisFailed(_) => "roundCapSynthesisFailed",
            Self::EventSink(_) => "eventSink",
            Self::Internal(_) => "internal",
        }
    }
}

/// Token usage normalized across providers.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// The response the engine is currently waiting for. Set by the engine before
/// the matching UI event is emitted, so `respond` can validate against it
/// without racing the engine task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpectedResponse {
    None,
    Approval { tool_use_id: String },
    ToolResult { tool_use_id: String },
}

impl ExpectedResponse {
    /// True when `response` is exactly what the engine is waiting for.
    pub fn matches(&self, response: &ClientTurnResponse) -> bool {
        match (self, response) {
            (
                ExpectedResponse::Approval { tool_use_id },
                ClientTurnResponse::ApprovalDecision {
                    tool_use_id: id, ..
                },
            ) => tool_use_id == id,
            (
                ExpectedResponse::ToolResult { tool_use_id },
                ClientTurnResponse::ToolExecutionResult {
                    tool_use_id: id, ..
                },
            ) => tool_use_id == id,
            _ => false,
        }
    }

    /// Stable key for response deduplication.
    pub fn key(&self) -> (&'static str, Option<&str>) {
        match self {
            ExpectedResponse::None => ("none", None),
            ExpectedResponse::Approval { tool_use_id } => ("approval", Some(tool_use_id)),
            ExpectedResponse::ToolResult { tool_use_id } => ("toolResult", Some(tool_use_id)),
        }
    }
}
