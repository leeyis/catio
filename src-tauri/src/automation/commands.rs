//! Tauri command adapters for the automation workbench (desktop head).
//!
//! Desktop is single-user: the actor owner is always `local`, transport-injected
//! and never client-controlled. Command bodies are macro-free helpers so the
//! owner injection + validation logic is unit-testable without a running Tauri
//! app (mirrors `agent::commands`).

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use super::dispatcher::{SessionProviderConfig, TaskResults, TaskRunInfo};
use super::scheduler::Scheduler;
use super::task_router::ActiveTarget;
use super::history::PromptHistoryStore;
use super::mcp_client::{McpClient, McpError};
use super::repo::AutomationStore;
use super::skill::{install_skill, parse_skill_json};
use super::types::{AutomationError, McpConnection, ScheduledTask, Skill, SkillScope, SkillSource};
use crate::agent::types::{AnthropicAuthMode, ApiCredential, ProviderConfig, ProviderProtocol};

/// Desktop owner — fixed, never request-supplied.
pub const DESKTOP_OWNER: &str = "local";

/// Injectable runner for fired scheduled tasks (shell / prompt). The desktop
/// wiring supplies a production runner that drives SSH execution + the Agent
/// runtime; tests inject a scripted one.
#[async_trait::async_trait]
pub trait TaskRunner: Send + Sync {
    async fn run(&self, task: &ScheduledTask) -> Result<String, AutomationError>;
}

/// Parse a client task payload, injecting the desktop owner (a spoofed
/// `ownerId` is overwritten). Macro-free → unit-testable.
pub fn parse_task_input(owner: &str, input: Value) -> Result<ScheduledTask, AutomationError> {
    let mut task_input = input;
    task_input["ownerId"] = json!(owner);
    let mut task: ScheduledTask = serde_json::from_value(task_input)
        .map_err(|e| AutomationError::Invalid(format!("bad task input: {e}")))?;
    task.owner_id = owner.to_string();
    task.validate()?;
    Ok(task)
}

/// Compose a skill from imported bytes + desktop owner.
pub fn skill_from_import(
    owner: &str,
    body: String,
    scope: SkillScope,
    target_ref: Option<String>,
) -> Result<Skill, AutomationError> {
    let imp = parse_skill_json(body.as_bytes())?;
    Ok(super::skill::new_skill_from_import(
        &imp,
        scope,
        target_ref,
        SkillSource::Import,
        owner,
    ))
}

pub async fn list_tasks(store: &AutomationStore) -> Vec<ScheduledTask> {
    store.list_tasks(DESKTOP_OWNER)
}

pub async fn create_task(
    store: &AutomationStore,
    task: ScheduledTask,
) -> Result<String, AutomationError> {
    store.upsert_task(&task)?;
    Ok(format!("task {} saved", task.id))
}

pub async fn delete_task(store: &AutomationStore, id: String) -> Result<(), AutomationError> {
    store.delete_task(DESKTOP_OWNER, &id)
}

pub async fn set_task_enabled(
    store: &AutomationStore,
    id: String,
    enabled: bool,
) -> Result<(), AutomationError> {
    store.set_task_enabled(DESKTOP_OWNER, &id, enabled)
}

pub async fn test_mcp(client: &McpClient, conn: McpConnection) -> Result<Vec<String>, McpError> {
    client.list_tools(&conn).await
}

pub async fn install_skill_for_owner(
    http: &reqwest::Client,
    url: String,
    scope: SkillScope,
    target_ref: Option<String>,
) -> Result<Skill, AutomationError> {
    install_skill(http, &url, scope, target_ref, DESKTOP_OWNER).await
}

// ---- Tauri command wrappers ----

pub struct AutomationService {
    pub store: Arc<AutomationStore>,
    pub history: Arc<PromptHistoryStore>,
    pub client: Arc<McpClient>,
    pub http: reqwest::Client,
    /// Last-run results for scheduled tasks, surfaced to the task list.
    pub results: TaskResults,
    /// Session provider config for prompt tasks (set by the frontend).
    pub provider: Arc<SessionProviderConfig>,
    /// The frontend's active connection id — default target for tasks created
    /// in natural language.
    pub active_target: ActiveTarget,
    /// The running scheduler (heartbeat for diagnostics).
    pub scheduler: std::sync::Arc<Scheduler>,
}

#[tauri::command]
pub async fn automation_list_tasks(
    state: State<'_, AutomationService>,
) -> Result<Vec<ScheduledTask>, String> {
    Ok(list_tasks(&state.store).await)
}

