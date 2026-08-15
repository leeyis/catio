use std::collections::VecDeque;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use catio_lib::agent::bridge::{ClientBridge, NoopBridge};
use catio_lib::agent::engine::{AgentEventSink, TurnContext, TurnEngine};
use catio_lib::agent::provider::{
    Provider, ProviderError, ProviderObserver, ProviderRequest, ProviderRound, ProviderStop,
};
use catio_lib::agent::{
    ActorContext, AgentError, AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole,
    AgentRuntime, AnthropicAuthMode, ApiCredential, ApprovalDecision, ClientTurnResponse,
    ContentBlock, ExecutionMode, ProviderConfig, ProviderFactory, ProviderProtocol,
    StartTurnRequest, ToolExecutionOutcome, ToolExecutionStatus, ToolResultStatus, TurnHandle,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::Notify;
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
struct ScriptedRound {
    round: ProviderRound,
    deltas: Vec<String>,
}

#[derive(Clone)]
struct ScriptedProvider {
    rounds: Arc<Mutex<VecDeque<ScriptedRound>>>,
    failures: Arc<Mutex<VecDeque<ProviderError>>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    pending_when_empty: bool,
}

fn text_round(text: &str) -> ProviderRound {
    ProviderRound {
        message: AgentMessage {
            role: AgentRole::Assistant,
            content: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
        },
        stop: ProviderStop::Stop,
        usage: None,
    }
}

impl ScriptedProvider {
    fn text(parts: &[&str]) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([ScriptedRound {
                round: text_round(&parts.concat()),
                deltas: parts.iter().map(|s| s.to_string()).collect(),
            }]))),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    fn tool_then_text(command: &str, synthesis: &str) -> Self {
        let tool_round = ScriptedRound {
            round: ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::ToolUse {
                        id: "tool-1".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": command }),
                    }],
                },
                stop: ProviderStop::ToolUse,
                usage: None,
            },
            deltas: vec![],
        };
        let synthesis_round = ScriptedRound {
            round: text_round(synthesis),
            deltas: vec![synthesis.to_string()],
        };
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([tool_round, synthesis_round]))),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// One round that first fails with `ToolsUnsupported`, then returns a
    /// fenced markdown text round followed by a final synthesis round.
    fn tools_unsupported_then_text(fenced: &str, synthesis: &str) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([
                ScriptedRound {
                    round: text_round(fenced),
                    deltas: vec![fenced.to_string()],
                },
                ScriptedRound {
                    round: text_round(synthesis),
                    deltas: vec![synthesis.to_string()],
                },
            ]))),
            failures: Arc::new(Mutex::new(VecDeque::from([
                ProviderError::ToolsUnsupported,
            ]))),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// One round with an invalid-input `terminal_exec` and an unknown tool,
    /// followed by a text synthesis round.
    fn invalid_tools() -> Self {
        let invalid_round = ScriptedRound {
            round: ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![
                        ContentBlock::ToolUse {
                            id: "tool-1".into(),
                            name: "terminal_exec".into(),
                            input: json!({ "command": 123 }),
                        },
                        ContentBlock::ToolUse {
                            id: "tool-2".into(),
                            name: "system_info".into(),
                            input: json!({}),
                        },
                    ],
                },
                stop: ProviderStop::ToolUse,
                usage: None,
            },
            deltas: vec![],
        };
        let synthesis_round = ScriptedRound {
            round: text_round("done"),
            deltas: vec!["done".into()],
        };
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([invalid_round, synthesis_round]))),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// `n` tool rounds followed by a text synthesis round.
    fn tool_rounds_then_text(n: usize, command: &str, text: &str) -> Self {
        let mut rounds = VecDeque::new();
        for i in 0..n {
            rounds.push_back(ScriptedRound {
                round: ProviderRound {
                    message: AgentMessage {
                        role: AgentRole::Assistant,
                        content: vec![ContentBlock::ToolUse {
                            id: format!("tool-{}", i + 1),
                            name: "terminal_exec".into(),
                            input: json!({ "command": command }),
                        }],
                    },
                    stop: ProviderStop::ToolUse,
                    usage: None,
                },
                deltas: vec![],
            });
        }
        rounds.push_back(ScriptedRound {
            round: text_round(text),
            deltas: vec![text.to_string()],
        });
        Self {
            rounds: Arc::new(Mutex::new(rounds)),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// Two consecutive tool rounds (used to prove a tools-disabled synthesis
    /// that still requests a tool fails the turn).
    fn tool_then_tool(first: &str, second: &str) -> Self {
        let rounds = VecDeque::from([
            ScriptedRound {
                round: ProviderRound {
                    message: AgentMessage {
                        role: AgentRole::Assistant,
                        content: vec![ContentBlock::ToolUse {
                            id: "tool-1".into(),
                            name: "terminal_exec".into(),
                            input: json!({ "command": first }),
                        }],
                    },
                    stop: ProviderStop::ToolUse,
                    usage: None,
                },
                deltas: vec![],
            },
            ScriptedRound {
                round: ProviderRound {
                    message: AgentMessage {
                        role: AgentRole::Assistant,
                        content: vec![ContentBlock::ToolUse {
                            id: "tool-2".into(),
                            name: "terminal_exec".into(),
                            input: json!({ "command": second }),
                        }],
                    },
                    stop: ProviderStop::ToolUse,
                    usage: None,
                },
                deltas: vec![],
            },
        ]);
        Self {
            rounds: Arc::new(Mutex::new(rounds)),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    fn fail_with(err: ProviderError) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::new())),
            failures: Arc::new(Mutex::new(VecDeque::from([err]))),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// ToolsUnsupported once, then two fenced-markdown rounds: the retried
    /// round may execute its fence; the NEXT round is the final synthesis
    /// after a deny / round cap and must never execute another fence.
    fn tools_unsupported_then_fences(first: &str, second: &str) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([
                ScriptedRound {
                    round: text_round(first),
                    deltas: vec![first.to_string()],
                },
                ScriptedRound {
                    round: text_round(second),
                    deltas: vec![second.to_string()],
                },
            ]))),
            failures: Arc::new(Mutex::new(VecDeque::from([
                ProviderError::ToolsUnsupported,
            ]))),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// ToolsUnsupported on the first call, one fenced round, then
    /// ToolsUnsupported AGAIN — proves the fallback never re-activates.
    fn tools_unsupported_fence_then_unsupported(fenced: &str) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([ScriptedRound {
                round: text_round(fenced),
                deltas: vec![fenced.to_string()],
            }]))),
            failures: Arc::new(Mutex::new(VecDeque::from([
                ProviderError::ToolsUnsupported,
                ProviderError::ToolsUnsupported,
            ]))),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: false,
        }
    }

    /// One tool round followed by an indefinitely blocked provider (used to
    /// keep a Turn alive after dispatch).
    fn tool_then_blocked(command: &str) -> Self {
        let tool_round = ScriptedRound {
            round: ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::ToolUse {
                        id: "tool-1".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": command }),
                    }],
                },
                stop: ProviderStop::ToolUse,
                usage: None,
            },
            deltas: vec![],
        };
        Self {
            rounds: Arc::new(Mutex::new(VecDeque::from([tool_round]))),
            failures: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
            pending_when_empty: true,
        }
    }

    fn request_count(&self) -> usize {
        self.requests.lock().len()
    }

    fn request(&self, index: usize) -> ProviderRequest {
        self.requests.lock()[index].clone()
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        self.requests.lock().push(request.clone());
        if let Some(err) = self.failures.lock().pop_front() {
            return Err(err);
        }
        let scripted = self.rounds.lock().pop_front();
        let scripted = match scripted {
            Some(scripted) => scripted,
            None if self.pending_when_empty => std::future::pending().await,
            None => return Err(ProviderError::Protocol("no scripted round".into())),
        };
        for delta in &scripted.deltas {
            observer.text_delta(delta);
        }
        Ok(scripted.round)
    }
}

