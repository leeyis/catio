use catio_lib::agent::{
    AgentEvent, AgentEventEnvelope, ApiCredential, ContentBlock, ToolResultStatus,
};

#[test]
fn credential_debug_is_redacted() {
    let credential = ApiCredential::from("sk-secret-value".to_string());
    assert_eq!(format!("{credential:?}"), "ApiCredential([REDACTED])");
    assert_eq!(credential.expose(), "sk-secret-value");
}

#[test]
fn event_envelope_uses_camel_case_without_secret_fields() {
    let event = AgentEventEnvelope {
        owner_id: "local".into(),
        conversation_id: "conv-1".into(),
        turn_id: "turn-1".into(),
        sequence: 1,
        event: AgentEvent::TurnStarted,
    };
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["conversationId"], "conv-1");
    assert_eq!(value["event"]["type"], "turnStarted");
    assert!(!value.to_string().contains("credential"));
}

#[test]
fn tool_result_status_serializes_stably() {
    let block = ContentBlock::ToolResult {
        tool_use_id: "tool-1".into(),
        content: "exit 0".into(),
        status: ToolResultStatus::Succeeded,
    };
    assert_eq!(serde_json::to_value(block).unwrap()["status"], "succeeded");
}
