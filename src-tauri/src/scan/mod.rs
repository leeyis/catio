//! Catio 自动扫描后端（自动发现主机/数据库）。
//!
//! 扫描分两类（mode）：
//!   * `host` —— 端口探测 + SSH banner 识别 + 凭证字典/私钥试登录；
//!   * `db`   —— 端口探测 + 原生协议握手识别类型/版本 + 凭证字典试连。
//!
//! 后台任务用 tokio 信号量限流并发，逐节点 emit `scan://found`、周期 emit
//! `scan://progress`、收尾 emit `scan://done`。所有 found 负载严格 camelCase。

pub mod range;
pub mod probe;
pub mod commands;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use serde::Serialize;

/// scanId → 取消令牌的并发表。`scan_cancel` 触发对应令牌，运行中的任务池据此提前结束。
/// 派生 `Default`，由 `lib.rs` 经 `.manage(ScanState::default())` 注册。
#[derive(Default, Clone)]
pub struct ScanState {
    inner: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl ScanState {
    /// 登记一个 scanId 的取消令牌，返回其克隆供后台任务监听。
    pub async fn register(&self, scan_id: String) -> CancellationToken {
        let token = CancellationToken::new();
        self.inner.lock().await.insert(scan_id, token.clone());
        token
    }

    /// 触发某 scanId 的取消（不存在则 no-op）。
    pub async fn cancel(&self, scan_id: &str) {
        if let Some(token) = self.inner.lock().await.get(scan_id) {
            token.cancel();
        }
    }

    /// 任务结束后移除登记，避免取消表无限增长。
    pub async fn remove(&self, scan_id: &str) {
        self.inner.lock().await.remove(scan_id);
    }
}

/// 序列化成前端可判别标签联合：{ kind: "BadRange", message: "..." }，风格同 `SshError`。
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("invalid range: {0}")]
    BadRange(String),
    #[error("invalid args: {0}")]
    BadArgs(String),
    #[error("io error: {0}")]
    Io(String),
}

impl Serialize for ScanError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            ScanError::BadRange(_) => "BadRange",
            ScanError::BadArgs(_) => "BadArgs",
            ScanError::Io(_) => "Io",
        };
        let mut st = s.serialize_struct("ScanError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
