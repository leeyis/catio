//! Turn engine: provider rounds, tool policy, approval, execution pairing,
//! event sequencing and the terminal invariant. `TurnContext` injects
//! provider, event sink, client bridge and cancel token; the engine reads no
//! global state.

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::agent::bridge::ClientBridge;
use crate::agent::legacy::first_shell_tool;
use crate::agent::policy::{PolicyDecision, ToolPolicy};
use crate::agent::provider::{Provider, ProviderError, ProviderRequest, ProviderRound};
use crate::agent::types::{
    AgentError, AgentEvent, AgentEventEnvelope, ApprovalDecision, ContentBlock, ExecutionMode,
    ExpectedResponse, StartTurnRequest, ToolExecutionOutcome, ToolExecutionStatus, ToolResult,
    ToolResultStatus, ToolSpec, ToolUse,
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
    /// Set by the engine before the matching UI event; `respond` validates
    /// against it without racing the engine task.
    pub expected: Arc<Mutex<ExpectedResponse>>,
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
        // During unwinding (e.g. a provider panic) the terminal event cannot
        // be emitted; a debug_assert panic here would abort the process.
        debug_assert!(
            self.terminal_emitted || std::thread::panicking(),
            "TurnEngine must emit exactly one terminal event"
        );
    }
}

/// Provider observer with a live delta queue: the provider's synchronous
/// `text_delta`/`thinking_delta` calls push into a `VecDeque` and wake the
/// engine via `Notify`. The engine drains and emits deltas WHILE the provider
/// is still inside `complete`, preserving real-time streaming, arrival order
/// and the strict per-turn sequence. The queue is explicitly bounded by the
/// engine draining it continuously; the sink's async `emit` provides back
/// pressure.
struct EngineObserver {
    deltas: Arc<Mutex<VecDeque<Delta>>>,
    notify: Arc<Notify>,
}

enum Delta {
    Text(String),
    Thinking(String),
}

impl EngineObserver {
    fn new() -> Self {
        Self {
            deltas: Arc::new(Mutex::new(VecDeque::new())),
            notify: Arc::new(Notify::new()),
        }
    }

    fn push(&self, delta: Delta) {
        self.deltas.lock().push_back(delta);
        self.notify.notify_waiters();
    }

    /// Returns the next delta, waiting for the provider to produce one.
    async fn next_delta(&self) -> Option<Delta> {
        loop {
            if let Some(delta) = self.deltas.lock().pop_front() {
                return Some(delta);
            }
            self.notify.notified().await;
        }
    }

    /// Returns a delta if one is already queued (used after completion).
    fn try_next(&self) -> Option<Delta> {
        self.deltas.lock().pop_front()
    }
}

impl crate::agent::provider::ProviderObserver for EngineObserver {
    fn text_delta(&self, delta: &str) {
        self.push(Delta::Text(delta.to_string()));
    }

    fn thinking_delta(&self, delta: &str) {
        self.push(Delta::Thinking(delta.to_string()));
    }
}

/// Provider/tool loop for one Turn.
pub struct TurnEngine;

/// Result of one provider round: a provider error (fallback may react to it)
/// or an engine-side failure (sink/cancel).
enum RoundOutcome {
    ProviderErr(ProviderError),
    Engine(AgentError),
}

impl From<AgentError> for RoundOutcome {
    fn from(err: AgentError) -> Self {
        Self::Engine(err)
    }
}

impl TurnEngine {
    /// Drives one provider round with real-time delta forwarding: deltas are
    /// emitted to the sink as they arrive, while `complete` is still running.
    /// On completion any remaining queued deltas are drained in arrival order.
    /// Cancellation during the round returns `TurnCancelled`.
    async fn complete_round_live(
        ctx: &TurnContext,
        emitter: &mut SequenceEmitter,
        message_id: &str,
        observer: &EngineObserver,
        request: ProviderRequest,
    ) -> Result<ProviderRound, RoundOutcome> {
        let complete = ctx.provider.complete(request, observer);
        tokio::pin!(complete);
        loop {
            tokio::select! {
                result = &mut complete => {
                    // Deltas produced just before completion must still be
                    // delivered, in arrival order.
                    while let Some(delta) = observer.try_next() {
                        Self::emit_delta(emitter, message_id, delta).await?;
                    }
                    return result.map_err(RoundOutcome::ProviderErr);
                }
                delta = observer.next_delta() => {
                    if let Some(delta) = delta {
                        Self::emit_delta(emitter, message_id, delta).await?;
                    }
                }
                _ = ctx.cancel_token.cancelled() => {
                    return Err(RoundOutcome::Engine(AgentError::TurnCancelled));
                }
            }
        }
    }

