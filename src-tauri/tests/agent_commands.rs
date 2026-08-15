use std::sync::Arc;

use async_trait::async_trait;
use catio_lib::agent::commands::{
    cancel_for_actor, desktop_actor, respond_for_actor, start_turn_for_actor,
};
use catio_lib::agent::engine::AgentEventSink;
use catio_lib::agent::provider::{Provider, ProviderError, ProviderRequest, ProviderRound};
use catio_lib::agent::{
    ActorContext, AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole,
    AgentRuntime, AnthropicAuthMode, ApiCredential, ClientTurnResponse, ContentBlock,
    ExecutionMode, ProviderConfig, ProviderFactory, ProviderProtocol, StartTurnRequest, TurnHandle,
};
use parking_lot::Mutex;
use serde_json::json;

// ---------------------------------------------------------------------------
// Minimal seams (the command adapters must not depend on Tauri macros)
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
struct TextProvider;

#[async_trait]
impl Provider for TextProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        observer: &dyn catio_lib::agent::ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        observer.text_delta("hello from scripted provider");
        Ok(ProviderRound {
            message: AgentMessage {
                role: AgentRole::Assistant,
                content: vec![ContentBlock::Text {
                    text: "hello from scripted provider".into(),
                }],
            },
            stop: catio_lib::agent::ProviderStop::Stop,
            usage: None,
        })
    }
}

#[derive(Clone)]
struct ScriptedFactory {
    provider: Arc<dyn Provider>,
}

#[async_trait]
impl ProviderFactory for ScriptedFactory {
    async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        Ok(self.provider.clone())
    }
}

#[derive(Clone, Default)]
struct RecordingSink {
    envelopes: Arc<Mutex<Vec<AgentEventEnvelope>>>,
}

#[async_trait]
impl AgentEventSink for RecordingSink {
    async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError> {
        self.envelopes.lock().push(envelope);
        Ok(())
    }
}

fn actor(owner: &str) -> ActorContext {
    ActorContext {
        owner_id: owner.into(),
    }
}

// ---------------------------------------------------------------------------
// Command adapter contract
// ---------------------------------------------------------------------------

#[test]
fn desktop_actor_is_fixed_local_owner() {
    assert_eq!(desktop_actor().owner_id, "local");
}

#[tokio::test]
async fn start_turn_for_actor_runs_with_fixed_local_actor() {
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(TextProvider),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let handle = start_turn_for_actor(
        &runtime,
        desktop_actor(),
        valid_request(ExecutionMode::Manual),
        Arc::new(sink.clone()),
    )
    .await
    .unwrap();
    assert!(!handle.turn_id.is_empty());
    // 等待 terminal 事件。
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let types: Vec<String> = sink
                .envelopes
                .lock()
                .iter()
                .map(|e| {
                    serde_json::to_value(&e.event).unwrap()["type"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                })
                .collect();
            if types.iter().any(|t| t == "turnFinished") {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("turn finished");
    let envelopes = sink.envelopes.lock().clone();
    assert_eq!(envelopes[0].owner_id, "local");
    assert!(envelopes.iter().all(|e| e.sequence > 0));
}

fn valid_request_json() -> serde_json::Value {
    json!({
        "conversationId": "conv-1",
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }],
        "systemPrompt": "sys",
        "terminalContext": "term",
        "targetRef": "target-1",
        "provider": {
            "protocol": "openai",
            "baseUrl": "https://example.test/v1",
            "model": "test-model",
            "credential": "sk-test",
            "anthropicAuthMode": "auto"
        },
        "executionMode": "ask",
        "singleLineCommands": true,
        "roundCap": 5
    })
}

#[test]
fn start_turn_request_rejects_transport_owned_owner_field() {
    let mut payload = valid_request_json();
    payload["ownerId"] = json!("attacker");
    let parsed = serde_json::from_value::<StartTurnRequest>(payload);
    assert!(
        parsed.is_err(),
        "ownerId must not be injectable via the request"
    );
}

#[test]
fn request_without_owner_field_deserializes() {
    let payload = valid_request_json();
    assert!(serde_json::from_value::<StartTurnRequest>(payload).is_ok());
}

#[tokio::test]
async fn respond_and_cancel_for_actor_propagate_errors() {
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(TextProvider),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    // 未知 turn → TurnNotFound 透传。
    assert_eq!(
        respond_for_actor(
            &runtime,
            actor("local"),
            "missing".into(),
            ClientTurnResponse::ApprovalDecision {
                tool_use_id: "tool-1".into(),
                decision: catio_lib::agent::ApprovalDecision::Allow,
            },
        )
        .await,
        Err(AgentError::TurnNotFound)
    );
    assert_eq!(
        cancel_for_actor(&runtime, actor("local"), "missing".into()).await,
        Err(AgentError::TurnNotFound)
    );
}

#[tokio::test]
async fn envelope_serialization_is_stable_across_sinks() {
    let envelope = AgentEventEnvelope {
        owner_id: "local".into(),
        conversation_id: "conv-1".into(),
        turn_id: "turn-1".into(),
        sequence: 1,
        event: AgentEvent::TurnStarted,
    };
    let json = serde_json::to_value(&envelope).unwrap();
    assert_eq!(json["ownerId"], "local");
    assert_eq!(json["event"]["type"], "turnStarted");
    assert_eq!(json["sequence"], 1);
}
