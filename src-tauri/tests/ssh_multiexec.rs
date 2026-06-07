// D3 integration tests: multi-session broadcast exec core.
//
// We test `run_on` directly (the Tauri command needs an AppHandle, which is not
// available in unit / integration tests). Two sessions are built against the
// same in-process test server and exercised concurrently via `run_on`.
//
// Command used: "whoami-test-marker" — not one of the five intercepted monitor
// commands and does not start with "nvidia-smi", so the test server echoes it
// back verbatim with a trailing "\n".

mod common;
use common::test_server;

use std::sync::Arc;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager};
use catio_lib::ssh::multiexec::run_on;
use tokio::sync::Mutex;

/// Build a ConnectArgs pointing at `addr` with password auth.
fn make_args(addr: std::net::SocketAddr) -> ConnectArgs {
    ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    }
}

/// `run_on` echoes the command back from the test server.
///
/// The test server appends "\n" to every non-intercepted command, so the
/// returned string is "whoami-test-marker\n". We assert it `contains` the
/// marker string to be robust to any future trailing whitespace changes.
#[tokio::test]
async fn run_on_returns_echoed_output() {
    let addr = test_server::start().await;
    let args = make_args(addr);

    let (handle, _, forwarded) = connect_authenticated(&args).await.unwrap();

    let sess = Arc::new(Mutex::new(Session {
        handle,
        host: args.host.clone(),
        user: args.user.clone(),
        terms: Default::default(),
        forwarded,
    }));

    let result = run_on(sess, "whoami-test-marker").await;
    assert!(result.is_ok(), "run_on failed: {:?}", result.err());
    let output = result.unwrap();
    assert!(
        output.contains("whoami-test-marker"),
        "expected echo of command, got: {:?}",
        output
    );
}

/// Two sessions respond concurrently and both return the echoed command.
///
/// Sessions connect independently; `run_on` tasks are spawned concurrently via
/// `tokio::join!`. Both must complete successfully and contain the marker.
#[tokio::test]
async fn run_on_two_sessions_respond_concurrently() {
    let addr = test_server::start().await;

    // Session 1
    let args1 = make_args(addr);
    let (handle1, _, forwarded1) = connect_authenticated(&args1).await.unwrap();
    let sess1 = Arc::new(Mutex::new(Session {
        handle: handle1,
        host: args1.host.clone(),
        user: args1.user.clone(),
        terms: Default::default(),
        forwarded: forwarded1,
    }));

    // Session 2 (independent connection)
    let args2 = make_args(addr);
    let (handle2, _, forwarded2) = connect_authenticated(&args2).await.unwrap();
    let sess2 = Arc::new(Mutex::new(Session {
        handle: handle2,
        host: args2.host.clone(),
        user: args2.user.clone(),
        terms: Default::default(),
        forwarded: forwarded2,
    }));

    // Run concurrently via tokio::join!
    let cmd = "echo-multiexec-marker";
    let (res1, res2) = tokio::join!(
        run_on(sess1.clone(), cmd),
        run_on(sess2.clone(), cmd),
    );

    // Both must succeed
    assert!(res1.is_ok(), "session 1 failed: {:?}", res1.err());
    assert!(res2.is_ok(), "session 2 failed: {:?}", res2.err());

    let out1 = res1.unwrap();
    let out2 = res2.unwrap();

    // Both outputs must contain the echoed command
    assert!(
        out1.contains(cmd),
        "session 1: expected echo of command, got: {:?}",
        out1
    );
    assert!(
        out2.contains(cmd),
        "session 2: expected echo of command, got: {:?}",
        out2
    );

    // Sanity: output is non-empty
    assert!(!out1.is_empty(), "session 1 output must be non-empty");
    assert!(!out2.is_empty(), "session 2 output must be non-empty");
}

/// Insert sessions into a SessionManager and retrieve via `mgr.get`, then call
/// `run_on` — mirrors the production code path in `multiexec_run`.
#[tokio::test]
async fn run_on_via_session_manager() {
    let addr = test_server::start().await;
    let mgr = SessionManager::default();

    // Insert two sessions
    for i in 0..2usize {
        let args = make_args(addr);
        let (handle, _, forwarded) = connect_authenticated(&args).await.unwrap();
        mgr.insert(
            format!("sess-me-{i}"),
            Session {
                handle,
                host: args.host.clone(),
                user: args.user.clone(),
                terms: Default::default(),
                forwarded,
            },
        )
        .await;
    }

    // Retrieve and run concurrently
    let sess0 = mgr.get("sess-me-0").await.unwrap();
    let sess1 = mgr.get("sess-me-1").await.unwrap();

    let (r0, r1) = tokio::join!(
        run_on(sess0, "manager-roundtrip-cmd"),
        run_on(sess1, "manager-roundtrip-cmd"),
    );

    assert!(r0.is_ok(), "sess-me-0 failed: {:?}", r0.err());
    assert!(r1.is_ok(), "sess-me-1 failed: {:?}", r1.err());
    assert!(r0.unwrap().contains("manager-roundtrip-cmd"));
    assert!(r1.unwrap().contains("manager-roundtrip-cmd"));
}
