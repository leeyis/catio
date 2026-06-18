//! SFTP 子系统分段并行传输引擎。
//!
//! 已实现：分段规划纯函数 `plan_segments`、SFTP 子系统会话建立 `open_sftp`、
//! 单流顺序上传/下载 `upload_sftp` / `download_sftp`（N=1 路径）。后续 slice 接入
//! 分段并行。详见
//! `docs/superpowers/specs/2026-06-19-sftp-multithread-transfer-design.md` §5。

use std::sync::atomic::{AtomicBool, Ordering};
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
