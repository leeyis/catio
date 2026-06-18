//! SFTP 子系统分段并行传输引擎。
//!
//! 已实现：分段规划纯函数 `plan_segments`、SFTP 子系统会话建立 `open_sftp`、
//! 单流顺序上传/下载 `upload_sftp` / `download_sftp`（N=1 路径）、分段并行下载
//! `download_sftp_segmented`（§5.2）、分段并行上传 `upload_sftp_segmented`（§5.3）。
//! 后续 slice 接入命令层分发。详见
//! `docs/superpowers/specs/2026-06-19-sftp-multithread-transfer-design.md` §5。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;

use crate::ssh::manager::SessionManager;
use crate::ssh::SshError;

/// 低于此大小不分段，走单流顺序传输。
pub const SEGMENT_THRESHOLD: u64 = 8 * 1024 * 1024;
/// 最大段数。
pub const SEGMENTS: u64 = 4;
/// 每段最小长度，限制小文件段数膨胀。
pub const MIN_SEG_SIZE: u64 = 1 * 1024 * 1024;
/// 单次 SFTP read/write 长度，规避服务端 read-len 上限。
pub const CHUNK: usize = 32 * 1024;
/// 进度回调节流阈值：累计该字节数才回调一次（设计文档 §6）。
pub const PROGRESS_STEP: u64 = 256 * 1024;

/// 把 `total` 字节切成若干 `(offset, len)` 段。
///
/// 规则（设计文档 §5.1）：
/// - 有效段数 `n = min(SEGMENTS, ceil(total / MIN_SEG_SIZE))`，且至少为 1；
/// - 段长 `total / n`，最后一段吃掉余数；
/// - 约定 `total == 0` 时返回单段 `(0, 0)`。
///
/// 保证：各段长度之和等于 `total`，相邻段首尾相接（无重叠、无空洞），段数 ≤ `SEGMENTS`。
pub fn plan_segments(total: u64) -> Vec<(u64, u64)> {
    if total == 0 {
        return vec![(0, 0)];
    }
    // ceil(total / MIN_SEG_SIZE)
    let by_min = total.div_ceil(MIN_SEG_SIZE);
    let n = SEGMENTS.min(by_min).max(1);
    let seg = total / n;
    let mut out = Vec::with_capacity(n as usize);
    let mut offset = 0u64;
    for i in 0..n {
        // 最后一段吃掉余数。
        let len = if i == n - 1 { total - offset } else { seg };
        out.push((offset, len));
        offset += len;
    }
    out
}

// ─── SFTP 子系统会话建立 ──────────────────────────────────────────────────────

/// 在已建立的会话上开一条 SFTP 子系统 channel 并建 `SftpSession`。
///
/// 与 `sftp::open_exec_channel` 同样的「短暂持锁 → `channel_open_session` → 释放锁」
/// 模式：`russh::client::Handle` 不可 clone，故在锁内仅开 channel，随后 channel 独立
/// 持有，request_subsystem / 建 session 都在锁外完成。
///
/// 任一步失败返回 `Err`，供上层回退到 exec + base64（ESXi ash 等无 sftp 子系统的环境）。
pub async fn open_sftp(mgr: &SessionManager, session_id: &str) -> Result<SftpSession, SshError> {
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
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))
}

// ─── 按大小分发（命令层入口）────────────────────────────────────────────────

