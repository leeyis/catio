//! Catio SSH backend (sub-project 2). russh-based.
pub mod conn;
pub mod exec;
pub mod import;
pub mod ids;
pub mod knownhosts;
pub mod manager;
pub mod monitor;
pub mod multiexec;
pub mod osc;
pub mod parse;
pub mod sftp;
pub mod sftp_transfer;
pub mod shell_integration;
pub mod term;
pub mod tunnel;

use serde::Serialize;

/// 序列化成前端可判别的标签联合：{ kind: "AuthFailed", message: "..." }
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("authentication failed")]
    AuthFailed,
    #[error("host unreachable: {0}")]
    HostUnreachable(String),
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("channel closed")]
    ChannelClosed,
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("sftp error: {0}")]
    Sftp(String),
    #[error("tunnel error: {0}")]
    Tunnel(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("file changed on server")]
    Conflict,
    /// 命令超时。`partial` 是超时前已收到的 stdout（可能为空）——长命令跑了一段
    /// 才超时的场景里，这段输出往往正是要看的，故随错误一起带出而非丢弃。
    #[error("operation timed out")]
    TimedOut { partial: String },
    #[error("operation cancelled")]
    Cancelled,
}

impl Serialize for SshError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            SshError::AuthFailed => ("AuthFailed", self.to_string()),
            SshError::HostUnreachable(_) => ("HostUnreachable", self.to_string()),
            SshError::HostKeyMismatch => ("HostKeyMismatch", self.to_string()),
            SshError::ChannelClosed => ("ChannelClosed", self.to_string()),
            SshError::NotFound(_) => ("NotFound", self.to_string()),
            SshError::Sftp(_) => ("Sftp", self.to_string()),
            SshError::Tunnel(_) => ("Tunnel", self.to_string()),
            SshError::Io(_) => ("Io", self.to_string()),
            SshError::Conflict => ("Conflict", self.to_string()),
            SshError::TimedOut { .. } => ("TimedOut", self.to_string()),
            SshError::Cancelled => ("Cancelled", self.to_string()),
        };
        let mut st = s.serialize_struct("SshError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}
