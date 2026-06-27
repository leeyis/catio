//! 非 SSH 终端：本地 shell（portable-pty）、串口（serialport）、Telnet（raw TCP）。
//!
//! 复用 SSH 终端与前端之间的同一套协议：服务端字节经 `term://<chan_id>` 事件流向前端
//! （payload `{ "bytesBase64": "<base64>" }`，关闭时 `{ "closed": true }`），用户输入/缩放/
//! 关闭经 [`TermCmd`] 指令。区别仅在数据源不依赖 SSH 会话——按 chan_id 挂在独立的
//! [`LocalTermManager`] 上。
//!
//! 每个终端：一个**阻塞读线程**（数据源 → emit）+ 一个 **tokio 命令任务**（写/缩放/关闭）。
//! 任一端结束都会驱动另一端退出并从注册表自清理，杜绝僵尸终端与句柄滞留。

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::ssh::ids::IdGen;
use crate::ssh::term::TermCmd;
use crate::ssh::SshError;

static CHAN_IDS: IdGen = IdGen::new("lterm");

/// 一个终端在注册表里的句柄：指令发送端 + 「前端就绪」标志（读线程在它置位前不开读，
/// 避免首屏输出落在前端注册监听之前被丢弃）。
struct TermHandle {
    tx: UnboundedSender<TermCmd>,
    ready: Arc<AtomicBool>,
}

/// 非 SSH 终端注册表：chan_id → 句柄。以 Tauri State 形式挂在 app 上。
#[derive(Default)]
pub struct LocalTermManager {
    terms: Mutex<HashMap<String, TermHandle>>,
}

impl LocalTermManager {
    fn insert(&self, id: String, tx: UnboundedSender<TermCmd>, ready: Arc<AtomicBool>) {
        self.terms.lock().unwrap().insert(id, TermHandle { tx, ready });
    }
    fn get_tx(&self, id: &str) -> Option<UnboundedSender<TermCmd>> {
        self.terms.lock().unwrap().get(id).map(|h| h.tx.clone())
    }
    fn set_ready(&self, id: &str) {
        if let Some(h) = self.terms.lock().unwrap().get(id) {
            h.ready.store(true, Ordering::Relaxed);
        }
    }
    fn remove(&self, id: &str) -> Option<UnboundedSender<TermCmd>> {
        self.terms.lock().unwrap().remove(id).map(|h| h.tx)
    }
}

type ResizeFn = Box<dyn FnMut(u32, u32) + Send>;
type CloseFn = Box<dyn FnOnce() + Send>;

/// 启动一个终端 owner。
/// - 阻塞读线程：先等 `ready`（最多 2s 兜底）再读，把字节 emit 给前端；读到 EOF/错误时发
///   `{closed:true}` 并通过 `eof_tx` 通知 owner 退出。串口读带超时，TimedOut/WouldBlock 续轮询。
/// - tokio 命令任务：消费 [`TermCmd`] 写入/缩放/关闭；退出时置 `stop`、调用 `closer` 拆除底层
///   资源（杀子进程 / shutdown socket），并从注册表移除自己 —— 故源端先死也能完整回收。
#[allow(clippy::too_many_arguments)]
fn spawn_terminal(
    app: tauri::AppHandle,
    chan_id: String,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    mut resize: ResizeFn,
    closer: CloseFn,
    eof_tx: UnboundedSender<TermCmd>,
    ready: Arc<AtomicBool>,
    mut rx: UnboundedReceiver<TermCmd>,
) {
    let evt = format!("term://{chan_id}");
    let stop = Arc::new(AtomicBool::new(false));

    // 阻塞读线程。
    {
        let evt = evt.clone();
        let app = app.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            // 等前端注册好 `term://` 监听（term_local_ready 置位）；2s 兜底防止前端异常时永久阻塞。
            let start = Instant::now();
            while !ready.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(5));
            }
            let mut buf = [0u8; 8192];
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = app.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(&buf[..n]) }));
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => continue,
                    Err(_) => break,
                }
            }
            let _ = app.emit(&evt, serde_json::json!({ "closed": true }));
            // 通知 owner 退出并自清理（owner 若已先退出，send 失败无副作用）。
            let _ = eof_tx.send(TermCmd::Close);
        });
    }

    // 命令任务。
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                TermCmd::Write(bytes) => {
                    let _ = writer.write_all(&bytes);
                    let _ = writer.flush();
                }
                TermCmd::Resize(c, r) => resize(c, r),
                TermCmd::Close => break,
            }
        }
        stop.store(true, Ordering::Relaxed);
        closer();
        // 从注册表移除自己（幂等：前端 close 已先移除时返回 None）。
        app.state::<LocalTermManager>().remove(&chan_id);
    });
}

/// 平台默认 shell。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
}

/// 在本地 PTY 里跑给定命令，接到终端 owner。供本地 shell / mosh 共用。
fn open_pty_terminal(
    cmd: portable_pty::CommandBuilder,
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: &LocalTermManager,
) -> Result<String, SshError> {
    use portable_pty::{native_pty_system, PtySize};

    let size = PtySize { rows: rows as u16, cols: cols as u16, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| SshError::Io(e.to_string()))?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| SshError::Io(e.to_string()))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| SshError::Io(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| SshError::Io(e.to_string()))?;
    let master = pair.master;
    let resize: ResizeFn = Box::new(move |c, r| {
        let _ = master.resize(PtySize { rows: r as u16, cols: c as u16, pixel_width: 0, pixel_height: 0 });
    });
    // kill + wait：避免 Unix 僵尸进程；并确保 slave 关闭后 master 读到 EOF 让读线程退出。
    let closer: CloseFn = Box::new(move || {
        let _ = child.kill();
        let _ = child.wait();
    });

    Ok(launch(app, reader, writer, resize, closer, mgr))
}

