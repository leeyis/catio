//! 远端文件浏览与传输 —— 元数据操作基于 SSH **exec**（照搬 Reach 的实现，MIT），
//! 上传/下载优先走 **SFTP 子系统**（分段并行），失败回退 exec + base64。
//!
//!   * 列目录：`ls -lA --time-style=+%s`，解析输出拿到 名称/类型/大小/属主/属组/
//!     权限/修改时间（[`parse_ls_output`] 为纯函数，单测覆盖）。
//!     仍走 exec：`ls -lA` 直接给到 tooltip 所需的属主/属组名称，SFTP `read_dir`
//!     只给数字 uid/gid，切换会造成回归。
//!   * 上传 / 下载：先试 `open_sftp`，成功则按大小走分段并行 / 单流 SFTP
//!     （[`crate::ssh::sftp_transfer`]）；`open_sftp` 失败（子系统不支持，如 ESXi ash）
//!     → 回退到现有 exec + base64 单流（[`upload_stream`] / [`download_stream`]）。
//!     进度按字节节流后经 `transfer-progress-{id}` 事件发出。
//!   * mkdir / rm / mv / touch / realpath：对应 shell 命令（仍走 exec）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::ssh::manager::SessionManager;
use crate::ssh::monitor::run_cmd;
use crate::ssh::SshError;

// ─── 数据类型 ────────────────────────────────────────────────────────────────

/// 远端目录项。serde camelCase 匹配前端 `SftpItem`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpItem {
    pub name: String,
    pub path: String,
    /// "dir" | "file" | "link"
    #[serde(rename = "type")]
    pub kind: String,
    /// 字节数（目录为 0）。
    pub size: u64,
    /// 修改时间（unix 秒；无法解析为 0）。
    pub modified: u64,
    /// 权限串，如 "drwxr-xr-x"。
    pub permissions: String,
    pub owner: String,
    pub group: String,
}

/// 一次传输的进度。serde camelCase 匹配前端监听载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub id: String,
    pub filename: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

/// 远端文件内容（在线编辑读取）。serde camelCase 匹配前端 `RemoteFileContent`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileContent {
    /// UTF-8 文本（lossy 解码）；二进制时为空串。
    pub content: String,
    /// 是否二进制（前 8KiB 含 NUL 字节）。
    pub is_binary: bool,
    /// 远端文件总字节数。
    pub size: u64,
    /// 修改时间（unix 秒），保存时的冲突检测基准。
    pub modified: Option<i64>,
    /// 权限位（低 12 位八进制），写回时还原。
    pub mode: Option<u32>,
    /// 内容是否因超过上限被截断（仅作只读预览）。
    pub truncated: bool,
}

/// 在线编辑可读取的最大字节数（5MB）；超过则只读预览，提示走下载。
const EDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 在线编辑读取的单次 SFTP read 长度。
const EDIT_RW_CHUNK: usize = 32 * 1024;

/// 单调递增的传输 id 计数器（避免引入 uuid 依赖）。
static TRANSFER_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_transfer_id() -> String {
    format!("xfer-{}", TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 每次传输的原始数据块（48KiB，3 的倍数 → base64 无中段填充）。
const CHUNK: usize = 48 * 1024;
/// 进度事件节流阈值：累计该字节数才发一次。
const PROGRESS_STEP: u64 = 256 * 1024;

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

/// 单引号转义，安全用于 shell。
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 取路径最后一段作为文件名。
fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => trimmed.to_string(),
    }
}

