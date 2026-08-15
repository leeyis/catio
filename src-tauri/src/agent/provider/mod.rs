//! Provider port: the true external dependency, injectable for tests via
//! scripted adapters. Wire formats are encoded/decoded behind this seam.

use std::sync::Arc;

use async_trait::async_trait;

pub mod anthropic;
pub mod ollama;
pub mod openai;

use anthropic::AnthropicProvider;
use ollama::OllamaProvider;
use openai::OpenAiProvider;

use crate::agent::types::{
    AgentError, AgentMessage, ProviderConfig, ProviderProtocol, TokenUsage, ToolSpec,
};

/// Provider-neutral request for one completion round.
#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    /// Empty when tools are disabled for this round.
    pub tools: Vec<ToolSpec>,
    pub target_ref: String,
    pub execution_mode: crate::agent::types::ExecutionMode,
    pub single_line_commands: bool,
    /// Zero-based provider round within the Turn. Adapters use it for stable
    /// synthetic identifiers (e.g. Ollama tool ids `ollama-{round}-{index}`);
    /// it always comes from the engine, never hard-coded.
    pub round: u32,
}

/// Streaming observer receiving deltas as the provider produces them.
pub trait ProviderObserver: Send + Sync {
    fn text_delta(&self, delta: &str);
    fn thinking_delta(&self, delta: &str);
}

/// Normalized stop reason for a provider round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderStop {
    Stop,
    ToolUse,
    MaxTokens,
    ContentFilter,
    Length,
}

/// A completed provider round with its typed message and metadata.
#[derive(Clone, Debug)]
pub struct ProviderRound {
    pub message: AgentMessage,
    pub stop: ProviderStop,
    pub usage: Option<TokenUsage>,
}

/// Provider-side failure, normalized and stable.
#[derive(Debug, thiserror::Error, Clone, PartialEq)]
pub enum ProviderError {
    #[error("provider authentication failed")]
    Auth,
    #[error("provider rate limited")]
    RateLimit,
    #[error("provider http error: {0}")]
    Http(String),
    #[error("provider network error: {0}")]
    Network(String),
    #[error("provider protocol error: {0}")]
    Protocol(String),
    #[error("provider stream ended unexpectedly")]
    UnexpectedEof,
    #[error("provider does not support tools")]
    ToolsUnsupported,
}

impl ProviderError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Auth => "providerAuth",
            Self::RateLimit => "providerRateLimit",
            Self::Http(_) => "providerHttp",
            Self::Network(_) => "providerNetwork",
            Self::Protocol(_) => "providerProtocol",
            Self::UnexpectedEof => "providerUnexpectedEof",
            Self::ToolsUnsupported => "toolsUnsupported",
        }
    }
}

/// Upper bound for error bodies embedded in diagnostics (kept small, so they
/// can never smuggle credentials or huge payloads into logs).
const ERROR_BODY_LIMIT: usize = 4096;

/// Shared HTTP error classification across the three production adapters.
///
/// Only an explicit, testable "tools not supported" capability response
/// becomes `ToolsUnsupported` (the sole trigger for the legacy fallback).
/// Auth, rate-limit, generic 4xx/5xx and malformed bodies never fall back.
/// Error bodies are length-limited and only ever read from the response —
/// never constructed from the request credential.
pub fn classify_error_response(status: reqwest::StatusCode, body: &[u8]) -> ProviderError {
    match status.as_u16() {
        401 | 403 => ProviderError::Auth,
        429 => ProviderError::RateLimit,
        code => {
            let limited: String =
                String::from_utf8_lossy(&body[..body.len().min(ERROR_BODY_LIMIT)]).into();
            if looks_like_tools_unsupported(limited.as_bytes()) {
                ProviderError::ToolsUnsupported
            } else {
                ProviderError::Http(format!(
                    "status {code}: {}",
                    redact_credentials(&limited)
                ))
            }
        }
    }
}

/// Strips credential-shaped substrings (`sk-…`, `Bearer …`) from error
/// diagnostics, so a provider echoing a secret back can never leak it into
/// logs.
fn redact_credentials(text: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?i)(sk-[a-z0-9_-]{8,}|bearer [a-z0-9._-]{8,})")
            .expect("static credential-redaction regex is valid")
    });
    re.replace_all(text, "[REDACTED]").into_owned()
}

/// True when the (already length-limited) error body explicitly says tool
/// capability is unavailable. Conservative: generic bodies never match.
fn looks_like_tools_unsupported(body: &[u8]) -> bool {
    let lower = body.to_ascii_lowercase();
    let has_tool = lower.windows(4).any(|w| w == b"tool");
    has_tool
        && (lower.windows(11).any(|w| w == b"not support")
            || lower.windows(11).any(|w| w == b"unsupported")
            || lower.windows(13).any(|w| w == b"not available")
            || lower.windows(11).any(|w| w == b"not enabled"))
}

/// True external dependency, injected; production adapters implement this
/// behind `ProviderFactory`.
#[async_trait]
pub trait Provider: Send + Sync {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError>;
}

/// Production factory: constructs the three adapters over one shared
/// `reqwest::Client`.
pub struct ReqwestProviderFactory {
    client: reqwest::Client,
}

impl ReqwestProviderFactory {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl Default for ReqwestProviderFactory {
    fn default() -> Self {
        Self::new(reqwest::Client::new())
    }
}

#[async_trait]
impl crate::agent::runtime::ProviderFactory for ReqwestProviderFactory {
    async fn create(&self, config: &ProviderConfig) -> Result<Arc<dyn Provider>, AgentError> {
        let provider: Arc<dyn Provider> = match config.protocol {
            ProviderProtocol::Openai => {
                Arc::new(OpenAiProvider::new(self.client.clone(), config.clone()))
            }
            ProviderProtocol::Anthropic => {
                Arc::new(AnthropicProvider::new(self.client.clone(), config.clone()))
            }
            ProviderProtocol::Ollama => {
                Arc::new(OllamaProvider::new(self.client.clone(), config.clone()))
            }
        };
        Ok(provider)
    }
}
