//! Task 1 contract tests: AutomationStore persistence + owner isolation.
//!
//! Uses temp dirs only — never the real app-data dir. Mirrors the db/history.rs
//! test style.

use catio_lib::agent::ApiCredential;
use catio_lib::automation::{
    AutomationStore, McpAuth, McpConnection, McpTransport, ScheduledTask, Skill, SkillRisk,
    SkillScope, TaskKind, TaskPolicy, TaskTrigger,
};

fn task(owner: &str) -> ScheduledTask {
    ScheduledTask {
        id: format!("{owner}-t1"),
        name: "备份".into(),
        trigger: TaskTrigger::Cron {
            expr: "0 2 * * *".into(),
        },
        kind: TaskKind::Shell,
        script: Some("pg_dump prod".into()),
        prompt: None,
        target_ref: Some("postgres-prod".into()),
        skill_ids: vec![],
        mcp_ids: vec![],
        policy: TaskPolicy::Reject,
        whitelist: vec![],
        enabled: true,
        auto_confirmed: false,
        owner_id: owner.into(),
    }
}

fn skill(owner: &str) -> Skill {
    Skill {
        id: format!("{owner}-s1"),
        name: "巡检".into(),
        scope: SkillScope::Global,
        target_ref: None,
        prompt_template: "检查 {{host}}".into(),
        risk_policy: SkillRisk::Readonly,
        source: catio_lib::automation::SkillSource::Import,
        version: 1,
        enabled: true,
        owner_id: owner.into(),
    }
}

fn mcp(owner: &str) -> McpConnection {
    McpConnection {
        id: format!("{owner}-m1"),
        name: "Filesystem".into(),
        transport: McpTransport::Http,
        url: "http://127.0.0.1:8080/mcp".into(),
        auth: McpAuth::Bearer,
        credential: ApiCredential::from(format!("sk-{owner}")),
        tool_allowlist: vec![],
        status: Default::default(),
        discovered_tools: vec!["read_file".into()],
        owner_id: owner.into(),
    }
}

fn store_in(dir: &std::path::Path) -> AutomationStore {
    let _ = std::fs::remove_dir_all(dir);
    let store = AutomationStore::open(dir);
    store
}

#[test]
fn store_round_trips_tasks_through_temp_dir() {
    let dir = std::env::temp_dir().join(format!("catio-auto-t-{}", std::process::id()));
    let store = store_in(&dir);

    assert!(store.list_tasks("owner-a").is_empty());
    store.upsert_task(&task("owner-a")).unwrap();
    let back = store.list_tasks("owner-a");
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].name, "备份");
    assert_eq!(
        back[0].trigger,
        TaskTrigger::Cron {
            expr: "0 2 * * *".into()
        }
    );

    // Reload from disk — persisted, not just in-memory.
    let reopened = AutomationStore::open(&dir);
    assert_eq!(reopened.list_tasks("owner-a").len(), 1);

    store.delete_task("owner-a", "owner-a-t1").unwrap();
    assert!(store.list_tasks("owner-a").is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_filters_by_owner() {
    let dir = std::env::temp_dir().join(format!("catio-auto-o-{}", std::process::id()));
    let store = store_in(&dir);

    store.upsert_task(&task("owner-a")).unwrap();
    store.upsert_task(&task("owner-b")).unwrap();

    assert_eq!(store.list_tasks("owner-a").len(), 1);
    assert_eq!(store.list_tasks("owner-b").len(), 1);
    // Owner A cannot see or touch B's task.
    let b_tasks = store.list_tasks("owner-a");
    assert!(b_tasks.iter().all(|t| t.owner_id == "owner-a"));
    store.delete_task("owner-a", "owner-b-t1").unwrap_err();
    assert_eq!(store.list_tasks("owner-b").len(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_round_trips_skills() {
    let dir = std::env::temp_dir().join(format!("catio-auto-s-{}", std::process::id()));
    let store = store_in(&dir);

    store.upsert_skill(&skill("owner-a")).unwrap();
    assert_eq!(store.list_skills("owner-a").len(), 1);
    store.delete_skill("owner-a", "owner-a-s1").unwrap();
    assert!(store.list_skills("owner-a").is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_skips_credential_on_disk() {
    let dir = std::env::temp_dir().join(format!("catio-auto-c-{}", std::process::id()));
    let store = store_in(&dir);

    store.upsert_mcp(&mcp("owner-a")).unwrap();
    // The JSON file on disk must not contain the plaintext credential.
    let raw = std::fs::read_to_string(dir.join("mcps.json")).unwrap();
    assert!(
        !raw.contains("sk-owner-a"),
        "credential leaked to disk: {raw}"
    );

    // In-memory credential survives in this session.
    let cred = store.mcp_credential("owner-a", "owner-a-m1").unwrap();
    assert_eq!(cred.expose(), "sk-owner-a");

    // After reopen, the connection row exists but the credential is gone.
    let reopened = AutomationStore::open(&dir);
    assert_eq!(reopened.list_mcps("owner-a").len(), 1);
    assert!(reopened.mcp_credential("owner-a", "owner-a-m1").is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_upsert_replaces_same_id() {
    let dir = std::env::temp_dir().join(format!("catio-auto-u-{}", std::process::id()));
    let store = store_in(&dir);

    store.upsert_task(&task("owner-a")).unwrap();
    let mut t = task("owner-a");
    t.name = "改名".into();
    store.upsert_task(&t).unwrap();
    let back = store.list_tasks("owner-a");
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].name, "改名");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_set_task_enabled_toggles() {
    let dir = std::env::temp_dir().join(format!("catio-auto-e-{}", std::process::id()));
    let store = store_in(&dir);

    store.upsert_task(&task("owner-a")).unwrap();
    store
        .set_task_enabled("owner-a", "owner-a-t1", false)
        .unwrap();
    assert!(!store.list_tasks("owner-a")[0].enabled);
    store
        .set_task_enabled("owner-a", "owner-a-t1", true)
        .unwrap();
    assert!(store.list_tasks("owner-a")[0].enabled);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn store_skill_version_bumps_on_update() {
    let dir = std::env::temp_dir().join(format!("catio-auto-v-{}", std::process::id()));
    let store = store_in(&dir);

    let mut s = skill("owner-a"); // version 1
    store.upsert_skill(&s).unwrap();
    assert_eq!(store.list_skills("owner-a")[0].version, 1);

    // Editing the same skill with a stale/equal version must bump, not overwrite.
    s.name = "改名巡检".into();
    store.upsert_skill(&s).unwrap();
    assert_eq!(store.list_skills("owner-a")[0].version, 2);
    assert_eq!(store.list_skills("owner-a")[0].name, "改名巡检");
    assert_eq!(store.list_skills("owner-a").len(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}
