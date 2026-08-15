//! Anthropic Messages API adapter. System prompt is encoded separately;
//! `content_block_*` events accumulate text/thinking/tool blocks, tool input
//! JSON is only parsed after `content_block_stop`, ping and unknown events are
//! ignored, and stream `error` fails immediately.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::provider::{
    classify_error_response, read_limited_body, Provider, ProviderError, ProviderObserver,
    ProviderRequest, ProviderRound, ProviderStop, ERROR_BODY_LIMIT,
};
use crate::agent::types::{
    AgentMessage, AgentRole, AnthropicAuthMode, ContentBlock, ProviderConfig, TokenUsage,
    ToolResultStatus,
};

/// Anthropic-compatible provider over `/v1/messages`.
pub struct AnthropicProvider {
    client: reqwest::Client,
    config: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Self {
        Self { client, config }
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError> {
        let body = encode_messages_request(&request, &self.config.model);
        let base = self.config.base_url.trim_end_matches('/');
        let url = if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        };
        let headers = auth_headers(&self.config);
        let mut builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01");
        if let Some(api_key) = headers.get("x-api-key") {
            builder = builder.header("x-api-key", api_key);
        }
        if let Some(authorization) = headers.get("Authorization") {
            builder = builder.header("Authorization", authorization);
        }
        let response = builder
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = response.status();
        if status.is_client_error() || status.is_server_error() {
            let body = read_limited_body(response, ERROR_BODY_LIMIT)
                .await
                .map_err(|e| ProviderError::Network(e.to_string()))?;
            return Err(classify_error_response(status, &body, &self.config.credential));
        }

        let mut stream = response.bytes_stream();
        let mut decoder = AnthropicDecoder::new();
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
        let decoded = decoder.finish()?;
        Ok(decoded.into_round())
    }
}

/// Auth headers matching the existing `models.ts::apiHeaders` heuristic:
/// `AuthToken` or `Auto` with a non-`sk-ant-api` key uses bearer; `ApiKey`
/// (or `Auto` with an `sk-ant-api` key) uses `x-api-key`. The
/// `anthropic-version` header is always present.
pub fn auth_headers(config: &ProviderConfig) -> HashMap<String, String> {
    let key = config.credential.expose();
    let bearer = match config.anthropic_auth_mode {
        AnthropicAuthMode::AuthToken => true,
        AnthropicAuthMode::ApiKey => false,
        AnthropicAuthMode::Auto => !key.starts_with("sk-ant-api"),
    };
    let mut headers = HashMap::new();
    headers.insert("anthropic-version".into(), "2023-06-01".into());
    if !key.is_empty() {
        if bearer {
            headers.insert("Authorization".into(), format!("Bearer {key}"));
        } else {
            headers.insert("x-api-key".into(), key.to_string());
        }
    }
    headers
}

/// Pure request encoder: system prompt separate, tool results as `user`
/// messages with `tool_result` blocks.
pub fn encode_messages_request(request: &ProviderRequest, model: &str) -> Value {
    let mut body = json!({
        "model": model,
        "system": request.system_prompt,
        "max_tokens": 4096,
        "messages": encode_messages(&request.messages),
        "stream": true,
    });
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
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
        let mut blocks = Vec::new();
        let mut tool_results = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text { text } => {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                ContentBlock::Thinking { thinking } => {
                    blocks.push(json!({ "type": "thinking", "thinking": thinking }));
                }
                ContentBlock::ToolUse { id, name, input } => {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input,
                    }));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    status,
                } => {
                    let is_error = !matches!(status, ToolResultStatus::Succeeded);
                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": is_error,
                    }));
                }
            }
        }
        match message.role {
            AgentRole::User => {
                out.push(json!({ "role": "user", "content": blocks }));
            }
            AgentRole::Assistant => {
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
        }
        if !tool_results.is_empty() {
            out.push(json!({ "role": "user", "content": tool_results }));
        }
    }
    out
}

/// Normalized Anthropic stream result.
#[derive(Debug)]
pub struct DecodedAnthropic {
    pub message: crate::agent::types::AgentMessage,
    pub stop: ProviderStop,
    pub usage: Option<TokenUsage>,
}

impl DecodedAnthropic {
    pub fn into_round(self) -> ProviderRound {
        ProviderRound {
            message: self.message,
            stop: self.stop,
            usage: self.usage,
        }
    }
}

/// Deltas surfaced by `feed` for live observer delivery.
#[derive(Debug)]
pub enum Delta {
    Text(String),
    Thinking(String),
}

/// Accumulating content block indexed by Anthropic `index`.
enum Block {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolUse {
        id: Option<String>,
        name: Option<String>,
        input: String,
    },
}

/// Pure incremental SSE decoder for the Anthropic streaming protocol.
pub struct AnthropicDecoder {
    line_buffer: Vec<u8>,
    event_type: Option<String>,
    blocks: HashMap<usize, Block>,
    block_order: Vec<usize>,
    stop_reason: Option<ProviderStop>,
    input_tokens: Option<u64>,
    output_tokens: u64,
    message_stop_seen: bool,
    error: Option<ProviderError>,
}

