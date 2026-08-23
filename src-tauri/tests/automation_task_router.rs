//! Task 7 contract tests: task-CRUD backend tools (built-in Agent only).

use catio_lib::agent::engine::ToolRouter;
use catio_lib::agent::ToolResultStatus;
use catio_lib::automation::task_router::TaskRouter;
use catio_lib::automation::{AutomationStore, TaskTrigger};
use serde_json::json;
use std::sync::Arc;

fn store_in(dir: &std::path::Path) -> Arc<AutomationStore> {
    let _ = std::fs::remove_dir_all(dir);
    Arc::new(AutomationStore::open(dir))
}

fn valid_task_input() -> serde_json::Value {
    json!({
        "id": "t1",
        "name": "备份",
        "trigger": { "type": "cron", "expr": "0 2 * * *" },
        "kind": "shell",
        "script": "pg_dump prod",
        "targetRef": "postgres-prod",
        "policy": "reject",
        "enabled": true
    })
}

#[tokio::test]
async fn tool_specs_expose_six_task_tools() {
    let dir = std::env::temp_dir().join(format!("catio-tr-spec-{}", std::process::id()));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));
    let specs = router.tool_specs();
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    for want in [
        "list_tasks",
        "create_task",
        "update_task",
        "delete_task",
        "enable_task",
        "disable_task",
    ] {
        assert!(names.contains(&want), "missing {want}: {names:?}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn create_then_list_then_enable_disable_then_delete() {
    let dir = std::env::temp_dir().join(format!("catio-tr-{}-{}", std::process::id(), "crud"));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));

    // create_task — even with a spoofed ownerId, the injected owner wins.
    let mut input = valid_task_input();
    input["ownerId"] = json!("attacker");
    let res = router
        .dispatch("u1", "owner-a", "create_task", input)
        .await
        .unwrap();
    assert_eq!(res.status, ToolResultStatus::Succeeded);

    // list_tasks scopes by owner.
    let listed = router
        .dispatch("u2", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    assert_eq!(listed.status, ToolResultStatus::Succeeded);
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    assert_eq!(tasks[0]["ownerId"], "owner-a");
    assert_eq!(tasks[0]["trigger"]["type"], "cron");

    // Another owner sees nothing.
    let other = router
        .dispatch("u3", "owner-b", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks_b: serde_json::Value = serde_json::from_str(&other.content).unwrap();
    assert!(tasks_b.as_array().unwrap().is_empty());

    // disable / enable / delete by id.
    let dis = router
        .dispatch("u4", "owner-a", "disable_task", json!({ "id": "t1" }))
        .await
        .unwrap();
    assert_eq!(dis.status, ToolResultStatus::Succeeded);
    let listed = router
        .dispatch("u5", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert_eq!(tasks[0]["enabled"], false);

    let en = router
        .dispatch("u6", "owner-a", "enable_task", json!({ "id": "t1" }))
        .await
        .unwrap();
    assert_eq!(en.status, ToolResultStatus::Succeeded);
    let listed = router
        .dispatch("u7", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert_eq!(tasks[0]["enabled"], true);

    let del = router
        .dispatch("u8", "owner-a", "delete_task", json!({ "id": "t1" }))
        .await
        .unwrap();
    assert_eq!(del.status, ToolResultStatus::Succeeded);
    let listed = router
        .dispatch("u9", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert!(tasks.as_array().unwrap().is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn delete_by_wrong_owner_fails() {
    let dir = std::env::temp_dir().join(format!("catio-tr-{}-{}", std::process::id(), "owner"));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));
    let created = router
        .dispatch("u1", "owner-a", "create_task", valid_task_input())
        .await
        .unwrap();
    assert_eq!(
        created.status,
        ToolResultStatus::Succeeded,
        "create failed: {}",
        created.content
    );

    let del = router
        .dispatch("u2", "owner-b", "delete_task", json!({ "id": "t1" }))
        .await
        .unwrap();
    assert_eq!(del.status, ToolResultStatus::Failed);
    assert!(del.content.contains("not found"));

    // Owner A's task is still there.
    let listed = router
        .dispatch("u3", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn invalid_create_input_fails() {
    let dir = std::env::temp_dir().join(format!("catio-tr-{}-{}", std::process::id(), "bad"));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));
    // Missing kind / script → validate rejects.
    let bad = json!({ "id": "x", "name": "", "trigger": { "type": "once", "at": "" } });
    let res = router
        .dispatch("u1", "owner-a", "create_task", bad)
        .await
        .unwrap();
    assert_eq!(res.status, ToolResultStatus::Failed);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unknown_tool_falls_through() {
    let dir = std::env::temp_dir().join(format!("catio-tr-{}-{}", std::process::id(), "unknown"));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));
    let res = router.dispatch("u1", "owner-a", "nope", json!({})).await;
    assert!(res.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn update_task_replaces_fields_same_id() {
    let dir = std::env::temp_dir().join(format!("catio-tr-{}-{}", std::process::id(), "upd"));
    let router = TaskRouter::new(store_in(&dir), std::sync::Arc::new(parking_lot::RwLock::new(None)));
    router
        .dispatch("u1", "owner-a", "create_task", valid_task_input())
        .await
        .unwrap();

    let mut updated = valid_task_input();
    updated["name"] = json!("改名备份");
    let res = router
        .dispatch("u2", "owner-a", "update_task", updated)
        .await
        .unwrap();
    assert_eq!(res.status, ToolResultStatus::Succeeded);

    let listed = router
        .dispatch("u3", "owner-a", "list_tasks", json!({}))
        .await
        .unwrap();
    let tasks: serde_json::Value = serde_json::from_str(&listed.content).unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    assert_eq!(tasks[0]["name"], "改名备份");
    assert_eq!(tasks[0]["trigger"]["expr"], "0 2 * * *");
    let _ = std::fs::remove_dir_all(&dir);
}

// Re-export guard: ScheduledTask trigger deserializes with tag type.
#[test]
fn task_trigger_from_json_round_trips() {
    let t: TaskTrigger =
        serde_json::from_value(json!({ "type": "interval", "seconds": 3600 })).unwrap();
    assert_eq!(t, TaskTrigger::Interval { seconds: 3600 });
}
