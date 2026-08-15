//! Turn engine: provider rounds, tool policy, approval, execution pairing,
//! event sequencing and the terminal invariant. `TurnContext` injects
//! provider, event sink, client bridge and cancel token; the engine reads no
//! global state.

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::agent::bridge::ClientBridge;
use crate::agent::policy::{PolicyDecision, ToolPolicy};
use crate::agent::provider::{Provider, ProviderError, ProviderRequest, ProviderRound};
use crate::agent::types::{
    AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, ApprovalDecision, ContentBlock,
    ExecutionMode, StartTurnRequest, ToolExecutionStatus, ToolResult, ToolResultStatus, ToolSpec,
    ToolUse,
};

/// The only structured tool supported by P0.
pub const TERMINAL_EXEC: &str = "terminal_exec";

/// Ordered event delivery for one Turn.
#[async_trait]
pub trait AgentEventSink: Send + Sync {
    async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError>;
}

/// Everything a Turn needs; constructed by `AgentRuntime` (or tests) only.
pub struct TurnContext {
    pub owner_id: String,
    pub turn_id: String,
    pub request: StartTurnRequest,
    pub provider: Arc<dyn Provider>,
    pub sink: Arc<dyn AgentEventSink>,
    pub bridge: Arc<dyn ClientBridge>,
    pub cancel_token: CancellationToken,
}

/// The only component that can create `AgentEventEnvelope`s. Emits a strictly
/// increasing sequence and refuses any event after the terminal one.
pub struct SequenceEmitter {
    owner_id: String,
    conversation_id: String,
    turn_id: String,
    sink: Arc<dyn AgentEventSink>,
    sequence: u64,
    terminal_emitted: bool,
}

impl SequenceEmitter {
    pub fn new(
        owner_id: String,
        conversation_id: String,
        turn_id: String,
        sink: Arc<dyn AgentEventSink>,
    ) -> Self {
        Self {
            owner_id,
            conversation_id,
            turn_id,
            sink,
            sequence: 0,
            terminal_emitted: false,
        }
    }

    pub async fn emit(&mut self, event: AgentEvent) -> Result<(), AgentError> {
        if self.terminal_emitted {
            return Err(AgentError::Internal("emit after terminal event".into()));
        }
        self.sequence += 1;
        let envelope = AgentEventEnvelope {
            owner_id: self.owner_id.clone(),
            conversation_id: self.conversation_id.clone(),
            turn_id: self.turn_id.clone(),
            sequence: self.sequence,
            event,
        };
        let terminal = matches!(
            envelope.event,
            AgentEvent::TurnFinished | AgentEvent::TurnCancelled | AgentEvent::TurnFailed { .. }
        );
        self.sink
            .emit(envelope)
            .await
            .map_err(|e| AgentError::EventSink(e.to_string()))?;
        if terminal {
            self.terminal_emitted = true;
        }
        Ok(())
    }
}

impl Drop for SequenceEmitter {
    fn drop(&mut self) {
        debug_assert!(
            self.terminal_emitted,
            "TurnEngine must emit exactly one terminal event"
        );
    }
}

/// Synchronous provider observer buffering deltas; the engine drains them in
/// arrival order after the round completes (the sink is async).
struct EngineObserver {
    deltas: Mutex<Vec<Delta>>,
    message_id: String,
}

enum Delta {
    Text(String),
    Thinking(String),
}

impl EngineObserver {
    fn new(message_id: String) -> Self {
        Self {
            deltas: Mutex::new(Vec::new()),
            message_id,
        }
    }

    fn drain(self) -> Vec<Delta> {
        self.deltas.into_inner()
    }
}

impl crate::agent::provider::ProviderObserver for EngineObserver {
    fn text_delta(&self, delta: &str) {
        self.deltas.lock().push(Delta::Text(delta.to_string()));
    }