/// 上传分发：文件 `total ≥ SEGMENT_THRESHOLD` 走分段并行 `upload_sftp_segmented`，
/// 否则走单流 `upload_sftp`（避免小文件的分段开销）。语义与底层一致：
/// 取消 → `Ok(true)`，完成 → `Ok(false)`，失败 → `Err`。
///
/// 由命令层在 `open_sftp` 成功后调用；`open_sftp` 失败则命令层回退 exec + base64。
pub async fn upload_dispatch<F>(
    sftp: Arc<SftpSession>,
    local_path: &str,
    remote_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<bool, SshError>
where
    F: Fn(u64) + Send + Sync + 'static,
{
    if total >= SEGMENT_THRESHOLD {
        upload_sftp_segmented(sftp, local_path, remote_path, total, cancel, on_progress).await
    } else {
        upload_sftp(&sftp, local_path, remote_path, total, cancel, on_progress).await
    }
}

/// 下载分发：远端 `total ≥ SEGMENT_THRESHOLD` 走分段并行 `download_sftp_segmented`，
/// 否则走单流 `download_sftp`。语义同 [`upload_dispatch`]。
pub async fn download_dispatch<F>(
    sftp: Arc<SftpSession>,
    remote_path: &str,
    local_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<bool, SshError>
where
    F: Fn(u64) + Send + Sync + 'static,
{
    if total >= SEGMENT_THRESHOLD {
        download_sftp_segmented(sftp, remote_path, local_path, total, cancel, on_progress).await
    } else {
        download_sftp(&sftp, remote_path, local_path, total, cancel, on_progress).await
    }
}

// ─── 单流顺序传输（N=1 路径）────────────────────────────────────────────────

/// 单流顺序上传：本地文件 → 远端单 `File` 句柄，按 `CHUNK` 顺序读写。
///
/// `total` 为本地文件字节数（由调用方预先取得，避免重复 stat）。`on_progress` 在
/// 每跨过 `PROGRESS_STEP` 字节时以累计字节数回调一次（末尾必回调一次终值）。
/// `cancel` 每块检查：置位即停止、删除远端半成品并返回 `Ok(true)`；正常完成返回 `Ok(false)`。
pub async fn upload_sftp<F>(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<bool, SshError>
where
    F: FnMut(u64),
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    on_progress(0);

    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    // CREATE | TRUNCATE | WRITE：建立/清空远端文件。
    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // 关闭句柄后删除远端半成品。
            let _ = remote.shutdown().await;
            let _ = sftp.remove_file(remote_path).await;
            return Ok(true);
        }
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            on_progress(done);
        }
    }

    remote
        .shutdown()
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    on_progress(total);
    Ok(false)
}

/// 单流顺序下载：远端单 `File` 句柄 → 本地文件，按 `CHUNK` 顺序读写。
///
/// 语义与 `upload_sftp` 对称：`cancel` 置位即停止、删除本地半成品并返回 `Ok(true)`。
pub async fn download_sftp<F>(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<bool, SshError>
where
    F: FnMut(u64),
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    on_progress(0);

    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(local);
            let _ = tokio::fs::remove_file(local_path).await;
            return Ok(true);
        }
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            on_progress(done);
        }
    }

    local
        .flush()
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    on_progress(total);
    Ok(false)
}

// ─── 分段并行下载（设计文档 §5.2）──────────────────────────────────────────

