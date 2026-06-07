//! 端口转发隧道。本任务（C1+C4）只实现本地转发（L）。
//!
//! 本地 (L) 转发：在本地起一个 TCP 监听器，每个入站连接都通过 SSH
//! `direct-tcpip` channel 桥接到远端目标；双向字节都被计数。
//!
//! russh 0.61.2（ring 后端）已确认的 direct-tcpip 客户端 API：
//!   * `handle.channel_open_direct_tcpip(host_to_connect: impl Into<String>,
//!      port_to_connect: u32, originator_address: impl Into<String>,
//!      originator_port: u32).await -> Result<Channel<client::Msg>, russh::Error>`
//!   * `channel.into_stream()` → 实现 AsyncRead+AsyncWrite 的流，可与
//!     tokio `TcpStream` 桥接。
//!
//! 桥接与计数：对每个连接把入站 TcpStream 与 channel 流各自 `split`，跑两个
//! 手写复制循环（read→记账→write_all），分别累加 up / down 计数。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use serde::Deserialize;
use tauri::Emitter;

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

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 打开一条隧道。L → 本地转发；R/D 暂未实现（C2/C3）。
///
/// 成功后登记到 manager 隧道注册表，并启动一个周期发射器（约每 500ms）将
/// up/down 计数经 `tunnel://{id}` 事件发出 `{ bytesUp, bytesDown }`。返回隧道 id。
#[tauri::command]
pub async fn tunnel_open(
    session_id: String,
    spec: TunnelSpec,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    if spec.kind != 'L' {
        return Err(SshError::Tunnel("not implemented (C2/C3)".into()));
    }
    let target = spec
        .target
        .clone()
        .ok_or_else(|| SshError::Tunnel("L forward requires target host:port".into()))?;

    let session = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    let fwd = open_local_forward(session, &spec.bind, &target).await?;
    let id = fwd.id.clone();

    // 周期性发射器：每 500ms 发一次累计字节。计数 Arc 仍被注册项持有，
    // 隧道被移除时其 emitter_abort 句柄会中止本任务。
    let evt = format!("tunnel://{id}");
    let up_e = fwd.up.clone();
    let down_e = fwd.down.clone();
    let emitter = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            tick.tick().await;
            let _ = app.emit(
                &evt,
                serde_json::json!({
                    "bytesUp": up_e.load(Ordering::Relaxed),
                    "bytesDown": down_e.load(Ordering::Relaxed),
                }),
            );
        }
    });

    mgr.insert_tunnel(
        id.clone(),
        TunnelEntry {
            kind: 'L',
            bind: fwd.bind_addr.to_string(),
            target: Some(target),
            up: fwd.up,
            down: fwd.down,
            abort: fwd.abort,
            emitter_abort: Some(emitter.abort_handle()),
        },
    )
    .await;

    Ok(id)
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
