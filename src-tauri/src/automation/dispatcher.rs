//! Production `TaskDispatcher`: drives a fired scheduled task to completion.
//!
//! - `shell` tasks execute the script on the target's **live SSH session**
//!   (`SessionManager` — the session is already authenticated, so no secret
//!   ever touches the store or task payload). If the target isn't connected the
//!   run is recorded as failed.
//! - `prompt` tasks assemble a `StartTurnRequest` (rendered skills + unattended
//!   policy + the session provider config) and run it through `AgentRuntime`,
//!   recording the outcome into prompt history.
//!
//! Every run writes a `TaskRunInfo` into a shared results map the frontend
//! reads to show "last run" state per task.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use parking_lot::{Mutex, RwLock};

use crate::agent::runtime::AgentRuntime;
use crate::agent::types::{
    ActorContext, AgentError, AgentMessage, AgentRole, ContentBlock, ExecutionMode, ProviderConfig,
    StartTurnRequest, UnattendedPolicy,
};
use crate::agent::AgentEventSink;
use crate::ssh::manager::SessionManager;
use crate::ssh::multiexec::run_on;

use super::history::{PromptHistoryEntry, PromptHistoryStore, PromptOutcome, PromptSource};
use super::mcp_client::McpClient;
use super::mcp_router::McpRouter;
use super::prompt::build_user_prompt;
use super::repo::AutomationStore;
use super::scheduler::TaskDispatcher;
use super::types::{AutomationError, ScheduledTask, TaskKind, TaskPolicy};

/// Result of one fired run, surfaced to the frontend task list.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunInfo {
    pub task_id: String,
    pub status: TaskRunStatus,
    /// Output summary or error message.
    pub summary: String,
    pub at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskRunStatus {
    Success,
    Failed,
}

/// Supplies the provider config for prompt tasks. Desktop keeps one in session
/// memory (set by the frontend); server mode would scope per owner.
#[async_trait]
pub trait ProviderConfigSource: Send + Sync {
    async fn current(&self) -> Option<ProviderConfig>;
}

/// Session-memory provider source; the frontend pushes it via a command.
#[derive(Default)]
pub struct SessionProviderConfig {
    current: RwLock<Option<ProviderConfig>>,
}

impl SessionProviderConfig {
    pub fn set(&self, config: ProviderConfig) {
        *self.current.write() = Some(config);
    }
}

#[async_trait]
impl ProviderConfigSource for SessionProviderConfig {
    async fn current(&self) -> Option<ProviderConfig> {
        self.current.read().clone()
    }
}

/// Shared "last run" results keyed by task id.
pub type TaskResults = Arc<RwLock<HashMap<String, TaskRunInfo>>>;

pub struct AutomationDispatcher {
    repo: Arc<AutomationStore>,
    sessions: Arc<SessionManager>,
    runtime: Arc<AgentRuntime>,
    history: Arc<PromptHistoryStore>,
    provider: Arc<dyn ProviderConfigSource>,
    results: TaskResults,
    mcp: Arc<McpClient>,
}

