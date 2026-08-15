//! OpenAI-compatible Chat Completions adapter (openai / deepseek / zhipu /
//! kimi presets). Streaming SSE decoder is a pure state machine so tests run
//! against raw fixtures without any network.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::provider::{
    classify_error_response, Provider, ProviderError, ProviderObserver, ProviderRequest,
    ProviderRound, ProviderStop,
};
use crate::agent::types::{
    AgentMessage, AgentRole, ContentBlock, ProviderConfig, TokenUsage, ToolUse,
};

/// OpenAI-compatible provider over the Chat Completions endpoint.
pub struct OpenAiProvider {
    client: reqwest::Client,
    config: ProviderConfig,
}

impl OpenAiProvider {
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Self {
        Self { client, config }
    }
}

#[async_trait]
impl Provider for OpenAiProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        let body = encode_chat_request(&request, &self.config.model);
        let base = self.config.base_url.trim_end_matches('/');
        let url = format!("{base}/chat/completions");
        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header(
                "Authorization",
                format!("Bearer {}", self.config.credential.expose()),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = response.status();
        if status.is_client_error() || status.is_server_error() {
            let body = response
                .bytes()
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;
            return Err(classify_error_response(status, &body));
        }

        let mut stream = response.bytes_stream();
        let mut decoder = OpenAiDecoder::new();
        use futures_util::StreamExt as _;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ProviderError::Network(e.to_string()))?;
            for delta in decoder.feed(&chunk)? {
                observer.text_delta(&delta);
            }
        }
        let decoded = decoder.finish()?;
        Ok(decoded.into_round())
    }
}

/// Pure request encoder: stable wire shape for tests. The system prompt leads
/// the messages as the first `system` message (never dropped).
pub fn encode_chat_request(request: &ProviderRequest, model: &str) -> Value {
    let mut messages = vec![json!({
        "role": "system",
        "content": request.system_prompt,
    })];
    messages.extend(encode_messages(&request.messages));
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                    })
                })
                .collect(),
        );
    }
    body
}

/// Provider-neutral messages → OpenAI wire messages. Tool results become
/// `role: tool` messages paired by `tool_call_id`.
fn encode_messages(messages: &[AgentMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let mut text_parts = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text { text } => text_parts.push(text.clone()),
                ContentBlock::Thinking { .. } => {}
                ContentBlock::ToolUse { id, name, input } => {
                    tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() }
                    }));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => {
                    tool_results.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": content,
                    }));
                }
            }
        }
        match message.role {
            AgentRole::User => {
                out.push(json!({ "role": "user", "content": text_parts.concat() }));
            }
            AgentRole::Assistant => {
                let mut assistant = json!({ "role": "assistant" });
                if !text_parts.is_empty() {
                    assistant["content"] = Value::String(text_parts.concat());
                }
                if !tool_calls.is_empty() {
                    assistant["tool_calls"] = Value::Array(tool_calls);
                }
                out.push(assistant);
            }
        }
        out.extend(tool_results);
    }
    out
}

/// Normalized finish reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
}

/// Fully decoded SSE stream, ready to become a `ProviderRound`.
#[derive(Debug, PartialEq)]
pub struct DecodedSse {
    pub text: String,
    pub tool_calls: Vec<ToolUse>,
    pub finish_reason: FinishReason,
    pub usage: Option<TokenUsage>,
}

impl DecodedSse {
    pub fn into_round(self) -> ProviderRound {
        let stop = match self.finish_reason {
            FinishReason::Stop => ProviderStop::Stop,
            FinishReason::ToolCalls => ProviderStop::ToolUse,
            FinishReason::Length => ProviderStop::Length,
            FinishReason::ContentFilter => ProviderStop::ContentFilter,
        };
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(ContentBlock::Text { text: self.text });
        }
        for tool in self.tool_calls {
            content.push(ContentBlock::ToolUse {
                id: tool.id,
                name: tool.name,
                input: tool.input,
            });
        }
        ProviderRound {
            message: crate::agent::types::AgentMessage {
                role: AgentRole::Assistant,
                content,
            },
            stop,
            usage: self.usage,
        }
    }
}

