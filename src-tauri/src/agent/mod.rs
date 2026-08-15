//! Catio Agent runtime: provider streaming, typed tool loop, approval state,
//! cancellation and ordered events, UI-agnostic.
//!
//! This module is the only public surface for the Rust agent engine.

pub mod bridge;
pub mod commands;
pub mod engine;
pub mod legacy;
pub mod policy;
pub mod provider;
pub mod runtime;
pub mod types;

pub use bridge::{ClientBridge, NoopBridge, RuntimeBridge};
pub use engine::{AgentEventSink, SequenceEmitter, TurnContext, TurnEngine};
pub use legacy::{first_shell_tool, LegacyParseError};
pub use policy::{PolicyDecision, ToolPolicy, ToolRisk};
pub use provider::{
    Provider, ProviderError, ProviderObserver, ProviderRequest, ProviderRound, ProviderStop,
};
pub use runtime::{AgentRuntime, ProviderFactory};
pub use types::{
    ActorContext, AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole,
    AnthropicAuthMode, ApiCredential, ApprovalDecision, ClientTurnResponse, ContentBlock,
    ExecutionMode, ExpectedResponse, ProviderConfig, ProviderProtocol, StartTurnRequest,
    TokenUsage, ToolExecutionOutcome, ToolExecutionStatus, ToolResult, ToolResultStatus, ToolSpec,
    ToolUse, TurnHandle,
};