/// Provider that blocks forever after notifying it entered `complete`.
#[derive(Clone, Default)]
struct BlockingProvider {
    entered: Arc<Notify>,
}

#[async_trait]
impl Provider for BlockingProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        self.entered.notify_waiters();
        std::future::pending().await
    }
}

/// Provider that emits one delta, signals, then blocks until released. Used to
/// prove deltas are forwarded to the sink BEFORE the completion returns.
#[derive(Clone, Default)]
struct GatedDeltaProvider {
    delta_emitted: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl Provider for GatedDeltaProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        observer.text_delta("early ");
        self.delta_emitted.notify_waiters();
        self.release.notified().await;
        Ok(text_round("early world"))
    }
}

/// Factory returning a fixed scripted provider.
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

/// Factory that weak-tracks the provider it creates (leak detection).
#[derive(Clone, Default)]
struct WeakTrackingFactory {
    last: Arc<Mutex<Option<Weak<ScriptedProvider>>>>,
}

impl WeakTrackingFactory {
    fn last_weak(&self) -> Option<Weak<ScriptedProvider>> {
        self.last.lock().clone()
    }
}

#[async_trait]
impl ProviderFactory for WeakTrackingFactory {
    async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        let provider = Arc::new(ScriptedProvider::text(&["leak check"]));
        *self.last.lock() = Some(Arc::downgrade(&provider));
        Ok(provider)
    }
}