    async fn emit_delta(
        emitter: &mut SequenceEmitter,
        message_id: &str,
        delta: Delta,
    ) -> Result<(), AgentError> {
        let event = match delta {
            Delta::Text(delta) => AgentEvent::TextDelta {
                message_id: message_id.to_string(),
                delta,
            },
            Delta::Thinking(delta) => AgentEvent::ThinkingDelta {
                message_id: message_id.to_string(),
                delta,
            },
        };
        emitter.emit(event).await
    }

    /// Runs the turn to a single terminal event: `TurnFinished`,
    /// `TurnCancelled` or `TurnFailed`.
    pub async fn run(&self, ctx: TurnContext) -> Result<(), AgentError> {
        let mut emitter = SequenceEmitter::new(
            ctx.owner_id.clone(),
            ctx.request.conversation_id.clone(),
            ctx.turn_id.clone(),
            ctx.sink.clone(),
        );
        emitter.emit(AgentEvent::TurnStarted).await?;
        let result = self.run_loop(&ctx, &mut emitter).await;
        match &result {
            Ok(()) => emitter.emit(AgentEvent::TurnFinished).await?,
            Err(AgentError::TurnCancelled) => {
                emitter.emit(AgentEvent::TurnCancelled).await?;
            }
            Err(err) => {
                emitter
                    .emit(AgentEvent::TurnFailed {
                        code: err.code().into(),
                        message: err.to_string(),
                    })
                    .await?;
            }
        }
        result
    }

