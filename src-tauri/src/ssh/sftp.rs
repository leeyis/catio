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

// ─── B2: 上传 / 下载（带进度）────────────────────────────────────────────────

/// 32 KiB 传输块。
const CHUNK: usize = 32 * 1024;

/// 从远端下载文件到本地。`on_progress(done, total)` 在每个块写入后回调。
///
/// total 取自 `sftp.metadata(remote).len()`；逐块读远端→写本地→累加进度。
pub async fn download<F: FnMut(u64, u64)>(
    sftp: &russh_sftp::client::SftpSession,
    remote: &str,
    local: &std::path::Path,
    mut on_progress: F,
) -> Result<(), SshError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let total = sftp
        .metadata(remote)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?
        .len();

    let mut rf = sftp
        .open(remote)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    let mut lf = tokio::fs::File::create(local)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    // 起始进度（空文件也会回调一次）。
    on_progress(done, total);
    loop {
        let n = rf
            .read(&mut buf)
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        if n == 0 {
            break;
        }
        lf.write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        done += n as u64;
        on_progress(done, total);
    }
    lf.flush().await.map_err(|e| SshError::Io(e.to_string()))?;
    Ok(())
}

/// 从本地上传文件到远端。`on_progress(done, total)` 在每个块写入后回调。
///
/// total 取自本地文件大小；远端以 写+建+截断 方式打开；逐块读本地→写远端。
pub async fn upload<F: FnMut(u64, u64)>(
    sftp: &russh_sftp::client::SftpSession,
    local: &std::path::Path,
    remote: &str,
    mut on_progress: F,
) -> Result<(), SshError> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let total = tokio::fs::metadata(local)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?
        .len();

    let mut lf = tokio::fs::File::open(local)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    let mut rf = sftp
        .open_with_flags(
            remote,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    on_progress(done, total);
    loop {
        let n = lf
            .read(&mut buf)
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        rf.write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        done += n as u64;
        on_progress(done, total);
    }
    rf.flush().await.map_err(|e| SshError::Sftp(e.to_string()))?;
    rf.shutdown()
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    Ok(())
}

// ─── B3: mkdir / rename / delete 核心包装 ────────────────────────────────────

/// 新建远端目录。
pub async fn mkdir(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), SshError> {
    sftp.create_dir(path)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))
}

/// 重命名/移动远端文件或目录。
pub async fn rename(
    sftp: &russh_sftp::client::SftpSession,
    from: &str,
    to: &str,
) -> Result<(), SshError> {
    sftp.rename(from, to)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))
}

/// 删除远端文件或目录（`is_dir` 决定 remove_dir / remove_file）。
pub async fn delete(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    is_dir: bool,
) -> Result<(), SshError> {
    let r = if is_dir {
        sftp.remove_dir(path).await
    } else {
        sftp.remove_file(path).await
    };
    r.map_err(|e| SshError::Sftp(e.to_string()))
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

/// 取会话并打开 sftp 子系统的小工具（命令共用）。
async fn session_sftp(
    mgr: &SessionManager,
    session_id: &str,
) -> Result<russh_sftp::client::SftpSession, SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    let sess = sess.lock().await;
    open_sftp(&sess.handle).await
}

/// Tauri 命令：下载远端文件到本地，进度通过 `sftp-progress://download` 事件发出。
#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    use tauri::Emitter;
    let sftp = session_sftp(&mgr, &session_id).await?;
    download(&sftp, &remote_path, std::path::Path::new(&local_path), |done, total| {
        let _ = app.emit(
            "sftp-progress://download",
            serde_json::json!({ "done": done, "total": total }),
        );
    })
    .await
}

/// Tauri 命令：上传本地文件到远端，进度通过 `sftp-progress://upload` 事件发出。
#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    use tauri::Emitter;
    let sftp = session_sftp(&mgr, &session_id).await?;
    upload(&sftp, std::path::Path::new(&local_path), &remote_path, |done, total| {
        let _ = app.emit(
            "sftp-progress://upload",
            serde_json::json!({ "done": done, "total": total }),
        );
    })
    .await
}

/// Tauri 命令：新建远端目录。
#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sftp = session_sftp(&mgr, &session_id).await?;
    mkdir(&sftp, &path).await
}

/// Tauri 命令：重命名/移动远端文件或目录。
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    from: String,
    to: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sftp = session_sftp(&mgr, &session_id).await?;
    rename(&sftp, &from, &to).await
}

/// Tauri 命令：删除远端文件或目录。
#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    is_dir: bool,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sftp = session_sftp(&mgr, &session_id).await?;
    delete(&sftp, &path, is_dir).await
}
