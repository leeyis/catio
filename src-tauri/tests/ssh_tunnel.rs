mod common;
use common::test_server;

use std::sync::atomic::Ordering;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use catio_lib::events::EventSink;
use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager, TunnelEntry};
use catio_lib::ssh::tunnel::{
    open_dynamic_forward, open_local_forward, open_remote_forward, tunnel_open_core, TunnelSpec,
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 捕获型 EventSink：把所有 emit 的 (topic, payload) 存进 Vec，供断言。
struct CapturingSink(std::sync::Mutex<Vec<(String, serde_json::Value)>>);
impl EventSink for CapturingSink {
    fn emit(&self, topic: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((topic.to_string(), payload));
    }
}

/// 连接测试 server 并把会话存入一个新建的 SessionManager，返回 (mgr, session_id)。
async fn connect_into_manager() -> (SessionManager, String) {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _, forwarded, _) = connect_authenticated(&args).await.unwrap();
    let mgr = SessionManager::default();
    mgr.insert(
        "sess-test".into(),
        Session {
            handle,
            host: args.host.clone(),
            user: args.user.clone(),
            terms: Default::default(),
            forwarded,
            _jump: None,
        },
    )
    .await;
    (mgr, "sess-test".into())
}

/// transport-agnostic 核心 `tunnel_open_core`：用一个 EventSink（而非 Tauri AppHandle）。
/// 验证它 (1) 返回隧道 id，(2) 登记进 SessionManager 注册表，(3) 周期发射器经 sink
/// 发出 `tunnel://{id}` 帧——这是 server（web）模式复用同一核心的关键。
#[tokio::test]
async fn tunnel_open_core_registers_and_emits_through_sink() {
    let (mgr, session_id) = connect_into_manager().await;
    let sink = Arc::new(CapturingSink(std::sync::Mutex::new(Vec::new())));

    let spec = TunnelSpec {
        kind: 'L',
        bind: "127.0.0.1:0".into(),
        target: Some("echo:9".into()),
    };
    let id = tunnel_open_core(session_id, spec, sink.clone(), &mgr)
        .await
        .unwrap();

    // (2) 已登记到注册表。
    let list = mgr.tunnel_status_list().await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].kind, "L");

    // (3) 周期发射器经 sink 发出 tunnel://{id} 帧（轮询，避免脆弱固定睡眠）。
    let topic = format!("tunnel://{id}");
    let mut emitted = false;
    for _ in 0..50 {
        if sink.0.lock().unwrap().iter().any(|(t, _)| t == &topic) {
            emitted = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(emitted, "emitter must emit tunnel://{id} frames through the sink");

    mgr.remove_tunnel(&id).await;
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

/// C3：动态（D/SOCKS5）转发端到端。
///
/// 验证完整的 SOCKS5 握手 + direct-tcpip + echo 往返：
///   1. 作为 SOCKS5 客户端，连接本地代理监听器。
///   2. 发 greeting `[0x05,0x01,0x00]`，读回 `[0x05,0x00]`（无认证确认）。
///   3. 发 CONNECT 请求（域名 "echo" 端口 9），读回 10 字节成功回复（首两字节 `[0x05,0x00]`）。
///   4. 写 payload，通过 direct-tcpip 到达测试 server 的 echo handler，读回相同字节。
///   5. 断言 up/down 计数 > 0。
#[tokio::test]
async fn dynamic_socks5_round_trips() {
    let (mgr, session_id) = connect_into_manager().await;
    let session = mgr.get(&session_id).await.unwrap();

    let up = Arc::new(AtomicU64::new(0));
    let down = Arc::new(AtomicU64::new(0));
    let (proxy_addr, abort) =
        open_dynamic_forward(session, "127.0.0.1:0", up.clone(), down.clone())
            .await
            .unwrap();

    // ── 连接到 SOCKS5 代理 ────────────────────────────────────────────────────
    let mut sock = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();

    // ── 阶段 1：问候 ──────────────────────────────────────────────────────────
    // 发：VER=5, NMETHODS=1, METHOD=NO_AUTH(0x00)
    sock.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut greet_reply = [0u8; 2];
    sock.read_exact(&mut greet_reply).await.unwrap();
    assert_eq!(
        greet_reply,
        [0x05, 0x00],
        "greeting reply must select NO-AUTH"
    );

    // ── 阶段 2：CONNECT 请求（域名 "echo" 端口 9）────────────────────────────
    // [VER][CMD=CONNECT][RSV][ATYP=0x03 domain][LEN=4][e][c][h][o][PORT_HI][PORT_LO]
    let domain = b"echo";
    let mut req = vec![0x05u8, 0x01, 0x00, 0x03, domain.len() as u8];
    req.extend_from_slice(domain);
    req.extend_from_slice(&9u16.to_be_bytes()); // port 9
    sock.write_all(&req).await.unwrap();

    // 读取 10 字节回复（IPv4 BND 格式）。
    let mut connect_reply = [0u8; 10];
    sock.read_exact(&mut connect_reply).await.unwrap();
    assert_eq!(
        connect_reply[0],
        0x05,
        "connect reply VER must be 5"
    );
    assert_eq!(
        connect_reply[1],
        0x00,
        "connect reply REP must be 0x00 (success)"
    );

    // ── 阶段 3：透明字节往返 ──────────────────────────────────────────────────
    let payload = b"socks-payload";
    sock.write_all(payload).await.unwrap();

    let mut got = vec![0u8; payload.len()];
    sock.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, payload, "bytes must round-trip through SOCKS5 tunnel");

    sock.shutdown().await.ok();

    // 轮询计数器（避免固定 sleep）。
    let mut counted = false;
    for _ in 0..50 {
        if up.load(Ordering::Relaxed) > 0 && down.load(Ordering::Relaxed) > 0 {
            counted = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        counted,
        "byte counters must be > 0 after round-trip (up={}, down={})",
        up.load(Ordering::Relaxed),
        down.load(Ordering::Relaxed)
    );

    abort.abort();
}

/// C2：远程（R/反向）转发端到端。
///
/// 数据流：测试 server 在 `tcpip_forward` 被请求后模拟"远端有人连进来"——用服务端
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
