mod common;
use common::test_server;

use std::sync::atomic::Ordering;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager, TunnelEntry};
use catio_lib::ssh::tunnel::open_local_forward;

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
    let (handle, _) = connect_authenticated(&args).await.unwrap();
    let mgr = SessionManager::default();
    mgr.insert(
        "sess-test".into(),
        Session {
            handle,
            host: args.host.clone(),
            user: args.user.clone(),
            terms: Default::default(),
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
