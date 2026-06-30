//! 端口转发隧道。L（本地，C1）、R（远程/反向，C2）与 D（动态 SOCKS5，C3）。
//!
//! 本地 (L) 转发：在本地起一个 TCP 监听器，每个入站连接都通过 SSH
//! `direct-tcpip` channel 桥接到远端目标；双向字节都被计数。
//!
//! 远程 (R) 转发：请服务端在远端 bind 端口监听；远端有连接时服务端打开一个
//! `forwarded-tcpip` channel 回到本客户端；隧道任务把该 channel 桥接到一个新
//! 建的本地目标 TCP 连接。即 L 的反向。
//!
//! 动态 (D) 转发：在本地起一个 SOCKS5 代理监听器。每个入站连接先执行 SOCKS5
//! 握手（无认证 CONNECT，RFC 1928 最小子集）获取目标 host:port，再通过
//! `direct-tcpip` channel 桥接到该目标；双向字节计数与 L 相同。
//!
//! russh 0.61.2（ring 后端）已确认的客户端 API：
//!   * direct-tcpip（L/D）：`handle.channel_open_direct_tcpip(host_to_connect:
//!     impl Into<String>, port_to_connect: u32, originator_address:
//!     impl Into<String>, originator_port: u32).await
//!     -> Result<Channel<client::Msg>, russh::Error>`
//!   * tcpip-forward（R 请求）：`handle.tcpip_forward(address: impl Into<String>,
//!     port: u32).await -> Result<u32, russh::Error>`；当 port==0 时返回服务端
//!     实际分配的端口，否则返回 0。
//!   * forwarded-tcpip（R 接收）：服务端发起的 channel 经
//!     `client::Handler::server_channel_open_forwarded_tcpip` 到达，由
//!     `ClientHandler` 据 `connected_port` 路由（见 conn.rs / Session.forwarded）。
//!   * `channel.into_stream()` → 实现 AsyncRead+AsyncWrite 的流，可与
//!     tokio `TcpStream` 桥接。
//!
//! 桥接与计数：对每个连接把 TcpStream 与 channel 流各自 `split`，跑两个手写
//! 复制循环（read→记账→write_all）。方向约定：
//!   * L/D：入站本地→channel 记 up；channel→入站本地 记 down。
//!   * R：本地目标→channel（→远端）记 up；channel（远端→）→本地目标 记 down。

use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use serde::Deserialize;

use crate::events::EventSink;
use crate::ssh::ids::IdGen;
use crate::ssh::manager::{Session, SessionManager, TunnelEntry};
use crate::ssh::SshError;

static TUN_IDS: IdGen = IdGen::new("tun");

/// 前端隧道规格：{ kind, bind, target }。kind 为 "L"|"R"|"D"（取首字符）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    /// "L" | "R" | "D"（本任务只支持 L）。
    pub kind: char,
    /// 本地绑定地址，如 "127.0.0.1:8080" 或 "127.0.0.1:0"（OS 选端口）。
    pub bind: String,
    /// 远端目标 "host:port"（L 转发必填）。
    pub target: Option<String>,
}

/// 一条隧道的核心句柄：id、实际绑定地址、字节计数、accept 循环中止句柄。
pub struct LocalForward {
    pub id: String,
    pub bind_addr: SocketAddr,
    pub up: Arc<AtomicU64>,
    pub down: Arc<AtomicU64>,
    pub abort: AbortHandle,
}

/// 把 "host:port" 拆成 (host, port)。
fn parse_target(target: &str) -> Result<(String, u16), SshError> {
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| SshError::Tunnel(format!("invalid target (need host:port): {target}")))?;
    let port: u16 = port
        .parse()
        .map_err(|_| SshError::Tunnel(format!("invalid target port: {target}")))?;
    Ok((host.to_string(), port))
}

/// 单向复制并计数：从 `r` 读、累加到 `counter`、写到 `w`，直到 EOF/出错。
async fn copy_counting<R, W>(mut r: R, mut w: W, counter: Arc<AtomicU64>)
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                counter.fetch_add(n as u64, Ordering::Relaxed);
                if w.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = w.shutdown().await;
}

