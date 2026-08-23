//! Task-CRUD backend tools for the built-in Catio Agent.
//!
//! These six tools (`list_tasks` … `disable_task`) are exposed ONLY through the
//! Agent's `ToolRouter` — i.e. the in-app Agent panel. They are deliberately NOT
//! added to the external MCP server's `lns_list`, so a third-party client
//! connecting to Catio's MCP endpoint can never see or call them.
//!
//! Every operation scopes by the turn's transport-injected `owner_id`; a
//! client-supplied `ownerId` in the input is ignored and overwritten.
//!
//! `create_task`/`update_task` parse **leniently**: the LLM rarely emits the
//! exact serde shape, so a cron string, a trigger object, a missing `id`
//! (auto-generated) or a missing `targetRef` (defaults to the frontend's
//! active connection) are all tolerated instead of rejected.

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use rand::RngExt as _;
use serde_json::{json, Value};

use crate::agent::engine::ToolRouter;
use crate::agent::types::{ToolResult, ToolResultStatus, ToolSpec};

use super::repo::AutomationStore;
use super::types::{AutomationError, ScheduledTask, TaskKind, TaskPolicy, TaskTrigger};

const LIST_TASKS: &str = "list_tasks";
const CREATE_TASK: &str = "create_task";
const UPDATE_TASK: &str = "update_task";
const DELETE_TASK: &str = "delete_task";
const ENABLE_TASK: &str = "enable_task";
const DISABLE_TASK: &str = "disable_task";

/// The frontend's currently-active connection id, injected by the app. Used as
/// the default `targetRef` when a task doesn't name one, so tasks created in
/// natural language land on the connection the user is looking at.
pub type ActiveTarget = Arc<RwLock<Option<String>>>;

pub struct TaskRouter {
    repo: Arc<AutomationStore>,
    active_target: ActiveTarget,
}

impl TaskRouter {
    pub fn new(repo: Arc<AutomationStore>, active_target: ActiveTarget) -> Self {
        Self {
            repo,
            active_target,
        }
    }
}

fn input_schema_for_task() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "task name (required)" },
            "id": { "type": "string", "description": "optional; auto-generated if omitted" },
            "kind": { "type": "string", "enum": ["shell", "prompt"], "description": "what the task runs; defaults to shell" },
            "script": { "type": "string", "description": "shell body when kind=shell" },
            "prompt": { "type": "string", "description": "prompt body when kind=prompt" },
            "trigger": { "type": ["string", "object"], "description": "a 5-field cron string like '*/2 * * * *', or an object: {type:'cron',expr:'...'}, {type:'interval',seconds:120}, {type:'once',at:'2026-08-23T22:30:00Z'}" },
            "targetRef": { "type": "string", "description": "target connection id (host/db); defaults to the currently active connection if omitted" },
            "skillIds": { "type": "array", "items": { "type": "string" } },
            "mcpIds": { "type": "array", "items": { "type": "string" } },
            "policy": { "type": "string", "enum": ["reject", "whitelist", "auto"], "description": "unattended permission policy; defaults to reject" },
            "whitelist": { "type": "array", "items": { "type": "string" } },
            "enabled": { "type": "boolean" }
        },
        "required": ["name"]
    })
}

fn id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "id": { "type": "string", "description": "task id" } },
        "required": ["id"]
    })
}

#[async_trait]
impl ToolRouter for TaskRouter {
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: LIST_TASKS.into(),
                description: "List the caller's scheduled tasks".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
            },
            ToolSpec {
                name: CREATE_TASK.into(),
                description: "Create a scheduled task. Provide a `name` and either `script` (shell) or `prompt` (prompt), plus a `trigger`: a 5-field cron string like '*/2 * * * *', or an object {type:'interval',seconds:120} or {type:'once',at:'...'}. `targetRef` defaults to the active connection; `id`/`policy` are optional.".into(),
                input_schema: input_schema_for_task(),
            },
            ToolSpec {
                name: UPDATE_TASK.into(),
                description: "Update an existing task (same id; fields edited like create_task)".into(),
                input_schema: input_schema_for_task(),
            },
            ToolSpec {
                name: DELETE_TASK.into(),
                description: "Delete a scheduled task by id".into(),
                input_schema: id_schema(),
            },
            ToolSpec {
                name: ENABLE_TASK.into(),
                description: "Enable a scheduled task by id".into(),
                input_schema: id_schema(),
            },
            ToolSpec {
                name: DISABLE_TASK.into(),
                description: "Disable a scheduled task by id".into(),
                input_schema: id_schema(),
            },
        ]
    }

    async fn dispatch(
        &self,
        tool_use_id: &str,
        owner_id: &str,
        name: &str,
        input: Value,
    ) -> Option<ToolResult> {
        let result = match name {
            LIST_TASKS => self.list_tasks(owner_id),
            CREATE_TASK | UPDATE_TASK => self.create_or_update(owner_id, &input),
            DELETE_TASK => self.delete(owner_id, &input),
            ENABLE_TASK => self.set_enabled(owner_id, &input, true),
            DISABLE_TASK => self.set_enabled(owner_id, &input, false),
            _ => return None,
        };
        Some(match result {
            Ok(content) => ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content,
                status: ToolResultStatus::Succeeded,
            },
            Err(err) => ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: err.to_string(),
                status: ToolResultStatus::Failed,
            },
        })
    }
}