impl AnthropicDecoder {
    pub fn new() -> Self {
        Self {
            line_buffer: Vec::new(),
            event_type: None,
            blocks: HashMap::new(),
            block_order: Vec::new(),
            stop_reason: None,
            input_tokens: None,
            output_tokens: 0,
            message_stop_seen: false,
            error: None,
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

    /// Requires `message_stop`, then assembles typed content blocks.
    pub fn finish(mut self) -> Result<DecodedAnthropic, ProviderError> {
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.handle_line(&line, &mut Vec::new())?;
        }
        if let Some(err) = self.error {
            return Err(err);
        }
        if !self.message_stop_seen {
            return Err(ProviderError::UnexpectedEof);
        }
        let mut content = Vec::new();
        for index in &self.block_order {
            match self.blocks.get_mut(index) {
                Some(Block::Text { text }) => {
                    content.push(ContentBlock::Text {
                        text: std::mem::take(text),
                    });
                }
                Some(Block::Thinking { thinking }) => {
                    content.push(ContentBlock::Thinking {
                        thinking: std::mem::take(thinking),
                    });
                }
                Some(Block::ToolUse { id, name, input }) => {
                    let id = id
                        .take()
                        .ok_or_else(|| ProviderError::Protocol("tool_use missing id".into()))?;
                    let name = name
                        .take()
                        .ok_or_else(|| ProviderError::Protocol("tool_use missing name".into()))?;
                    let input: Value = serde_json::from_str(input)
                        .map_err(|e| ProviderError::Protocol(format!("invalid tool input: {e}")))?;
                    if !input.is_object() {
                        return Err(ProviderError::Protocol(
                            "tool input must be a JSON object".into(),
                        ));
                    }
                    content.push(ContentBlock::ToolUse { id, name, input });
                }
                None => {}
            }
        }
        let stop = self.stop_reason.unwrap_or(ProviderStop::Stop);
        let usage = self.input_tokens.map(|input| TokenUsage {
            input_tokens: input,
            output_tokens: self.output_tokens,
        });
        Ok(DecodedAnthropic {
            message: AgentMessage {
                role: AgentRole::Assistant,
                content,
            },
            stop,
            usage,
        })
    }

    fn handle_line(&mut self, line: &[u8], deltas: &mut Vec<Delta>) -> Result<(), ProviderError> {
        let line = std::str::from_utf8(line)
            .map_err(|_| ProviderError::Protocol("stream is not valid UTF-8".into()))?;
        if let Some(event) = line.strip_prefix("event:") {
            self.event_type = Some(event.trim().to_string());
            return Ok(());
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(());
        };
        let data = data.trim_start();
        if data.is_empty() {
            return Ok(());
        }
        let event: Value = serde_json::from_str(data)
            .map_err(|e| ProviderError::Protocol(format!("malformed SSE event: {e}")))?;
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "ping" => {}
            "error" => {
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown stream error");
                self.error = Some(ProviderError::Protocol(message.to_string()));
            }
            "message_start" => {
                self.input_tokens = event
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_u64);
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block_type = event
                    .pointer("/content_block/type")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let block = match block_type {
                    "text" => Block::Text {
                        text: String::new(),
                    },
                    "thinking" => Block::Thinking {
                        thinking: String::new(),
                    },
                    "tool_use" => Block::ToolUse {
                        id: event
                            .pointer("/content_block/id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        name: event
                            .pointer("/content_block/name")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        input: String::new(),
                    },
                    _ => return Ok(()),
                };
                if self.blocks.insert(index, block).is_none() {
                    self.block_order.push(index);
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = event.get("delta").unwrap_or(&Value::Null);
                let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                match self.blocks.get_mut(&index) {
                    Some(Block::Text { text }) if delta_type == "text_delta" => {
                        if let Some(chunk) = delta.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                            deltas.push(Delta::Text(chunk.to_string()));
                        }
                    }
                    Some(Block::Thinking { thinking }) if delta_type == "thinking_delta" => {
                        if let Some(chunk) = delta.get("thinking").and_then(Value::as_str) {
                            thinking.push_str(chunk);
                            deltas.push(Delta::Thinking(chunk.to_string()));
                        }
                    }
                    Some(Block::ToolUse { input, .. }) if delta_type == "input_json_delta" => {
                        if let Some(chunk) = delta.get("partial_json").and_then(Value::as_str) {
                            input.push_str(chunk);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" | "message_delta" | "message_stop" => {
                if event_type == "message_delta" {
                    if let Some(reason) =
                        event.pointer("/delta/stop_reason").and_then(Value::as_str)
                    {
                        self.stop_reason = Some(match reason {
                            "tool_use" => ProviderStop::ToolUse,
                            "max_tokens" => ProviderStop::MaxTokens,
                            _ => ProviderStop::Stop,
                        });
                    }
                    if let Some(output) = event
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                    {
                        self.output_tokens = output;
                    }
                } else if event_type == "message_stop" {
                    self.message_stop_seen = true;
                }
            }
            // Unknown future event types are ignored per the streaming contract.
            _ => {}
        }
        Ok(())
    }
}

impl Default for AnthropicDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Decodes a full SSE stream split into arbitrary byte chunks (test seam).
pub fn decode_sse_chunks(chunks: &[&[u8]]) -> Result<DecodedAnthropic, ProviderError> {
    let mut decoder = AnthropicDecoder::new();
    for chunk in chunks {
        decoder.feed(chunk)?;
    }
    decoder.finish()
}