/// Scripted client bridge recording approval/execution calls.
#[derive(Clone)]
struct ScriptedBridge {
    approvals: Arc<Mutex<VecDeque<ApprovalDecision>>>,
    outcome: Arc<Mutex<Option<ToolExecutionOutcome>>>,
    panic_on_execute: bool,
    approval_requests: Arc<Mutex<Vec<String>>>,
    executions: Arc<Mutex<Vec<String>>>,
}

impl ScriptedBridge {
    fn allow_then_succeed(content: &str) -> Self {
        Self {
            approvals: Arc::new(Mutex::new(VecDeque::from([ApprovalDecision::Allow]))),
            outcome: Arc::new(Mutex::new(Some(ToolExecutionOutcome {
                content: content.to_string(),
                status: ToolExecutionStatus::Succeeded,
            }))),
            panic_on_execute: false,
            approval_requests: Arc::new(Mutex::new(Vec::new())),
            executions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn deny() -> Self {
        Self {
            approvals: Arc::new(Mutex::new(VecDeque::from([ApprovalDecision::Deny]))),
            outcome: Arc::new(Mutex::new(None)),
            panic_on_execute: false,
            approval_requests: Arc::new(Mutex::new(Vec::new())),
            executions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn succeed(content: &str) -> Self {
        Self {
            approvals: Arc::new(Mutex::new(VecDeque::new())),
            outcome: Arc::new(Mutex::new(Some(ToolExecutionOutcome {
                content: content.to_string(),
                status: ToolExecutionStatus::Succeeded,
            }))),
            panic_on_execute: false,
            approval_requests: Arc::new(Mutex::new(Vec::new())),
            executions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn panic_on_execute() -> Self {
        Self {
            approvals: Arc::new(Mutex::new(VecDeque::new())),
            outcome: Arc::new(Mutex::new(None)),
            panic_on_execute: true,
            approval_requests: Arc::new(Mutex::new(Vec::new())),
            executions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn approval_requests(&self) -> Vec<String> {
        self.approval_requests.lock().clone()
    }

    fn executions(&self) -> Vec<String> {
        self.executions.lock().clone()
    }
}

#[async_trait]
impl ClientBridge for ScriptedBridge {
    async fn request_approval(
        &self,
        tool_use_id: &str,
        _reason: &str,
    ) -> Result<ApprovalDecision, AgentError> {
        self.approval_requests.lock().push(tool_use_id.to_string());
        Ok(self
            .approvals
            .lock()
            .pop_front()
            .unwrap_or(ApprovalDecision::Deny))
    }

    async fn execute_tool(
        &self,
        tool_use_id: &str,
        _target: &str,
        _input: Value,
    ) -> Result<ToolExecutionOutcome, AgentError> {
        assert!(!self.panic_on_execute, "ScriptedBridge must not execute");
        self.executions.lock().push(tool_use_id.to_string());
        self.outcome
            .lock()
            .clone()
            .ok_or_else(|| AgentError::Internal("no scripted outcome".into()))
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
            .iter()
            .map(|e| event_type_name(&e.event))
            .collect()
    }

    fn sequences(&self) -> Vec<u64> {
        self.envelopes.lock().iter().map(|e| e.sequence).collect()
    }

    fn count_type(&self, name: &str) -> usize {
        self.event_types()
            .iter()
            .filter(|t| **t == name)
            .count()
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
            .iter()
            .filter_map(|e| match &e.event {
                AgentEvent::ToolFinished { tool_use_id, .. } => Some(tool_use_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// Polls until `predicate` holds, failing the test after 5 seconds.
    async fn wait_for(&self, predicate: impl Fn(&RecordingSink) -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if predicate(self) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("timed out waiting for sink state");
    }

    async fn wait_for_terminal(&self) {
        self.wait_for(|sink| sink.terminal_count() == 1).await;
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
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    TurnEngine.run(ctx).await
}

async fn run_test_turn(provider: ScriptedProvider, sink: RecordingSink) -> Result<(), AgentError> {
    run_turn_with(provider, sink, ExecutionMode::Ask).await
}

async fn run_tool_turn_with_provider<P: Provider + Send + Sync + 'static>(
    mode: ExecutionMode,
    provider: Arc<P>,
    bridge: ScriptedBridge,
    sink: RecordingSink,
) -> Result<(), AgentError> {
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request: valid_request(mode),
        provider,
        sink: Arc::new(sink),
        bridge: Arc::new(bridge),
        cancel_token: CancellationToken::new(),
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    TurnEngine.run(ctx).await
}

async fn run_tool_turn(
    mode: ExecutionMode,
    command: &str,
    bridge: ScriptedBridge,
    sink: RecordingSink,
) -> Result<(), AgentError> {
    let provider = ScriptedProvider::tool_then_text(command, "done");
    run_tool_turn_with_provider(mode, Arc::new(provider), bridge, sink).await
}

async fn run_text_turn_with_mode(
    mode: ExecutionMode,
    provider: ScriptedProvider,
) -> Result<(), AgentError> {
    run_turn_with(provider, RecordingSink::default(), mode).await
}

async fn run_invalid_tools_turn(
    bridge: ScriptedBridge,
    sink: RecordingSink,
) -> Result<(), AgentError> {
    run_tool_turn_with_provider(
        ExecutionMode::Ask,
        Arc::new(ScriptedProvider::invalid_tools()),
        bridge,
        sink,
    )
    .await
}

fn actor(owner: &str) -> ActorContext {
    ActorContext {
        owner_id: owner.into(),
    }
}

fn allow_response(tool_use_id: &str) -> ClientTurnResponse {
    ClientTurnResponse::ApprovalDecision {
        tool_use_id: tool_use_id.into(),
        decision: ApprovalDecision::Allow,
    }
}

fn deny_response(tool_use_id: &str) -> ClientTurnResponse {
    ClientTurnResponse::ApprovalDecision {
        tool_use_id: tool_use_id.into(),
        decision: ApprovalDecision::Deny,
    }
}

/// Starts a Turn whose first tool round awaits approval, then stays alive on a
/// blocked provider round.
async fn runtime_waiting_for_approval(
    owner: ActorContext,
) -> (Arc<AgentRuntime>, TurnHandle, RecordingSink) {
    let provider = ScriptedProvider::tool_then_blocked("rm -rf /tmp/demo");
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(provider),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            owner.clone(),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    sink.wait_for(|s| s.event_types().contains(&"approvalRequested"))
        .await;
    (runtime, turn, sink)
}

/// Runs a completed Turn and waits until the registry entry is gone.
async fn completed_runtime(owner: ActorContext) -> (Arc<AgentRuntime>, TurnHandle, RecordingSink) {
    let provider = ScriptedProvider::text(&["done"]);
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(provider),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            owner.clone(),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    sink.wait_for_terminal().await;
    loop {
        if runtime.cancel(owner.clone(), turn.clone()).await == Err(AgentError::TurnNotFound) {
            break;
        }
        tokio::task::yield_now().await;
    }
    (runtime, turn, sink)
}

// ---------------------------------------------------------------------------
// AgentRuntime registry: owner, idempotency, cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn wrong_owner_cannot_respond_or_cancel() {
    let (runtime, turn, _sink) = runtime_waiting_for_approval(actor("owner-a")).await;
    let response = allow_response("tool-1");
    assert_eq!(
        runtime
            .respond(actor("owner-b"), turn.clone(), response)
            .await,
        Err(AgentError::OwnerMismatch)
    );
    assert_eq!(
        runtime.cancel(actor("owner-b"), turn).await,
        Err(AgentError::OwnerMismatch)
    );
}

#[tokio::test]
async fn duplicate_equal_response_is_noop_but_conflict_fails() {
    let (runtime, turn, sink) = runtime_waiting_for_approval(actor("owner-a")).await;
    runtime
        .respond(actor("owner-a"), turn.clone(), allow_response("tool-1"))
        .await
        .unwrap();
    runtime
        .respond(actor("owner-a"), turn.clone(), allow_response("tool-1"))
        .await
        .unwrap();
    assert_eq!(
        runtime
            .respond(actor("owner-a"), turn.clone(), deny_response("tool-1"))
            .await,
        Err(AgentError::ResponseConflict)
    );
    // The tool executes exactly once; the replay must not re-dispatch.
    sink.wait_for(|s| s.event_types().contains(&"toolStarted"))
        .await;
    assert_eq!(
        sink.event_types()
            .iter()
            .filter(|t| **t == "toolStarted")
            .count(),
        1
    );
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
}

#[tokio::test]
async fn cancel_before_dispatch_is_cancelled() {
    let provider = Arc::new(BlockingProvider::default());
    let entered = provider.entered.notified();
    let factory = Arc::new(ScriptedFactory {
        provider: provider.clone(),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            actor("owner-a"),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    entered.await;
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
    sink.wait_for_terminal().await;
    assert_eq!(sink.terminal_types(), ["turnCancelled"]);
}

#[tokio::test]
async fn cancel_after_dispatch_without_stop_proof_is_outcome_unknown() {
    let provider = ScriptedProvider::tool_then_blocked("echo hi");
    let factory = Arc::new(ScriptedFactory {
        provider: Arc::new(provider),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            actor("owner-a"),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    // Ordinary command in ask mode dispatches without approval.
    sink.wait_for(|s| s.event_types().contains(&"toolStarted"))
        .await;
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
    sink.wait_for_terminal().await;
    assert_eq!(
        sink.tool_finished_statuses(),
        [ToolResultStatus::OutcomeUnknown]
    );
    assert_eq!(sink.terminal_count(), 1);
}

#[tokio::test]
async fn terminal_turn_cannot_be_reactivated() {
    let (runtime, turn, _sink) = completed_runtime(actor("owner-a")).await;
    assert_eq!(
        runtime
            .respond(actor("owner-a"), turn.clone(), allow_response("tool-1"))
            .await,
        Err(AgentError::TurnNotFound)
    );
    assert_eq!(
        runtime.cancel(actor("owner-a"), turn).await,
        Err(AgentError::TurnNotFound)
    );
}

#[tokio::test]
async fn terminal_turn_drops_provider_and_clears_registry() {
    let factory = Arc::new(WeakTrackingFactory::default());
    let runtime = Arc::new(AgentRuntime::new(factory.clone()));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            actor("owner-a"),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    sink.wait_for_terminal().await;
    loop {
        if runtime.cancel(actor("owner-a"), turn.clone()).await == Err(AgentError::TurnNotFound) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let weak = factory.last_weak();
    assert!(
        weak.as_ref().is_none_or(|w| w.upgrade().is_none()),
        "provider must be dropped after the terminal event"
    );
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
async fn text_delta_is_emitted_before_completion_releases() {
    let provider = GatedDeltaProvider::default();
    let emitted = provider.delta_emitted.notified();
    let sink = RecordingSink::default();
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request: valid_request(ExecutionMode::Ask),
        provider: Arc::new(provider.clone()),
        sink: Arc::new(sink.clone()),
        bridge: Arc::new(NoopBridge),
        cancel_token: CancellationToken::new(),
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    let task = tokio::spawn(TurnEngine.run(ctx));
    // The provider has produced a delta and is still blocked inside `complete`:
    // the delta must already be on the sink (real-time streaming).
    emitted.await;
    sink.wait_for(|s| s.event_types().contains(&"textDelta"))
        .await;
    assert_eq!(
        sink.event_types(),
        ["turnStarted", "assistantMessageStarted", "textDelta"]
    );
    // Release completion; the rest of the turn then finishes normally.
    provider.release.notify_waiters();
    task.await.unwrap().unwrap();
    assert_eq!(
        sink.event_types(),
        [
            "turnStarted",
            "assistantMessageStarted",
            "textDelta",
            "assistantMessageFinished",
            "turnFinished",
        ]
    );
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

// ---------------------------------------------------------------------------
// Structured terminal_exec tool loop
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sensitive_ask_waits_for_allow_before_tool_dispatch() {
    let bridge = ScriptedBridge::allow_then_succeed("exit 0");
    let sink = RecordingSink::default();
    run_tool_turn(
        ExecutionMode::Ask,
        "rm -rf /tmp/demo",
        bridge.clone(),
        sink.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bridge.approval_requests(), ["tool-1"]);
    assert_eq!(bridge.executions(), ["tool-1"]);
    assert!(sink.precedes("approvalRequested", "toolExecutionRequested"));
}

#[tokio::test]
async fn denied_tool_gets_one_result_and_one_tools_disabled_synthesis() {
    let bridge = ScriptedBridge::deny();
    let provider = ScriptedProvider::tool_then_text("rm -rf /tmp/demo", "已取消执行。");
    let sink = RecordingSink::default();
    run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider.clone()), bridge, sink.clone())
        .await
        .unwrap();
    assert_eq!(provider.request_count(), 2);
    assert!(provider.request(1).tools.is_empty());
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::Denied]);
}

#[tokio::test]
async fn auto_dispatches_sensitive_tool_without_approval_event() {
    let bridge = ScriptedBridge::succeed("exit 0");
    let sink = RecordingSink::default();
    run_tool_turn(
        ExecutionMode::Auto,
        "rm -rf /tmp/demo",
        bridge.clone(),
        sink.clone(),
    )
    .await
    .unwrap();
    assert!(bridge.approval_requests().is_empty());
    assert_eq!(bridge.executions(), ["tool-1"]);
    assert!(!sink.event_types().contains(&"approvalRequested"));
}

#[tokio::test]
async fn manual_never_exposes_terminal_tool() {
    let provider = ScriptedProvider::text(&["只回答，不执行。"]);
    run_text_turn_with_mode(ExecutionMode::Manual, provider.clone())
        .await
        .unwrap();
    assert!(provider.request(0).tools.is_empty());
}

#[tokio::test]
async fn invalid_and_unknown_tools_are_not_executed() {
    let bridge = ScriptedBridge::panic_on_execute();
    let sink = RecordingSink::default();
    run_invalid_tools_turn(bridge, sink.clone()).await.unwrap();
    assert_eq!(
        sink.tool_finished_statuses(),
        [ToolResultStatus::Failed, ToolResultStatus::Unsupported]
    );
    assert_eq!(sink.tool_use_ids(), sink.tool_result_ids());
}

#[tokio::test]
async fn round_cap_reached_forces_tools_disabled_synthesis() {
    let bridge = ScriptedBridge::succeed("ok");
    let provider = ScriptedProvider::tool_rounds_then_text(5, "echo round", "final");
    let sink = RecordingSink::default();
    run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider.clone()), bridge, sink.clone())
        .await
        .unwrap();
    // 5 tool rounds + 1 tools-disabled synthesis = 6 provider requests.
    assert_eq!(provider.request_count(), 6);
    assert!(provider.request(5).tools.is_empty());
    assert_eq!(sink.tool_use_ids().len(), 5);
    assert_eq!(sink.terminal_types(), ["turnFinished"]);
}

#[tokio::test]
async fn synthesis_requesting_tools_fails_turn() {
    let bridge = ScriptedBridge::deny();
    let provider = ScriptedProvider::tool_then_tool("rm -rf /tmp/demo", "echo again");
    let sink = RecordingSink::default();
    let err = run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider), bridge, sink.clone())
        .await
        .unwrap_err();
    assert_eq!(err.code(), "toolsDisabledSynthesisViolated");
    assert_eq!(sink.terminal_types(), ["turnFailed"]);
}

#[tokio::test]
async fn provider_requests_carry_increasing_round_numbers() {
    let bridge = ScriptedBridge::succeed("ok");
    let provider = ScriptedProvider::tool_rounds_then_text(3, "echo round", "final");
    let sink = RecordingSink::default();
    run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider.clone()), bridge, sink.clone())
        .await
        .unwrap();
    assert_eq!(provider.request_count(), 4);
    let rounds: Vec<u32> = (0..4).map(|i| provider.request(i).round).collect();
    assert_eq!(rounds, [0, 1, 2, 3]);
}

/// A `RuntimeBridge` whose responses never arrive: approval times out and
/// fails CLOSED (Blocked, never executed); tool results time out AFTER dispatch
/// and report OutcomeUnknown.
fn timeout_bridge(timeout: Duration) -> Arc<dyn ClientBridge> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // Keep the sender alive for the bridge's lifetime so `recv` waits (and
    // the timeout branch fires) instead of returning TurnNotFound.
    std::mem::forget(tx);
    Arc::new(catio_lib::agent::bridge::RuntimeBridge::with_timeout(
        rx,
        CancellationToken::new(),
        timeout,
    ))
}

#[tokio::test]
async fn approval_timeout_fails_closed_as_blocked() {
    let provider = ScriptedProvider::tool_then_text("rm -rf /tmp/demo", "done");
    let sink = RecordingSink::default();
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request: valid_request(ExecutionMode::Ask),
        provider: Arc::new(provider),
        sink: Arc::new(sink.clone()),
        bridge: timeout_bridge(Duration::from_millis(50)),
        cancel_token: CancellationToken::new(),
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    TurnEngine.run(ctx).await.unwrap();
    // Fail-closed: the tool never executes, the paired result is Blocked.
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::Blocked]);
    assert!(!sink.event_types().contains(&"toolExecutionRequested"));
    assert!(!sink.event_types().contains(&"toolStarted"));
}

#[tokio::test]
async fn tool_result_timeout_after_dispatch_is_outcome_unknown() {
    let provider = ScriptedProvider::tool_then_text("echo hi", "done");
    let sink = RecordingSink::default();
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request: valid_request(ExecutionMode::Ask),
        provider: Arc::new(provider),
        sink: Arc::new(sink.clone()),
        bridge: timeout_bridge(Duration::from_millis(50)),
        cancel_token: CancellationToken::new(),
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    TurnEngine.run(ctx).await.unwrap();
    assert_eq!(
        sink.tool_finished_statuses(),
        [ToolResultStatus::OutcomeUnknown]
    );
    // The dispatch DID happen before the timeout.
    assert!(sink.event_types().contains(&"toolStarted"));
}

/// Provider whose first round reports ToolsUnsupported and whose fallback
/// retry blocks forever — proves the fallback retry honours cancellation.
#[derive(Clone)]
struct FallbackBlockingProvider {
    calls: Arc<std::sync::atomic::AtomicUsize>,
    retry_entered: Arc<Notify>,
}

#[async_trait]
impl Provider for FallbackBlockingProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if call == 0 {
            Err(ProviderError::ToolsUnsupported)
        } else {
            self.retry_entered.notify_waiters();
            std::future::pending().await
        }
    }
}

#[tokio::test]
async fn fallback_retry_cancels_promptly() {
    let provider = Arc::new(FallbackBlockingProvider {
        calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        retry_entered: Arc::new(Notify::new()),
    });
    let factory = Arc::new(ScriptedFactory {
        provider: provider.clone(),
    });
    let runtime = Arc::new(AgentRuntime::new(factory));
    let sink = RecordingSink::default();
    let turn = runtime
        .start_turn(
            actor("owner-a"),
            valid_request(ExecutionMode::Ask),
            Arc::new(sink.clone()),
        )
        .await
        .unwrap();
    // First round fails with ToolsUnsupported; the retry is now blocked.
    provider.retry_entered.notified().await;
    tokio::task::yield_now().await;
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
    sink.wait_for_terminal().await;
    assert_eq!(sink.terminal_types(), ["turnCancelled"]);
}

// ---------------------------------------------------------------------------
// Explicit legacy fallback (ToolsUnsupported only)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn compatibility_fallback_activates_for_tools_unsupported() {
    let bridge = ScriptedBridge::succeed("exit 0");
    let provider = ScriptedProvider::tools_unsupported_then_text("```sh\necho hi\n```", "done");
    let sink = RecordingSink::default();
    run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider.clone()), bridge, sink.clone())
        .await
        .unwrap();
    // 第一次请求带 tools 触发 ToolsUnsupported；重试不带 tools。
    assert!(!provider.request(0).tools.is_empty());
    assert!(provider.request(1).tools.is_empty());
    assert!(sink
        .event_types()
        .contains(&"compatibilityFallbackActivated"));
    // fenced command 变为 synthetic tool 并执行一次。
    assert_eq!(
        sink.event_types()
            .iter()
            .filter(|t| **t == "toolStarted")
            .count(),
        1
    );
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::Succeeded]);
    // synthetic id 稳定为 turn_id + round + 0。
    assert_eq!(sink.tool_use_ids(), ["turn-1-0-0"]);
    assert_eq!(sink.terminal_types(), ["turnFinished"]);
}