/// 可测试核心：开启一条本地（L）转发。
///
/// - 在 `bind` 上绑定一个 TCP 监听器（支持 "127.0.0.1:0" → OS 选端口，返回真实地址）。
/// - spawn 一个 accept 循环：每个入站连接解析 `target`，锁住会话调用
///   `channel_open_direct_tcpip`，取 `channel.into_stream()` 后双向桥接并计数。
///   单连接错误仅记录/忽略，循环继续。
pub async fn open_local_forward(
    session: Arc<Mutex<Session>>,
    bind: &str,
    target: &str,
) -> Result<LocalForward, SshError> {
    // 早校验 target 格式（接受循环里也会再解析，但这里失败可立即报错）。
    let _ = parse_target(target)?;

    let listener = TcpListener::bind(bind)
        .await
        .map_err(|e| SshError::Tunnel(format!("bind {bind}: {e}")))?;
    let bind_addr = listener
        .local_addr()
        .map_err(|e| SshError::Tunnel(e.to_string()))?;

    let id = TUN_IDS.next();
    let up = Arc::new(AtomicU64::new(0));
    let down = Arc::new(AtomicU64::new(0));
    let target = target.to_string();

    let up_loop = up.clone();
    let down_loop = down.clone();
    let handle = tokio::spawn(async move {
        loop {
            let (inbound, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let target = target.clone();
            let session = session.clone();
            let up = up_loop.clone();
            let down = down_loop.clone();
            // 每个入站连接一个任务，避免慢连接阻塞 accept 循环。
            tokio::spawn(async move {
                let (host, port) = match parse_target(&target) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                // 仅在打开 channel 期间短暂锁住会话。
                let channel = {
                    let s = session.lock().await;
                    s.handle
                        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                        .await
                };
                let channel = match channel {
                    Ok(c) => c,
                    Err(_) => return, // 远端打开失败：丢弃此连接，循环继续。
                };
                let stream = channel.into_stream();
                let (ri, wi) = tokio::io::split(inbound);
                let (rc, wc) = tokio::io::split(stream);
                // 入站→channel 记 up；channel→入站 记 down。
                let up_task = tokio::spawn(copy_counting(ri, wc, up));
                let down_task = tokio::spawn(copy_counting(rc, wi, down));
                let _ = tokio::join!(up_task, down_task);
            });
        }
    });

    Ok(LocalForward {
        id,
        bind_addr,
        up,
        down,
        abort: handle.abort_handle(),
    })
}

/// 可测试核心：开启一条远程（R/反向）转发。
///
/// - 在 `session.forwarded` 登记 `remote_port → Sender`，使服务端发起的
///   forwarded-tcpip channel 能被路由到本任务（C2 的 ClientHandler 据 connected_port 投递）。
/// - 调用 `handle.tcpip_forward(remote_bind, remote_port)` 请服务端在远端监听；
///   `remote_port==0` 时捕获服务端实际分配的端口并改用它作为路由键。
/// - spawn 一个任务：`rx.recv().await` 收到每个 forwarded `Channel` 后，新建一个
///   到 `target`（本地 host:port）的 TCP 连接并双向桥接、计数。单连接错误仅忽略。
///
/// 返回 `(实际远端端口, accept 任务 AbortHandle)`。
pub async fn open_remote_forward(
    session: Arc<Mutex<Session>>,
    remote_bind: &str,
    remote_port: u32,
    target: &str,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
) -> Result<(u32, AbortHandle), SshError> {
    // 早校验 target 格式。
    let _ = parse_target(target)?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<russh::Channel<russh::client::Msg>>();

    // 仅在请求转发期间短暂锁住会话。
    let actual_port = {
        let s = session.lock().await;
        // 先按请求端口登记路由——服务端可能在 tcpip_forward 返回前就推来
        // forwarded channel；若那时尚未登记会被丢弃。对具体端口（!=0）这足够。
        s.forwarded
            .lock()
            .expect("forwarded routes mutex poisoned")
            .insert(remote_port, tx.clone());

        let allocated = match s.handle.tcpip_forward(remote_bind, remote_port).await {
            Ok(p) => p,
            Err(e) => {
                // 回滚预登记，避免悬挂路由。
                s.forwarded
                    .lock()
                    .expect("forwarded routes mutex poisoned")
                    .remove(&remote_port);
                return Err(SshError::Tunnel(format!(
                    "tcpip_forward {remote_bind}:{remote_port}: {e}"
                )));
            }
        };
        // port==0 → 服务端返回实际端口；否则沿用请求端口。
        let actual = if remote_port == 0 { allocated } else { remote_port };
        // 若实际端口与预登记键不同（仅 port==0 时），改用实际端口作键
        // （forwarded channel 的 connected_port 会是它）。
        if actual != remote_port {
            let mut map = s.forwarded.lock().expect("forwarded routes mutex poisoned");
            map.remove(&remote_port);
            map.insert(actual, tx);
        }
        actual
    };

    let target = target.to_string();
    let handle = tokio::spawn(async move {
        // 每个 forwarded channel 一个桥接任务。
        while let Some(channel) = rx.recv().await {
            let target = target.clone();
            let up = up.clone();
            let down = down.clone();
            tokio::spawn(async move {
                // 新建到本地目标的连接；失败则丢弃此 channel。
                let local = match tokio::net::TcpStream::connect(&target).await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let stream = channel.into_stream();
                let (rc, wc) = tokio::io::split(stream);
                let (rl, wl) = tokio::io::split(local);
                // 本地目标→channel（→远端）记 up；channel（远端→）→本地目标 记 down。
                let up_task = tokio::spawn(copy_counting(rl, wc, up));
                let down_task = tokio::spawn(copy_counting(rc, wl, down));
                let _ = tokio::join!(up_task, down_task);
            });
        }
    });

    Ok((actual_port, handle.abort_handle()))
}

// ─── SOCKS5 动态转发（D，C3）────────────────────────────────────────────────

/// SOCKS5 握手（RFC 1928 最小子集：无认证 CONNECT）。
///
/// 执行 greeting 与 request 两阶段，返回 CONNECT 请求的目标 `(host, port)`。
/// 成功后 greeting 的 `[0x05][0x00]` 已发出；CONNECT reply 由调用方负责发送
/// （需先尝试打开 channel，再按成功/失败发不同回复）。
///
/// 出错时返回 `io::Error`，调用方丢弃此连接。
async fn socks5_handshake<S>(stream: &mut S) -> Result<(String, u16), io::Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // ── 阶段 1：问候 ─────────────────────────────────────────────────────────
    // client → [VER=0x05][NMETHODS][METHODS...]
    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr).await?;
    let ver = hdr[0];
    let nmethods = hdr[1] as usize;
    if ver != 5 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SOCKS: expected VER=5",
        ));
    }
    if nmethods == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SOCKS: NMETHODS=0",
        ));
    }
    let mut methods = vec![0u8; nmethods];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0x00) {
        // 不提供无认证方式 → 告知 FF（无可接受方法）并拒绝。
        stream.write_all(&[0x05, 0xFF]).await?;
        stream.shutdown().await?;
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "SOCKS: no acceptable auth method",
        ));
    }
    // 选择无认证（0x00）。
    stream.write_all(&[0x05, 0x00]).await?;

    // ── 阶段 2：请求 ─────────────────────────────────────────────────────────
    // client → [VER=0x05][CMD][RSV=0x00][ATYP][DST.ADDR][DST.PORT(2BE)]
    let mut req_hdr = [0u8; 4];
    stream.read_exact(&mut req_hdr).await?;
    if req_hdr[0] != 5 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SOCKS: request VER != 5",
        ));
    }
    let cmd = req_hdr[1];
    let atyp = req_hdr[3];

    if cmd != 0x01 {
        // 只支持 CONNECT(0x01)；其他命令回复 0x07（command not supported）。
        // BND.ADDR/PORT 填零（10 字节总计）。
        stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await?;
        stream.shutdown().await?;
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "SOCKS: CMD not supported",
        ));
    }

    // 解析目标地址。
    let host: String = match atyp {
        0x01 => {
            // IPv4：4 字节。
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await?;
            format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
        }
        0x03 => {
            // 域名：1 字节长度 + n 字节 UTF-8。
            let mut len_buf = [0u8; 1];
            stream.read_exact(&mut len_buf).await?;
            let len = len_buf[0] as usize;
            if len == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "SOCKS: domain length=0",
                ));
            }
            let mut name = vec![0u8; len];
            stream.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "SOCKS: domain not UTF-8")
            })?
        }
        0x04 => {
            // IPv6：16 字节。
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await?;
            let v6 = std::net::Ipv6Addr::from(addr);
            format!("{v6}")
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SOCKS: unknown ATYP",
            ));
        }
    };

    // 目标端口：2 字节大端。
    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await?;
    let port = u16::from_be_bytes(port_buf);

    Ok((host, port))
}

