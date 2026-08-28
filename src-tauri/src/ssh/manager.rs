use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use tokio::task::AbortHandle;

use crate::ssh::conn::{ClientHandler, ForwardedRoutes};

/// 一条已建立的 SSH 会话。`handle` 是 russh 客户端句柄。
pub struct Session {
    pub handle: russh::client::Handle<ClientHandler>,
    pub host: String,
    pub user: String,
    /// 每个终端 channel 一个 owner 任务；此处仅存向其发指令的 mpsc 发送端。
    pub terms: HashMap<String, tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>>,
    /// R（远程）转发路由表，与 ClientHandler 共享。R 隧道任务在此登记
    /// `远端bind端口 → Sender`，使服务端发起的 forwarded-tcpip channel 能被
    /// 路由到对应隧道任务。非 R 用途的会话此表保持空。
    pub forwarded: ForwardedRoutes,
    /// ProxyJump 的跳板 handle（若经跳板连接）。仅为**保活**而持有：跳板 handle
    /// 一旦 drop，目标会话赖以传输的 direct-tcpip 通道随之断开。直连会话为 `None`。
    /// 字段以 `_` 前缀命名，表示按名字不被使用——存在即维持链路。
    pub _jump: Option<russh::client::Handle<ClientHandler>>,
}

impl Session {
    pub fn insert_term(
        &mut self,
        id: String,
        tx: tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>,
    ) {
        self.terms.insert(id, tx);
    }

    pub fn get_term(
        &self,
        id: &str,
    ) -> Option<tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>> {
        self.terms.get(id).cloned()
    }

    pub fn remove_term(
        &mut self,
        id: &str,
    ) -> Option<tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>> {
        self.terms.remove(id)
    }
}

const RECONNECT_CONNECTED: u8 = 0;
const RECONNECTING: u8 = 1;
const RECONNECT_STOPPED: u8 = 2;

/// 一条逻辑 SSH 会话的物理连接状态。逻辑会话只在用户主动断开时停止；
/// 网络抖动只会把状态切到 reconnecting，并唤醒等待中的操作在原 session id 上续用。
pub(crate) struct ReconnectControl {
    phase: AtomicU8,
    changed: Notify,
}

impl ReconnectControl {
    pub(crate) fn connected() -> Self {
        Self {
            phase: AtomicU8::new(RECONNECT_CONNECTED),
            changed: Notify::new(),
        }
    }

    pub(crate) fn mark_reconnecting(&self) {
        self.phase.store(RECONNECTING, Ordering::Release);
        self.changed.notify_waiters();
    }

    pub(crate) fn mark_connected(&self) {
        self.phase.store(RECONNECT_CONNECTED, Ordering::Release);
        self.changed.notify_waiters();
    }

    pub(crate) fn stop(&self) {
        self.phase.store(RECONNECT_STOPPED, Ordering::Release);
        self.changed.notify_waiters();
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.phase.load(Ordering::Acquire) == RECONNECT_CONNECTED
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.phase.load(Ordering::Acquire) == RECONNECT_STOPPED
    }
}

struct ReconnectEntry {
    control: Arc<ReconnectControl>,
    abort: AbortHandle,
}

/// 一条活动隧道的注册项。不与单个会话生命周期绑定——以隧道 id 为键挂在
/// manager 上。`abort`/`emitter_abort` 分别中止接受循环与周期性字节计数发射器。
pub struct TunnelEntry {
    pub kind: char,           // 'L' | 'R' | 'D'
    pub bind: String,         // 实际绑定的本地地址 "127.0.0.1:PORT"
    pub target: Option<String>,
    pub up: Arc<AtomicU64>,   // 字节 本地→远端
    pub down: Arc<AtomicU64>, // 字节 远端→本地
    pub abort: AbortHandle,   // 中止 accept 循环
    /// 周期性 `tunnel://{id}` 发射器的中止句柄（命令层填入；核心层为 None）。
    pub emitter_abort: Option<AbortHandle>,
}

/// 隧道状态快照（`tunnel_list` 返回；serde camelCase 供前端）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub kind: String,
    pub bind: String,
    pub target: Option<String>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub status: String,
}

