//! Catio SSH backend (sub-project 2). russh-based.
pub mod conn;
pub mod ids;
pub mod knownhosts;
pub mod manager;
pub mod monitor;
pub mod multiexec;
pub mod osc;
pub mod parse;
pub mod sftp;
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
        };
        let mut st = s.serialize_struct("SshError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}
