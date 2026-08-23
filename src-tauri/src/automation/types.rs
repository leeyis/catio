//! Provider-neutral domain types for the automation workbench.
//!
//! Wire shapes are camelCase (`#[serde(rename_all = "camelCase")]`) and stable,
//! mirroring the existing `agent::types` conventions. `McpConnection.credential`
//! reuses `agent::ApiCredential`: redacted `Debug`, never serialized to disk.

use crate::agent::ApiCredential;
use serde::{Deserialize, Serialize};

/// Validation / storage errors surfaced to the command layer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AutomationError {
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("storage: {0}")]
    Storage(String),
    #[error("network: {0}")]
    Network(String),
}

/// A scheduled task fires on a trigger and executes a shell script or an Agent
/// prompt. Mirrors Spec §5.1.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub trigger: TaskTrigger,
    pub kind: TaskKind,
    /// Shell body — required when `kind == Shell`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    /// Prompt body — required when `kind == Prompt`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Target host/db reference; `*` means all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub mcp_ids: Vec<String>,
    pub policy: TaskPolicy,
    #[serde(default)]
    pub whitelist: Vec<String>,
    pub enabled: bool,
    /// User confirmation for `policy == Auto`. Only meaningful then.
    #[serde(default)]
    pub auto_confirmed: bool,
    /// Transport-injected owner; never client-supplied.
    pub owner_id: String,
}

/// How a task is scheduled. `tag = "type"` keeps the wire shape explicit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskTrigger {
    Cron { expr: String },
    Interval { seconds: u64 },
    Once { at: String },
}

/// What a task executes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Shell,
    Prompt,
}

/// Unattended permission policy for prompt tasks. Spec §10.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskPolicy {
    /// Sensitive commands are auto-rejected and recorded. Default.
    Reject,
    /// Only exact-match whitelist commands are allowed.
    Whitelist,
    /// Sensitive commands run without approval — requires explicit confirmation.
    Auto,
}

/// A reusable instruction template injected into Agent context.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub scope: SkillScope,
    /// Bound target when `scope == Target`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    /// Template text with `{{host}}` / `{{db}}` placeholders.
    pub prompt_template: String,
    pub risk_policy: SkillRisk,
    pub source: SkillSource,
    /// Immutable publish version; updates create a new version, never overwrite.
    pub version: u32,
    pub enabled: bool,
    pub owner_id: String,
}

/// Skill visibility scope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillScope {
    Global,
    Target,
}

/// Risk hint carried by a skill. Publication approves content only — it never
/// grants tool-execution rights; `ToolPolicy` still governs each command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillRisk {
    Readonly,
    ReadonlyPreferred,
    ConfirmedWrite,
}

/// Where a skill came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Import,
    Url { url: String },
}

/// An external MCP server the Agent can call tools on.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnection {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub url: String,
    pub auth: McpAuth,
    /// Present only in this session's memory; never serialized to disk. On load
    /// it comes back empty and the caller must supply it again to connect.
    #[serde(skip_serializing, default = "empty_credential")]
    pub credential: ApiCredential,
    /// Empty = allow every discovered tool.
    #[serde(default)]
    pub tool_allowlist: Vec<String>,
    #[serde(default)]
    pub status: McpStatus,
    #[serde(default)]
    pub discovered_tools: Vec<String>,
    pub owner_id: String,
}

fn empty_credential() -> ApiCredential {
    ApiCredential::from(String::new())
}

/// MCP transport. P0 only supports HTTP (Streamable HTTP).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Http,
}

/// Auth flavor for the external MCP endpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpAuth {
    None,
    Bearer,
    Header,
}

/// Connection state surfaced to the UI.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpStatus {
    #[default]
    Disconnected,
    Connected,
    Error,
}

impl ScheduledTask {
    /// Validates task invariants. Spec §5.1:
    /// - non-empty name
    /// - cron is a 5-field expression
    /// - interval is at least 60s
    /// - once has a non-empty timestamp
    /// - shell needs `script`, prompt needs `prompt`
    /// - `policy == Auto` requires `auto_confirmed`
    pub fn validate(&self) -> Result<(), AutomationError> {
        if self.name.trim().is_empty() {
            return Err(AutomationError::Invalid("name is required".into()));
        }
        match &self.trigger {
            TaskTrigger::Cron { expr } => {
                let fields = expr.split_whitespace().count();
                if fields != 5 {
                    return Err(AutomationError::Invalid(
                        "cron expression must have 5 fields".into(),
                    ));
                }
            }
            TaskTrigger::Interval { seconds } => {
                if *seconds < 60 {
                    return Err(AutomationError::Invalid(
                        "interval must be at least 60 seconds".into(),
                    ));
                }
            }
            TaskTrigger::Once { at } => {
                if at.trim().is_empty() {
                    return Err(AutomationError::Invalid("once time is required".into()));
                }
            }
        }
        match self.kind {
            TaskKind::Shell if self.script.as_deref().unwrap_or("").trim().is_empty() => {
                return Err(AutomationError::Invalid(
                    "shell task requires a script".into(),
                ));
            }
            TaskKind::Prompt if self.prompt.as_deref().unwrap_or("").trim().is_empty() => {
                return Err(AutomationError::Invalid(
                    "prompt task requires a prompt".into(),
                ));
            }
            _ => {}
        }
        if self.policy == TaskPolicy::Auto && !self.auto_confirmed {
            return Err(AutomationError::Invalid(
                "auto policy requires explicit confirmation".into(),
            ));
        }
        Ok(())
    }
}
