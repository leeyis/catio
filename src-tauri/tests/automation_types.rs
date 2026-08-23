//! Task 1 contract tests: domain types + validation invariants.
//!
//! These tests pin the stable wire shape and validation rules before the
//! implementation exists (red → green). They never touch real files/network.

use catio_lib::agent::ApiCredential;
use catio_lib::automation::{
    McpAuth, McpConnection, McpTransport, ScheduledTask, Skill, SkillRisk, SkillScope, SkillSource,
    TaskKind, TaskPolicy, TaskTrigger,
};

fn task() -> ScheduledTask {
    ScheduledTask {
        id: "task-1".into(),
        name: "每日数据库备份巡检".into(),
        trigger: TaskTrigger::Cron {
            expr: "0 2 * * *".into(),
        },
        kind: TaskKind::Shell,
        script: Some("pg_dump -Fc prod > /backup/prod.dump".into()),
        prompt: None,
        target_ref: Some("postgres-prod".into()),
        skill_ids: vec![],
        mcp_ids: vec![],
        policy: TaskPolicy::Reject,
        whitelist: vec![],
        enabled: true,
        auto_confirmed: false,
        owner_id: "owner-a".into(),
    }
}

#[test]
fn validate_accepts_valid_cron_task() {
    assert!(task().validate().is_ok());
}

#[test]
fn validate_rejects_empty_name() {
    let mut t = task();
    t.name = "".into();
    assert_eq!(
        t.validate().unwrap_err().to_string(),
        "invalid: name is required"
    );
}

#[test]
fn validate_rejects_subminute_interval() {
    let mut t = task();
    t.trigger = TaskTrigger::Interval { seconds: 30 };
    assert!(t.validate().is_err());
    // Boundary: exactly one minute is the minimum.
    t.trigger = TaskTrigger::Interval { seconds: 60 };
    assert!(t.validate().is_ok());
}

#[test]
fn validate_rejects_malformed_cron() {
    let mut t = task();
    // Only 4 fields — invalid.
    t.trigger = TaskTrigger::Cron {
        expr: "* * * *".into(),
    };
    assert!(t.validate().is_err());
    // Six fields — invalid.
    t.trigger = TaskTrigger::Cron {
        expr: "* * * * * *".into(),
    };
    assert!(t.validate().is_err());
}

#[test]
fn validate_requires_script_for_shell() {
    let mut t = task();
    t.script = None;
    assert!(t.validate().is_err());
}

#[test]
fn validate_requires_prompt_for_prompt() {
    let mut t = task();
    t.kind = TaskKind::Prompt;
    t.script = None;
    t.prompt = Some("检查磁盘空间".into());
    assert!(t.validate().is_ok());
    // Prompt kind without prompt text is invalid.
    let mut t2 = task();
    t2.kind = TaskKind::Prompt;
    t2.script = None;
    t2.prompt = None;
    assert!(t2.validate().is_err());
}

#[test]
fn validate_auto_policy_requires_confirmation() {
    let mut t = task();
    t.kind = TaskKind::Prompt;
    t.script = None;
    t.prompt = Some("清理无用日志".into());
    t.policy = TaskPolicy::Auto;
    t.auto_confirmed = false;
    assert!(t.validate().is_err());

    t.auto_confirmed = true;
    assert!(t.validate().is_ok());
}

#[test]
fn trigger_serializes_stably() {
    let v = serde_json::to_value(TaskTrigger::Cron {
        expr: "0 2 * * *".into(),
    })
    .unwrap();
    assert_eq!(v["type"], "cron");
    assert_eq!(v["expr"], "0 2 * * *");
    let v = serde_json::to_value(TaskTrigger::Interval { seconds: 3600 }).unwrap();
    assert_eq!(v["type"], "interval");
    assert_eq!(v["seconds"], 3600);
}

#[test]
fn task_serializes_camel_case() {
    let value = serde_json::to_value(task()).unwrap();
    assert_eq!(value["ownerId"], "owner-a");
    assert_eq!(value["kind"], "shell");
    assert_eq!(value["targetRef"], "postgres-prod");
}

#[test]
fn skill_round_trips() {
    let skill = Skill {
        id: "s1".into(),
        name: "数据库巡检".into(),
        scope: SkillScope::Target,
        target_ref: Some("postgres-prod".into()),
        prompt_template: "检查 {{db}} 的健康状态".into(),
        risk_policy: SkillRisk::Readonly,
        source: SkillSource::Url {
            url: "https://skills.example/s1.json".into(),
        },
        version: 3,
        enabled: true,
        owner_id: "owner-a".into(),
    };
    let back: Skill = serde_json::from_value(serde_json::to_value(&skill).unwrap()).unwrap();
    assert_eq!(back, skill);
    // Version bumps on publish are user-visible, not derived here.
    assert_eq!(back.version, 3);
}

#[test]
fn mcp_connection_never_serializes_credential() {
    let mcp = McpConnection {
        id: "m1".into(),
        name: "Filesystem".into(),
        transport: McpTransport::Http,
        url: "http://127.0.0.1:8080/mcp".into(),
        auth: McpAuth::Bearer,
        credential: ApiCredential::from("sk-secret-value".to_string()),
        tool_allowlist: vec!["read_file".into()],
        status: Default::default(),
        discovered_tools: vec!["read_file".into()],
        owner_id: "owner-a".into(),
    };
    let json = serde_json::to_string(&mcp).unwrap();
    assert!(
        !json.contains("sk-secret-value"),
        "credential must not be serialized"
    );
    // Deserialize back: credential comes back empty, other fields intact.
    let back: McpConnection = serde_json::from_str(&json).unwrap();
    assert_eq!(back.name, "Filesystem");
    assert_eq!(back.url, "http://127.0.0.1:8080/mcp");
    assert_eq!(back.credential.expose(), "");
}
