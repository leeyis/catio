//! SFTP 子系统分段并行传输引擎。
//!
//! 当前 slice 仅实现分段规划纯函数 `plan_segments`，后续 slice 接入
//! `SftpSession` 的上传/下载并行传输。详见
//! `docs/superpowers/specs/2026-06-19-sftp-multithread-transfer-design.md` §5.1。

/// 低于此大小不分段，走单流顺序传输。
pub const SEGMENT_THRESHOLD: u64 = 8 * 1024 * 1024;
/// 最大段数。
pub const SEGMENTS: u64 = 4;
/// 每段最小长度，限制小文件段数膨胀。
pub const MIN_SEG_SIZE: u64 = 1 * 1024 * 1024;
/// 单次 SFTP read/write 长度，规避服务端 read-len 上限。
pub const CHUNK: usize = 32 * 1024;

/// 把 `total` 字节切成若干 `(offset, len)` 段。
///
/// 规则（设计文档 §5.1）：
/// - 有效段数 `n = min(SEGMENTS, ceil(total / MIN_SEG_SIZE))`，且至少为 1；
/// - 段长 `total / n`，最后一段吃掉余数；
/// - 约定 `total == 0` 时返回单段 `(0, 0)`。
///
/// 保证：各段长度之和等于 `total`，相邻段首尾相接（无重叠、无空洞），段数 ≤ `SEGMENTS`。
pub fn plan_segments(total: u64) -> Vec<(u64, u64)> {
    // 待实现：真实分段逻辑见后续 feat 提交。
    let _ = total;
    Vec::new()
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
