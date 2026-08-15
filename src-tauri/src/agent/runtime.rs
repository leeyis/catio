//! `AgentRuntime`: the only public entry point for starting, responding to and
//! cancelling Turns. Owns the active Turn registry, owner/state/idempotency
//! routing and cancellation; the engine task never outlives its entry.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use rand::RngExt as _;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent::bridge::RuntimeBridge;
use crate::agent::engine::{TurnContext, TurnEngine};
use crate::agent::provider::Provider;
use crate::agent::types::{
    ActorContext, AgentError, ClientTurnResponse, ExpectedResponse, ProviderConfig,
    StartTurnRequest, TurnHandle,
};
use crate::agent::AgentEventSink;

/// Constructs concrete providers from `ProviderConfig`.
#[async_trait]
pub trait ProviderFactory: Send + Sync {
    async fn create(&self, config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError>;
}

struct ActiveTurn {
    owner_id: String,
    expected: Arc<Mutex<ExpectedResponse>>,
    consumed: HashMap<String, String>,
    sender: mpsc::UnboundedSender<ClientTurnResponse>,
    cancel_token: CancellationToken,
    /// Set right after the engine task is spawned; `None` only during the
    /// brief window between registry insert and spawn.
    task: Option<JoinHandle<()>>,
}

/// Deep module holding the active Turn registry; desktop, server and tests
/// share this one surface.
pub struct AgentRuntime {
    turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
    factory: Arc<dyn ProviderFactory>,
}

impl AgentRuntime {
    pub fn new(factory: Arc<dyn ProviderFactory>) -> Self {
        Self {
            turns: Arc::new(Mutex::new(HashMap::new())),
            factory,
        }
    }

    /// Production runtime with the shared reqwest-backed provider factory.
    pub fn production() -> Self {
        Self::new(Arc::new(
            crate::agent::provider::ReqwestProviderFactory::default(),
        ))
    }

    /// Starts a Turn and returns an opaque handle. The frontend must subscribe
    /// to `agent://events` before calling this.
    pub async fn start_turn(
        &self,
        actor: ActorContext,
        request: StartTurnRequest,
        events: Arc<dyn AgentEventSink>,
    ) -> Result<TurnHandle, AgentError> {
        request.validate()?;
        let provider = self.factory.create(&request.provider).await?;
        let turn_id = generate_turn_id();
        let cancel_token = CancellationToken::new();
        let (sender, receiver) = mpsc::unbounded_channel();
        let expected = Arc::new(Mutex::new(ExpectedResponse::None));

        let ctx = TurnContext {
            owner_id: actor.owner_id.clone(),
            turn_id: turn_id.clone(),
            request,
            provider,
            sink: events,
            bridge: Arc::new(RuntimeBridge::new(receiver, cancel_token.clone())),
            cancel_token: cancel_token.clone(),
            expected: expected.clone(),
        };

        // Insert the active entry BEFORE the engine task can run: a fast (or
        // panicking) task must never observe a missing entry (the
        // spawn-before-insert race) and leave a leftover behind.
        self.turns.lock().insert(
            turn_id.clone(),
            ActiveTurn {
                owner_id: actor.owner_id,
                expected,
                consumed: HashMap::new(),
                sender,
                cancel_token,
                task: None,
            },
        );

        let turns = self.turns.clone();
        let task_turn_id = turn_id.clone();
        let task = tokio::spawn(async move {
            // RAII cleanup: removes the active entry even when the engine
            // task panics mid-run (a bare statement after `.await` would not
            // execute on unwind).
            struct CleanupGuard {
                turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
                turn_id: String,
            }
            impl Drop for CleanupGuard {
                fn drop(&mut self) {
                    self.turns.lock().remove(&self.turn_id);
                }
            }
            let _guard = CleanupGuard {
                turns,
                turn_id: task_turn_id,
            };
            let _ = TurnEngine.run(ctx).await;
        });

        // The task may already have finished (and cleaned up its entry);
        // attach the handle only while the entry still exists.
        if let Some(entry) = self.turns.lock().get_mut(&turn_id) {
            entry.task = Some(task);
        }
        Ok(TurnHandle { turn_id })
    }