/// 分段并行下载：`plan_segments(total)` 切段，每段一个 `tokio` task 各持独立远端/本地
/// `File` 句柄，`seek` 到本段偏移后循环按 `CHUNK` 远端读 / 本地写。所有远端句柄共享同一
/// `SftpSession`（请求自动 pipelining）。
///
/// 流程：
/// 1. 本地 `File::create` 后 `set_len(total)` 预占位，使各段可写到对应偏移；
/// 2. 共享 `Arc<AtomicU64> done` 聚合进度，跨 `PROGRESS_STEP` 回调一次；
/// 3. 共享 `cancel` 各段每 CHUNK 检查；任一段出错 → 置 `cancel` 并记录首个 error；
/// 4. `join` 全部 task：取消或失败 → 删除本地半成品并按情况返回 `Ok(true)` / `Err`；
///    全部成功 → 末尾回调终值，返回 `Ok(false)`。
pub async fn download_sftp_segmented<F>(
    sftp: Arc<SftpSession>,
    remote_path: &str,
    local_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<bool, SshError>
where
    F: Fn(u64) + Send + Sync + 'static,
{
    on_progress(0);

    // 预分配本地文件：set_len(total) 稀疏占位，各段写到对应偏移。
    {
        let f = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        f.set_len(total)
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
    }

    let segments = plan_segments(total);
    let done = Arc::new(AtomicU64::new(0));
    let on_progress = Arc::new(on_progress);

    let mut tasks = Vec::with_capacity(segments.len());
    for (offset, len) in segments {
        let sftp = sftp.clone();
        let cancel = cancel.clone();
        let done = done.clone();
        let on_progress = on_progress.clone();
        let remote_path = remote_path.to_string();
        let local_path = local_path.to_string();
        tasks.push(tokio::spawn(async move {
            download_one_segment(
                &sftp,
                &remote_path,
                &local_path,
                offset,
                len,
                &cancel,
                &done,
                on_progress.as_ref(),
            )
            .await
        }));
    }

    // join 全部 task：记录首个 error。
    let mut first_err: Option<SshError> = None;
    for t in tasks {
        match t.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                cancel.store(true, Ordering::Relaxed);
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(join_err) => {
                cancel.store(true, Ordering::Relaxed);
                if first_err.is_none() {
                    first_err = Some(SshError::Sftp(join_err.to_string()));
                }
            }
        }
    }

    if let Some(e) = first_err {
        // 失败：删除本地半成品后向上报错。
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(e);
    }
    if cancel.load(Ordering::Relaxed) {
        // 取消：删除本地半成品。
        let _ = tokio::fs::remove_file(local_path).await;
        return Ok(true);
    }

    // 防截断校验：各段只读 `total` 字节、never 触发 EOF；若远端真实大小 > total
    // （stat 给小了 / 文件在 stat 与传输间被改写变大），本地 set_len(total) 会比远端短、
    // 内容被静默截断却报成功。完成后探测一次远端真实大小，不等于 total 即报错并清理。
    let remote_size = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?
        .len();
    if remote_size != total {
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(SshError::Sftp(format!(
            "远端文件大小 {remote_size} 与预期 {total} 不一致，疑似 stat 失真或传输中被改写，已中止以避免静默截断"
        )));
    }

    on_progress(total);
    Ok(false)
}