impl TaskRouter {
    fn list_tasks(&self, owner: &str) -> Result<String, AutomationError> {
        let tasks = self.repo.list_tasks(owner);
        serde_json::to_string_pretty(&tasks).map_err(|e| AutomationError::Storage(e.to_string()))
    }

    fn create_or_update(&self, owner: &str, input: &Value) -> Result<String, AutomationError> {
        let task = parse_task_lenient(owner, input, self.active_target.clone())?;
        self.repo.upsert_task(&task)?;
        Ok(format!("task {} saved", task.id))
    }

    fn delete(&self, owner: &str, input: &Value) -> Result<String, AutomationError> {
        let id = id_from(input)?;
        self.repo.delete_task(owner, &id)?;
        Ok(format!("task {id} deleted"))
    }

    fn set_enabled(
        &self,
        owner: &str,
        input: &Value,
        enabled: bool,
    ) -> Result<String, AutomationError> {
        let id = id_from(input)?;
        self.repo.set_task_enabled(owner, &id, enabled)?;
        Ok(format!(
            "task {id} {}",
            if enabled { "enabled" } else { "disabled" }
        ))
    }
}

fn id_from(input: &Value) -> Result<String, AutomationError> {
    input
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| AutomationError::Invalid("task id is required".into()))
}

fn str_field(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn arr_field(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Lenient trigger parsing: a cron string, or a `{type, ...}` object, or
/// `{cron: '...'}`, `{interval: '...'}`, `{once: '...'}` shorthand.
fn parse_trigger(input: &Value) -> Result<TaskTrigger, AutomationError> {
    let v = input.get("trigger").ok_or_else(|| {
        AutomationError::Invalid("trigger is required (e.g. a cron string '*/2 * * * *' or {type:'interval',seconds:120})".into())
    })?;
    match v {
        Value::String(s) if !s.trim().is_empty() => Ok(TaskTrigger::Cron {
            expr: s.trim().to_string(),
        }),
        Value::Object(o) => {
            let ty = o.get("type").and_then(Value::as_str).unwrap_or("cron");
            match ty {
                "cron" => {
                    let expr = o
                        .get("expr")
                        .or_else(|| o.get("cron"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AutomationError::Invalid("cron trigger needs expr".into()))?;
                    Ok(TaskTrigger::Cron {
                        expr: expr.trim().to_string(),
                    })
                }
                "interval" => {
                    let secs = o
                        .get("seconds")
                        .or_else(|| o.get("interval"))
                        .and_then(Value::as_u64)
                        .ok_or_else(|| AutomationError::Invalid("interval trigger needs seconds".into()))?;
                    Ok(TaskTrigger::Interval { seconds: secs })
                }
                "once" => {
                    let at = o
                        .get("at")
                        .or_else(|| o.get("once"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AutomationError::Invalid("once trigger needs at".into()))?;
                    Ok(TaskTrigger::Once {
                        at: at.trim().to_string(),
                    })
                }
                other => Err(AutomationError::Invalid(format!(
                    "unknown trigger type {other:?} (use cron|interval|once)"
                ))),
            }
        }
        _ => Err(AutomationError::Invalid(
            "trigger must be a cron string or an object".into(),
        )),
    }
}

/// Build a `ScheduledTask` from a possibly-messy LLM payload. Defaults: id
/// auto-generated, kind=shell, policy=reject, targetRef=active connection.
fn parse_task_lenient(
    owner: &str,
    input: &Value,
    active_target: ActiveTarget,
) -> Result<ScheduledTask, AutomationError> {
    let name = str_field(input, "name")
        .ok_or_else(|| AutomationError::Invalid("task name is required".into()))?;
    let id = str_field(input, "id").unwrap_or_else(|| {
        format!("task-{}", rand::rng().random::<u64>())
    });
    let kind = match input.get("kind").and_then(Value::as_str) {
        Some("prompt") | Some("Prompt") => TaskKind::Prompt,
        Some("shell") | Some("Shell") | None => TaskKind::Shell,
        Some(other) => {
            return Err(AutomationError::Invalid(format!(
                "kind must be shell or prompt (got {other:?})"
            )))
        }
    };
    let script = str_field(input, "script");
    let prompt = str_field(input, "prompt");
    let trigger = parse_trigger(input)?;
    let policy = match input.get("policy").and_then(Value::as_str) {
        Some("whitelist") => TaskPolicy::Whitelist,
        Some("auto") => TaskPolicy::Auto,
        _ => TaskPolicy::Reject,
    };
    let target_ref = str_field(input, "targetRef")
        .or_else(|| str_field(input, "target"))
        .or_else(|| active_target.read().clone());

    if kind == TaskKind::Shell && script.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AutomationError::Invalid(
            "shell task requires a script".into(),
        ));
    }
    if kind == TaskKind::Prompt && prompt.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AutomationError::Invalid(
            "prompt task requires a prompt".into(),
        ));
    }

    let auto_confirmed = policy == TaskPolicy::Auto;
    let task = ScheduledTask {
        id,
        name,
        trigger,
        kind,
        script,
        prompt,
        target_ref,
        skill_ids: arr_field(input, "skillIds"),
        mcp_ids: arr_field(input, "mcpIds"),
        policy,
        whitelist: arr_field(input, "whitelist"),
        enabled: input
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        auto_confirmed,
        owner_id: owner.to_string(),
    };
    task.validate()?;
    Ok(task)
}
