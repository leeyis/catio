use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use catio_lib::agent::bridge::{ClientBridge, NoopBridge};
use catio_lib::agent::engine::{AgentEventSink, TurnContext, TurnEngine};
use catio_lib::agent::provider::{
    Provider, ProviderError, ProviderObserver, ProviderRequest, ProviderRound, ProviderStop,
};
use catio_lib::agent::{
    AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole, AnthropicAuthMode,
    ApiCredential, ContentBlock, ExecutionMode, ProviderConfig, ProviderProtocol, StartTurnRequest,
    ToolResultStatus,
};
use tokio_util::sync::CancellationToken;

// ---------------------------------------------------------------------------
// Test seams (public interface only)
// ---------------------------------------------------------------------------

fn valid_request(mode: ExecutionMode) -> StartTurnRequest {
    StartTurnRequest {
        conversation_id: "conv-1".into(),
        messages: vec![AgentMessage {
            role: AgentRole::User,
            content: vec![ContentBlock::Text { text: "hi".into() }],
        }],
        system_prompt: "sys".into(),
        terminal_context: "term".into(),
        target_ref: "target-1".into(),
        provider: ProviderConfig {
            protocol: ProviderProtocol::Openai,
            base_url: "https://example.test/v1".into(),
            model: "test-model".into(),
            credential: ApiCredential::from("sk-test".to_string()),
            anthropic_auth_mode: AnthropicAuthMode::Auto,
        },
        execution_mode: mode,
        single_line_commands: true,
        round_cap: 5,
    }
}

#[derive(Clone)]
struct ScriptedProvider {
    deltas: Vec<String>,
    round: Option<ProviderRound>,
    fail: Option<ProviderError>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

impl ScriptedProvider {
    fn text(parts: &[&str]) -> Self {
        let text = parts.concat();
        Self {
            deltas: parts.iter().map(|s| s.to_string()).collect(),
            round: Some(ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::Text { text: text.clone() }],
                },
                stop: ProviderStop::Stop,
                usage: None,
            }),
            fail: None,
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn fail_with(err: ProviderError) -> Self {
        Self {
            deltas: Vec::new(),
            round: None,
            fail: Some(err),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn request(&self, index: usize) -> ProviderRequest {
        self.requests.lock().unwrap()[index].clone()
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(err) = &self.fail {
            return Err(err.clone());
        }
        for delta in &self.deltas {
            observer.text_delta(delta);
        }
        self.round
            .clone()
            .ok_or_else(|| ProviderError::Protocol("no scripted round".into()))
    }
}

#[derive(Clone, Default)]
struct RecordingSink {
    envelopes: Arc<Mutex<Vec<AgentEventEnvelope>>>,
}

#[async_trait]
impl AgentEventSink for RecordingSink {
    async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError> {
        self.envelopes.lock().unwrap().push(envelope);
        Ok(())
    }
}

fn event_type_name(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::TurnStarted => "turnStarted",
        AgentEvent::AssistantMessageStarted { .. } => "assistantMessageStarted",
        AgentEvent::TextDelta { .. } => "textDelta",
        AgentEvent::ThinkingDelta { .. } => "thinkingDelta",
        AgentEvent::AssistantMessageFinished { .. } => "assistantMessageFinished",
        AgentEvent::ToolProposed { .. } => "toolProposed",
        AgentEvent::ApprovalRequested { .. } => "approvalRequested",
        AgentEvent::ToolExecutionRequested { .. } => "toolExecutionRequested",
        AgentEvent::ToolStarted { .. } => "toolStarted",
        AgentEvent::ToolOutputDelta { .. } => "toolOutputDelta",
        AgentEvent::ToolFinished { .. } => "toolFinished",
        AgentEvent::UsageUpdated { .. } => "usageUpdated",
        AgentEvent::CompatibilityFallbackActivated { .. } => "compatibilityFallbackActivated",
        AgentEvent::TurnFinished => "turnFinished",
        AgentEvent::TurnCancelled => "turnCancelled",
        AgentEvent::TurnFailed { .. } => "turnFailed",
    }
}

impl RecordingSink {
    fn event_types(&self) -> Vec<&'static str> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .map(|e| event_type_name(&e.event))
            .collect()
    }

    fn sequences(&self) -> Vec<u64> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.sequence)
            .collect()
    }

    fn terminal_count(&self) -> usize {
        self.event_types()
            .iter()
            .filter(|t| matches!(**t, "turnFinished" | "turnCancelled" | "turnFailed"))
            .count()
    }

    fn terminal_types(&self) -> Vec<&'static str> {
        self.event_types()
            .into_iter()
            .filter(|t| matches!(*t, "turnFinished" | "turnCancelled" | "turnFailed"))
            .collect()
    }

    fn precedes(&self, before: &str, after: &str) -> bool {
        let types = self.event_types();
        match (
            types.iter().position(|t| *t == before),
            types.iter().position(|t| *t == after),
        ) {
            (Some(a), Some(b)) => a < b,
            _ => false,
        }
    }

    fn tool_finished_statuses(&self) -> Vec<ToolResultStatus> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match &e.event {
                AgentEvent::ToolFinished { result, .. } => Some(result.status.clone()),
                _ => None,
            })
            .collect()
    }

    fn tool_use_ids(&self) -> Vec<String> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match &e.event {
                AgentEvent::ToolProposed { tool_use_id, .. } => Some(tool_use_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn tool_result_ids(&self) -> Vec<String> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match &e.event {
                AgentEvent::ToolFinished { tool_use_id, .. } => Some(tool_use_id.clone()),
                _ => None,
            })
            .collect()
    }
}

async fn run_turn_with(
    provider: ScriptedProvider,
    sink: RecordingSink,
    mode: ExecutionMode,
) -> Result<(), AgentError> {
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request: valid_request(mode),
        provider: Arc::new(provider),
        sink: Arc::new(sink),
        bridge: Arc::new(NoopBridge),
        cancel_token: CancellationToken::new(),
    };
    TurnEngine.run(ctx).await
}

async fn run_test_turn(provider: ScriptedProvider, sink: RecordingSink) -> Result<(), AgentError> {
    run_turn_with(provider, sink, ExecutionMode::Ask).await
}

// ---------------------------------------------------------------------------
// Text-only turn contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn text_only_turn_emits_ordered_single_terminal_sequence() {
    let provider = ScriptedProvider::text(&["hello ", "world"]);
    let sink = RecordingSink::default();
    run_test_turn(provider, sink.clone()).await.unwrap();
    assert_eq!(
        sink.event_types(),
        [
            "turnStarted",
            "assistantMessageStarted",
            "textDelta",
            "textDelta",
            "assistantMessageFinished",
            "turnFinished",
        ]
    );
    assert_eq!(sink.sequences(), [1, 2, 3, 4, 5, 6]);
    assert_eq!(sink.terminal_count(), 1);
}

#[tokio::test]
async fn provider_unexpected_eof_fails_turn() {
    let provider = ScriptedProvider::fail_with(ProviderError::UnexpectedEof);
    let sink = RecordingSink::default();
    let err = run_test_turn(provider, sink.clone()).await.unwrap_err();
    assert_eq!(err.code(), "providerUnexpectedEof");
    let types = sink.event_types();
    assert_eq!(types[0], "turnStarted");
    assert_eq!(types[types.len() - 1], "turnFailed");
    assert_eq!(sink.terminal_count(), 1);
}
