//! Provider error-path safety: error bodies are read with a hard byte budget
//! (never `bytes()`-then-truncate) and the exact credential value is redacted
//! from diagnostics even when it has no `sk-`/`Bearer` shape. One adapter
//! exercises the shared seam against a raw TCP server; all three adapters use
//! the same `read_limited_body` + `classify_error_response` helpers.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use catio_lib::agent::provider::openai::OpenAiProvider;
use catio_lib::agent::provider::{
    Provider, ProviderError, ProviderObserver, ProviderRequest, ProviderRound,
};
use catio_lib::agent::types::{
    AgentMessage, AgentRole, AnthropicAuthMode, ApiCredential, ContentBlock, ExecutionMode,
    ProviderConfig, ProviderProtocol,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Observer that ignores deltas (error path only).
struct NoopObserver;

#[async_trait]
impl ProviderObserver for NoopObserver {
    async fn text_delta(&self, _delta: &str) {}
    async fn thinking_delta(&self, _delta: &str) {}
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

/// A raw HTTP server that answers one request with a 500 whose body echoes the
/// credential, declares a 100 KB `Content-Length` but only writes the first
/// ~5 KB and then stalls. A truly bounded client read returns quickly; an
/// unbounded `bytes()` read waits for the missing 95 KB forever.
async fn spawn_stalling_500_server(secret: &str) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let secret = secret.to_string();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        // Drain the request head so the client can finish writing.
        let mut buf = [0u8; 4096];
        let mut seen = 0usize;
        while seen < 4 {
            let n = socket.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            seen += n;
        }
        let declared = 100_000usize;
        let mut body = format!(
            r#"{{"error":"upstream echoed {secret} and failed","detail":"tools unavailable"}}"#
        )
        .into_bytes();
        // Pad to ~5 KB written (still far below the declared length).
        body.extend(std::iter::repeat_n(b'x', 5_000 - body.len()));
        let head = format!(
            "HTTP/1.1 500 Internal Server Error\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {declared}\r\n\
             Connection: close\r\n\r\n"
        );
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(&body).await;
        // Stall: never write the remaining 95 KB.
        tokio::time::sleep(Duration::from_secs(30)).await;
    });
    (port, task)
}

#[tokio::test]
async fn adapter_error_read_is_bounded_and_credential_is_exactly_redacted() {
    let secret = "catio-secret-plain-42";
    let (port, server) = spawn_stalling_500_server(secret).await;

    let provider = Arc::new(OpenAiProvider::new(
        reqwest::Client::new(),
        ProviderConfig {
            protocol: ProviderProtocol::Openai,
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "test-model".into(),
            credential: ApiCredential::from(secret.to_string()),
            anthropic_auth_mode: AnthropicAuthMode::Auto,
        },
    ));

    // A bounded read must return well before the server's 30 s stall; an
    // unbounded `bytes()` read would wait for the declared 100 KB and time out.
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        provider.complete(request(), &NoopObserver),
    )
    .await;

    server.abort();

    match outcome {
        Ok(Err(ProviderError::Http(message))) => {
            assert!(
                message.len() < 5_000,
                "error body must be length-limited, got {} chars",
                message.len()
            );
            assert!(
                !message.contains(secret),
                "credential leaked into diagnostics: {message}"
            );
            assert!(
                message.contains("[REDACTED]"),
                "credential must be visibly redacted: {message}"
            );
        }
        Ok(other) => panic!("expected ProviderError::Http, got {other:?}"),
        Err(_) => {
            panic!("adapter waited for the full declared error body: the read is not bounded")
        }
    }
}
