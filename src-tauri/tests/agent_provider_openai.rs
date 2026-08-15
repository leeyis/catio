use catio_lib::agent::provider::openai::{
    decode_sse_chunks, encode_chat_request, FinishReason, OpenAiDecoder,
};
use catio_lib::agent::provider::{ProviderError, ProviderRequest, ProviderStop};
use catio_lib::agent::{
    AgentMessage, AgentRole, ContentBlock, ExecutionMode, TokenUsage, ToolSpec, ToolUse,
};
use serde_json::json;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/agent/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn text_request() -> ProviderRequest {
    ProviderRequest {
        system_prompt: "sys".into(),
        messages: vec![AgentMessage {
            role: AgentRole::User,
            content: vec![ContentBlock::Text { text: "hi".into() }],
        }],
        tools: Vec::new(),
        target_ref: "target-1".into(),
        execution_mode: ExecutionMode::Ask,
        single_line_commands: true,
    }
}

#[test]
fn decodes_text_stream_with_usage_and_stop() {
    let decoded = decode_sse_chunks(&[&fixture("openai_text.sse")]).unwrap();
    assert_eq!(decoded.text, "hello world");
    assert_eq!(decoded.finish_reason, FinishReason::Stop);
    assert_eq!(
        decoded.usage,
        Some(TokenUsage {
            input_tokens: 9,
            output_tokens: 2
        })
    );
    assert!(decoded.tool_calls.is_empty());
}

#[test]
fn reassembles_tool_call_fragments_across_chunks() {
    let decoded = decode_sse_chunks(&[&fixture("openai_tool.sse")]).unwrap();
    assert_eq!(
        decoded.tool_calls,
        vec![ToolUse {
            id: "call_1".into(),
            name: "terminal_exec".into(),
            input: json!({ "command": "pwd" }),
        }]
    );
    assert_eq!(decoded.finish_reason, FinishReason::ToolCalls);
}

#[test]
fn invalid_json_arguments_are_a_protocol_error() {
    let err = decode_sse_chunks(&[&fixture("openai_invalid_args.sse")]).unwrap_err();
    assert!(matches!(err, ProviderError::Protocol(_)));
}

#[test]
fn missing_done_marker_is_unexpected_eof() {
    let bytes = fixture("openai_text.sse");
    let idx = bytes
        .windows(13)
        .rposition(|w| w == b"data: [DONE]\n")
        .expect("fixture contains [DONE]");
    let err = decode_sse_chunks(&[&bytes[..idx]]).unwrap_err();
    assert_eq!(err, ProviderError::UnexpectedEof);
}

#[test]
fn missing_tool_id_or_name_is_a_protocol_error() {
    let chunks = [
        br#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"terminal_exec","arguments":"{}"}}]},"finish_reason":null}]}"#.as_slice(),
        b"\n\ndata: [DONE]\n",
    ];
    assert!(matches!(
        decode_sse_chunks(&chunks).unwrap_err(),
        ProviderError::Protocol(_)
    ));
}

#[test]
fn length_finish_reason_maps_to_length_stop() {
    let chunks = [
        br#"data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}"#
            .as_slice(),
        b"\n\ndata: [DONE]\n",
    ];
    let decoded = decode_sse_chunks(&chunks).unwrap();
    assert_eq!(decoded.finish_reason, FinishReason::Length);
    assert_eq!(decoded.text, "partial");
}

#[test]
fn content_filter_finish_reason_maps_to_content_filter() {
    let chunks = [
        br#"data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}"#.as_slice(),
        b"\n\ndata: [DONE]\n",
    ];
    let decoded = decode_sse_chunks(&chunks).unwrap();
    assert_eq!(decoded.finish_reason, FinishReason::ContentFilter);
}

#[test]
fn multibyte_utf8_split_across_byte_chunks_reassembles() {
    // "你" = 3 bytes; split mid-character between two feeds.
    let mut decoder = OpenAiDecoder::new();
    decoder
        .feed(br#"data: {"choices":[{"delta":{"content":""#)
        .unwrap();
    decoder.feed(&[0xE4, 0xBD]).unwrap();
    decoder.feed(&[0xA0]).unwrap();
    decoder.feed(br#""},"finish_reason":"stop"}]}"#).unwrap();
    decoder.feed(b"\n\ndata: [DONE]\n").unwrap();
    let decoded = decoder.finish().unwrap();
    assert_eq!(decoded.text, "你");
}

#[test]
fn malformed_sse_json_is_a_protocol_error() {
    let chunks = [
        br#"data: {"choices": [broken"#.as_slice(),
        b"\n\ndata: [DONE]\n",
    ];
    assert!(matches!(
        decode_sse_chunks(&chunks).unwrap_err(),
        ProviderError::Protocol(_)
    ));
}

#[test]
fn encode_request_body_matches_openai_wire_shape() {
    let request = ProviderRequest {
        system_prompt: "sys".into(),
        messages: vec![
            AgentMessage {
                role: AgentRole::User,
                content: vec![ContentBlock::Text {
                    text: "run pwd".into(),
                }],
            },
            AgentMessage {
                role: AgentRole::Assistant,
                content: vec![
                    ContentBlock::ToolUse {
                        id: "call_1".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": "pwd" }),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call_1".into(),
                        content: "/tmp".into(),
                        status: catio_lib::agent::ToolResultStatus::Succeeded,
                    },
                ],
            },
        ],
        tools: vec![ToolSpec {
            name: "terminal_exec".into(),
            description: "run a command".into(),
            input_schema: json!({ "type": "object" }),
        }],
        target_ref: "target-1".into(),
        execution_mode: ExecutionMode::Ask,
        single_line_commands: true,
    };
    let body = encode_chat_request(&request, "model-x");
    assert_eq!(body["model"], "model-x");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"], "run pwd");
    // assistant tool call + tool role result pairing
    assert_eq!(body["messages"][1]["role"], "assistant");
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["name"],
        "terminal_exec"
    );
    assert_eq!(body["messages"][2]["role"], "tool");
    assert_eq!(body["messages"][2]["tool_call_id"], "call_1");
    // tools only present when non-empty
    assert!(body["tools"][0]["function"]["name"] == "terminal_exec");
    let no_tools = encode_chat_request(&text_request(), "model-x");
    assert!(no_tools.get("tools").is_none());
}

#[test]
fn provider_stop_mapping_is_stable() {
    assert_eq!(
        ProviderStop::ToolUse,
        match FinishReason::ToolCalls {
            FinishReason::Stop => ProviderStop::Stop,
            FinishReason::ToolCalls => ProviderStop::ToolUse,
            FinishReason::Length => ProviderStop::Length,
            FinishReason::ContentFilter => ProviderStop::ContentFilter,
        }
    );
}
