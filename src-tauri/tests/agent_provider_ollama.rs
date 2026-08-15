use catio_lib::agent::provider::ollama::{
    decode_ndjson_chunks, encode_chat_request, OllamaDecoder,
};
use catio_lib::agent::provider::{ProviderError, ProviderRequest, ProviderStop};
use catio_lib::agent::{
    AgentMessage, AgentRole, ContentBlock, ExecutionMode, ToolResultStatus, ToolSpec, ToolUse,
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
fn decodes_text_and_thinking_stream() {
    let decoded = decode_ndjson_chunks(&[&fixture("ollama_text.ndjson")], 0).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![
            ContentBlock::Thinking {
                thinking: "reasoning here".into()
            },
            ContentBlock::Text {
                text: "hello world".into()
            },
        ]
    );
    assert_eq!(decoded.stop, ProviderStop::Stop);
}

#[test]
fn assembles_multiple_tool_calls_with_stable_synthetic_ids() {
    let decoded = decode_ndjson_chunks(&[&fixture("ollama_tool.ndjson")], 0).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![
            ContentBlock::ToolUse {
                id: "ollama-0-0".into(),
                name: "terminal_exec".into(),
                input: json!({ "command": "pwd" }),
            },
            ContentBlock::ToolUse {
                id: "ollama-0-1".into(),
                name: "terminal_exec".into(),
                input: json!({ "command": "ls" }),
            },
        ]
    );
    assert_eq!(decoded.stop, ProviderStop::ToolUse);
}

#[test]
fn synthetic_ids_include_round_number() {
    let decoded = decode_ndjson_chunks(&[&fixture("ollama_tool.ndjson")], 3).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![
            ContentBlock::ToolUse {
                id: "ollama-3-0".into(),
                name: "terminal_exec".into(),
                input: json!({ "command": "pwd" }),
            },
            ContentBlock::ToolUse {
                id: "ollama-3-1".into(),
                name: "terminal_exec".into(),
                input: json!({ "command": "ls" }),
            },
        ]
    );
}

#[test]
fn synthetic_tool_id_format_is_round_and_index() {
    // Production seam: the decoder and the wire path share this ID generator,
    // so a synthetic id is always `ollama-{round}-{index}` — never round 0.
    use catio_lib::agent::provider::ollama::synthetic_tool_id;
    assert_eq!(synthetic_tool_id(0, 0), "ollama-0-0");
    assert_eq!(synthetic_tool_id(2, 0), "ollama-2-0");
    assert_eq!(synthetic_tool_id(5, 3), "ollama-5-3");
}

#[test]
fn malformed_line_is_a_protocol_error() {
    let chunks = [
        br#"{"model":"llama3","message":{"role":"assistant","content":"ok"},"done":false}"#
            .as_slice(),
        b"\n",
        br#"this is not json"#.as_slice(),
        b"\n",
        br#"{"model":"llama3","message":{"role":"assistant","content":""},"done":true}"#.as_slice(),
        b"\n",
    ];
    let err = decode_ndjson_chunks(&chunks, 0).unwrap_err();
    assert!(matches!(err, ProviderError::Protocol(_)));
}

#[test]
fn missing_done_marker_is_unexpected_eof() {
    let bytes = fixture("ollama_text.ndjson");
    let line_end = bytes
        .windows(12)
        .rposition(|w| w == br#""done":true}"#)
        .expect("fixture contains done:true")
        + 12;
    // 找到该行的行首（上一个 \n 之后），整行丢弃。
    let line_start = bytes[..line_end]
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let err = decode_ndjson_chunks(&[&bytes[..line_start]], 0).unwrap_err();
    assert_eq!(err, ProviderError::UnexpectedEof);
}

#[test]
fn multibyte_utf8_split_across_byte_chunks_reassembles() {
    let mut decoder = OllamaDecoder::new();
    // 注意：br# 中 `"#` 是结束标记，因此行首必须以转义字符串构造，避免吞掉 content 开引号。
    decoder
        .feed(b"{\"model\":\"llama3\",\"message\":{\"role\":\"assistant\",\"content\":\"")
        .unwrap();
    decoder.feed(&[0xE4, 0xBD]).unwrap();
    decoder.feed(&[0xA0]).unwrap();
    decoder
        .feed(
            br#""},"done":false}
{"model":"llama3","message":{"role":"assistant","content":""},"done":true}
"#,
        )
        .unwrap();
    let decoded = decoder.finish(0).unwrap();
    assert_eq!(
        decoded.message.content,
        vec![ContentBlock::Text { text: "你".into() }]
    );
}

#[test]
fn encode_request_preserves_full_assistant_message_and_tool_results() {
    let provider_request = ProviderRequest {
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
                    ContentBlock::Thinking {
                        thinking: "t".into(),
                    },
                    ContentBlock::Text { text: "ok".into() },
                    ContentBlock::ToolUse {
                        id: "ollama-0-0".into(),
                        name: "terminal_exec".into(),
                        input: json!({ "command": "pwd" }),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "ollama-0-0".into(),
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
    let body = encode_chat_request(&provider_request, "llama3");
    assert_eq!(body["model"], "llama3");
    assert_eq!(body["stream"], true);
    assert_eq!(body["system"], "sys");
    let assistant = &body["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "ok");
    assert_eq!(assistant["thinking"], "t");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        "terminal_exec"
    );
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        json!({ "command": "pwd" })
    );
    let tool_result = &body["messages"][2];
    assert_eq!(tool_result["role"], "tool");
    assert_eq!(tool_result["tool_name"], "terminal_exec");
    assert_eq!(tool_result["content"], "/tmp");
    let no_tools = encode_chat_request(&request(), "llama3");
    assert!(no_tools.get("tools").is_none());
}
