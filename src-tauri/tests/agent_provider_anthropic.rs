use catio_lib::agent::provider::anthropic::{
    auth_headers, decode_sse_chunks, encode_messages_request, AnthropicDecoder,
};
use catio_lib::agent::provider::{ProviderError, ProviderRequest, ProviderStop};
use catio_lib::agent::{
    AgentMessage, AgentRole, AnthropicAuthMode, ApiCredential, ContentBlock, ExecutionMode,
    ProviderConfig, TokenUsage, ToolResultStatus, ToolSpec,
};
use serde_json::json;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/agent/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn request() -> ProviderRequest {
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
        round: 0,
    }
}

#[test]
fn decodes_text_stream_with_stop() {
    let decoded = decode_sse_chunks(&[&fixture("anthropic_text.sse")]).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![ContentBlock::Text {
            text: "hello world".into()
        }]
    );
    assert_eq!(decoded.stop, ProviderStop::Stop);
    assert_eq!(
        decoded.usage,
        Some(TokenUsage {
            input_tokens: 10,
            output_tokens: 8
        })
    );
}

#[test]
fn reassembles_tool_use_after_content_block_stop() {
    let decoded = decode_sse_chunks(&[&fixture("anthropic_tool.sse")]).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![ContentBlock::ToolUse {
            id: "toolu_1".into(),
            name: "terminal_exec".into(),
            input: json!({ "command": "pwd" }),
        }]
    );
    assert_eq!(decoded.stop, ProviderStop::ToolUse);
}

#[test]
fn thinking_blocks_are_preserved() {
    let chunks = [
        br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}

event: message_stop
data: {"type":"message_stop"}
"#.as_slice(),
    ];
    let decoded = decode_sse_chunks(&chunks).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![
            ContentBlock::Thinking {
                thinking: "let me think".into()
            },
            ContentBlock::Text {
                text: "answer".into()
            },
        ]
    );
}

#[test]
fn ping_and_unknown_events_are_ignored() {
    let chunks = [br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}

event: ping
data: {"type":"ping"}

event: future_event
data: {"type":"future_event","opaque":true}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
"#
    .as_slice()];
    let decoded = decode_sse_chunks(&chunks).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![ContentBlock::Text { text: "ok".into() }]
    );
}

#[test]
fn stream_error_fails_immediately() {
    let chunks = [br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}

event: error
data: {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}
"#
    .as_slice()];
    let err = decode_sse_chunks(&chunks).unwrap_err();
    assert!(matches!(err, ProviderError::Protocol(_)));
}

#[test]
fn max_tokens_stop_reason_maps_to_max_tokens() {
    let chunks = [br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
"#
    .as_slice()];
    let decoded = decode_sse_chunks(&chunks).unwrap();
    assert_eq!(decoded.stop, ProviderStop::MaxTokens);
}

#[test]
fn missing_message_stop_is_unexpected_eof() {
    let bytes = fixture("anthropic_text.sse");
    let idx = bytes
        .windows(27)
        .rposition(|w| w == b"event: message_stop\ndata: {")
        .expect("fixture contains message_stop");
    let err = decode_sse_chunks(&[&bytes[..idx]]).unwrap_err();
    assert_eq!(err, ProviderError::UnexpectedEof);
}

#[test]
fn unfinished_tool_input_is_a_protocol_error() {
    let chunks = [
        br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"terminal_exec","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\": "}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
"#.as_slice(),
    ];
    let err = decode_sse_chunks(&chunks).unwrap_err();
    assert!(matches!(err, ProviderError::Protocol(_)));
}

#[test]
fn multibyte_utf8_split_across_byte_chunks_reassembles() {
    let mut decoder = AnthropicDecoder::new();
    decoder
        .feed(
            b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"",
        )
        .unwrap();
    decoder.feed(&[0xE4, 0xBD]).unwrap();
    decoder.feed(&[0xA0]).unwrap();
    decoder
        .feed(b"\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n")
        .unwrap();
    // decoder 需要 message_start 之前设置 usage；这里跳过不影响 text 断言。
    let decoded = decoder.finish().unwrap();
    assert_eq!(
        decoded.message.content,
        vec![ContentBlock::Text { text: "你".into() }]
    );
}

#[test]
fn auth_headers_follow_existing_heuristic() {
    let config = |mode: AnthropicAuthMode, key: &str| ProviderConfig {
        protocol: catio_lib::agent::ProviderProtocol::Anthropic,
        base_url: "https://api.anthropic.com/v1".into(),
        model: "claude-x".into(),
        credential: ApiCredential::from(key.to_string()),
        anthropic_auth_mode: mode,
    };
    // API key mode → x-api-key
    let headers = auth_headers(&config(AnthropicAuthMode::ApiKey, "sk-ant-api03-secret"));
    assert_eq!(
        headers.get("x-api-key").map(String::as_str),
        Some("sk-ant-api03-secret")
    );
    assert!(headers.get("Authorization").is_none());
    // auth-token mode → bearer
    let headers = auth_headers(&config(AnthropicAuthMode::AuthToken, "sk-ant-oat01-secret"));
    assert_eq!(
        headers.get("Authorization").map(String::as_str),
        Some("Bearer sk-ant-oat01-secret")
    );
    // auto: sk-ant-api prefix → x-api-key
    let headers = auth_headers(&config(AnthropicAuthMode::Auto, "sk-ant-api03-secret"));
    assert!(headers.get("x-api-key").is_some());
    // auto: other key → bearer
    let headers = auth_headers(&config(AnthropicAuthMode::Auto, "custom-token"));
    assert_eq!(
        headers.get("Authorization").map(String::as_str),
        Some("Bearer custom-token")
    );
    // anthropic-version always present
    assert_eq!(
        headers.get("anthropic-version").map(String::as_str),
        Some("2023-06-01")
    );
}

#[test]
fn encode_request_separates_system_and_pairs_tool_results() {
    let provider_request = ProviderRequest {
        system_prompt: "system prompt".into(),
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
                        id: "toolu_1".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": "pwd" }),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "toolu_1".into(),
                        content: "/tmp".into(),
                        status: ToolResultStatus::Succeeded,
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
        round: 0,
    };
    let body = encode_messages_request(&provider_request, "claude-x");
    assert_eq!(body["model"], "claude-x");
    assert_eq!(body["system"], "system prompt");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 4096);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][1]["role"], "assistant");
    assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(body["messages"][2]["role"], "user");
    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "toolu_1");
    assert_eq!(body["tools"][0]["name"], "terminal_exec");
    let no_tools = encode_messages_request(&request(), "claude-x");
    assert!(no_tools.get("tools").is_none());
}
