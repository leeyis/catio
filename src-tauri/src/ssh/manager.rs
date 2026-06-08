use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
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
    tunnels: Mutex<HashMap<String, TunnelEntry>>,
    /// 周期监控任务注册表：会话 id → 任务 AbortHandle。
    monitors: Mutex<HashMap<String, AbortHandle>>,
}

impl SessionManager {
    pub async fn insert(&self, id: String, sess: Session) {
        self.sessions
            .lock()
            .await
            .insert(id, Arc::new(Mutex::new(sess)));
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
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
}
