//! Shared provider HTTP-error classification: only explicit, testable
//! "tools not supported" capability responses may become `ToolsUnsupported`
//! (which triggers the legacy fallback). Auth/rate-limit/network/generic
//! 4xx/5xx/malformed bodies never fall back; error bodies are length-limited
//! and never contain credentials.

use catio_lib::agent::provider::{classify_error_response, ProviderError};
use reqwest::StatusCode;

fn body_with_tool_error() -> Vec<u8> {
    br#"{"error":{"message":"this model does not support tools"}}"#.to_vec()
}

#[test]
fn auth_and_rate_limit_never_become_tools_unsupported() {
    assert_eq!(
        classify_error_response(StatusCode::UNAUTHORIZED, &body_with_tool_error()),
        ProviderError::Auth
    );
    assert_eq!(
        classify_error_response(StatusCode::FORBIDDEN, &body_with_tool_error()),
        ProviderError::Auth
    );
    assert_eq!(
        classify_error_response(StatusCode::TOO_MANY_REQUESTS, &body_with_tool_error()),
        ProviderError::RateLimit
    );
}

#[test]
fn explicit_tools_capability_error_classifies_as_tools_unsupported() {
    let variants: Vec<&[u8]> = vec![
        br#"{"error":"tools are not supported by this model"}"#,
        br#"{"error":"model does not support tool calling"}"#,
        br#"{"error":"unsupported tool"}"#,
        br#"{"error":"tool use not enabled for this deployment"}"#,
        br#"{"error":"tools not available on endpoint"}"#,
    ];
    for body in variants {
        assert_eq!(
            classify_error_response(StatusCode::BAD_REQUEST, body),
            ProviderError::ToolsUnsupported,
            "body: {}",
            String::from_utf8_lossy(body)
        );
    }
}

#[test]
fn generic_errors_never_fall_back() {
    let bodies: Vec<&[u8]> = vec![
        b"internal server error",
        br#"{"error":{"message":"rate limited by upstream"}}"#,
        b"",
        br#"{"error":"invalid request"}"#,
        // Mentions tools but without a capability signal: still generic.
        br#"{"error":"tool arguments must be valid JSON"}"#,
    ];
    for body in bodies {
        let err = classify_error_response(StatusCode::INTERNAL_SERVER_ERROR, body);
        assert!(
            !matches!(err, ProviderError::ToolsUnsupported),
            "body: {}",
            String::from_utf8_lossy(body)
        );
    }
    assert!(matches!(
        classify_error_response(StatusCode::BAD_GATEWAY, b"upstream"),
        ProviderError::Http(_)
    ));
}

#[test]
fn error_body_is_length_limited_and_credentials_are_not_leaked() {
    // A huge body: the capability signal is inside the first 4096 bytes so
    // classification works; the trailing credential spam must never leak.
    let mut huge = br#"{"error":"tools not supported"}"#.to_vec();
    huge.extend_from_slice(
        b"CREDENTIAL=sk-super-secret-value-1234567890;"
            .repeat(10_000)
            .as_slice(),
    );
    match classify_error_response(StatusCode::BAD_REQUEST, &huge) {
        ProviderError::ToolsUnsupported => {}
        other => panic!("expected ToolsUnsupported, got {other:?}"),
    }

    // Generic errors embed a TRUNCATED body only.
    let mut body = b"sk-super-secret-value-1234567890;".repeat(10_000);
    body.extend_from_slice(b"server exploded");
    let err = classify_error_response(StatusCode::INTERNAL_SERVER_ERROR, &body);
    match err {
        ProviderError::Http(message) => {
            assert!(
                message.len() < 5000,
                "error body must be length-limited, got {} chars",
                message.len()
            );
            assert!(
                !message.contains("sk-super-secret"),
                "credential leaked: {message}"
            );
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}