#[tauri::command]
pub async fn automation_create_task(
    state: State<'_, AutomationService>,
    task: Value,
) -> Result<String, String> {
    let task = parse_task_input(DESKTOP_OWNER, task).map_err(|e| e.to_string())?;
    create_task(&state.store, task)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_delete_task(
    state: State<'_, AutomationService>,
    id: String,
) -> Result<(), String> {
    delete_task(&state.store, id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_set_task_enabled(
    state: State<'_, AutomationService>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    set_task_enabled(&state.store, id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_list_skills(
    state: State<'_, AutomationService>,
) -> Result<Vec<Skill>, String> {
    Ok(state.store.list_skills(DESKTOP_OWNER))
}

#[tauri::command]
pub async fn automation_import_skill(
    state: State<'_, AutomationService>,
    body: String,
    scope: SkillScope,
    target_ref: Option<String>,
) -> Result<Skill, String> {
    let skill =
        skill_from_import(DESKTOP_OWNER, body, scope, target_ref).map_err(|e| e.to_string())?;
    state
        .store
        .upsert_skill(&skill)
        .map_err(|e| e.to_string())?;
    Ok(skill)
}

#[tauri::command]
pub async fn automation_install_skill(
    state: State<'_, AutomationService>,
    url: String,
    scope: SkillScope,
    target_ref: Option<String>,
) -> Result<Skill, String> {
    let skill = install_skill_for_owner(&state.http, url, scope, target_ref)
        .await
        .map_err(|e| e.to_string())?;
    state
        .store
        .upsert_skill(&skill)
        .map_err(|e| e.to_string())?;
    Ok(skill)
}

#[tauri::command]
pub async fn automation_delete_skill(
    state: State<'_, AutomationService>,
    id: String,
) -> Result<(), String> {
    state
        .store
        .delete_skill(DESKTOP_OWNER, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_set_skill_enabled(
    state: State<'_, AutomationService>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .store
        .set_skill_enabled(DESKTOP_OWNER, &id, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_list_mcps(
    state: State<'_, AutomationService>,
) -> Result<Vec<McpConnection>, String> {
    Ok(state.store.list_mcps(DESKTOP_OWNER))
}

#[tauri::command]
pub async fn automation_add_mcp(
    state: State<'_, AutomationService>,
    conn: McpConnection,
) -> Result<String, String> {
    // Owner is transport-injected; the connection row keeps the credential in
    // session memory (never serialized) keyed by the injected id.
    let mut conn = conn;
    conn.owner_id = DESKTOP_OWNER.to_string();
    let id = conn.id.clone();
    state.store.upsert_mcp(&conn).map_err(|e| e.to_string())?;
    Ok(format!("mcp {id} saved"))
}

#[tauri::command]
pub async fn automation_delete_mcp(
    state: State<'_, AutomationService>,
    id: String,
) -> Result<(), String> {
    state
        .store
        .delete_mcp(DESKTOP_OWNER, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_test_mcp(
    state: State<'_, AutomationService>,
    conn: McpConnection,
) -> Result<Vec<String>, String> {
    let mut conn = conn;
    conn.owner_id = DESKTOP_OWNER.to_string();
    test_mcp(state.client.as_ref(), conn)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_list_prompt_history(
    state: State<'_, AutomationService>,
) -> Result<Vec<super::history::PromptHistoryEntry>, String> {
    Ok(state.history.list(DESKTOP_OWNER))
}

#[tauri::command]
pub async fn automation_clear_prompt_history(
    state: State<'_, AutomationService>,
) -> Result<(), String> {
    state
        .history
        .clear(DESKTOP_OWNER)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_delete_prompt_history(
    state: State<'_, AutomationService>,
    id: String,
) -> Result<(), String> {
    state
        .history
        .delete(DESKTOP_OWNER, &id)
        .map_err(|e| e.to_string())
}

/// Last-run results for scheduled tasks (what the task list shows).
#[tauri::command]
pub async fn automation_task_results(
    state: State<'_, AutomationService>,
) -> Result<Vec<TaskRunInfo>, String> {
    Ok(state.results.read().values().cloned().collect())
}

/// Scheduler heartbeat (diagnostic: proves the tick loop is running).
#[tauri::command]
pub async fn automation_scheduler_heartbeat(
    state: State<'_, AutomationService>,
) -> Result<Option<String>, String> {
    Ok(state.scheduler.last_tick().map(|t| t.to_rfc3339()))
}

/// The frontend reports the connection the user is currently looking at; tasks
/// created via natural language default their target to it.
#[tauri::command]
pub async fn automation_set_active_target(
    state: State<'_, AutomationService>,
    target: String,
) -> Result<(), String> {
    *state.active_target.write() = if target.is_empty() { None } else { Some(target) };
    Ok(())
}

/// Push the current AI provider config for prompt tasks (session memory only —
/// the credential never persists).
#[tauri::command]
pub async fn automation_set_provider(
    state: State<'_, AutomationService>,
    protocol: ProviderProtocol,
    base_url: String,
    model: String,
    anthropic_auth_mode: AnthropicAuthMode,
    credential: String,
) -> Result<(), String> {
    state.provider.set(ProviderConfig {
        protocol,
        base_url,
        model,
        credential: ApiCredential::from(credential),
        anthropic_auth_mode,
    });
    Ok(())
}
