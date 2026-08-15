//! Legacy Markdown command fallback: fenced shell block → synthetic
//! `terminal_exec` `ToolUse`. No shell tokenization; only the first closed
//! shell fence is extracted, matching the pre-Rust loop's first-command
//! behavior without establishing a second execution loop.

use serde_json::json;

use crate::agent::types::ToolUse;

/// Fence languages eligible for fallback execution.
const SHELL_LANGS: [&str; 5] = ["sh", "bash", "shell", "powershell", "ps1"];

/// Why a fenced block could not become a synthetic tool.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum LegacyParseError {
    #[error("first shell fence has an empty command body")]
    EmptyCommand,
    #[error("shell command spans multiple lines in single-line mode")]
    MultiLineCommand,
}

/// Extracts the first closed `sh|bash|shell|powershell|ps1` fence as a
/// synthetic `terminal_exec` `ToolUse`. The caller supplies a stable
/// `tool_use_id` so the synthetic tool never loses its pairing identity.
pub fn first_shell_tool(
    markdown: &str,
    single_line: bool,
    tool_use_id: &str,
) -> Result<Option<ToolUse>, LegacyParseError> {
    static FENCE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let fence = FENCE.get_or_init(|| {
        regex::Regex::new(r"```([^\r\n`]*)\r?\n([\s\S]*?)```").expect("static fence regex")
    });

    for capture in fence.captures_iter(markdown) {
        let lang = capture.get(1).expect("lang group").as_str();
        let lang = lang.trim().split_whitespace().next().unwrap_or("");
        let lower = lang.to_ascii_lowercase();
        if !SHELL_LANGS.contains(&lower.as_str()) {
            continue;
        }
        let command = capture.get(2).expect("command group").as_str().trim();
        if command.is_empty() {
            return Err(LegacyParseError::EmptyCommand);
        }
        if single_line && (command.contains('\r') || command.contains('\n')) {
            return Err(LegacyParseError::MultiLineCommand);
        }
        return Ok(Some(ToolUse {
            id: tool_use_id.to_string(),
            name: "terminal_exec".into(),
            input: json!({ "command": command }),
        }));
    }
    Ok(None)
}