/// 解析 `ls -lA --time-style=+%s`（或回退的标准 `ls -lA`）输出为目录项列表。
///
/// 行格式：`perms links owner group size <epoch|月 日 时> name...`。
/// 对 `--time-style=+%s`，第 6 列是 epoch；否则是月份（取 0 时间）。
/// 跳过 `.`/`..`/`total` 行；软链 `name -> target` 取 `->` 前的名字。
pub fn parse_ls_output(output: &str, base_path: &str) -> Vec<SftpItem> {
    let base = if base_path.ends_with('/') {
        base_path.to_string()
    } else {
        format!("{}/", base_path)
    };

    let mut items = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 7 {
            continue;
        }
        let permissions = parts[0];
        // 首字符必须是合法文件类型标记。
        if !permissions.starts_with(|c: char| "d-lcbps".contains(c)) {
            continue;
        }
        let kind = match permissions.chars().next() {
            Some('d') => "dir",
            Some('l') => "link",
            _ => "file",
        };
        let size: u64 = parts[4].parse().unwrap_or(0);
        let owner = parts[2].to_string();
        let group = parts[3].to_string();

        // 第 6 列是 epoch（数字）→ 时间风格输出；否则是标准月份。
        let (modified, name) = if let Ok(ts) = parts[5].parse::<u64>() {
            (ts, parts[6..].join(" "))
        } else if parts.len() >= 9 {
            (0u64, parts[8..].join(" "))
        } else {
            (0u64, parts[parts.len() - 1].to_string())
        };

        if name == "." || name == ".." || name.is_empty() {
            continue;
        }
        // 软链：取 " -> " 之前的名字。
        let clean_name = match name.find(" -> ") {
            Some(idx) => name[..idx].to_string(),
            None => name,
        };

        items.push(SftpItem {
            path: format!("{}{}", base, clean_name),
            name: clean_name,
            kind: kind.to_string(),
            size: if kind == "dir" { 0 } else { size },
            modified,
            permissions: permissions.to_string(),
            owner,
            group,
        });
    }

    // 目录在前，再按名称（忽略大小写）排序。
    items.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    items
}

// ─── exec 包装（短暂持锁取 handle，跑命令）──────────────────────────────────

/// 列目录。`run_cmd` 仅在打开 channel 期间短暂持有会话锁。
pub async fn list_directory(
    mgr: &SessionManager,
    session_id: &str,
    path: &str,
) -> Result<Vec<SftpItem>, SshError> {
    let esc = shell_escape(path);
    let cmd = format!(
        "ls -lA --time-style=+%s {esc} 2>/dev/null || ls -lA {esc}",
        esc = esc
    );
    let out = exec(mgr, session_id, &cmd).await?;
    Ok(parse_ls_output(&out, path))
}

/// 解析为绝对路径（地址栏展示用）。`.` → 家目录。
pub async fn realpath(
    mgr: &SessionManager,
    session_id: &str,
    path: &str,
) -> Result<String, SshError> {
    let esc = shell_escape(path);
    let cmd = format!(
        "cd -- {esc} 2>/dev/null && pwd || readlink -f -- {esc} 2>/dev/null || echo {esc}",
        esc = esc
    );
    let out = exec(mgr, session_id, &cmd).await?;
    let resolved = out.lines().next().unwrap_or("").trim().to_string();
    Ok(if resolved.is_empty() {
        path.to_string()
    } else {
        resolved
    })
}

/// 在会话上跑一条命令，短暂持锁取 handle。
async fn exec(mgr: &SessionManager, session_id: &str, cmd: &str) -> Result<String, SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    let guard = sess.lock().await;
    run_cmd(&guard.handle, cmd).await
}

/// 短暂持锁打开一个 exec channel（流式传输用，随后释放锁，channel 独立运行）。
async fn open_exec_channel(
    mgr: &SessionManager,
    session_id: &str,
    cmd: &str,
) -> Result<Channel<Msg>, SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    let channel = {
        let guard = sess.lock().await;
        guard
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Io(e.to_string()))?
    };
    channel
        .exec(true, cmd.to_string())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    Ok(channel)
}

// ─── 流式传输 ────────────────────────────────────────────────────────────────

/// 上传（exec + base64 回退流）：本地文件 → 远端 `base64 -d > path`，48KiB 原始块流式 base64。
/// 返回 `Ok(true)` 表示被取消，`Ok(false)` 表示正常完成。
///
/// `on_progress(done)` 在起始（0）、每跨 `PROGRESS_STEP` 字节、末尾（total）各回调一次，
/// 与 SFTP 引擎的回调约定一致；调用方负责把字节进度转成事件（见 `progress_emitter`）。
pub async fn upload_stream<F>(
    mut channel: Channel<Msg>,
    local_path: &str,
    total_bytes: u64,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<bool, SshError>
where
    F: FnMut(u64),
{
    use tokio::io::AsyncReadExt;

    on_progress(0);

    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut sent: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = channel.eof().await;
            return Ok(true);
        }
        // 尽量填满 CHUNK（除最后一块外保证为 48KiB 的整块 → base64 无中段填充）。
        let mut filled = 0;
        while filled < CHUNK {
            let n = file
                .read(&mut buf[filled..])
                .await
                .map_err(|e| SshError::Io(e.to_string()))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        let mut b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..filled]);
        b64.push('\n');
        channel
            .data(b64.as_bytes())
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        sent += filled as u64;
        if sent - last_emit >= PROGRESS_STEP || filled < CHUNK {
            last_emit = sent;
            on_progress(sent);
        }
        if filled < CHUNK {
            break;
        }
    }

    channel
        .eof()
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    wait_exit(&mut channel).await?;
    on_progress(total_bytes);
    Ok(false)
}