    fn thinking_delta(&self, delta: &str) {
        self.deltas.lock().push(Delta::Thinking(delta.to_string()));
    }
}

/// Provider/tool loop for one Turn.
pub struct TurnEngine;

impl TurnEngine {
    pub async fn run(&self, ctx: TurnContext) -> Result<(), AgentError> {
        let mut emitter = SequenceEmitter::new(
            ctx.owner_id.clone(),
            ctx.request.conversation_id.clone(),
            ctx.turn_id.clone(),
            ctx.sink.clone(),
        );
        emitter.emit(AgentEvent::TurnStarted).await?;

        let mut messages = ctx.request.messages.clone();
        let round_cap = ctx.request.round_cap.max(1);
        let mode = ctx.request.execution_mode;
        let single_line = ctx.request.single_line_commands;
        let target = ctx.request.target_ref.clone();

        // manual mode never advertises tools; deny and round cap disable them
        // for exactly one tools-disabled synthesis.
        let mut tools_disabled = matches!(mode, ExecutionMode::Manual);
        let mut used_rounds: u32 = 0;

        loop {
            if ctx.cancel_token.is_cancelled() {
                emitter.emit(AgentEvent::TurnCancelled).await?;
                return Err(AgentError::TurnCancelled);
            }
            if used_rounds >= round_cap {
                tools_disabled = true;
            }
            used_rounds += 1;

            let tools = if tools_disabled {
                Vec::new()
            } else {
                vec![terminal_exec_spec()]
            };
            let provider_request = ProviderRequest {
                system_prompt: ctx.request.system_prompt.clone(),
                messages: messages.clone(),
                tools,
                target_ref: target.clone(),
                execution_mode: mode,
                single_line_commands: single_line,
            };

            let round_index = used_rounds - 1;
            let message_id = format!("{}-m{}", ctx.turn_id, round_index);
            emitter
                .emit(AgentEvent::AssistantMessageStarted {
                    message_id: message_id.clone(),
                    round: round_index,
                })
                .await?;

            let observer = EngineObserver::new(message_id.clone());
            let round = match ctx.provider.complete(provider_request, &observer).await {
                Ok(round) => round,
                Err(err) => {
                    let code = err.code().to_string();
                    let message = err.to_string();
                    emitter
                        .emit(AgentEvent::TurnFailed { code, message })
                        .await?;
                    return Err(map_provider_error(err));
                }
            };

            for delta in observer.drain() {
                let event = match delta {
                    Delta::Text(delta) => AgentEvent::TextDelta {
                        message_id: message_id.clone(),
                        delta,
                    },
                    Delta::Thinking(delta) => AgentEvent::ThinkingDelta {
                        message_id: message_id.clone(),
                        delta,
                    },
                };
                emitter.emit(event).await?;
            }

            emitter
                .emit(AgentEvent::AssistantMessageFinished {
                    message_id: message_id.clone(),
                })
                .await?;

            if let Some(usage) = round.usage {
                emitter
                    .emit(AgentEvent::UsageUpdated {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                    })
                    .await?;
            }

            let tool_uses: Vec<ToolUse> = round
                .message
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, input } => Some(ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    }),
                    _ => None,
                })
                .collect();

            if tool_uses.is_empty() {
                emitter.emit(AgentEvent::TurnFinished).await?;
                return Ok(());
            }

            if tools_disabled {
                let message =
                    "provider requested tools during tools-disabled synthesis".to_string();
                emitter
                    .emit(AgentEvent::TurnFailed {
                        code: "toolsDisabledSynthesisViolated".into(),
                        message: message.clone(),
                    })
                    .await?;
                return Err(AgentError::ToolsDisabledSynthesisViolated(message));
            }

            let mut any_denied = false;
            let mut results = Vec::new();
            for tool_use in &tool_uses {
                let result =
                    Self::process_tool(&ctx, &mut emitter, tool_use, mode, single_line, &target)
                        .await?;
                if result.status == ToolResultStatus::Denied {
                    any_denied = true;
                }
                results.push(result);
            }

            // Append the typed assistant round plus engine-created tool results
            // to the in-turn history.
            messages.push(round.message.clone());
            if let Some(last) = messages.last_mut() {
                for result in &results {
                    last.content.push(ContentBlock::ToolResult {
                        tool_use_id: result.tool_use_id.clone(),
                        content: result.content.clone(),
                        status: result.status.clone(),
                    });
                }
            }

            // A denial allows exactly one tools-disabled final synthesis.
            if any_denied {
                tools_disabled = true;
            }
        }
    }

    /// One tool transition: validate → propose → policy → optional approval →
    /// dispatch → outcome → paired terminal result.
    async fn process_tool(
        ctx: &TurnContext,
        emitter: &mut SequenceEmitter,
        tool_use: &ToolUse,
        mode: ExecutionMode,
        single_line: bool,
        target: &str,
    ) -> Result<ToolResult, AgentError> {
        let tool_use_id = tool_use.id.clone();
        let name = tool_use.name.as_str();
        if name != TERMINAL_EXEC {
            let result = ToolResult {
                tool_use_id: tool_use_id.clone(),
                content: format!("unknown tool: {name}"),
                status: ToolResultStatus::Unsupported,
            };
            emitter
                .emit(AgentEvent::ToolProposed {
                    tool_use_id: tool_use_id.clone(),
                    name: name.to_string(),
                    input: tool_use.input.clone(),
                    risk: Vec::new(),
                })
                .await?;
            emitter
                .emit(AgentEvent::ToolFinished {
                    tool_use_id: tool_use_id.clone(),
                    result: result.clone(),
                })
                .await?;
            return Ok(result);
        }

        let command = match validate_terminal_input(&tool_use.input, single_line) {
            Ok(command) => command,
            Err(error) => {
                let result = ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: format!("invalid tool input: {error}"),
                    status: ToolResultStatus::Failed,
                };
                emitter
                    .emit(AgentEvent::ToolProposed {
                        tool_use_id: tool_use_id.clone(),
                        name: tool_use.name.clone(),
                        input: tool_use.input.clone(),
                        risk: Vec::new(),
                    })
                    .await?;
                emitter
                    .emit(AgentEvent::ToolFinished {
                        tool_use_id: tool_use_id.clone(),
                        result: result.clone(),
                    })
                    .await?;
                return Ok(result);
            }
        };

        let decision = ToolPolicy::authorize(mode, &command);
        match decision {
            PolicyDecision::Hidden => {
                let result = ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: "tool hidden by execution mode".into(),
                    status: ToolResultStatus::Blocked,
                };
                emitter
                    .emit(AgentEvent::ToolProposed {
                        tool_use_id: tool_use_id.clone(),
                        name: tool_use.name.clone(),
                        input: tool_use.input.clone(),
                        risk: Vec::new(),
                    })
                    .await?;
                emitter
                    .emit(AgentEvent::ToolFinished {
                        tool_use_id: tool_use_id.clone(),
                        result: result.clone(),
                    })
                    .await?;
                return Ok(result);
            }
            PolicyDecision::Allowed { risk } => {
                emitter
                    .emit(AgentEvent::ToolProposed {
                        tool_use_id: tool_use_id.clone(),
                        name: tool_use.name.clone(),
                        input: tool_use.input.clone(),
                        risk: risk.reasons,
                    })
                    .await?;
            }
            PolicyDecision::ApprovalRequired { risk, reason } => {
                emitter
                    .emit(AgentEvent::ToolProposed {
                        tool_use_id: tool_use_id.clone(),
                        name: tool_use.name.clone(),
                        input: tool_use.input.clone(),
                        risk: risk.reasons,
                    })
                    .await?;
                emitter
                    .emit(AgentEvent::ApprovalRequested {
                        tool_use_id: tool_use_id.clone(),
                        reason: reason.clone(),
                    })
                    .await?;
                let decision = ctx.bridge.request_approval(&tool_use_id, &reason).await?;
                match decision {
                    ApprovalDecision::Allow => {}
                    ApprovalDecision::Deny => {
                        let result = ToolResult {
                            tool_use_id: tool_use_id.clone(),
                            content: "denied by user".into(),
                            status: ToolResultStatus::Denied,
                        };
                        emitter
                            .emit(AgentEvent::ToolFinished {
                                tool_use_id: tool_use_id.clone(),
                                result: result.clone(),
                            })
                            .await?;
                        return Ok(result);
                    }
                }
            }
        }

        emitter
            .emit(AgentEvent::ToolExecutionRequested {
                tool_use_id: tool_use_id.clone(),
                target: target.to_string(),
                input: tool_use.input.clone(),
            })
            .await?;
        // ToolStarted means the bridge entered dispatched state; it does not
        // prove the target process started.
        emitter
            .emit(AgentEvent::ToolStarted {
                tool_use_id: tool_use_id.clone(),
            })
            .await?;
        let outcome = ctx
            .bridge
            .execute_tool(&tool_use_id, target, tool_use.input.clone())
            .await?;
        let result = ToolResult {
            tool_use_id: tool_use_id.clone(),
            content: outcome.content,
            status: map_execution_status(outcome.status),
        };
        emitter
            .emit(AgentEvent::ToolFinished {
                tool_use_id: tool_use_id.clone(),
                result: result.clone(),
            })
            .await?;
        Ok(result)
    }
}