#[tokio::test]
async fn provider_auth_error_does_not_trigger_fallback() {
    let provider = ScriptedProvider::fail_with(ProviderError::Auth);
    let sink = RecordingSink::default();
    let err = run_test_turn(provider, sink.clone()).await.unwrap_err();
    assert_eq!(err.code(), "providerAuth");
    assert!(!sink
        .event_types()
        .contains(&"compatibilityFallbackActivated"));
}

#[tokio::test]
async fn generic_http_error_does_not_trigger_fallback() {
    let provider = ScriptedProvider::fail_with(ProviderError::Http("status 500".into()));
    let sink = RecordingSink::default();
    let err = run_test_turn(provider, sink.clone()).await.unwrap_err();
    assert_eq!(err.code(), "providerHttp");
    assert!(!sink
        .event_types()
        .contains(&"compatibilityFallbackActivated"));
}

#[tokio::test]
async fn legacy_deny_prevents_final_synthesis_fence_execution() {
    let bridge = ScriptedBridge::deny();
    let provider = ScriptedProvider::tools_unsupported_then_fences(
        "```sh\nrm -rf /tmp/demo\n```",
        "```sh\necho must-not-run\n```",
    );
    let sink = RecordingSink::default();
    let err = run_tool_turn_with_provider(ExecutionMode::Ask, Arc::new(provider.clone()), bridge.clone(), sink.clone())
        .await
        .unwrap_err();
    // The final synthesis after a deny must fail the turn: the fenced command
    // is never approved, executed or re-synthesized.
    assert_eq!(err.code(), "toolsDisabledSynthesisViolated");
    assert_eq!(sink.terminal_types(), ["turnFailed"]);
    // 1 tools round (ToolsUnsupported) + 1 legacy retry + 1 final synthesis.
    assert_eq!(provider.request_count(), 3);
    assert!(!provider.request(0).tools.is_empty());
    assert!(provider.request(1).tools.is_empty());
    assert!(provider.request(2).tools.is_empty());
    // The pre-deny fence was proposed and denied exactly once; nothing after
    // the deny may execute.
    assert_eq!(bridge.approval_requests(), ["turn-1-0-0"]);
    assert!(bridge.executions().is_empty());
    assert_eq!(sink.count_type("toolStarted"), 0);
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::Denied]);
    assert_eq!(sink.count_type("compatibilityFallbackActivated"), 1);
    assert_eq!(sink.terminal_count(), 1);
}

