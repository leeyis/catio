// ProxyJump 多跳连接集成测试（P1）。
//
// 拓扑：client --SSH--> jump(bastion) --direct-tcpip(real TCP)--> target。
// jump 用 `start_forwarding()`：其 direct-tcpip channel 真去 TcpStream::connect
// 目标并双向桥接字节；target 是普通 `start()`（echo shell + exec）。
// 断言：经跳板建立的**目标**会话能 exec 并收到命令回显——即真有字节穿过跳板。

mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs, JumpSpec};

#[tokio::test]
async fn connects_through_jump() {
    let target = test_server::start().await; // 最终目标：echo shell + exec
    let jump = test_server::start_forwarding().await; // 跳板：direct-tcpip 转发到真 TCP

    let args = ConnectArgs {
        host: target.ip().to_string(),
        port: target.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: Some(JumpSpec {
            host: jump.ip().to_string(),
            port: jump.port(),
            user: test_server::TEST_USER.into(),
            auth: AuthMethod::Password,
            secret: Some(test_server::TEST_PW.into()),
        }),
    };

    // 第 4 个返回值是跳板 handle——必须在目标会话生命周期内保活，否则
    // direct-tcpip 通道断开。这里持有到测试结束。
    let (handle, _fp, _forwarded, _jump) =
        connect_authenticated(&args).await.expect("jump connect");

    // 证明经跳板的**目标**会话可用：exec 回显命令。
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.exec(true, "marker-cmd").await.unwrap();
    let mut got = Vec::new();
    while let Some(m) = ch.wait().await {
        if let russh::ChannelMsg::Data { ref data } = m {
            got.extend_from_slice(data);
        }
        if got.windows(10).any(|w| w == b"marker-cmd") {
            break;
        }
    }
    assert!(
        got.windows(10).any(|w| w == b"marker-cmd"),
        "target exec output must round-trip through the jump host"
    );

    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
    // _jump 在此 drop——链路随测试结束断开。
}