/// 下载（exec + base64 回退流）：远端 `base64 path` → 本地文件，按完整 base64 行解码写入。
/// 返回 `Ok(true)` 表示被取消，`Ok(false)` 表示正常完成。
///
/// `on_progress(done)` 约定同 [`upload_stream`]：起始 0、每跨 `PROGRESS_STEP`、末尾各回调一次。
/// 下载侧总字节数由远端流自然界定（读到 EOF 即止），无需传入 `total`。
pub async fn download_stream<F>(
    mut channel: Channel<Msg>,
    local_path: &str,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<bool, SshError>
where
    F: FnMut(u64),
{
    use tokio::io::AsyncWriteExt;

    on_progress(0);

    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    let mut b64_buf = String::new();
    let mut written: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stderr = String::new();
    let mut got_eof = false;
    let mut got_exit = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(local_path).await; // 删除不完整的本地文件
            return Ok(true);
        }
        // 500ms 超时轮询，使取消即使在数据停滞时也能及时响应。
        let msg = match tokio::time::timeout(std::time::Duration::from_millis(500), channel.wait()).await {
            Ok(m) => m,
            Err(_) => continue, // 超时 → 回到循环顶部重新检查取消标志
        };
        match msg {
            Some(ChannelMsg::Data { ref data }) => {
                b64_buf.push_str(&String::from_utf8_lossy(data));
                while let Some(nl) = b64_buf.find('\n') {
                    let line: String = b64_buf[..nl].chars().filter(|c| !c.is_whitespace()).collect();
                    b64_buf = b64_buf[nl + 1..].to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(&line)
                        .map_err(|e| SshError::Sftp(e.to_string()))?;
                    file.write_all(&decoded)
                        .await
                        .map_err(|e| SshError::Io(e.to_string()))?;
                    written += decoded.len() as u64;
                }
                if written - last_emit >= PROGRESS_STEP {
                    last_emit = written;
                    on_progress(written);
                }
            }
            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                stderr.push_str(&String::from_utf8_lossy(data));
            }
            Some(ChannelMsg::Eof) => {
                got_eof = true;
                if got_exit {
                    break;
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                got_exit = true;
                if exit_status != 0 && !stderr.trim().is_empty() {
                    return Err(SshError::Sftp(stderr.trim().to_string()));
                }
                if got_eof {
                    break;
                }
            }
            None => break,
            _ => {}
        }
    }

    // 解码尾部残余。
    let tail: String = b64_buf.chars().filter(|c| !c.is_whitespace()).collect();
    if !tail.is_empty() {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&tail)
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        file.write_all(&decoded)
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        written += decoded.len() as u64;
    }
    file.flush().await.map_err(|e| SshError::Io(e.to_string()))?;
    on_progress(written);
    Ok(false)
}

// ─── 命令层分发：先试 SFTP 子系统，失败回退 exec + base64 ───────────────────

