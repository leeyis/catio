//! Ollama `/api/chat` NDJSON adapter. Accumulates streamed `thinking`,
//! `content` and `message.tool_calls`; the full assistant message fields are
//! written back on the next round; tool results use `role: tool` +
//! `tool_name`. Internal tool-use IDs are stable synthetic
//! `ollama-{round}-{index}` values because Ollama does not emit IDs.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::provider::{
    classify_error_response, read_limited_body, Provider, ProviderError, ProviderObserver,
    ProviderRequest, ProviderRound, ProviderStop, ERROR_BODY_LIMIT,
};
use crate::agent::types::{AgentMessage, AgentRole, ContentBlock, ProviderConfig};

/// Ollama-compatible provider over `/api/chat`.
pub struct OllamaProvider {
    client: reqwest::Client,
    config: ProviderConfig,
}

impl OllamaProvider {
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Self {
        Self { client, config }
    }
}

#[async_trait]
impl Provider for OllamaProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        let body = encode_chat_request(&request, &self.config.model);
        let base = self.config.base_url.trim_end_matches('/');
        let url = format!("{base}/api/chat");
        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = response.status();
        if status.is_client_error() || status.is_server_error() {
            let body = read_limited_body(response, ERROR_BODY_LIMIT)
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;
            return Err(classify_error_response(
                status,
                &body,
                &self.config.credential,
            ));
        }

        let mut stream = response.bytes_stream();
        let mut decoder = OllamaDecoder::new();
        use futures_util::StreamExt as _;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ProviderError::Network(e.to_string()))?;
            for delta in decoder.feed(&chunk)? {
                match delta {
                    Delta::Text(text) => observer.text_delta(&text).await,
                    Delta::Thinking(thinking) => observer.thinking_delta(&thinking).await,
                }
            }
        }
        let decoded = decoder.finish(request.round)?;
        Ok(decoded.into_round())
    }
}

/// Stable synthetic tool-use id for Ollama (which never emits ids). The round
/// comes from the engine's `ProviderRequest`, so ids are unique across rounds:
/// `ollama-{round}-{index}`.
pub fn synthetic_tool_id(round: u32, index: usize) -> String {
    format!("ollama-{round}-{index}")
}

/// Pure request encoder preserving the full assistant message fields and
/// emitting tool results with `role: tool` + `tool_name`. `/api/chat` takes
/// the system prompt as the FIRST `system` message — the generate-style
/// top-level `system` field may be ignored by chat endpoints.
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

fn encode_messages(messages: &[AgentMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let mut text = String::new();
        let mut thinking = String::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text { text: t } => text.push_str(t),
                ContentBlock::Thinking { thinking: t } => thinking.push_str(t),
                ContentBlock::ToolUse { id, name, input } => {
                    let _ = id;
                    tool_calls.push(json!({
                        "function": { "name": name, "arguments": input }
                    }));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    status,
                } => {
                    let _ = tool_use_id;
                    let _ = status;
                    // P0 supports exactly one tool, so the wire name is fixed.
                    tool_results.push(json!({
                        "role": "tool",
                        "tool_name": "terminal_exec",
                        "content": content,
                    }));
                }
            }
        }
        match message.role {
            AgentRole::User => {
                out.push(json!({ "role": "user", "content": text }));
            }
            AgentRole::Assistant => {
                let mut assistant = json!({ "role": "assistant", "content": text });
                if !thinking.is_empty() {
                    assistant["thinking"] = Value::String(thinking);
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

/// Deltas surfaced by `feed` for live observer delivery.
#[derive(Debug)]
pub enum Delta {
    Text(String),
    Thinking(String),
}

/// Normalized Ollama stream result.
#[derive(Debug)]
pub struct DecodedOllama {
    pub message: AgentMessage,
    pub stop: ProviderStop,
}

impl DecodedOllama {
    pub fn into_round(self) -> ProviderRound {
        ProviderRound {
            message: self.message,
            stop: self.stop,
            usage: None,
        }
    }
}

/// Pure incremental NDJSON decoder for `/api/chat`.
pub struct OllamaDecoder {
    line_buffer: Vec<u8>,
    text: String,
    thinking: String,
    tool_calls: Vec<(String, Value)>,
    done_seen: bool,
}

impl OllamaDecoder {
    pub fn new() -> Self {
        Self {
            line_buffer: Vec::new(),
            text: String::new(),
            thinking: String::new(),
            tool_calls: Vec::new(),
            done_seen: false,
        }
    }

    /// Feeds bytes; returns text/thinking deltas produced (arrival order).
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Delta>, ProviderError> {
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

    /// Requires `done: true`, then assembles the typed assistant message.
    pub fn finish(mut self, round: u32) -> Result<DecodedOllama, ProviderError> {
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.handle_line(&line, &mut Vec::new())?;
        }
        if !self.done_seen {
            return Err(ProviderError::UnexpectedEof);
        }
        let mut content = Vec::new();
        if !self.thinking.is_empty() {
            content.push(ContentBlock::Thinking {
                thinking: std::mem::take(&mut self.thinking),
            });
        }
        if !self.text.is_empty() {
            content.push(ContentBlock::Text {
                text: std::mem::take(&mut self.text),
            });
        }
        let tool_calls = std::mem::take(&mut self.tool_calls);
        for (index, (name, input)) in tool_calls.into_iter().enumerate() {
            if !input.is_object() {
                return Err(ProviderError::Protocol(
                    "tool arguments must be a JSON object".into(),
                ));
            }
            content.push(ContentBlock::ToolUse {
                id: synthetic_tool_id(round, index),
                name,
                input,
            });
        }
        let stop = if content
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        {
            ProviderStop::ToolUse
        } else {
            ProviderStop::Stop
        };
        Ok(DecodedOllama {
            message: AgentMessage {
                role: AgentRole::Assistant,
                content,
            },
            stop,
        })
    }

    fn handle_line(&mut self, line: &[u8], deltas: &mut Vec<Delta>) -> Result<(), ProviderError> {
        let line = std::str::from_utf8(line)
            .map_err(|_| ProviderError::Protocol("stream is not valid UTF-8".into()))?;
        let event: Value = serde_json::from_str(line).map_err(|e| {
            ProviderError::Protocol(format!("malformed NDJSON line: {e} (line: {line})"))
        })?;
        if let Some(done) = event.get("done").and_then(Value::as_bool) {
            if done {
                self.done_seen = true;
            }
        }
        let message = event.get("message").unwrap_or(&Value::Null);
        if let Some(content) = message.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                self.text.push_str(content);
                deltas.push(Delta::Text(content.to_string()));
            }
        }
        if let Some(thinking) = message.get("thinking").and_then(Value::as_str) {
            if !thinking.is_empty() {
                self.thinking.push_str(thinking);
                deltas.push(Delta::Thinking(thinking.to_string()));
            }
        }
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                let function = call.get("function").unwrap_or(&Value::Null);
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Protocol("tool call missing name".into()))?
                    .to_string();
                let arguments = function
                    .get("arguments")
                    .ok_or_else(|| ProviderError::Protocol("tool call missing arguments".into()))?
                    .clone();
                self.tool_calls.push((name, arguments));
            }
        }
        Ok(())
    }
}

impl Default for OllamaDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Decodes a full NDJSON stream split into arbitrary byte chunks (test seam).
pub fn decode_ndjson_chunks(chunks: &[&[u8]], round: u32) -> Result<DecodedOllama, ProviderError> {
    let mut decoder = OllamaDecoder::new();
    for chunk in chunks {
        decoder.feed(chunk)?;
    }
    decoder.finish(round)
}
