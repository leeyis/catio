//! Tauri command adapters: fixed local desktop actor, `agent://events`
//! delivery and error surfacing. The `*_for_actor` bodies are macro-free so
//! tests drive them without a running Tauri app.

use std::sync::Arc;

use async_trait::async_trait;
use tauri::{AppHandle, Emitter, State};

use crate::agent::runtime::AgentRuntime;
use crate::agent::types::{
    ActorContext, AgentError, AgentEventEnvelope, ClientTurnResponse, StartTurnRequest, TurnHandle,
};
use crate::agent::AgentEventSink;

/// Desktop actor: transport-injected and never request-controlled.
pub fn desktop_actor() -> ActorContext {
    ActorContext {
        owner_id: "local".into(),
    }
}

/// Event sink delivering envelopes to the frontend `agent://events` topic.
pub struct TauriAgentEventSink {
    app: AppHandle,
    topic: &'static str,
}

impl TauriAgentEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            topic: "agent://events",
        }
    }
}

#[async_trait]
impl AgentEventSink for TauriAgentEventSink {
    async fn emit(&self, envelope: AgentEventEnvelope) -> Result<(), AgentError> {
        // A failed emit fails the Turn: never silently drop the first or
        // terminal event.
        self.app
            .emit(self.topic, &envelope)
            .map_err(|e| AgentError::EventSink(e.to_string()))
    }
}

pub async fn start_turn_for_actor(
    runtime: &AgentRuntime,
    actor: ActorContext,
    request: StartTurnRequest,
    sink: Arc<dyn AgentEventSink>,
) -> Result<TurnHandle, AgentError> {
    runtime.start_turn(actor, request, sink).await
}

pub async fn respond_for_actor(
    runtime: &AgentRuntime,
    actor: ActorContext,
    turn_id: String,
    response: ClientTurnResponse,
) -> Result<(), AgentError> {
    runtime
        .respond(actor, TurnHandle { turn_id }, response)
        .await
}

pub async fn cancel_for_actor(
    runtime: &AgentRuntime,
    actor: ActorContext,
    turn_id: String,
) -> Result<(), AgentError> {
    runtime.cancel(actor, TurnHandle { turn_id }).await
}

#[tauri::command]
pub async fn agent_start_turn(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: StartTurnRequest,
) -> Result<TurnHandle, String> {
    let sink = TauriAgentEventSink::new(app);
    start_turn_for_actor(&state, desktop_actor(), request, Arc::new(sink))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_respond(
    state: State<'_, AgentRuntime>,
    turn_id: String,
    response: ClientTurnResponse,
) -> Result<(), String> {
    respond_for_actor(&state, desktop_actor(), turn_id, response)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AgentRuntime>, turn_id: String) -> Result<(), String> {
    cancel_for_actor(&state, desktop_actor(), turn_id)
        .await
        .map_err(|e| e.to_string())
}
