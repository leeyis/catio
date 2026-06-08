mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};

/// 验证原始 russh PTY+shell echo 路径（owner 任务需 AppHandle 才能 emit，
/// 故不直接单测——此原始路径证明 russh 交互工作正常）。
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