impl AutomationDispatcher {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<AutomationStore>,
        sessions: Arc<SessionManager>,
        runtime: Arc<AgentRuntime>,
        history: Arc<PromptHistoryStore>,
        provider: Arc<dyn ProviderConfigSource>,
        results: TaskResults,
        mcp: Arc<McpClient>,
    ) -> Self {
        Self {
            repo,
            sessions,
            runtime,
            history,
            provider,
            results,
            mcp,
        }
    }

    fn record(&self, task_id: &str, status: TaskRunStatus, summary: String) {
        self.results.write().insert(
            task_id.to_string(),
            TaskRunInfo {
                task_id: task_id.to_string(),
                status,
                summary,
                at: Utc::now().to_rfc3339(),
            },
        );
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[async_trait]
impl TaskDispatcher for AutomationDispatcher {
    async fn dispatch(&self, task: &ScheduledTask) -> Result<(), AutomationError> {
        match task.kind {
            TaskKind::Shell => self.run_shell(task).await,
            TaskKind::Prompt => self.run_prompt(task).await,
        }
    }
}

impl AutomationDispatcher {
    async fn run_shell(&self, task: &ScheduledTask) -> Result<(), AutomationError> {
        let target = task.target_ref.clone().unwrap_or_default();
        if target.is_empty() {
            self.record(&task.id, TaskRunStatus::Failed, "任务未指定目标连接".into());
            return Ok(());
        }
        let session = match self.sessions.get(&target).await {
            Some(s) => s,
            None => {
                self.record(
                    &task.id,
                    TaskRunStatus::Failed,
                    "目标未连接（请先在 Catio 中连接该主机）".into(),
                );
                return Ok(());
            }
        };
        let script = task.script.clone().unwrap_or_default();
        match run_on(session, &script).await {
            Ok(out) => {
                let summary = if out.trim().is_empty() {
                    "exit 0（无输出）".to_string()
                } else {
                    truncate(out.trim(), 200)
                };
                self.record(&task.id, TaskRunStatus::Success, summary);
            }
            Err(e) => {
                self.record(&task.id, TaskRunStatus::Failed, format!("执行失败: {e}"));
            }
        }
        Ok(())
    }

    async fn run_prompt(&self, task: &ScheduledTask) -> Result<(), AutomationError> {
        let Some(provider) = self.provider.current().await else {
            self.record(
                &task.id,
                TaskRunStatus::Failed,
                "未配置 AI Provider（请在设置中配置模型）".into(),
            );
            return Ok(());
        };

        // Render the task's referenced skills, then prepend the task prompt.
        let skills = self
            .repo
            .list_skills(&task.owner_id)
            .into_iter()
            .filter(|s| task.skill_ids.contains(&s.id))
            .collect::<Vec<_>>();
        let ctx = HashMap::new();
        let user_prompt = build_user_prompt(task, &skills, &ctx);

        let request = StartTurnRequest {
            conversation_id: format!("task-{}", task.id),
            messages: vec![AgentMessage {
                role: AgentRole::User,
                content: vec![ContentBlock::Text { text: user_prompt }],
            }],
            system_prompt: String::new(),
            terminal_context: String::new(),
            target_ref: task.target_ref.clone().unwrap_or_default(),
            provider,
            execution_mode: ExecutionMode::Ask,
            single_line_commands: true,
            round_cap: 5,
        };
        let unattended = match task.policy {
            TaskPolicy::Reject => Some(UnattendedPolicy::RejectSensitive),
            TaskPolicy::Whitelist => Some(UnattendedPolicy::Whitelist {
                commands: task.whitelist.clone(),
            }),
            TaskPolicy::Auto => Some(UnattendedPolicy::Auto),
        };
        let actor = ActorContext {
            owner_id: task.owner_id.clone(),
        };
        let sink =
            HistoryCollectingSink::new(self.history.clone(), self.results.clone(), task.clone());
        // Scope the turn's external-MCP tools to the task's chosen connections.
        let mcp_router: Option<Arc<dyn crate::agent::engine::ToolRouter>> =
            if task.mcp_ids.is_empty() {
                None
            } else {
                Some(Arc::new(McpRouter::scoped(
                    self.repo.clone(),
                    self.mcp.clone(),
                    task.mcp_ids.clone(),
                )))
            };
        if let Err(e) = self
            .runtime
            .start_turn_with_router(actor, request, Arc::new(sink), unattended, mcp_router)
            .await
        {
            self.record(&task.id, TaskRunStatus::Failed, format!("启动失败: {e}"));
        }
        Ok(())
    }
}

/// Collects a prompt turn's terminal outcome, writes prompt history and the
/// task's last-run result on drop.
struct HistoryCollectingSink {
    history: Arc<PromptHistoryStore>,
    results: TaskResults,
    task: ScheduledTask,
    outcome: Mutex<PromptOutcome>,
}

impl HistoryCollectingSink {
    fn new(history: Arc<PromptHistoryStore>, results: TaskResults, task: ScheduledTask) -> Self {
        Self {
            history,
            results,
            task,
            outcome: Mutex::new(PromptOutcome::OutcomeUnknown),
        }
    }
}

#[async_trait]
impl AgentEventSink for HistoryCollectingSink {
    async fn emit(
        &self,
        _envelope: crate::agent::types::AgentEventEnvelope,
    ) -> Result<(), AgentError> {
        use crate::agent::types::AgentEvent;
        match &_envelope.event {
            AgentEvent::TurnFinished => *self.outcome.lock() = PromptOutcome::Completed,
            AgentEvent::TurnCancelled => *self.outcome.lock() = PromptOutcome::Cancelled,
            AgentEvent::TurnFailed { .. } => *self.outcome.lock() = PromptOutcome::Failed,
            _ => {}
        }
        Ok(())
    }
}

impl Drop for HistoryCollectingSink {
    fn drop(&mut self) {
        let outcome = self.outcome.lock().clone();
        let entry = PromptHistoryEntry {
            id: format!(
                "ph-{}-{}",
                self.task.id,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            ),
            kind: "prompt".into(),
            source: PromptSource::Task,
            turn_id: self.task.id.clone(),
            target: self.task.target_ref.clone().unwrap_or_default(),
            text: truncate(&self.task.prompt.clone().unwrap_or_default(), 120),
            outcome: outcome.clone(),
            when: Utc::now().to_rfc3339(),
            dur: String::new(),
            owner_id: self.task.owner_id.clone(),
        };
        let _ = self.history.push(entry);

        let (status, summary) = match outcome {
            PromptOutcome::Completed => (TaskRunStatus::Success, "已完成".to_string()),
            PromptOutcome::Failed => (TaskRunStatus::Failed, "失败".to_string()),
            PromptOutcome::Cancelled => (TaskRunStatus::Failed, "已取消".to_string()),
            PromptOutcome::OutcomeUnknown => (TaskRunStatus::Failed, "结果未知".to_string()),
        };
        self.results.write().insert(
            self.task.id.clone(),
            TaskRunInfo {
                task_id: self.task.id.clone(),
                status,
                summary,
                at: Utc::now().to_rfc3339(),
            },
        );
    }
}