/// 可测试核心：开启一条动态（D/SOCKS5）转发。
///
/// - 在 `bind` 上绑定一个 TCP 监听器（支持 ":0" 或 "127.0.0.1:0" → 返回真实地址）。
/// - spawn 一个 accept 循环：每个入站连接先执行 SOCKS5 握手获取 `(host, port)`，
///   再锁住会话调用 `channel_open_direct_tcpip`，成功后发 SOCKS5 成功回复并双向
///   桥接计数；失败则发 SOCKS5 失败回复并丢弃连接。单连接错误不杀死 accept 循环。
///
/// 返回 `(实际绑定地址, accept 循环 AbortHandle)`。
pub async fn open_dynamic_forward(
    session: Arc<Mutex<Session>>,
    bind: &str,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
) -> Result<(SocketAddr, AbortHandle), SshError> {
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|e| SshError::Tunnel(format!("D bind {bind}: {e}")))?;
    let bind_addr = listener
        .local_addr()
        .map_err(|e| SshError::Tunnel(e.to_string()))?;

    let up_loop = up.clone();
    let down_loop = down.clone();
    let handle = tokio::spawn(async move {
        loop {
            let (mut inbound, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let session = session.clone();
            let up = up_loop.clone();
            let down = down_loop.clone();
            tokio::spawn(async move {
                // SOCKS5 握手：得到目标 host:port。
                let (host, port) = match socks5_handshake(&mut inbound).await {
                    Ok(v) => v,
                    Err(_) => return, // 握手失败：丢弃连接。
                };

                // 打开 direct-tcpip channel（仅在打开期间短暂持锁）。
                let channel_result = {
                    let s = session.lock().await;
                    s.handle
                        .channel_open_direct_tcpip(
                            host.clone(),
                            port as u32,
                            "127.0.0.1",
                            0,
                        )
                        .await
                };

                match channel_result {
                    Ok(channel) => {
                        // 发 SOCKS5 成功回复，然后透明桥接。
                        // [VER][REP=0][RSV][ATYP=IPv4][BND.ADDR=0.0.0.0][BND.PORT=0]
                        if inbound
                            .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let stream = channel.into_stream();
                        let (ri, wi) = tokio::io::split(inbound);
                        let (rc, wc) = tokio::io::split(stream);
                        // 客户端→远端记 up；远端→客户端记 down。
                        let up_task = tokio::spawn(copy_counting(ri, wc, up));
                        let down_task = tokio::spawn(copy_counting(rc, wi, down));
                        let _ = tokio::join!(up_task, down_task);
                    }
                    Err(_) => {
                        // 发 SOCKS5 一般失败回复（0x01）并丢弃。
                        let _ = inbound
                            .write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                            .await;
                    }
                }
            });
        }
    });

    Ok((bind_addr, handle.abort_handle()))
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 把隧道的 `bind`（"host:port"）拆成 (host, port)。R 转发用以请求远端监听。
fn parse_bind(bind: &str) -> Result<(String, u32), SshError> {
    let (host, port) = bind
        .rsplit_once(':')
        .ok_or_else(|| SshError::Tunnel(format!("invalid bind (need host:port): {bind}")))?;
    let port: u32 = port
        .parse()
        .map_err(|_| SshError::Tunnel(format!("invalid bind port: {bind}")))?;
    Ok((host.to_string(), port))
}

/// 启动周期性 `tunnel://{id}` 发射器（约每 500ms 发一次累计字节），返回其 AbortHandle。
/// 经 `EventSink` 发出，桌面端落到 Tauri 事件总线、web 端广播给 WebSocket 订阅者。
fn spawn_byte_emitter(
    sink: Arc<dyn EventSink>,
    id: &str,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
) -> AbortHandle {
    let evt = format!("tunnel://{id}");
    let emitter = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            tick.tick().await;
            sink.emit(
                &evt,
                serde_json::json!({
                    "bytesUp": up.load(Ordering::Relaxed),
                    "bytesDown": down.load(Ordering::Relaxed),
                }),
            );
        }
    });
    emitter.abort_handle()
}

