//! Shared provider HTTP-error classification: only explicit, testable
//! "tools not supported" capability responses may become `ToolsUnsupported`
//! (which triggers the legacy fallback). Auth/rate-limit/network/generic
//! 4xx/5xx/malformed bodies never fall back; error bodies are length-limited
//! and never contain credentials.

use catio_lib::agent::provider::{classify_error_response, ProviderError};
use catio_lib::agent::ApiCredential;
use reqwest::StatusCode;

fn body_with_tool_error() -> Vec<u8> {
    br#"{"error":{"message":"this model does not support tools"}}"#.to_vec()
}

#[test]
fn auth_and_rate_limit_never_become_tools_unsupported() {
    assert_eq!(
        classify_error_response(
            StatusCode::UNAUTHORIZED,
            &body_with_tool_error(),
            &ApiCredential::from("sk-test".to_string())
        ),
        ProviderError::Auth
    );
    assert_eq!(
        classify_error_response(
            StatusCode::FORBIDDEN,
            &body_with_tool_error(),
            &ApiCredential::from("sk-test".to_string())
        ),
        ProviderError::Auth
    );
    assert_eq!(
        classify_error_response(
            StatusCode::TOO_MANY_REQUESTS,
            &body_with_tool_error(),
            &ApiCredential::from("sk-test".to_string())
        ),
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
            classify_error_response(
                StatusCode::BAD_REQUEST,
                body,
                &ApiCredential::from("sk-test".to_string())
            ),
            ProviderError::ToolsUnsupported,
            "body: {}",
            String::from_utf8_lossy(body)
        );
    }
}

#[test]
fn server_errors_never_become_tools_unsupported_even_with_capability_body() {
    // 5xx means the service is broken or the gateway failed: the body must
    // never turn it into a capability error (and never trigger fallback).
    for status in [
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::GATEWAY_TIMEOUT,
    ] {
        let err = classify_error_response(
            status,
            &body_with_tool_error(),
            &ApiCredential::from("sk-test".to_string()),
        );
        assert!(
            !matches!(err, ProviderError::ToolsUnsupported),
            "status {status} with a tools-unsupported body must stay Http, got {err:?}"
        );
        assert!(
            matches!(err, ProviderError::Http(_)),
            "status {status} must be ProviderError::Http, got {err:?}"
        );
    }
}

#[test]
fn generic_client_errors_never_become_tools_unsupported() {
    // Only a small, explicit capability status set may signal
    // ToolsUnsupported; every other client status is a transport failure even
    // when the body says "tools not supported".
    let body = body_with_tool_error();
    let capability_bodies: Vec<(StatusCode, &[u8])> = vec![
        (StatusCode::CONFLICT, &body),
        (StatusCode::NOT_ACCEPTABLE, &body),
        (StatusCode::UNPROCESSABLE_ENTITY, &body),
        (StatusCode::BAD_REQUEST, &body),
    ];
    // 400 with an explicit capability body IS the capability case (below);
    // the others must stay Http.
    for (status, body) in capability_bodies {
        if status == StatusCode::BAD_REQUEST {
            continue;
        }
        let err =
            classify_error_response(status, body, &ApiCredential::from("sk-test".to_string()));
        assert!(
            matches!(err, ProviderError::Http(_)),
            "status {status} must stay ProviderError::Http, got {err:?}"
        );
    }
    // A 400 body that mentions tools but is NOT an explicit capability signal
    // stays Http as well (no speculative fallback).
    assert!(matches!(
        classify_error_response(
            StatusCode::BAD_REQUEST,
            br#"{"error":"tool arguments must be valid JSON"}"#,
            &ApiCredential::from("sk-test".to_string())
        ),
        ProviderError::Http(_)
    ));
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
        let err = classify_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            body,
            &ApiCredential::from("sk-test".to_string()),
        );
        assert!(
            !matches!(err, ProviderError::ToolsUnsupported),
            "body: {}",
            String::from_utf8_lossy(body)
        );
    }
    assert!(matches!(
        classify_error_response(
            StatusCode::BAD_GATEWAY,
            b"upstream",
            &ApiCredential::from("sk-test".to_string())
        ),
        ProviderError::Http(_)
    ));
}

#[test]
fn exact_credential_value_is_redacted_even_without_sk_or_bearer_shape() {
    let secret = "catio-secret-plain-42";
    let credential = ApiCredential::from(secret.to_string());
    let body = format!(r#"{{"error":"upstream echoed {secret} back"}}"#);
    let err = classify_error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        body.as_bytes(),
        &credential,
    );
    match err {
        ProviderError::Http(message) => {
            assert!(
                !message.contains(secret),
                "exact credential leaked into diagnostics: {message}"
            );
            assert!(
                message.contains("[REDACTED]"),
                "missing redaction: {message}"
            );
        }
        other => panic!("expected Http error, got {other:?}"),
    }
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
    match classify_error_response(
        StatusCode::BAD_REQUEST,
        &huge,
        &ApiCredential::from("sk-test".to_string()),
    ) {
        ProviderError::ToolsUnsupported => {}
        other => panic!("expected ToolsUnsupported, got {other:?}"),
    }

    // Generic errors embed a TRUNCATED body only.
    let mut body = b"sk-super-secret-value-1234567890;".repeat(10_000);
    body.extend_from_slice(b"server exploded");
    let err = classify_error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        &body,
        &ApiCredential::from("sk-test".to_string()),
    );
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
