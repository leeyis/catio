//! Automation workbench: scheduled tasks, skills, and external MCP connections.
//!
//! Three domain repositories (tasks / skills / MCP connections) live here once
//! and are shared by the desktop head (Tauri commands) and the server head. All
//! owner-scoping happens inside the store; transport layers only ever inject
//! `owner_id` and never trust a client-supplied one.

pub mod repo;
pub mod types;

pub use repo::AutomationStore;
pub use types::{
    AutomationError, McpAuth, McpConnection, McpStatus, McpTransport, ScheduledTask, Skill,
    SkillRisk, SkillScope, SkillSource, TaskKind, TaskPolicy, TaskTrigger,
};