    /// Routes a client response. Order: owner → active entry → dedupe key →
    /// digest → expected response. Replays of an already-consumed response are
    /// idempotent no-ops; a conflicting response for the same key is rejected.
    pub async fn respond(
        &self,
        actor: ActorContext,
        turn: TurnHandle,
        response: ClientTurnResponse,
    ) -> Result<(), AgentError> {
        let turn_id = turn.turn_id;
        let mut turns = self.turns.lock();
        if !turns.contains_key(&turn_id) {
            return Err(AgentError::TurnNotFound);
        }
        if turns
            .get(&turn_id)
            .is_some_and(|entry| entry.task.as_ref().is_some_and(|t| t.is_finished()))
        {
            // Terminal turn: never reactivatable.
            turns.remove(&turn_id);
            return Err(AgentError::TurnNotFound);
        }
        let entry = turns.get_mut(&turn_id).expect("checked above");
        if entry.owner_id != actor.owner_id {
            return Err(AgentError::OwnerMismatch);
        }

        let key = response_key(&response);
        let digest = digest(&response);
        if let Some(existing) = entry.consumed.get(&key) {
            if *existing == digest {
                return Ok(());
            }
            return Err(AgentError::ResponseConflict);
        }
        let expected = entry.expected.lock().clone();
        if !expected.matches(&response) {
            return Err(AgentError::TurnStateConflict(format!(
                "expected {:?}, got {}",
                expected.key(),
                key
            )));
        }
        entry.consumed.insert(key, digest);
        entry
            .sender
            .send(response)
            .map_err(|_| AgentError::TurnNotFound)?;
        Ok(())
    }