/// 打开一个本地 shell 终端（PTY）。
#[tauri::command]
pub async fn term_open_local(
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    let mut cmd = portable_pty::CommandBuilder::new(default_shell());
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    open_pty_terminal(cmd, cols, rows, app, &mgr)
}

/// 打开一个 Mosh 终端：委托系统 `mosh` 客户端在本地 PTY 里跑 `mosh user@host`
/// （mosh 自行 SSH 起 mosh-server 再走 UDP）。需本机已安装 mosh，否则 spawn 失败回错误。
#[tauri::command]
pub async fn term_open_mosh(
    host: String,
    user: String,
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    if host.trim().is_empty() {
        return Err(SshError::Io("mosh host is empty".into()));
    }
    let target = if user.trim().is_empty() { host } else { format!("{user}@{host}") };
    let mut cmd = portable_pty::CommandBuilder::new("mosh");
    // `--` 终止 mosh 选项扫描,防止 host 以 `-` 开头被当成选项注入(如 --ssh=<cmd> 致 RCE)。
    cmd.arg("--");
    cmd.arg(target);
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    open_pty_terminal(cmd, cols, rows, app, &mgr)
}

/// 打开一个串口终端。`baud` 波特率（常见 9600 / 115200）。
#[tauri::command]
pub async fn term_open_serial(
    port: String,
    baud: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    if port.trim().is_empty() {
        return Err(SshError::Io("serial port is empty".into()));
    }
    // 50ms 读超时：无数据时 read 返回 TimedOut，使读线程能在轮询间隙感知 stop。
    let sp = serialport::new(&port, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| SshError::Io(e.to_string()))?;
    let reader = sp.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let resize: ResizeFn = Box::new(|_, _| {});
    let closer: CloseFn = Box::new(|| {}); // 串口靠 stop 标志停轮询，无需额外拆除。

    Ok(launch(app, Box::new(reader), Box::new(sp), resize, closer, &mgr))
}

/// 打开一个 Telnet 终端（raw TCP 透传，最小实现）。connect 走 spawn_blocking + 超时，
/// 避免不可达 host 阻塞 tokio 执行器线程。
#[tauri::command]
pub async fn term_open_telnet(
    host: String,
    port: u16,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    use std::net::{TcpStream, ToSocketAddrs};
    if host.trim().is_empty() {
        return Err(SshError::Io("telnet host is empty".into()));
    }
    let stream = tokio::task::spawn_blocking(move || -> std::io::Result<TcpStream> {
        let addr = (host.as_str(), port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::new(ErrorKind::NotFound, "no address resolved"))?;
        TcpStream::connect_timeout(&addr, Duration::from_secs(10))
    })
    .await
    .map_err(|e| SshError::Io(e.to_string()))?
    .map_err(|e| SshError::Io(e.to_string()))?;

    let reader = stream.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let writer = stream.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let resize: ResizeFn = Box::new(|_, _| {});
    let closer: CloseFn = Box::new(move || {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    });

    Ok(launch(app, Box::new(reader), Box::new(writer), resize, closer, &mgr))
}

/// 公共收尾：建 mpsc + ready 标志，spawn owner，登记注册表，返回 chan_id。
fn launch(
    app: tauri::AppHandle,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    resize: ResizeFn,
    closer: CloseFn,
    mgr: &LocalTermManager,
) -> String {
    let (tx, rx) = mpsc::unbounded_channel::<TermCmd>();
    let ready = Arc::new(AtomicBool::new(false));
    let chan_id = CHAN_IDS.next();
    spawn_terminal(app, chan_id.clone(), reader, writer, resize, closer, tx.clone(), ready.clone(), rx);
    mgr.insert(chan_id.clone(), tx, ready);
    chan_id
}

/// 列出系统可用串口（新建连接的串口下拉）。
#[tauri::command]
pub fn serial_list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

/// 前端注册好 `term://` 监听后调用，放行读线程开始读（避免丢首屏输出）。
#[tauri::command]
pub fn term_local_ready(chan_id: String, mgr: tauri::State<'_, LocalTermManager>) {
    mgr.set_ready(&chan_id);
}

/// 向非 SSH 终端写入字节（base64）。
#[tauri::command]
pub fn term_local_write(
    chan_id: String,
    data_base64: String,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    let bytes = B64.decode(data_base64.as_bytes()).map_err(|e| SshError::Io(e.to_string()))?;
    let tx = mgr.get_tx(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Write(bytes)).map_err(|_| SshError::ChannelClosed)
}

/// 调整非 SSH 终端窗口大小（仅本地 PTY 生效；串口/Telnet 无操作）。
#[tauri::command]
pub fn term_local_resize(
    chan_id: String,
    cols: u32,
    rows: u32,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    let tx = mgr.get_tx(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Resize(cols, rows)).map_err(|_| SshError::ChannelClosed)
}

/// 关闭非 SSH 终端：从注册表移除并通知 owner 拆除。
#[tauri::command]
pub fn term_local_close(
    chan_id: String,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    if let Some(tx) = mgr.remove(&chan_id) {
        let _ = tx.send(TermCmd::Close);
    }
    Ok(())
}