#[tokio::test]
async fn legacy_round_cap_prevents_final_synthesis_fence_execution() {
    let bridge = ScriptedBridge::succeed("ok");
    let provider = ScriptedProvider::tools_unsupported_then_fences(
        "```sh\necho first\n```",
        "```sh\necho must-not-run\n```",
    );
    let sink = RecordingSink::default();
    let mut request = valid_request(ExecutionMode::Ask);
    request.round_cap = 1;
    let ctx = TurnContext {
        owner_id: "owner-a".into(),
        turn_id: "turn-1".into(),
        request,
        provider: Arc::new(provider.clone()),
        sink: Arc::new(sink.clone()),
        bridge: Arc::new(bridge.clone()),
        cancel_token: CancellationToken::new(),
        expected: Arc::new(parking_lot::Mutex::new(
            catio_lib::agent::ExpectedResponse::None,
        )),
    };
    let err = TurnEngine.run(ctx).await.unwrap_err();
    // Round cap reached: the ONE tools-disabled final synthesis must fail the
    // turn instead of executing the fenced command.
    assert_eq!(err.code(), "toolsDisabledSynthesisViolated");
    assert_eq!(sink.terminal_types(), ["turnFailed"]);
    assert_eq!(provider.request_count(), 3);
    assert!(provider.request(2).tools.is_empty());
    // Exactly one execution: the pre-cap legacy fence, never the post-cap one.
    assert_eq!(bridge.executions(), ["turn-1-0-0"]);
    assert_eq!(sink.count_type("toolStarted"), 1);
    assert_eq!(sink.count_type("compatibilityFallbackActivated"), 1);
    assert_eq!(sink.terminal_count(), 1);
}