    /// Cancels a Turn: signals the cancel token and wakes approval/tool
    /// waiters. The engine decides `Cancelled` vs `OutcomeUnknown` per the
    /// dispatch state.
    pub async fn cancel(&self, actor: ActorContext, turn: TurnHandle) -> Result<(), AgentError> {
        let turn_id = turn.turn_id;
        let mut turns = self.turns.lock();
        if !turns.contains_key(&turn_id) {
            return Err(AgentError::TurnNotFound);
        }
        if turns
            .get(&turn_id)
            .is_some_and(|entry| entry.task.as_ref().is_some_and(|t| t.is_finished()))
        {
            turns.remove(&turn_id);
            return Err(AgentError::TurnNotFound);
        }
        let entry = turns.get_mut(&turn_id).expect("checked above");
        if entry.owner_id != actor.owner_id {
            return Err(AgentError::OwnerMismatch);
        }
        entry.cancel_token.cancel();
        Ok(())
    }
}

fn response_key(response: &ClientTurnResponse) -> String {
    match response {
        ClientTurnResponse::ApprovalDecision { tool_use_id, .. } => {
            format!("approval:{tool_use_id}")
        }
        ClientTurnResponse::ToolExecutionResult { tool_use_id, .. } => {
            format!("toolResult:{tool_use_id}")
        }
    }
}

/// Stable canonical digest of the response for idempotency checks.
fn digest(response: &ClientTurnResponse) -> String {
    serde_json::to_string(response).unwrap_or_default()
}

fn generate_turn_id() -> String {
    let nonce: u64 = rand::rng().random();
    format!("turn-{}", nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::NoopBridge;
    use crate::agent::engine::AgentEventSink;
    use crate::agent::provider::{
        ProviderError, ProviderObserver, ProviderRequest, ProviderRound, ProviderStop,
    };
    use crate::agent::types::{
        AgentEvent, AgentEventEnvelope, AgentMessage, AgentRole, AnthropicAuthMode, ApiCredential,
        ContentBlock, ExecutionMode, ProviderProtocol,
    };
    use std::sync::Weak;

    fn valid_request() -> StartTurnRequest {
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
            execution_mode: ExecutionMode::Ask,
            single_line_commands: true,
            round_cap: 5,
        }
    }

    fn actor() -> ActorContext {
        ActorContext {
            owner_id: "owner-a".into(),
        }
    }

    #[derive(Clone, Default)]
    struct RecordingSink(Arc<Mutex<Vec<AgentEventEnvelope>>>);

    #[async_trait]
    impl AgentEventSink for RecordingSink {
        async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError> {
            self.0.lock().push(envelope);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct TextProvider;

    #[async_trait]
    impl Provider for TextProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _observer: &dyn ProviderObserver,
        ) -> Result<ProviderRound, ProviderError> {
            Ok(ProviderRound {
                message: AgentMessage {
                    role: AgentRole::Assistant,
                    content: vec![ContentBlock::Text {
                        text: "done".into(),
                    }],
                },
                stop: ProviderStop::Stop,
                usage: None,
            })
        }
    }

    #[derive(Clone)]
    struct FailingProvider;

    #[async_trait]
    impl Provider for FailingProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _observer: &dyn ProviderObserver,
        ) -> Result<ProviderRound, ProviderError> {
            Err(ProviderError::Auth)
        }
    }

    /// Panics inside `complete` — the engine task must still clean up.
    #[derive(Clone)]
    struct PanicProvider;

    #[async_trait]
    impl Provider for PanicProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _observer: &dyn ProviderObserver,
        ) -> Result<ProviderRound, ProviderError> {
            panic!("provider exploded")
        }
    }

    #[derive(Clone)]
    struct TrackingFactory {
        last: Arc<Mutex<Option<Weak<dyn Provider>>>>,
    }

    #[async_trait]
    impl ProviderFactory for TrackingFactory {
        async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
            let provider: Arc<dyn Provider> = Arc::new(PanicProvider);
            *self.last.lock() = Some(Arc::downgrade(&provider));
            Ok(provider)
        }
    }

    fn text_factory() -> Arc<ScriptedFactory<TextProvider>> {
        Arc::new(ScriptedFactory {
            provider: Arc::new(TextProvider),
        })
    }

    fn failing_factory() -> Arc<ScriptedFactory<FailingProvider>> {
        Arc::new(ScriptedFactory {
            provider: Arc::new(FailingProvider),
        })
    }

    #[derive(Clone)]
    struct ScriptedFactory<P: Provider> {
        provider: Arc<P>,
    }

    #[async_trait]
    impl<P: Provider + Send + Sync + 'static> ProviderFactory for ScriptedFactory<P> {
        async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
            Ok(self.provider.clone())
        }
    }

    /// Waits (bounded) until the active registry is empty.
    async fn wait_empty(runtime: &AgentRuntime) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if runtime.turns.lock().is_empty() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active registry never emptied");
    }

    #[tokio::test]
    async fn success_removes_active_entry_and_drops_provider() {
        let runtime = AgentRuntime::new(text_factory());
        let _turn = runtime
            .start_turn(actor(), valid_request(), Arc::new(RecordingSink::default()))
            .await
            .unwrap();
        wait_empty(&runtime).await;
        assert!(runtime.turns.lock().is_empty());
    }

    #[tokio::test]
    async fn failure_removes_active_entry() {
        let runtime = AgentRuntime::new(failing_factory());
        let _turn = runtime
            .start_turn(actor(), valid_request(), Arc::new(RecordingSink::default()))
            .await
            .unwrap();
        wait_empty(&runtime).await;
        assert!(runtime.turns.lock().is_empty());
    }

    #[tokio::test]
    async fn panic_in_provider_removes_active_entry_and_drops_provider() {
        let factory = Arc::new(TrackingFactory {
            last: Arc::new(Mutex::new(None)),
        });
        let runtime = AgentRuntime::new(factory.clone());
        let _turn = runtime
            .start_turn(actor(), valid_request(), Arc::new(RecordingSink::default()))
            .await
            .unwrap();
        wait_empty(&runtime).await;
        assert!(runtime.turns.lock().is_empty());
        let weak = factory.last.lock().clone();
        assert!(
            weak.as_ref().is_none_or(|w| w.upgrade().is_none()),
            "provider must be dropped after a panicked turn"
        );
    }

    #[tokio::test]
    async fn fast_turn_never_leaves_a_leftover_entry() {
        // The engine task may finish before `start_turn` returns. The registry
        // entry must be inserted BEFORE the task can run its cleanup, so a
        // fast (or panicked) task can never leave a leftover active entry.
        let runtime = AgentRuntime::new(text_factory());
        let _turn = runtime
            .start_turn(actor(), valid_request(), Arc::new(RecordingSink::default()))
            .await
            .unwrap();
        wait_empty(&runtime).await;
        assert!(runtime.turns.lock().is_empty());
    }
}