fn terminal_exec_spec() -> ToolSpec {
    ToolSpec {
        name: TERMINAL_EXEC.into(),
        description: "Execute a shell command in the turn's target terminal".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "shell command to execute" }
            },
            "required": ["command"],
            "additionalProperties": false
        }),
    }
}

/// `terminal_exec` accepts an object with a non-empty string `command`;
/// multi-line commands are rejected in single-line mode.
fn validate_terminal_input(input: &Value, single_line: bool) -> Result<String, String> {
    let object = input.as_object().ok_or("input must be an object")?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or("command must be a string")?;
    let command = command.trim();
    if command.is_empty() {
        return Err("command must be non-empty".into());
    }
    if single_line && (command.contains('\n') || command.contains('\r')) {
        return Err("multi-line command rejected in single-line mode".into());
    }
    Ok(command.to_string())
}

/// The client `ToolHost` reports facts only; the engine maps them to the
/// terminal `ToolResultStatus` (the client can never produce `Denied`).
fn map_execution_status(status: ToolExecutionStatus) -> ToolResultStatus {
    match status {
        ToolExecutionStatus::Succeeded => ToolResultStatus::Succeeded,
        ToolExecutionStatus::Failed => ToolResultStatus::Failed,
        ToolExecutionStatus::Blocked => ToolResultStatus::Blocked,
        ToolExecutionStatus::Cancelled => ToolResultStatus::Cancelled,
        ToolExecutionStatus::OutcomeUnknown => ToolResultStatus::OutcomeUnknown,
        ToolExecutionStatus::Unsupported => ToolResultStatus::Unsupported,
    }
}

fn map_provider_error(err: ProviderError) -> AgentError {
    match err {
        ProviderError::Auth => AgentError::ProviderAuth,
        ProviderError::RateLimit => AgentError::ProviderRateLimit,
        ProviderError::Http(m) => AgentError::ProviderHttp(m),
        ProviderError::Network(m) => AgentError::ProviderHttp(m),
        ProviderError::Protocol(m) => AgentError::ProviderProtocol(m),
        ProviderError::UnexpectedEof => AgentError::ProviderUnexpectedEof,
        ProviderError::ToolsUnsupported => AgentError::ToolsUnsupported,
    }
}
