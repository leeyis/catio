//! Task 9 contract tests: desktop command bodies (owner injection, parsing).

use catio_lib::automation::commands::{parse_task_input, skill_from_import};
use catio_lib::automation::{
    AutomationStore, ScheduledTask, SkillScope, TaskKind, TaskPolicy, TaskTrigger,
};
use serde_json::json;

fn task_input() -> serde_json::Value {
    json!({
        "id": "t1",
        "name": "备份",
        "trigger": { "type": "cron", "expr": "0 2 * * *" },
        "kind": "shell",
        "script": "pg_dump prod",
        "policy": "reject",
        "enabled": true
    })
}

#[test]
fn parse_task_input_injects_desktop_owner_and_rejects_spoofed_owner() {
    let mut input = task_input();
    input["ownerId"] = json!("attacker");
    let task = parse_task_input("local", input).unwrap();
    assert_eq!(task.owner_id, "local");
    assert_eq!(task.id, "t1");
    assert_eq!(
        task.trigger,
        TaskTrigger::Cron {
            expr: "0 2 * * *".into()
        }
    );
    assert_eq!(task.kind, TaskKind::Shell);
}

#[test]
fn parse_task_input_rejects_invalid_task() {
    let bad = json!({ "id": "x", "name": "", "trigger": { "type": "once", "at": "" } });
    assert!(parse_task_input("local", bad).is_err());
}

#[test]
fn skill_from_import_parses_and_scopes() {
    let body = r#"{ "name": "巡检", "promptTemplate": "检查 {{host}}" }"#.to_string();
    let skill =
        skill_from_import("local", body, SkillScope::Target, Some("web-01".into()), None).unwrap();
    assert_eq!(skill.name, "巡检");
    assert_eq!(skill.scope, SkillScope::Target);
    assert_eq!(skill.target_ref.as_deref(), Some("web-01"));
    assert_eq!(skill.owner_id, "local");
    assert_eq!(skill.version, 1);
}

#[test]
fn skill_from_import_rejects_bad_body() {
    assert!(skill_from_import("local", "<html>".into(), SkillScope::Global, None, None).is_err());
}

#[test]
fn store_upsert_task_validates() {
    let dir = std::env::temp_dir().join(format!("catio-cmd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = AutomationStore::open(&dir);
    let task = parse_task_input("local", task_input()).unwrap();
    store.upsert_task(&task).unwrap();
    assert_eq!(store.list_tasks("local").len(), 1);
    // Other owners can't see it.
    assert!(store.list_tasks("someone-else").is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
