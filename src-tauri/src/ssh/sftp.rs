//! SFTP 客户端：打开 sftp 子系统 + 目录列表。
//!
//! russh-sftp 2.3.0 已确认 API（client）：
//!   * `russh_sftp::client::SftpSession::new(stream).await -> Result<SftpSession, Error>`，
//!     stream 由 `channel.into_stream()`（在 `request_subsystem(true, "sftp")` 之后）得到。
//!   * `sftp.read_dir(path).await -> Result<ReadDir, Error>`；`ReadDir: Iterator<Item = DirEntry>`，
//!     自动跳过 "." 与 ".."。
//!   * `DirEntry::file_name() -> String`、`DirEntry::metadata() -> Metadata`
//!     （`Metadata = protocol::FileAttributes`）。
//!   * `FileAttributes`：公开字段 `size: Option<u64>`、`mtime: Option<u32>`；
//!     方法 `is_dir() -> bool`、`len() -> u64`、`modified() -> io::Result<SystemTime>`。

use crate::ssh::conn::ClientHandler;
use crate::ssh::manager::SessionManager;
use crate::ssh::parse::{human_size, SftpItem};
use crate::ssh::SshError;

/// 在给定的会话 handle 上打开一个 SFTP 子系统会话。
pub async fn open_sftp(
    handle: &russh::client::Handle<ClientHandler>,
) -> Result<russh_sftp::client::SftpSession, SshError> {
    let ch = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    ch.request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))
}

/// 列出远端目录。目录项 size 为 None，文件项 size 为人类可读字符串。
pub async fn list(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<Vec<SftpItem>, SshError> {
    let rd = sftp
        .read_dir(path)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut items = Vec::new();
    for entry in rd {
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let size = if is_dir {
            None
        } else {
            Some(human_size(meta.len()))
        };
        // mtime（unix 秒）→ 字符串；缺失则 None。前端 `mod?` 仅作展示。
        let modified = meta.mtime.map(|t| t.to_string());
        items.push(SftpItem {
            name: entry.file_name(),
            kind: if is_dir { "dir".into() } else { "file".into() },
            size,
            modified,
        });
    }
    Ok(items)
}

/// Tauri 命令：列出某会话上的远端目录。
#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<Vec<SftpItem>, SshError> {
    let sess = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    let sess = sess.lock().await;
    let sftp = open_sftp(&sess.handle).await?;
    list(&sftp, &path).await
}