/// 单段下载循环：远端 `File` seek 到 `offset` 读、本地 `File` seek 到 `offset` 写，
/// 共读写 `len` 字节。每 CHUNK 检查 `cancel`、累加共享 `done` 并按节流回调进度。
async fn download_one_segment(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    len: u64,
    cancel: &Arc<AtomicBool>,
    done: &Arc<AtomicU64>,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), SshError> {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    if len == 0 {
        return Ok(());
    }

    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    remote
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut local = tokio::fs::OpenOptions::new()
        .write(true)
        .open(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    local
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut remaining = len;
    while remaining > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let want = remaining.min(CHUNK as u64) as usize;
        let n = remote
            .read(&mut buf[..want])
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        if n == 0 {
            // 远端提前 EOF：段未读满，视为协议/数据错误。
            return Err(SshError::Sftp(format!(
                "段 [{offset}, {}) 远端提前 EOF（剩余 {remaining}）",
                offset + len
            )));
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        remaining -= n as u64;

        // 聚合进度：跨 PROGRESS_STEP 边界时回调一次（轻微竞态可接受，进度为 cosmetic）。
        let prev = done.fetch_add(n as u64, Ordering::Relaxed);
        let now = prev + n as u64;
        if now / PROGRESS_STEP != prev / PROGRESS_STEP {
            on_progress(now);
        }
    }

    local
        .flush()
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    Ok(())
}

// ─── 分段并行上传（设计文档 §5.3）──────────────────────────────────────────

/// 分段并行上传：先以 `CREATE | TRUNCATE | WRITE` 开一次远端文件建立/清空并立即关闭
/// （避免多段并发 TRUNCATE 竞态），再 `plan_segments(total)` 切段，每段一个 `tokio`
/// task 各持独立本地/远端 `File` 句柄，`seek` 到本段偏移后循环按 `CHUNK` 本地读 / 远端
/// 写（SFTP 按 offset 写、自动扩展）。所有远端句柄共享同一 `SftpSession`（请求自动
/// pipelining）。
///
/// 流程：
/// 1. CREATE|TRUNCATE|WRITE 开远端文件并 `shutdown` 立即关闭，建立/清空文件；
/// 2. 共享 `Arc<AtomicU64> done` 聚合进度，跨 `PROGRESS_STEP` 回调一次；
/// 3. 共享 `cancel` 各段每 CHUNK 检查；任一段出错 → 置 `cancel` 并记录首个 error；
/// 4. `join` 全部 task：取消或失败 → 删除远端半成品（`remove_file`）并按情况返回
///    `Ok(true)` / `Err`；全部成功 → 末尾回调终值，返回 `Ok(false)`。
pub async fn upload_sftp_segmented<F>(
    sftp: Arc<SftpSession>,
    local_path: &str,
    remote_path: &str,
    total: u64,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<bool, SshError>
where
    F: Fn(u64) + Send + Sync + 'static,
{
    use tokio::io::AsyncWriteExt;

    on_progress(0);

    // 建立/清空远端文件：CREATE|TRUNCATE|WRITE 开一次并立即关闭，避免多段并发 TRUNCATE 竞态。
    {
        let mut remote = sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        remote
            .shutdown()
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
    }

    let segments = plan_segments(total);
    let done = Arc::new(AtomicU64::new(0));
    let on_progress = Arc::new(on_progress);

    let mut tasks = Vec::with_capacity(segments.len());
    for (offset, len) in segments {
        let sftp = sftp.clone();
        let cancel = cancel.clone();
        let done = done.clone();
        let on_progress = on_progress.clone();
        let local_path = local_path.to_string();
        let remote_path = remote_path.to_string();
        tasks.push(tokio::spawn(async move {
            upload_one_segment(
                &sftp,
                &local_path,
                &remote_path,
                offset,
                len,
                &cancel,
                &done,
                on_progress.as_ref(),
            )
            .await
        }));
    }

    // join 全部 task：记录首个 error。
    let mut first_err: Option<SshError> = None;
    for t in tasks {
        match t.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                cancel.store(true, Ordering::Relaxed);
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(join_err) => {
                cancel.store(true, Ordering::Relaxed);
                if first_err.is_none() {
                    first_err = Some(SshError::Sftp(join_err.to_string()));
                }
            }
        }
    }

    if let Some(e) = first_err {
        // 失败：删除远端半成品后向上报错。
        let _ = sftp.remove_file(remote_path).await;
        return Err(e);
    }
    if cancel.load(Ordering::Relaxed) {
        // 取消：删除远端半成品。
        let _ = sftp.remove_file(remote_path).await;
        return Ok(true);
    }

    // 防截断校验：各段只读本地 `total` 字节；若本地真实大小 > total（传输中被写大等），
    // 超出部分不会上传却报成功。完成后探测一次本地真实大小，不等于 total 即报错并清理远端。
    let local_size = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?
        .len();
    if local_size != total {
        let _ = sftp.remove_file(remote_path).await;
        return Err(SshError::Io(format!(
            "本地文件大小 {local_size} 与预期 {total} 不一致，疑似传输中被改写，已中止以避免远端静默截断"
        )));
    }

    on_progress(total);
    Ok(false)
}

/// 单段上传循环：本地 `File` seek 到 `offset` 读、远端 `File`（WRITE，不 TRUNCATE）
/// seek 到 `offset` 写，共读写 `len` 字节。每 CHUNK 检查 `cancel`、累加共享 `done`
/// 并按节流回调进度。
#[allow(clippy::too_many_arguments)]
async fn upload_one_segment(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    offset: u64,
    len: u64,
    cancel: &Arc<AtomicBool>,
    done: &Arc<AtomicU64>,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), SshError> {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    if len == 0 {
        return Ok(());
    }

    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    local
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    // 远端 WRITE（不 TRUNCATE，文件已由调用方预建）→ seek 到本段偏移，SFTP 按 offset 写、自动扩展。
    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::WRITE)
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    remote
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK];
    let mut remaining = len;
    while remaining > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let want = remaining.min(CHUNK as u64) as usize;
        let n = local
            .read(&mut buf[..want])
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        if n == 0 {
            // 本地提前 EOF：段未读满，视为本地文件被并发截断等数据错误。
            return Err(SshError::Io(format!(
                "段 [{offset}, {}) 本地提前 EOF（剩余 {remaining}）",
                offset + len
            )));
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        remaining -= n as u64;

        // 聚合进度：跨 PROGRESS_STEP 边界时回调一次（轻微竞态可接受，进度为 cosmetic）。
        let prev = done.fetch_add(n as u64, Ordering::Relaxed);
        let now = prev + n as u64;
        if now / PROGRESS_STEP != prev / PROGRESS_STEP {
            on_progress(now);
        }
    }

    // 排空并关闭远端句柄，确保本段写入全部 ack 落盘。
    remote
        .shutdown()
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 通用不变量断言：各段之和 == total、相邻段首尾相接、无重叠无空洞、段数 <= SEGMENTS。
    fn assert_invariants(total: u64, segs: &[(u64, u64)]) {
        assert!(!segs.is_empty(), "至少一段");
        assert!(
            segs.len() as u64 <= SEGMENTS,
            "段数 {} 应 <= SEGMENTS {}",
            segs.len(),
            SEGMENTS
        );
        // 首段从 0 开始。
        assert_eq!(segs[0].0, 0, "首段 offset 必须为 0");
        let mut expected_offset = 0u64;
        let mut sum = 0u64;
        for &(offset, len) in segs {
            assert_eq!(offset, expected_offset, "段必须首尾相接，无重叠无空洞");
            expected_offset += len;
            sum += len;
        }
        assert_eq!(sum, total, "各段之和必须等于 total");
        assert_eq!(expected_offset, total, "末段终点必须等于 total");
    }

    #[test]
    fn total_zero_returns_single_empty_segment() {
        let segs = plan_segments(0);
        assert_eq!(segs, vec![(0, 0)]);
        assert_invariants(0, &segs);
    }

    #[test]
    fn below_threshold_single_segment() {
        // 1 MiB < 8 MiB 阈值，ceil(1MiB / 1MiB) = 1 段。
        let total = 1 * 1024 * 1024;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 1, "1 MiB 应为单段");
        assert_invariants(total, &segs);
    }

    #[test]
    fn at_threshold_segments() {
        // 恰好 8 MiB：ceil(8MiB / 1MiB) = 8，min(4, 8) = 4 段。
        let total = SEGMENT_THRESHOLD;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 4, "8 MiB 应为 4 段");
        assert_invariants(total, &segs);
    }

    #[test]
    fn evenly_divisible() {
        // 16 MiB：min(4, 16) = 4 段，每段恰好 4 MiB，无余数。
        let total = 16 * 1024 * 1024;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 4);
        for &(_, len) in &segs {
            assert_eq!(len, 4 * 1024 * 1024, "整除时每段应等长");
        }
        assert_invariants(total, &segs);
    }

    #[test]
    fn with_remainder_last_segment_absorbs() {
        // 16 MiB + 7 字节：4 段，前三段等长，末段吃掉余数。
        let total = 16 * 1024 * 1024 + 7;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 4);
        let seg = total / 4;
        assert_eq!(segs[0].1, seg);
        assert_eq!(segs[1].1, seg);
        assert_eq!(segs[2].1, seg);
        assert_eq!(segs[3].1, total - 3 * seg, "末段吸收余数");
        assert!(segs[3].1 > seg, "末段比前段长");
        assert_invariants(total, &segs);
    }

    #[test]
    fn very_large_value() {
        // 极大值（约 1 TiB）：仍为 4 段，不溢出、首尾相接。
        let total = 1024u64 * 1024 * 1024 * 1024;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 4);
        assert_invariants(total, &segs);
    }

    #[test]
    fn between_min_seg_sizes() {
        // 2 MiB + 1 字节：ceil(/1MiB) = 3，min(4, 3) = 3 段。
        let total = 2 * 1024 * 1024 + 1;
        let segs = plan_segments(total);
        assert_eq!(segs.len(), 3, "应为 3 段");
        assert_invariants(total, &segs);
    }
}
