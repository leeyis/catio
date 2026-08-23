//! Task 12 contract tests: AutomationDispatcher routing (shell/prompt) with
//! realistic failure branches that don't need a live session or model.

use async_trait::async_trait;
use catio_lib::agent::provider::{ProviderError, ProviderObserver, ProviderRequest, ProviderRound};
use catio_lib::agent::{AgentError, Provider, ProviderConfig, ProviderFactory};
use catio_lib::automation::dispatcher::{
    AutomationDispatcher, SessionProviderConfig, TaskResults, TaskRunStatus,
};
use catio_lib::automation::history::PromptHistoryStore;
use catio_lib::automation::mcp_client::McpClient;
use catio_lib::automation::scheduler::TaskDispatcher;
use catio_lib::automation::{AutomationStore, ScheduledTask, TaskKind, TaskPolicy, TaskTrigger};
use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

fn task(kind: TaskKind) -> ScheduledTask {
    ScheduledTask {
        id: "t1".into(),
        name: "任务".into(),
        trigger: TaskTrigger::Once {
            at: "2026-01-01T00:00:00Z".into(),
        },
        kind,
        script: Some("echo hi".into()),
        prompt: Some("检查磁盘".into()),
        target_ref: Some("web-01".into()),
        skill_ids: vec![],
        mcp_ids: vec![],
        policy: TaskPolicy::Reject,
        whitelist: vec![],
        enabled: true,
        auto_confirmed: false,
        owner_id: "owner-a".into(),
    }
}

/// A provider factory that never makes a network call (prompt tests never
/// reach it because the provider source is empty first).
#[derive(Clone)]
struct NoopProvider;

#[async_trait]
impl Provider for NoopProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        Err(ProviderError::Auth)
    }
}

struct NoopFactory;

#[async_trait]
impl ProviderFactory for NoopFactory {
    async fn create(&self, _config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        Ok(Arc::new(NoopProvider))
    }
}

fn build(dir: &std::path::Path) -> (AutomationDispatcher, Arc<AutomationStore>, TaskResults) {
    let _ = std::fs::remove_dir_all(dir);
    let store = Arc::new(AutomationStore::open(dir));
    let history = Arc::new(PromptHistoryStore::open(dir));
    let sessions = Arc::new(SessionManager::default());
    let runtime = Arc::new(catio_lib::agent::AgentRuntime::new(Arc::new(NoopFactory)));
    let provider = Arc::new(SessionProviderConfig::default());
    let results: TaskResults = Arc::new(RwLock::new(HashMap::new()));
    let mcp = Arc::new(McpClient::new(reqwest::Client::new()));
    let dispatcher = AutomationDispatcher::new(
        store.clone(),
        sessions,
        runtime,
        history,
        provider,
        results.clone(),
        mcp,
    );
    (dispatcher, store, results)
}

#[tokio::test]
async fn shell_task_without_connected_target_is_recorded_failed() {
    let dir = std::env::temp_dir().join(format!("catio-disp-shell-{}", std::process::id()));
    let (dispatcher, _, results) = build(&dir);
    dispatcher.dispatch(&task(TaskKind::Shell)).await.unwrap();
    let info = results.read().get("t1").cloned().expect("result recorded");
    assert_eq!(info.status, TaskRunStatus::Failed);
    assert!(info.summary.contains("未连接"), "got: {}", info.summary);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn prompt_task_without_provider_is_recorded_failed() {
    let dir = std::env::temp_dir().join(format!("catio-disp-prompt-{}", std::process::id()));
    let (dispatcher, _, results) = build(&dir);
    dispatcher.dispatch(&task(TaskKind::Prompt)).await.unwrap();
    let info = results.read().get("t1").cloned().expect("result recorded");
    assert_eq!(info.status, TaskRunStatus::Failed);
    assert!(info.summary.contains("Provider"), "got: {}", info.summary);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn shell_task_with_empty_target_is_recorded_failed() {
    let dir = std::env::temp_dir().join(format!("catio-disp-notarget-{}", std::process::id()));
    let (dispatcher, _, results) = build(&dir);
    let mut t = task(TaskKind::Shell);
    t.target_ref = None;
    dispatcher.dispatch(&t).await.unwrap();
    let info = results.read().get("t1").cloned().expect("result recorded");
    assert_eq!(info.status, TaskRunStatus::Failed);
    assert!(info.summary.contains("目标"), "got: {}", info.summary);
    let _ = std::fs::remove_dir_all(&dir);
}

/// End-to-end: a shell task whose target is an actually-connected session runs
/// the script on the real container and records a success summary.
#[tokio::test]
#[ignore = "requires a local sshd container (see ssh_live.rs doc comment)"]
async fn live_shell_task_runs_on_connected_target() {
    let dir = std::env::temp_dir().join(format!("catio-disp-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(AutomationStore::open(&dir));
    let history = Arc::new(PromptHistoryStore::open(&dir));
    let sessions = Arc::new(SessionManager::default());

    let args = ConnectArgs {
        host: "127.0.0.1".into(),
        port: 2222,
        user: "root".into(),
        auth: AuthMethod::Password,
        secret: Some("testpass123".into()),
        jump: None,
    };
    let (handle, _fp, forwarded, jump) =
        connect_authenticated(&args).await.expect("connect failed");
    sessions
        .insert(
            "catio-ssh-test".into(),
            Session {
                handle,
                host: "127.0.0.1".into(),
                user: "root".into(),
                terms: HashMap::new(),
                forwarded,
                _jump: jump,
            },
        )
        .await;

    let runtime = Arc::new(catio_lib::agent::AgentRuntime::new(Arc::new(NoopFactory)));
    let provider = Arc::new(SessionProviderConfig::default());
    let results: TaskResults = Arc::new(RwLock::new(HashMap::new()));
    let mcp = Arc::new(McpClient::new(reqwest::Client::new()));
    let dispatcher = AutomationDispatcher::new(
        store.clone(),
        sessions,
        runtime,
        history,
        provider,
        results.clone(),
        mcp,
    );

    let mut t = task(TaskKind::Shell);
    t.target_ref = Some("catio-ssh-test".into());
    t.script = Some("echo live-catio-ok && hostname".into());
    dispatcher.dispatch(&t).await.unwrap();

    let info = results.read().get("t1").cloned().expect("result recorded");
    assert_eq!(info.status, TaskRunStatus::Success, "got: {}", info.summary);
    assert!(
        info.summary.contains("live-catio-ok"),
        "got: {}",
        info.summary
    );
    let _ = std::fs::remove_dir_all(&dir);
}
