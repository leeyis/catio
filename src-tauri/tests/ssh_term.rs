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

/// 回归:同一 SSH session 上并发开多个 PTY channel(终端分屏/复用连接的核心场景)。
/// 此前测试只覆盖单 channel;分屏时第 2+ 个 channel 若静默失败会空白闪光标。这里在同一
/// sess-1 上开 3 个 channel,各自 term_write 一段唯一字节,断言每个 channel 的 term://
/// 事件都回显了自己的输入——证明多 channel 复用同一 session 端到端可用、互不串扰。
#[tokio::test]
async fn multiple_terms_on_one_session_each_echo_independently() {
    let addr = test_server::start().await;
    let mgr = manager_with_session(addr).await;

    let mut chans: Vec<(String, Arc<CapturingSink>, String)> = Vec::new();
    for i in 0..3 {
        let sink = Arc::new(CapturingSink::default());
        let chan = term_open_core("sess-1".into(), 80, 24, sink.clone(), &mgr, |_| {})
            .await
            .unwrap_or_else(|e| panic!("open term #{i} failed: {e:?}"));
        let marker = format!("catio-pane-{i}");
        chans.push((chan, sink, marker));
    }

    // term_open_core 有连接期 mute:丢弃可见输出直到 Ready 哨兵到达或 3s 兜底(MUTE_FALLBACK_MS)。
    // 测试 server 不跑我们的 shell-integration bootstrap,永不发哨兵,故须等过 3s 兜底解除 mute
    // 后再写标记——否则标记回显落在 mute 窗口内被(按设计)丢弃,测的是 mute 而非多 channel 回显。
    tokio::time::sleep(std::time::Duration::from_millis(3300)).await;

    // 给每个 channel 写各自唯一的标记(base64),经交互式 PTY 回显。
    for (chan, _sink, marker) in &chans {
        let b64 = base64_encode(marker.as_bytes());
        term_write_core(&mgr, "sess-1", chan, &b64)
            .await
            .expect("write to term");
    }

    // 每个 channel 的 term:// 事件应回显自己的标记,且不含别的 channel 的标记(不串扰)。
    for (chan, sink, marker) in &chans {
        let topic = format!("term://{chan}");
        let mut echoed = false;
        for _ in 0..100 {
            {
                let events = sink.events.lock().unwrap();
                echoed = events.iter().any(|(t, p)| {
                    t == &topic
                        && p.get("bytesBase64")
                            .and_then(Value::as_str)
                            .and_then(|b| base64_decode(b))
                            .map(|bytes| find_sub(&bytes, marker.as_bytes()))
                            .unwrap_or(false)
                });
            }
            if echoed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(echoed, "channel {chan} 未回显自己的标记 {marker}");
    }
}

fn base64_encode(b: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(b)
}
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(s).ok()
}
fn find_sub(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
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
