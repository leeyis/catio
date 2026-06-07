mod common;
use common::test_server;

use std::sync::atomic::Ordering;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager, TunnelEntry};
use catio_lib::ssh::tunnel::{open_local_forward, open_remote_forward};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 连接测试 server 并把会话存入一个新建的 SessionManager，返回 (mgr, session_id)。
async fn connect_into_manager() -> (SessionManager, String) {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, _, forwarded) = connect_authenticated(&args).await.unwrap();
    let mgr = SessionManager::default();
    mgr.insert(
        "sess-test".into(),
        Session {
            handle,
            host: args.host.clone(),
            user: args.user.clone(),
            terms: Default::default(),
            forwarded,
        },
    )
    .await;
    (mgr, "sess-test".into())
}

/// L 转发往返：通过本地监听器写字节 → direct-tcpip → server echo → 读回。
/// 证明桥接真的搬运了字节，并且 up/down 计数 > 0。
#[tokio::test]
async fn local_forward_round_trips_bytes_through_direct_tcpip() {
    let (mgr, session_id) = connect_into_manager().await;
    let session = mgr.get(&session_id).await.unwrap();

    // target host/port 任意——测试 server 无视它们一律 echo。
    let fwd = open_local_forward(session, "127.0.0.1:0", "echo:9")
        .await
        .unwrap();

    let mut sock = tokio::net::TcpStream::connect(fwd.bind_addr)
        .await
        .unwrap();
    let payload = b"ping-through-tunnel";
    sock.write_all(payload).await.unwrap();

    let mut got = vec![0u8; payload.len()];
    sock.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, payload, "bytes must round-trip through the tunnel");

    // 关闭写端促使 server echo 复制完成并刷新计数。
    sock.shutdown().await.ok();
    // 给计数器一点时间累加（down 在读回后必然 > 0，up 在写后必然 > 0）。
    assert!(fwd.up.load(Ordering::Relaxed) > 0, "up counter must be > 0");
    assert!(
        fwd.down.load(Ordering::Relaxed) > 0,
        "down counter must be > 0"
    );

    fwd.abort.abort();
}

/// C4：注册表 insert / tunnel_status_list / remove_tunnel 往返。
#[tokio::test]
async fn tunnel_registry_insert_list_remove() {
    let (mgr, session_id) = connect_into_manager().await;
    let session = mgr.get(&session_id).await.unwrap();

    let fwd = open_local_forward(session, "127.0.0.1:0", "echo:9")
        .await
        .unwrap();
    let id = fwd.id.clone();

    mgr.insert_tunnel(
        id.clone(),
        TunnelEntry {
            kind: 'L',
            bind: fwd.bind_addr.to_string(),
            target: Some("echo:9".into()),
            up: fwd.up.clone(),
            down: fwd.down.clone(),
            abort: fwd.abort.clone(),
            emitter_abort: None,
        },
    )
    .await;

    let list = mgr.tunnel_status_list().await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].kind, "L");
    assert_eq!(list[0].status, "up");
    assert_eq!(list[0].target.as_deref(), Some("echo:9"));

    let removed = mgr.remove_tunnel(&id).await;
    assert!(removed.is_some());
    assert!(mgr.tunnel_status_list().await.is_empty());
}

/// C2：远程（R/反向）转发端到端。
///
/// 数据流：测试 server 在 `tcpip_forward` 被请求后模拟“远端有人连进来”——用服务端
/// Handle 打开一个 forwarded-tcpip channel 回到客户端，并往里写一个 payload。客户端
/// `ClientHandler::server_channel_open_forwarded_tcpip` 据 `connected_port` 把该 channel
/// 路由给我们刚开的 R 隧道任务；该任务新建一个到本测试内 LOCAL ECHO 目标的 TCP 连接并
/// 双向桥接。echo 把 payload 原样送回 channel → 回到服务端。
///
/// 断言：客户端侧 up/down 计数都 > 0，证明真有字节经 forwarded channel 双向桥接到本地
/// 目标——即 R 隧道把投递到客户端的 forwarded channel 真正搬运了字节。
#[tokio::test]
async fn remote_forward_delivers_forwarded_channel() {
    let (mgr, session_id) = connect_into_manager().await;
    let session = mgr.get(&session_id).await.unwrap();

    // 本测试内的本地 echo 目标：R 隧道会把 forwarded channel 桥接到这里。
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_addr = echo.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match echo.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            tokio::spawn(async move {
                let (mut r, mut w) = sock.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });

    let up = Arc::new(AtomicU64::new(0));
    let down = Arc::new(AtomicU64::new(0));
    // 请求远端在 127.0.0.1:7777 监听（测试 server 接受并立即模拟一个反向连接）。
    let (actual_port, abort) = open_remote_forward(
        session,
        "127.0.0.1",
        7777,
        &echo_addr.to_string(),
        up.clone(),
        down.clone(),
    )
    .await
    .unwrap();
    assert_eq!(actual_port, 7777, "concrete requested port is preserved");

    // 等待：forwarded channel 投递 → 桥接到本地 echo → 往返字节。轮询计数，避免脆弱的固定睡眠。
    let mut crossed = false;
    for _ in 0..50 {
        if up.load(Ordering::Relaxed) > 0 && down.load(Ordering::Relaxed) > 0 {
            crossed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        crossed,
        "bytes must bridge both ways through the forwarded channel (up={}, down={})",
        up.load(Ordering::Relaxed),
        down.load(Ordering::Relaxed)
    );

    abort.abort();
}