    async fn run_loop(
        &self,
        ctx: &TurnContext,
        emitter: &mut SequenceEmitter,
    ) -> Result<(), AgentError> {
        let mut messages = ctx.request.messages.clone();
        let round_cap = ctx.request.round_cap.max(1);
        let mode = ctx.request.execution_mode;
        let single_line = ctx.request.single_line_commands;
        let target = ctx.request.target_ref.clone();

        // manual mode never advertises tools. A deny or the round cap forces
        // exactly ONE tools-disabled final synthesis: that round may never
        // request or execute a tool — native `ToolUse` and legacy fenced
        // commands are both `toolsDisabledSynthesisViolated`.
        let mut final_synthesis = false;
        // Capability fallback: exactly one tools-disabled retry after
        // `ToolsUnsupported`; the provider is then known to lack tools and
        // the fallback never re-activates.
        let mut legacy_mode = false;
        let mut used_rounds: u32 = 0;

        loop {
            if ctx.cancel_token.is_cancelled() {
                return Err(AgentError::TurnCancelled);
            }
            if !final_synthesis && used_rounds >= round_cap {
                final_synthesis = true;
            }
            used_rounds += 1;
            let round_index = used_rounds - 1;

            let tools_disabled = final_synthesis || legacy_mode || matches!(mode, ExecutionMode::Manual);
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
                round: round_index,
            };

            let message_id = format!("{}-m{}", ctx.turn_id, round_index);
            emitter
                .emit(AgentEvent::AssistantMessageStarted {
                    message_id: message_id.clone(),
                    round: round_index,
                })
                .await?;

            let observer = EngineObserver::new();
            let round = match Self::complete_round_live(
                ctx,
                emitter,
                &message_id,
                &observer,
                provider_request,
            )
            .await
            {
                Ok(round) => round,
                Err(RoundOutcome::ProviderErr(ProviderError::ToolsUnsupported))
                    if !final_synthesis && !legacy_mode =>
                {
                    // Explicit legacy fallback: exactly one tools-disabled
                    // retry of the current round. Capability errors on the
                    // fallback retry, the final synthesis or any later round
                    // never re-activate the fallback.
                    emitter
                        .emit(AgentEvent::CompatibilityFallbackActivated {
                            provider: "compatibility".into(),
                            reason: "toolsUnsupported".into(),
                        })
                        .await?;
                    legacy_mode = true;
                    let retry = ProviderRequest {
                        system_prompt: ctx.request.system_prompt.clone(),
                        messages: messages.clone(),
                        tools: Vec::new(),
                        target_ref: target.clone(),
                        execution_mode: mode,
                        single_line_commands: single_line,
                        round: round_index,
                    };
                    match Self::complete_round_live(ctx, emitter, &message_id, &observer, retry)
                        .await
                    {
                        Ok(round) => round,
                        Err(RoundOutcome::ProviderErr(err)) => return Err(map_provider_error(err)),
                        Err(RoundOutcome::Engine(err)) => return Err(err),
                    }
                }
                Err(RoundOutcome::ProviderErr(err)) => return Err(map_provider_error(err)),
                Err(RoundOutcome::Engine(err)) => return Err(err),
            };

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

            let mut tool_uses: Vec<ToolUse> = round
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

            // Legacy fallback: the retried round is plain markdown; the first
            // valid shell fence becomes a synthetic `terminal_exec` tool that
            // flows through the exact same policy/bridge/result path — except
            // during the final synthesis, where any fenced command is a
            // violation and must never be approved or executed.
            let mut synthetic_tool: Option<ToolUse> = None;
            if legacy_mode && tool_uses.is_empty() {
                let text: String = round
                    .message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let synthetic_id = format!("{}-{}-0", ctx.turn_id, round_index);
                if let Ok(Some(tool)) = first_shell_tool(&text, single_line, &synthetic_id) {
                    if final_synthesis {
                        return Err(AgentError::ToolsDisabledSynthesisViolated(
                            "fenced command during final synthesis".into(),
                        ));
                    }
                    synthetic_tool = Some(tool);
                }
            }

            // The final synthesis is exactly one tools-disabled round whose
            // answer is plain text; it ends the Turn either way.
            if final_synthesis {
                if !tool_uses.is_empty() || synthetic_tool.is_some() {
                    return Err(AgentError::ToolsDisabledSynthesisViolated(
                        "provider requested tools during the final synthesis".into(),
                    ));
                }
                return Ok(());
            }

            if tool_uses.is_empty() && synthetic_tool.is_none() {
                return Ok(());
            }

            // A tools-disabled (legacy-mode) round may carry the fallback's
            // synthetic tool; anything else requesting tools is a violation.
            if tools_disabled && synthetic_tool.is_none() {
                return Err(AgentError::ToolsDisabledSynthesisViolated(
                    "provider requested tools during tools-disabled synthesis".into(),
                ));
            }
            if let Some(tool) = synthetic_tool {
                tool_uses.push(tool);
            }

            let mut any_denied = false;
            let mut results = Vec::new();
            for tool_use in &tool_uses {
                let result =
                    Self::process_tool(ctx, emitter, tool_use, mode, single_line, &target).await?;
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

            // A denial forces exactly one tools-disabled final synthesis;
            // that round must not request or execute anything.
            if any_denied {
                final_synthesis = true;
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
                // Publish the expected response before the UI-facing event so
                // `respond` can validate without racing the engine task.
                *ctx.expected.lock() = ExpectedResponse::Approval {
                    tool_use_id: tool_use_id.clone(),
                };
                emitter
                    .emit(AgentEvent::ApprovalRequested {
                        tool_use_id: tool_use_id.clone(),
                        reason: reason.clone(),
                    })
                    .await?;
                let decision = match ctx.bridge.request_approval(&tool_use_id, &reason).await {
                    Ok(decision) => decision,
                    Err(AgentError::TurnCancelled) => {
                        // Cancellation before dispatch is safely `Cancelled`.
                        let result = ToolResult {
                            tool_use_id: tool_use_id.clone(),
                            content: "turn cancelled before dispatch".into(),
                            status: ToolResultStatus::Cancelled,
                        };
                        emitter
                            .emit(AgentEvent::ToolFinished {
                                tool_use_id: tool_use_id.clone(),
                                result: result.clone(),
                            })
                            .await?;
                        return Err(AgentError::TurnCancelled);
                    }
                    Err(AgentError::ApprovalTimeout) => {
                        // Fail-closed BEFORE dispatch: no decision → never
                        // execute; the paired result is Blocked.
                        let result = ToolResult {
                            tool_use_id: tool_use_id.clone(),
                            content: "approval timed out; fail-closed, not executed".into(),
                            status: ToolResultStatus::Blocked,
                        };
                        emitter
                            .emit(AgentEvent::ToolFinished {
                                tool_use_id: tool_use_id.clone(),
                                result: result.clone(),
                            })
                            .await?;
                        return Ok(result);
                    }
                    Err(err) => return Err(err),
                };
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

        *ctx.expected.lock() = ExpectedResponse::ToolResult {
            tool_use_id: tool_use_id.clone(),
        };
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
        let outcome = match ctx
            .bridge
            .execute_tool(&tool_use_id, target, tool_use.input.clone())
            .await
        {
            Ok(outcome) => outcome,
            Err(AgentError::ToolBridgeTimeout) => {
                // The dispatch already happened; without a trusted result the
                // outcome stays unknown.
                ToolExecutionOutcome {
                    content: "tool bridge timed out after dispatch; outcome unknown".into(),
                    status: ToolExecutionStatus::OutcomeUnknown,
                }
            }
            Err(err) => return Err(err),
        };
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