/// 上传分发：先 `open_sftp`，成功则按大小走分段/单流 SFTP（`upload_dispatch`），
/// 进度经 `transfer-progress-{id}` 发出；`open_sftp` 失败（子系统不支持，如 ESXi ash）
/// → 回退到现有 exec + base64 单流（`upload_stream`）。语义保持一致：
/// `Ok(false)` 完成、`Ok(true)` 取消、`Err` 出错。
#[allow(clippy::too_many_arguments)]
async fn upload_dispatch_or_fallback(
    mgr: &SessionManager,
    app: &tauri::AppHandle,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    total_bytes: u64,
    filename: &str,
    transfer_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<bool, SshError> {
    match crate::ssh::sftp_transfer::open_sftp(mgr, session_id).await {
        Ok(sftp) => {
            let on_progress = progress_emitter(app, transfer_id, filename, total_bytes);
            crate::ssh::sftp_transfer::upload_dispatch(
                Arc::new(sftp),
                local_path,
                remote_path,
                total_bytes,
                cancel,
                on_progress,
            )
            .await
        }
        // 子系统不可用：回退到 exec + base64。
        Err(_) => {
            let cmd = format!("base64 -d > {}", shell_escape(remote_path));
            let channel = open_exec_channel(mgr, session_id, &cmd).await?;
            let on_progress = progress_emitter(app, transfer_id, filename, total_bytes);
            upload_stream(channel, local_path, total_bytes, cancel, on_progress).await
        }
    }
}

/// 下载分发：对称于 [`upload_dispatch_or_fallback`]。先 `open_sftp`，成功走
/// `download_dispatch`，失败回退 exec + base64（`download_stream`）。
#[allow(clippy::too_many_arguments)]
async fn download_dispatch_or_fallback(
    mgr: &SessionManager,
    app: &tauri::AppHandle,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    total_bytes: u64,
    filename: &str,
    transfer_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<bool, SshError> {
    match crate::ssh::sftp_transfer::open_sftp(mgr, session_id).await {
        Ok(sftp) => {
            let on_progress = progress_emitter(app, transfer_id, filename, total_bytes);
            crate::ssh::sftp_transfer::download_dispatch(
                Arc::new(sftp),
                remote_path,
                local_path,
                total_bytes,
                cancel,
                on_progress,
            )
            .await
        }
        Err(_) => {
            let cmd = format!("base64 {}", shell_escape(remote_path));
            let channel = open_exec_channel(mgr, session_id, &cmd).await?;
            let on_progress = progress_emitter(app, transfer_id, filename, total_bytes);
            download_stream(channel, local_path, cancel, on_progress).await
        }
    }
}

/// 构造一个把 SFTP 引擎的字节进度回调转成 `transfer-progress-{id}` 事件的闭包。
/// 满足 `upload_dispatch`/`download_dispatch` 要求的 `Fn(u64) + Send + Sync + 'static`。
fn progress_emitter(
    app: &tauri::AppHandle,
    transfer_id: &str,
    filename: &str,
    total: u64,
) -> impl Fn(u64) + Send + Sync + 'static {
    let app = app.clone();
    let transfer_id = transfer_id.to_string();
    let filename = filename.to_string();
    move |done| emit_progress(&app, &transfer_id, &filename, done, total)
}

// ─── 阻塞式传输（供 MCP 等非 UI 调用方：等待完成、不发进度事件）─────────────

/// 上传本地文件到远端，等待完成后返回字节数。复用流式上传核心。
pub async fn upload_blocking(
    mgr: &SessionManager,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    app: &tauri::AppHandle,
) -> Result<u64, SshError> {
    let total_bytes = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?
        .len();
    if total_bytes == 0 {
        let cmd = format!(": > {}", shell_escape(remote_path));
        exec(mgr, session_id, &cmd).await?;
        return Ok(0);
    }
    let filename = basename(local_path);
    let cancel = Arc::new(AtomicBool::new(false));
    let cancelled = upload_dispatch_or_fallback(
        mgr,
        app,
        session_id,
        local_path,
        remote_path,
        total_bytes,
        &filename,
        "mcp",
        cancel,
    )
    .await?;
    if cancelled {
        return Err(SshError::Sftp("cancelled".into()));
    }
    Ok(total_bytes)
}

/// 下载远端文件到本地，等待完成后返回字节数。复用流式下载核心。
pub async fn download_blocking(
    mgr: &SessionManager,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    app: &tauri::AppHandle,
) -> Result<u64, SshError> {
    let stat_cmd = format!(
        "stat -c%s {p} 2>/dev/null || stat -f%z {p} 2>/dev/null",
        p = shell_escape(remote_path)
    );
    let size_out = exec(mgr, session_id, &stat_cmd).await?;
    let total_bytes: u64 = size_out.trim().parse().unwrap_or(0);
    if total_bytes == 0 {
        tokio::fs::write(local_path, b"")
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        return Ok(0);
    }
    let filename = basename(remote_path);
    let cancel = Arc::new(AtomicBool::new(false));
    let cancelled = download_dispatch_or_fallback(
        mgr,
        app,
        session_id,
        remote_path,
        local_path,
        total_bytes,
        &filename,
        "mcp",
        cancel,
    )
    .await?;
    if cancelled {
        return Err(SshError::Sftp("cancelled".into()));
    }
    Ok(total_bytes)
}

/// 等待远端命令结束并校验退出码（上传用）。
async fn wait_exit(channel: &mut Channel<Msg>) -> Result<(), SshError> {
    let mut stderr = String::new();
    let mut exit: Option<u32> = None;
    let mut got_eof = false;
    let mut got_exit = false;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                stderr.push_str(&String::from_utf8_lossy(data));
            }
            Some(ChannelMsg::Eof) => {
                got_eof = true;
                if got_exit {
                    break;
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit = Some(exit_status);
                got_exit = true;
                if got_eof {
                    break;
                }
            }
            None => break,
            _ => {}
        }
    }
    if let Some(code) = exit {
        if code != 0 {
            let msg = stderr.trim();
            return Err(SshError::Sftp(if msg.is_empty() {
                format!("远端命令退出码 {}", code)
            } else {
                msg.to_string()
            }));
        }
    }
    Ok(())
}

fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    filename: &str,
    done: u64,
    total: u64,
) {
    let percent = if total > 0 {
        (done as f64 / total as f64 * 100.0).min(100.0)
    } else {
        100.0
    };
    let _ = app.emit(
        &format!("transfer-progress-{}", id),
        TransferProgress {
            id: id.to_string(),
            filename: filename.to_string(),
            bytes_transferred: done,
            total_bytes: total,
            percent,
        },
    );
}

// ─── Tauri 命令 ──────────────────────────────────────────────────────────────

/// 列出远端目录。
#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<Vec<SftpItem>, SshError> {
    list_directory(&mgr, &session_id, &path).await
}

/// 解析绝对路径（地址栏初始化 / 校验用）。
#[tauri::command]
pub async fn sftp_realpath(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    realpath(&mgr, &session_id, &path).await
}

/// 上传：立即返回 transfer_id，后台流式传输，进度经 `transfer-progress-{id}`、
/// 完成经 `transfer-complete-{id}`、出错经 `transfer-error-{id}` 事件发出。
#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    let total_bytes = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?
        .len();
    let filename = basename(&local_path);

    let id = next_transfer_id();

    // 空文件：truncate 即可。
    if total_bytes == 0 {
        let cmd = format!(": > {}", shell_escape(&remote_path));
        exec(&mgr, &session_id, &cmd).await?;
        let _ = app.emit(&format!("transfer-complete-{}", id), ());
        return Ok(id);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    mgr.register_transfer(id.clone(), cancel.clone()).await;

    let tid = id.clone();
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<SessionManager>();
        let result = upload_dispatch_or_fallback(
            &mgr,
            &app,
            &session_id,
            &local_path,
            &remote_path,
            total_bytes,
            &filename,
            &tid,
            cancel,
        )
        .await;
        mgr.unregister_transfer(&tid).await;
        dispatch_outcome(&app, &tid, result);
    });
    Ok(id)
}

/// 下载：立即返回 transfer_id，后台流式传输（事件同上传）。
#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    let filename = basename(&remote_path);

    // 先取大小（用于进度百分比）。
    let stat_cmd = format!(
        "stat -c%s {p} 2>/dev/null || stat -f%z {p} 2>/dev/null",
        p = shell_escape(&remote_path)
    );
    let size_out = exec(&mgr, &session_id, &stat_cmd).await?;
    let total_bytes: u64 = size_out.trim().parse().unwrap_or(0);

    let id = next_transfer_id();

    // 空文件：直接写空。
    if total_bytes == 0 {
        tokio::fs::write(&local_path, b"")
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        let _ = app.emit(&format!("transfer-complete-{}", id), ());
        return Ok(id);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    mgr.register_transfer(id.clone(), cancel.clone()).await;

    let tid = id.clone();
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<SessionManager>();
        let result = download_dispatch_or_fallback(
            &mgr,
            &app,
            &session_id,
            &remote_path,
            &local_path,
            total_bytes,
            &filename,
            &tid,
            cancel,
        )
        .await;
        mgr.unregister_transfer(&tid).await;
        dispatch_outcome(&app, &tid, result);
    });
    Ok(id)
}

