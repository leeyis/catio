//! Catio Agent runtime: provider streaming, typed tool loop, approval state,
//! cancellation and ordered events, UI-agnostic.
//!
//! This module is the only public surface for the Rust agent engine.

pub mod legacy;
pub mod policy;
pub mod types;

pub use legacy::{first_shell_tool, LegacyParseError};
pub use policy::{PolicyDecision, ToolPolicy, ToolRisk};
pub use types::{
    ActorContext, AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole,
    ApiCredential, ApprovalDecision, ClientTurnResponse, ContentBlock, ExecutionMode,
    ProviderConfig, ProviderProtocol, StartTurnRequest, TokenUsage, ToolExecutionOutcome,
    ToolExecutionStatus, ToolResult, ToolResultStatus, ToolSpec, ToolUse, TurnHandle,
};
