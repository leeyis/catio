use catio_lib::agent::{
    legacy::{self, LegacyParseError},
    policy::{PolicyDecision, ToolPolicy},
    ExecutionMode,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct PolicyCase {
    command: String,
    sensitive: bool,
    reasons: Vec<String>,
}

fn fixture_cases() -> Vec<PolicyCase> {
    serde_json::from_str(include_str!("fixtures/agent/policy_commands.json")).unwrap()
}

#[test]
fn policy_matches_shared_fixture_for_every_risk_code() {
    let cases = fixture_cases();
    assert_eq!(
        cases.len(),
        14,
        "fixture must cover all 13 risk codes plus a benign command"
    );
    for case in &cases {
        let risk = ToolPolicy::classify(&case.command);
        assert_eq!(risk.sensitive, case.sensitive, "command: {}", case.command);
        assert_eq!(risk.reasons, case.reasons, "command: {}", case.command);
    }
}

#[test]
fn ordinary_commands_are_never_flagged_sensitive() {
    for command in ["ls -la", "pwd", "echo hello", "git status"] {
        let risk = ToolPolicy::classify(command);
        assert!(!risk.sensitive, "command: {command}");
        assert!(risk.reasons.is_empty(), "command: {command}");
    }
}

#[test]
fn manual_mode_hides_terminal_tool() {
    assert!(matches!(
        ToolPolicy::authorize(ExecutionMode::Manual, "rm -rf /tmp/demo"),
        PolicyDecision::Hidden
    ));
}

#[test]
fn ask_mode_requires_approval_only_for_sensitive_commands() {
    match ToolPolicy::authorize(ExecutionMode::Ask, "rm -rf /tmp/demo") {
        PolicyDecision::ApprovalRequired { reason, risk } => {
            assert_eq!(reason, "sensitiveCommand");
            assert!(risk.sensitive);
        }
        other => panic!("expected approval, got {other:?}"),
    }
    assert!(matches!(
        ToolPolicy::authorize(ExecutionMode::Ask, "ls -la"),
        PolicyDecision::Allowed { .. }
    ));
}

#[test]
fn auto_mode_allows_sensitive_commands_without_approval() {
    assert!(matches!(
        ToolPolicy::authorize(ExecutionMode::Auto, "rm -rf /tmp/demo"),
        PolicyDecision::Allowed { .. }
    ));
}

#[test]
fn first_shell_tool_takes_first_closed_shell_fence() {
    let markdown = "```sql\nselect 1\n```\n```bash\necho first\n```\n```sh\necho second\n```";
    let tool = legacy::first_shell_tool(markdown, true, "tool-legacy-1")
        .unwrap()
        .unwrap();
    assert_eq!(tool.id, "tool-legacy-1");
    assert_eq!(tool.name, "terminal_exec");
    assert_eq!(tool.input, serde_json::json!({ "command": "echo first" }));
}

#[test]
fn first_shell_tool_ignores_unlabeled_and_unclosed_fences() {
    let markdown = "`whoami`\n```\nwhoami\n```\n```sh\nunclosed";
    assert!(legacy::first_shell_tool(markdown, true, "id")
        .unwrap()
        .is_none());
}

#[test]
fn single_line_rejects_multiline_fence() {
    let markdown = "```sh\nls -la\necho multi\n```";
    assert_eq!(
        legacy::first_shell_tool(markdown, true, "id"),
        Err(LegacyParseError::MultiLineCommand)
    );
    assert!(legacy::first_shell_tool(markdown, false, "id")
        .unwrap()
        .is_some());
}

#[test]
fn empty_command_is_rejected() {
    let markdown = "```sh\n   \n```";
    assert_eq!(
        legacy::first_shell_tool(markdown, true, "id"),
        Err(LegacyParseError::EmptyCommand)
    );
}

#[test]
fn powershell_fence_is_recognized() {
    let markdown = "```powershell\nGet-Process\n```";
    let tool = legacy::first_shell_tool(markdown, true, "id")
        .unwrap()
        .unwrap();
    assert_eq!(tool.input, serde_json::json!({ "command": "Get-Process" }));
}