/// 根据传输结果发出对应的终态事件：完成 / 取消 / 出错。
fn dispatch_outcome(app: &tauri::AppHandle, tid: &str, result: Result<bool, SshError>) {
    match result {
        Ok(false) => { let _ = app.emit(&format!("transfer-complete-{}", tid), ()); }
        Ok(true) => { let _ = app.emit(&format!("transfer-cancelled-{}", tid), ()); }
        Err(e) => { let _ = app.emit(&format!("transfer-error-{}", tid), e.to_string()); }
    }
}

/// 取消一个进行中的传输（置取消标志；流循环会尽快停止）。
#[tauri::command]
pub async fn sftp_transfer_cancel(
    transfer_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    mgr.cancel_transfer(&transfer_id).await;
    Ok(())
}

/// 新建远端目录。
#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let cmd = format!("mkdir -p {}", shell_escape(&path));
    exec(&mgr, &session_id, &cmd).await?;
    Ok(())
}

/// 重命名/移动。
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    from: String,
    to: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let cmd = format!("mv -- {} {}", shell_escape(&from), shell_escape(&to));
    exec(&mgr, &session_id, &cmd).await?;
    Ok(())
}

/// 删除文件或目录（递归）。
#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    is_dir: bool,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let _ = is_dir; // rm -rf 同时适用文件与目录；保留参数兼容前端签名。
    let cmd = format!("rm -rf -- {}", shell_escape(&path));
    exec(&mgr, &session_id, &cmd).await?;
    Ok(())
}

/// 新建空文件。
#[tauri::command]
pub async fn sftp_touch(
    session_id: String,
    path: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let cmd = format!("touch -- {}", shell_escape(&path));
    exec(&mgr, &session_id, &cmd).await?;
    Ok(())
}

/// 读取远端文件内容到内存（在线编辑）。内容传输走 SFTP 子系统；
/// 返回大小 / 修改时间 / 权限位用于保存时的冲突检测与权限还原。
///
/// - `max_bytes` 缺省取 [`EDIT_MAX_BYTES`]；超限只读取前 `max_bytes` 字节并置 `truncated`。
/// - 前 8KiB 含 NUL 字节即判定二进制，`content` 留空、`is_binary = true`，前端引导走下载。
#[tauri::command]
pub async fn sftp_read_file(
    session_id: String,
    path: String,
    max_bytes: Option<u64>,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<RemoteFileContent, SshError> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let limit = max_bytes.unwrap_or(EDIT_MAX_BYTES);
    let sftp = crate::ssh::sftp_transfer::open_sftp(&mgr, &session_id).await?;

    let attrs = sftp
        .metadata(path.as_str())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    let size = attrs.size.unwrap_or(0);
    let modified = attrs.mtime.map(|m| m as i64);
    let mode = attrs.permissions.map(|p| p & 0o7777);

    // 读取至多 limit+1 字节以判断是否截断。
    let mut remote = sftp
        .open_with_flags(path.as_str(), OpenFlags::READ)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    let cap = limit.saturating_add(1) as usize;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; EDIT_RW_CHUNK];
    loop {
        let n = remote
            .read(&mut chunk)
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() >= cap {
            break;
        }
    }
    let _ = remote.shutdown().await;

    let truncated = buf.len() as u64 > limit;
    if truncated {
        buf.truncate(limit as usize);
    }

    // 二进制判定：前 8KiB 含 NUL 字节即视为二进制（git 同款启发，对截断鲁棒）。
    let probe_len = buf.len().min(8192);
    let is_binary = buf[..probe_len].contains(&0);

    Ok(RemoteFileContent {
        content: if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(&buf).into_owned()
        },
        is_binary,
        size,
        modified,
        mode,
        truncated,
    })
}

