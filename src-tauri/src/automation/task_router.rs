//! Task-CRUD backend tools for the built-in Catio Agent.
//!
//! These six tools (`list_tasks` … `disable_task`) are exposed ONLY through the
//! Agent's `ToolRouter` — i.e. the in-app Agent panel. They are deliberately NOT
//! added to the external MCP server's `lns_list`, so a third-party client
//! connecting to Catio's MCP endpoint can never see or call them.
//!
//! Every operation scopes by the turn's transport-injected `owner_id`; a
//! client-supplied `ownerId` in the input is ignored and overwritten.

use super::repo::AutomationStore;
use super::types::{AutomationError, ScheduledTask};
use crate::agent::engine::ToolRouter;
use crate::agent::types::{ToolResult, ToolResultStatus, ToolSpec};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

const LIST_TASKS: &str = "list_tasks";
const CREATE_TASK: &str = "create_task";
const UPDATE_TASK: &str = "update_task";
const DELETE_TASK: &str = "delete_task";
const ENABLE_TASK: &str = "enable_task";
const DISABLE_TASK: &str = "disable_task";

pub struct TaskRouter {
    repo: Arc<AutomationStore>,
}

impl TaskRouter {
    pub fn new(repo: Arc<AutomationStore>) -> Self {
        Self { repo }
    }
}

fn input_schema_for_task() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "task name" },
            "trigger": { "type": "object", "description": "cron|interval|once trigger" },
            "kind": { "type": "string", "enum": ["shell", "prompt"], "description": "what the task runs" },
            "script": { "type": "string", "description": "shell body when kind=shell" },
            "prompt": { "type": "string", "description": "prompt body when kind=prompt" },
            "targetRef": { "type": "string", "description": "target host/db, * = all" },
            "skillIds": { "type": "array", "items": { "type": "string" } },
            "mcpIds": { "type": "array", "items": { "type": "string" } },
            "policy": { "type": "string", "enum": ["reject", "whitelist", "auto"] },
            "whitelist": { "type": "array", "items": { "type": "string" } },
            "enabled": { "type": "boolean" }
        },
        "required": ["name", "trigger", "kind"]
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
                description: "Create a scheduled task (cron / interval / once, shell or prompt)"
                    .into(),
                input_schema: input_schema_for_task(),
            },
            ToolSpec {
                name: UPDATE_TASK.into(),
                description: "Update a scheduled task (same id, version-neutral field edits)"
                    .into(),
                input_schema: input_schema_for_task(),
            },
            ToolSpec {
                name: DELETE_TASK.into(),
                description: "Delete a scheduled task".into(),
                input_schema: id_schema(),
            },
            ToolSpec {
                name: ENABLE_TASK.into(),
                description: "Enable a scheduled task".into(),
                input_schema: id_schema(),
            },
            ToolSpec {
                name: DISABLE_TASK.into(),
                description: "Disable a scheduled task".into(),
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
            CREATE_TASK => self.create_or_update(owner_id, &input),
            UPDATE_TASK => self.create_or_update(owner_id, &input),
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
        // Owner is transport-injected: fill it before deserializing so a
        // missing field doesn't reject, and a client-supplied ownerId is
        // overwritten. The assignment after parsing is the authoritative one.
        let mut task_input = input.clone();
        task_input["ownerId"] = json!(owner);
        let mut task: ScheduledTask = serde_json::from_value(task_input)
            .map_err(|e| AutomationError::Invalid(format!("bad task input: {e}")))?;
        task.owner_id = owner.to_string();
        task.validate()?;
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
