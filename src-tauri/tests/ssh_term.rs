mod common;
use common::test_server;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use catio_lib::events::EventSink;
use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager};
use catio_lib::ssh::term::{term_open_core, term_write_core};
use serde_json::Value;

#[derive(Default)]
struct CapturingSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, topic: &str, payload: Value) {
        self.events.lock().unwrap().push((topic.to_string(), payload));
    }
}

async fn manager_with_session(addr: std::net::SocketAddr) -> SessionManager {
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _fp, forwarded, jump) = connect_authenticated(&args).await.expect("connect");
    let mgr = SessionManager::default();
    mgr.insert(
        "sess-1".into(),
        Session {
            handle,
            host: addr.ip().to_string(),
            user: test_server::TEST_USER.into(),
            terms: HashMap::new(),
            forwarded,
            _jump: jump,
        },
    )
    .await;
    mgr
}

/// 验证原始 russh PTY+shell echo 路径。
#[tokio::test]
async fn pty_shell_echoes_input() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _, _, _) = connect_authenticated(&args).await.unwrap();
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .unwrap();
    ch.request_shell(false).await.unwrap();
    ch.data(&b"hello"[..]).await.unwrap();
    let mut got = Vec::new();
    while let Some(msg) = ch.wait().await {
        if let russh::ChannelMsg::Data { ref data } = msg {
            got.extend_from_slice(data);
            if got.windows(5).any(|w| w == b"hello") {
                break;
            }
        }
    }
    assert!(got.windows(5).any(|w| w == b"hello"));
}

#[tokio::test]
async fn term_owner_emits_closed_and_removes_term_when_ssh_transport_drops() {
    let addr = test_server::start().await;
    let mgr = manager_with_session(addr).await;
    let sink = Arc::new(CapturingSink::default());

    let chan = term_open_core("sess-1".into(), 80, 24, sink.clone(), &mgr, |_| {})
        .await
        .expect("open term");
    let topic = format!("term://{chan}");

    let sess = mgr.get("sess-1").await.expect("session exists");
    {
        let guard = sess.lock().await;
        guard
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .ok();
    }

    let _ = term_write_core(&mgr, "sess-1", &chan, "eA==").await;

    let mut saw_closed = false;
    for _ in 0..50 {
        {
            let events = sink.events.lock().unwrap();
            saw_closed = events
                .iter()
                .any(|(t, p)| t == &topic && p.get("closed").and_then(Value::as_bool) == Some(true));
        }
        let term_removed = mgr
            .get("sess-1")
            .await
            .expect("session remains registered")
            .lock()
            .await
            .get_term(&chan)
            .is_none();
        if saw_closed && term_removed {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    panic!("expected closed event and term cleanup after SSH transport drop");
}