/// 进程内会话表。以会话 id（"sess-N"）为键。另持隧道注册表（以隧道 id 为键）。
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// 逻辑会话 id → 自动重连监督任务。仅主动 remove 才停止任务并删除逻辑会话。
    reconnects: Mutex<HashMap<String, ReconnectEntry>>,
    tunnels: Mutex<HashMap<String, TunnelEntry>>,
    /// 周期监控任务注册表：会话 id → 任务 AbortHandle。
    monitors: Mutex<HashMap<String, AbortHandle>>,
    /// 进行中的 SFTP 传输取消标志：transfer id → flag。置 true 即请求取消。
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SessionManager {
    pub async fn insert(&self, id: String, sess: Session) -> Arc<Mutex<Session>> {
        let sess = Arc::new(Mutex::new(sess));
        self.sessions.lock().await.insert(id, sess.clone());
        sess
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.get_cancellable(id, None).await
    }

    /// 取得当前可用的物理连接。自动重连中的逻辑会话会在这里等待且没有总时限；
    /// 传入取消标志后，MCP/传输请求仍可由用户或客户端主动取消。
    pub async fn get_cancellable(
        &self,
        id: &str,
        cancel: Option<&AtomicBool>,
    ) -> Option<Arc<Mutex<Session>>> {
        loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return None;
            }

            let sess = self.sessions.lock().await.get(id).cloned()?;
            let control = self
                .reconnects
                .lock()
                .await
                .get(id)
                .map(|entry| entry.control.clone());

            let Some(control) = control else {
                // 测试/内部临时会话不注册重连任务，保持原有直接取会话语义。
                return Some(sess);
            };
            if control.is_stopped() {
                return None;
            }

            let physical_open = {
                let guard = sess.lock().await;
                !guard.handle.is_closed()
            };
            if control.is_connected() && physical_open {
                return Some(sess);
            }

            // Notify 负责低延迟唤醒；短轮询同时覆盖“handle 已关闭、监督任务尚未来得及
            // 切 phase”的极小窗口，并让 AtomicBool 取消无需额外通知通道。
            tokio::select! {
                _ = control.changed.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
            }
        }
    }

    /// 错误发生后判断逻辑会话是否仍存在、且物理连接正在恢复或已经关闭。
    pub async fn is_reconnecting_or_closed(&self, id: &str) -> bool {
        let Some(sess) = self.sessions.lock().await.get(id).cloned() else {
            return false;
        };
        let reconnecting = self
            .reconnects
            .lock()
            .await
            .get(id)
            .is_some_and(|entry| !entry.control.is_connected() && !entry.control.is_stopped());
        if reconnecting {
            return true;
        }
        let closed = sess.lock().await.handle.is_closed();
        closed
    }

    pub(crate) async fn register_reconnect(
        &self,
        id: String,
        control: Arc<ReconnectControl>,
        abort: AbortHandle,
    ) {
        let old = self
            .reconnects
            .lock()
            .await
            .insert(id, ReconnectEntry { control, abort });
        if let Some(old) = old {
            old.control.stop();
            old.abort.abort();
        }
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        if let Some(entry) = self.reconnects.lock().await.remove(id) {
            entry.control.stop();
            entry.abort.abort();
        }
        self.sessions.lock().await.remove(id)
    }

    // ─── 隧道注册表 ───────────────────────────────────────────────────────────

    /// 登记一条隧道。
    pub async fn insert_tunnel(&self, id: String, entry: TunnelEntry) {
        self.tunnels.lock().await.insert(id, entry);
    }

    /// 当前所有隧道的状态快照。
    pub async fn tunnel_status_list(&self) -> Vec<TunnelStatus> {
        self.tunnels
            .lock()
            .await
            .iter()
            .map(|(id, e)| TunnelStatus {
                id: id.clone(),
                kind: e.kind.to_string(),
                bind: e.bind.clone(),
                target: e.target.clone(),
                bytes_up: e.up.load(Ordering::Relaxed),
                bytes_down: e.down.load(Ordering::Relaxed),
                status: "up".into(),
            })
            .collect()
    }

    /// 移除并返回一条隧道；中止其 accept 循环与发射器。
    pub async fn remove_tunnel(&self, id: &str) -> Option<TunnelEntry> {
        let entry = self.tunnels.lock().await.remove(id);
        if let Some(ref e) = entry {
            e.abort.abort();
            if let Some(ref h) = e.emitter_abort {
                h.abort();
            }
        }
        entry
    }

    // ─── 监控任务注册表 ──────────────────────────────────────────────────────

    /// 登记一个会话的周期监控任务。若该会话已有监控任务，先中止旧的。
    pub async fn insert_monitor(&self, session_id: String, abort: AbortHandle) {
        let mut map = self.monitors.lock().await;
        if let Some(old) = map.insert(session_id, abort) {
            old.abort();
        }
    }

    /// 中止并移除一个会话的周期监控任务。
    pub async fn remove_monitor(&self, session_id: &str) {
        if let Some(abort) = self.monitors.lock().await.remove(session_id) {
            abort.abort();
        }
    }

    // ─── SFTP 传输取消注册表 ─────────────────────────────────────────────────

    /// 登记一个传输的取消标志。
    pub async fn register_transfer(&self, id: String, flag: Arc<AtomicBool>) {
        self.transfers.lock().await.insert(id, flag);
    }

    /// 请求取消一个传输（置标志为 true）。返回是否找到该传输。
    pub async fn cancel_transfer(&self, id: &str) -> bool {
        match self.transfers.lock().await.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// 移除一个传输的取消标志（完成/出错/取消后清理）。
    pub async fn unregister_transfer(&self, id: &str) {
        self.transfers.lock().await.remove(id);
    }
}