/// 写回远端文件内容（在线编辑保存）。
///
/// 1. 冲突检测：`base_modified` 与远端当前 mtime 不一致 → 返回 [`SshError::Conflict`]，前端弹冲突提示。
/// 2. 原子写：先写临时文件 `<path>.catio.tmp`（SFTP），再 `mv -f` 覆盖目标
///    （SFTP v3 rename 不保证可覆盖已存在文件，故走 exec mv，与 mkdir/rename 同一架构）。
/// 3. 还原权限位（临时文件以默认权限创建）。
/// 4. 返回新的 mtime，作为下次保存的冲突检测基准。
#[tauri::command]
pub async fn sftp_write_file(
    session_id: String,
    path: String,
    content: String,
    base_modified: Option<i64>,
    mode: Option<u32>,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<i64, SshError> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let sftp = crate::ssh::sftp_transfer::open_sftp(&mgr, &session_id).await?;

    // 1. 冲突检测。
    if let Some(base) = base_modified {
        if let Ok(attrs) = sftp.metadata(path.as_str()).await {
            if let Some(cur) = attrs.mtime.map(|m| m as i64) {
                if cur != base {
                    return Err(SshError::Conflict);
                }
            }
        }
    }

    // 2. 写临时文件（SFTP 子系统）。
    let tmp = format!("{}.catio.tmp", path);
    {
        let mut f = sftp
            .open_with_flags(
                tmp.as_str(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        f.write_all(content.as_bytes())
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        f.shutdown()
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
    }

    // 3. 还原原权限位。
    if let Some(m) = mode {
        let _ = exec(
            &mgr,
            &session_id,
            &format!("chmod {:o} {}", m & 0o7777, shell_escape(&tmp)),
        )
        .await;
    }

    // 4. 原子替换目标；失败则清理临时文件并上报。
    let mv = format!("mv -f -- {} {}", shell_escape(&tmp), shell_escape(&path));
    if let Err(e) = exec(&mgr, &session_id, &mv).await {
        let _ = sftp.remove_file(tmp.as_str()).await;
        return Err(e);
    }

    // 5. 返回新 mtime。
    let attrs = sftp
        .metadata(path.as_str())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    Ok(attrs.mtime.map(|m| m as i64).unwrap_or(0))
}

// ─── 单元测试（纯函数 parse_ls_output）────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_epoch_time_style_with_owner_group() {
        let out = "total 12\n\
            drwxr-xr-x 2 root root 4096 1717800000 .config\n\
            -rw-r--r-- 1 alice users 1536 1717801234 notes.txt\n";
        let items = parse_ls_output(out, "/home/alice");
        assert_eq!(items.len(), 2);
        // 目录在前。
        assert_eq!(items[0].name, ".config");
        assert_eq!(items[0].kind, "dir");
        assert_eq!(items[0].size, 0);
        assert_eq!(items[0].owner, "root");
        assert_eq!(items[0].group, "root");
        assert_eq!(items[0].path, "/home/alice/.config");
        let f = &items[1];
        assert_eq!(f.name, "notes.txt");
        assert_eq!(f.kind, "file");
        assert_eq!(f.size, 1536);
        assert_eq!(f.modified, 1717801234);
        assert_eq!(f.owner, "alice");
        assert_eq!(f.group, "users");
        assert_eq!(f.permissions, "-rw-r--r--");
    }

    #[test]
    fn skips_dot_entries_and_total_line() {
        let out = "total 4\n\
            drwxr-xr-x 5 root root 4096 1717800000 .\n\
            drwxr-xr-x 3 root root 4096 1717800000 ..\n\
            -rw-r--r-- 1 root root 0 1717800000 keep\n";
        let items = parse_ls_output(out, "/x");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "keep");
    }

    #[test]
    fn handles_symlink_and_spaces_in_name() {
        let out = "lrwxrwxrwx 1 root root 7 1717800000 link -> /tmp/x\n\
            -rw-r--r-- 1 root root 10 1717800000 my file.txt\n";
        let items = parse_ls_output(out, "/x/");
        let link = items.iter().find(|i| i.name == "link").expect("link");
        assert_eq!(link.kind, "link");
        let spaced = items.iter().find(|i| i.name == "my file.txt").expect("spaced");
        assert_eq!(spaced.path, "/x/my file.txt");
    }

    #[test]
    fn falls_back_to_standard_ls_without_epoch() {
        // 无 --time-style 的标准格式：月 日 时 在 5/6/7 列，名字从第 9 列起。
        let out = "-rw-r--r-- 1 root root 100 Jun  8 16:08 app.log\n";
        let items = parse_ls_output(out, "/var/log");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "app.log");
        assert_eq!(items[0].modified, 0);
        assert_eq!(items[0].size, 100);
    }

    #[test]
    fn basename_takes_last_segment() {
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("plain"), "plain");
    }
}