/// 打开一条隧道（Tauri 命令薄封装）。L → 本地转发；R → 远程/反向转发；D → 动态 SOCKS5。
///
/// 实际逻辑在 transport-agnostic 的 [`tunnel_open_core`] 中，桌面端用 `TauriSink`、
/// web（server）端用 WebSocket hub 作为 `EventSink`，共享同一份隧道建立逻辑。
#[tauri::command]
pub async fn tunnel_open(
    session_id: String,
    spec: TunnelSpec,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    tunnel_open_core(session_id, spec, Arc::new(crate::events::TauriSink(app)), &mgr).await
}

/// 打开一条隧道（transport-agnostic 核心）。L → 本地转发；R → 远程/反向转发；D → 动态 SOCKS5。
///
/// 成功后登记到 manager 隧道注册表，并启动一个周期发射器（约每 500ms）将
/// up/down 计数经 `sink` 以 `tunnel://{id}` 主题发出 `{ bytesUp, bytesDown }`。返回隧道 id。
/// `sink` 在桌面端是 Tauri 事件总线、在 web 端是 WebSocket 广播 hub。
pub async fn tunnel_open_core(
    session_id: String,
    spec: TunnelSpec,
    sink: Arc<dyn EventSink>,
    mgr: &SessionManager,
) -> Result<String, SshError> {
    let session = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    match spec.kind {
        'L' => {
            let target = spec
                .target
                .clone()
                .ok_or_else(|| SshError::Tunnel("L forward requires target host:port".into()))?;

            let fwd = open_local_forward(session, &spec.bind, &target).await?;
            let id = fwd.id.clone();
            let emitter_abort =
                spawn_byte_emitter(sink, &id, fwd.up.clone(), fwd.down.clone());

            mgr.insert_tunnel(
                id.clone(),
                TunnelEntry {
                    kind: 'L',
                    bind: fwd.bind_addr.to_string(),
                    target: Some(target),
                    up: fwd.up,
                    down: fwd.down,
                    abort: fwd.abort,
                    emitter_abort: Some(emitter_abort),
                },
            )
            .await;

            Ok(id)
        }
        'R' => {
            let target = spec
                .target
                .clone()
                .ok_or_else(|| SshError::Tunnel("R forward requires target host:port".into()))?;
            let (remote_host, remote_port) = parse_bind(&spec.bind)?;

            let up = Arc::new(AtomicU64::new(0));
            let down = Arc::new(AtomicU64::new(0));
            let (actual_port, abort) = open_remote_forward(
                session,
                &remote_host,
                remote_port,
                &target,
                up.clone(),
                down.clone(),
            )
            .await?;

            let id = TUN_IDS.next();
            let emitter_abort = spawn_byte_emitter(sink, &id, up.clone(), down.clone());

            mgr.insert_tunnel(
                id.clone(),
                TunnelEntry {
                    kind: 'R',
                    bind: format!("{remote_host}:{actual_port}"),
                    target: Some(target),
                    up,
                    down,
                    abort,
                    emitter_abort: Some(emitter_abort),
                },
            )
            .await;

            Ok(id)
        }
        'D' => {
            let up = Arc::new(AtomicU64::new(0));
            let down = Arc::new(AtomicU64::new(0));
            let (bind_addr, abort) =
                open_dynamic_forward(session, &spec.bind, up.clone(), down.clone()).await?;

            let id = TUN_IDS.next();
            let emitter_abort = spawn_byte_emitter(sink, &id, up.clone(), down.clone());

            mgr.insert_tunnel(
                id.clone(),
                TunnelEntry {
                    kind: 'D',
                    bind: bind_addr.to_string(),
                    target: None,
                    up,
                    down,
                    abort,
                    emitter_abort: Some(emitter_abort),
                },
            )
            .await;

            Ok(id)
        }
        _ => Err(SshError::Tunnel(format!(
            "unknown tunnel kind '{}'",
            spec.kind
        ))),
    }
}

/// 关闭一条隧道：从注册表移除（同时中止 accept 循环与发射器）。
#[tauri::command]
pub async fn tunnel_close(
    tunnel_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    mgr.remove_tunnel(&tunnel_id).await;
    Ok(())
}

/// 列出当前所有隧道的状态。
#[tauri::command]
pub async fn tunnel_list(
    mgr: tauri::State<'_, SessionManager>,
) -> Result<Vec<crate::ssh::manager::TunnelStatus>, SshError> {
    Ok(mgr.tunnel_status_list().await)
}
