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
    task: JoinHandle<()>,
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

        let turns = self.turns.clone();
        let task_turn_id = turn_id.clone();
        let task = tokio::spawn(async move {
            let result = TurnEngine.run(ctx).await;
            // Best-effort cleanup; `lookup` also prunes finished tasks.
            turns.lock().remove(&task_turn_id);
            let _ = result;
        });

        self.turns.lock().insert(
            turn_id.clone(),
            ActiveTurn {
                owner_id: actor.owner_id,
                expected,
                consumed: HashMap::new(),
                sender,
                cancel_token,
                task,
            },
        );
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
            .is_some_and(|entry| entry.task.is_finished())
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
            .is_some_and(|entry| entry.task.is_finished())
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