/// Call 1: `ToolsUnsupported`; call 2: a fenced markdown round; later calls:
/// `ToolsUnsupported` again — proves the fallback never re-activates on a
/// capability error AFTER it already ran.
#[derive(Clone)]
struct FenceThenUnsupportedProvider {
    calls: Arc<std::sync::atomic::AtomicUsize>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

#[async_trait]
impl Provider for FenceThenUnsupportedProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        self.requests.lock().push(request.clone());
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match call {
            0 => Err(ProviderError::ToolsUnsupported),
            1 => {
                let fenced = "```sh\necho hi\n```";
                observer.text_delta(fenced);
                Ok(text_round(fenced))
            }
            _ => Err(ProviderError::ToolsUnsupported),
        }
    }
}

#[tokio::test]
async fn capability_error_after_fallback_does_not_reactivate() {
    let bridge = ScriptedBridge::succeed("ok");
    let provider = Arc::new(FenceThenUnsupportedProvider {
        calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        requests: Arc::new(Mutex::new(Vec::new())),
    });
    let sink = RecordingSink::default();
    let err = run_tool_turn_with_provider(ExecutionMode::Ask, provider.clone(), bridge.clone(), sink.clone())
        .await
        .unwrap_err();
    // The retried round executed its fence; a LATER ToolsUnsupported must not
    // re-trigger the fallback — it is a plain provider failure.
    assert_eq!(err.code(), "toolsUnsupported");
    assert_eq!(sink.terminal_types(), ["turnFailed"]);
    assert_eq!(provider.requests.lock().len(), 3);
    assert_eq!(sink.count_type("compatibilityFallbackActivated"), 1);
    assert_eq!(bridge.executions(), ["turn-1-0-0"]);
    assert_eq!(sink.terminal_count(), 1);
}
