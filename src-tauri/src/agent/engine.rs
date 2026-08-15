//! Turn engine: provider rounds, event sequencing and the terminal invariant.
//! `TurnContext` injects provider, event sink, client bridge and cancel token;
//! the engine reads no global state.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::agent::bridge::ClientBridge;
use crate::agent::provider::{Provider, ProviderError, ProviderRequest, ProviderRound};
use crate::agent::types::{
    AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, ContentBlock, StartTurnRequest,
};

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
        self.deltas.into_inner().unwrap_or_default()
    }
}

impl crate::agent::provider::ProviderObserver for EngineObserver {
    fn text_delta(&self, delta: &str) {
        self.deltas
            .lock()
            .unwrap()
            .push(Delta::Text(delta.to_string()));
    }

    fn thinking_delta(&self, delta: &str) {
        self.deltas
            .lock()
            .unwrap()
            .push(Delta::Thinking(delta.to_string()));
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

        let provider_request = ProviderRequest {
            system_prompt: ctx.request.system_prompt.clone(),
            messages: ctx.request.messages.clone(),
            tools: Vec::new(),
            target_ref: ctx.request.target_ref.clone(),
            execution_mode: ctx.request.execution_mode,
            single_line_commands: ctx.request.single_line_commands,
        };

        let message_id = format!("{}-m0", ctx.turn_id);
        emitter
            .emit(AgentEvent::AssistantMessageStarted {
                message_id: message_id.clone(),
                round: 0,
            })
            .await?;

        let observer = EngineObserver::new(message_id.clone());
        let round = ctx.provider.complete(provider_request, &observer).await;
        let round = match round {
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

        if round
            .message
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        {
            return Err(AgentError::Internal(
                "tool handling not yet implemented in this task".into(),
            ));
        }

        emitter.emit(AgentEvent::TurnFinished).await?;
        Ok(())
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