/// Accumulating tool-call fragment during decoding.
#[derive(Debug, Default)]
struct AccumulatingToolCall {
    index: usize,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// Pure incremental SSE line decoder. `feed` accepts arbitrary byte chunks
/// (including multibyte UTF-8 split mid-character); lines are buffered until
/// `\n` so decoding is always valid UTF-8. `finish` verifies `[DONE]` and the
/// assembled tool inputs.
pub struct OpenAiDecoder {
    line_buffer: Vec<u8>,
    text: String,
    tool_calls: Vec<AccumulatingToolCall>,
    finish_reason: Option<FinishReason>,
    usage: Option<TokenUsage>,
    done_seen: bool,
}

impl OpenAiDecoder {
    pub fn new() -> Self {
        Self {
            line_buffer: Vec::new(),
            text: String::new(),
            tool_calls: Vec::new(),
            finish_reason: None,
            usage: None,
            done_seen: false,
        }
    }

    /// Feeds bytes; returns any complete text deltas produced (arrival order).
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, ProviderError> {
        let mut deltas = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                let line = std::mem::take(&mut self.line_buffer);
                if !line.is_empty() {
                    self.handle_line(&line, &mut deltas)?;
                }
            } else {
                self.line_buffer.push(byte);
            }
        }
        Ok(deltas)
    }

    /// Requires `[DONE]`, then validates and assembles tool calls.
    pub fn finish(mut self) -> Result<DecodedSse, ProviderError> {
        // Flush any trailing line without a newline.
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.handle_line(&line, &mut Vec::new())?;
        }
        if !self.done_seen {
            return Err(ProviderError::UnexpectedEof);
        }
        let mut tool_calls = Vec::new();
        for call in &self.tool_calls {
            let id = call
                .id
                .clone()
                .ok_or_else(|| ProviderError::Protocol("tool call missing id".into()))?;
            let name = call
                .name
                .clone()
                .ok_or_else(|| ProviderError::Protocol("tool call missing name".into()))?;
            let input: Value = serde_json::from_str(&call.arguments)
                .map_err(|e| ProviderError::Protocol(format!("invalid tool arguments: {e}")))?;
            if !input.is_object() {
                return Err(ProviderError::Protocol(
                    "tool arguments must be a JSON object".into(),
                ));
            }
            tool_calls.push(ToolUse { id, name, input });
        }
        let finish_reason = self.finish_reason.unwrap_or(FinishReason::Stop);
        Ok(DecodedSse {
            text: self.text,
            tool_calls,
            finish_reason,
            usage: self.usage,
        })
    }

    fn handle_line(&mut self, line: &[u8], deltas: &mut Vec<String>) -> Result<(), ProviderError> {
        let line = std::str::from_utf8(line)
            .map_err(|_| ProviderError::Protocol("stream is not valid UTF-8".into()))?;
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(()); // SSE comment/event lines are ignored
        };
        let data = data.trim_start();
        if data == "[DONE]" {
            self.done_seen = true;
            return Ok(());
        }
        let event: Value = serde_json::from_str(data)
            .map_err(|e| ProviderError::Protocol(format!("malformed SSE event: {e}")))?;
        let choices = event.get("choices").and_then(Value::as_array);
        let choice = choices.and_then(|c| c.first()).unwrap_or(&Value::Null);
        if let Some(delta) = choice.get("delta") {
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                self.text.push_str(content);
                deltas.push(content.to_string());
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    while self.tool_calls.len() <= index {
                        self.tool_calls.push(AccumulatingToolCall {
                            index: self.tool_calls.len(),
                            ..Default::default()
                        });
                    }
                    let slot = &mut self.tool_calls[index];
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        slot.id = Some(id.to_string());
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                    {
                        slot.name = Some(name.to_string());
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        slot.arguments.push_str(args);
                    }
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(match reason {
                "tool_calls" => FinishReason::ToolCalls,
                "length" => FinishReason::Length,
                "content_filter" => FinishReason::ContentFilter,
                _ => FinishReason::Stop,
            });
        }
        if self.usage.is_none() {
            let usage = event
                .get("usage")
                .or_else(|| choice.get("usage"))
                .cloned()
                .unwrap_or(Value::Null);
            if usage.is_object() {
                let input = usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let output = usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.usage = Some(TokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                });
            }
        }
        Ok(())
    }
}

/// Decodes a full SSE stream split into arbitrary byte chunks (test seam).
pub fn decode_sse_chunks(chunks: &[&[u8]]) -> Result<DecodedSse, ProviderError> {
    let mut decoder = OpenAiDecoder::new();
    for chunk in chunks {
        decoder.feed(chunk)?;
    }
    decoder.finish()
}
