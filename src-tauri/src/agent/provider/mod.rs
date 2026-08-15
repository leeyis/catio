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
