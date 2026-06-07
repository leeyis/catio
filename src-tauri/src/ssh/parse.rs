//! SFTP 列表项 + 纯函数格式化（人类可读字节）。
//! Also: pure monitor-output parsers for cpu/mem/net/disk/procs/gpu (Task D1).
use serde::Serialize;

// ────────────────────────────────────────────────
// SFTP types (unchanged)
// ────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpItem {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String, // "dir" | "file"
    pub size: Option<String>,
    #[serde(rename = "mod")]
    pub modified: Option<String>,
}

/// 人类可读字节：1536 → "1.5 KB"
pub fn human_size(bytes: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, U[0])
    } else {
        format!("{:.1} {}", v, U[i])
    }
}

// ────────────────────────────────────────────────
// Monitor types (Task D1)
// ────────────────────────────────────────────────

/// Mirrors frontend `Proc` interface. serde camelCase matches TS field names.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub cmd: String,
    pub cpu: f64,
    pub mem: f64,
}

/// Mirrors frontend `Gpu` interface.
/// `memUsed` / `memTotal` are stored as GB (integer rounded from MiB / 1024).
/// `util` is a sparkline history; the single-sample parser sets `util = vec![util_now]`.
/// D2 will maintain the rolling window and replace `util` before emitting.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub idx: u32,
    pub name: String,
    /// Rolling utilisation history (%).  Single-sample: `vec![util_now]`.
    pub util: Vec<u32>,
    /// Most-recent utilisation sample (%).
    pub util_now: u32,
    /// Used VRAM in GB (rounded from MiB).
    pub mem_used: u32,
    /// Total VRAM in GB (rounded from MiB).
    pub mem_total: u32,
    /// GPU temperature (°C).
    pub temp: u32,
    /// Power draw (W, rounded).
    pub power: u32,
    /// Power cap / limit (W, rounded).
    pub power_cap: u32,
    /// Fan speed (%).
    pub fan: u32,
    /// Per-process info string (filled by D2; empty at parse time).
    pub procs: String,
}

// ────────────────────────────────────────────────
// Helper: parse the aggregate `cpu` line from /proc/stat
// ────────────────────────────────────────────────

/// Extract (total_jiffies, idle_jiffies) from the first `cpu ` line of /proc/stat.
fn stat_totals(stat: &str) -> (u64, u64) {
    for line in stat.lines() {
        // Match "cpu " (aggregate line, not "cpu0", "cpu1", …)
        if line.starts_with("cpu ") {
            let fields: Vec<u64> = line
                .split_whitespace()
                .skip(1) // skip "cpu" label
                .filter_map(|s| s.parse().ok())
                .collect();
            // /proc/stat columns: user nice system idle iowait irq softirq steal guest guest_nice
            let idle = fields.get(3).copied().unwrap_or(0)
                + fields.get(4).copied().unwrap_or(0); // idle + iowait
            let total: u64 = fields.iter().sum();
            return (total, idle);
        }
    }
    (0, 0)
}

// ────────────────────────────────────────────────
// 1. CPU % — two /proc/stat samples
// ────────────────────────────────────────────────

/// Returns CPU utilisation % (0.0–100.0) computed from two /proc/stat snapshots.
/// Returns 0.0 if the denominator is ≤ 0 (identical samples or malformed input).
pub fn parse_cpu_pct(prev: &str, now: &str) -> f64 {
    let (total_p, idle_p) = stat_totals(prev);
    let (total_n, idle_n) = stat_totals(now);
    let d_total = total_n.saturating_sub(total_p) as f64;
    let d_idle = idle_n.saturating_sub(idle_p) as f64;
    if d_total <= 0.0 {
        return 0.0;
    }
    let pct = 100.0 * (d_total - d_idle) / d_total;
    (pct * 10.0).round() / 10.0
}

/// Count logical CPU cores from /proc/stat (lines matching `cpu0`, `cpu1`, …).
pub fn parse_cpu_cores(stat: &str) -> usize {
    stat.lines()
        .filter(|l| {
            // Starts with "cpu" followed by at least one digit
            l.starts_with("cpu")
                && l.len() > 3
                && l.as_bytes().get(3).map_or(false, |b| b.is_ascii_digit())
        })
        .count()
}

// ────────────────────────────────────────────────
// 2. Memory — /proc/meminfo
// ────────────────────────────────────────────────

/// Parse /proc/meminfo.
/// Returns `(used_pct, total_str, used_str)`.
/// `used = MemTotal - MemAvailable`.  Strings are human-readable (e.g. "15.6 GB").
pub fn parse_mem(meminfo: &str) -> (f64, String, String) {
    let mut total_kb: u64 = 0;
    let mut avail_kb: u64 = 0;

    for line in meminfo.lines() {
        if line.starts_with("MemTotal:") {
            total_kb = line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if line.starts_with("MemAvailable:") {
            avail_kb = line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
    }

    if total_kb == 0 {
        return (0.0, "0 B".to_string(), "0 B".to_string());
    }

    let used_kb = total_kb.saturating_sub(avail_kb);
    let pct = 100.0 * used_kb as f64 / total_kb as f64;
    let pct = (pct * 10.0).round() / 10.0;

    let total_str = human_size(total_kb * 1024);
    let used_str = human_size(used_kb * 1024);

    (pct, total_str, used_str)
}

// ────────────────────────────────────────────────
// 3. Network throughput — two /proc/net/dev samples
// ────────────────────────────────────────────────

/// Sum rx+tx bytes across all non-loopback interfaces from one /proc/net/dev snapshot.
fn net_total_bytes(dev: &str) -> u64 {
    let mut total: u64 = 0;
    for line in dev.lines() {
        let trimmed = line.trim();
        // Lines look like: "  eth0:  123456  ..."
        // Skip header lines (no colon, or colon not followed by numeric data)
        let colon_pos = match trimmed.find(':') {
            Some(p) => p,
            None => continue,
        };
        let iface = trimmed[..colon_pos].trim();
        if iface == "lo" {
            continue;
        }
        let rest = trimmed[colon_pos + 1..].trim();
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        // /proc/net/dev columns after iface: rx_bytes rx_packets ... (8 rx fields) tx_bytes tx_packets ...
        let rx = fields.get(0).copied().unwrap_or(0);
        let tx = fields.get(8).copied().unwrap_or(0);
        total += rx + tx;
    }
    total
}

/// Returns combined rx+tx throughput in MB/s across all non-loopback interfaces.
/// Returns 0.0 if `secs` ≤ 0 or input is malformed.
pub fn parse_net_mbps(prev: &str, now: &str, secs: f64) -> f64 {
    if secs <= 0.0 {
        return 0.0;
    }
    let bytes_prev = net_total_bytes(prev);
    let bytes_now = net_total_bytes(now);
    let delta = bytes_now.saturating_sub(bytes_prev) as f64;
    let mbps = delta / secs / (1024.0 * 1024.0);
    (mbps * 10.0).round() / 10.0
}

// ────────────────────────────────────────────────
// 4. Disk % — df -P output
// ────────────────────────────────────────────────

/// Parse `df -P` output and return the use% of the `/` filesystem.
/// Looks for the row whose mountpoint (last whitespace-separated token) is exactly `/`.
/// The capacity column is formatted as `73%`; we strip the `%` and parse.
/// Returns 0 on parse failure.
pub fn parse_disk_pct(df_out: &str) -> u8 {
    for line in df_out.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // POSIX df -P: Filesystem Blocks Used Available Capacity Mounted-on  (6 cols)
        if fields.len() < 6 {
            continue;
        }
        let mountpoint = fields[fields.len() - 1];
        if mountpoint != "/" {
            continue;
        }
        let cap = fields[fields.len() - 2]; // e.g. "73%"
        return cap.trim_end_matches('%').parse().unwrap_or(0);
    }
    0
}

// ────────────────────────────────────────────────
// 5. Processes — ps -eo pid,comm,%cpu,%mem --sort=-%cpu
// ────────────────────────────────────────────────

/// Parse `ps -eo pid,comm,%cpu,%mem --sort=-%cpu` output.
/// Skips the header line; returns up to `limit` entries ordered by descending CPU.
pub fn parse_procs(ps_out: &str, limit: usize) -> Vec<Proc> {
    let mut result = Vec::new();
    let mut lines = ps_out.lines();
    // Skip header
    lines.next();
    for line in lines {
        if result.len() >= limit {
            break;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let pid: u32 = match fields[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let cmd = fields[1].to_string();
        let cpu: f64 = fields[2].parse().unwrap_or(0.0);
        let mem: f64 = fields[3].parse().unwrap_or(0.0);
        result.push(Proc { pid, cmd, cpu, mem });
    }
    result
}

// ────────────────────────────────────────────────
// 6. GPUs — nvidia-smi CSV
// ────────────────────────────────────────────────

/// Parse `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,
/// temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits`.
///
/// MiB→GB conversion: `(mib as f64 / 1024.0).round() as u32` (integer GB).
/// Returns empty vec if input is empty or all lines fail to parse.
pub fn parse_gpus(csv: &str) -> Vec<Gpu> {
    let mut result = Vec::new();
    for line in csv.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 9 {
            continue;
        }
        let idx: u32 = fields[0].trim().parse().unwrap_or(u32::MAX);
        if idx == u32::MAX {
            // Likely a header or error row; skip
            continue;
        }
        let name = fields[1].trim().to_string();
        let util_now: u32 = fields[2].trim().parse().unwrap_or(0);
        let mem_used_mib: f64 = fields[3].trim().parse().unwrap_or(0.0);
        let mem_total_mib: f64 = fields[4].trim().parse().unwrap_or(0.0);
        let temp: u32 = fields[5].trim().parse().unwrap_or(0);
        let power: u32 = fields[6].trim().parse::<f64>().unwrap_or(0.0).round() as u32;
        let power_cap: u32 = fields[7].trim().parse::<f64>().unwrap_or(0.0).round() as u32;
        let fan: u32 = fields[8].trim().parse().unwrap_or(0);

        // Convert MiB → GB (integer, rounded)
        let mem_used = (mem_used_mib / 1024.0).round() as u32;
        let mem_total = (mem_total_mib / 1024.0).round() as u32;

        result.push(Gpu {
            idx,
            name,
            util: vec![util_now],
            util_now,
            mem_used,
            mem_total,
            temp,
            power,
            power_cap,
            fan,
            procs: String::new(),
        });
    }
    result
}

// ────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── human_size (pre-existing) ──────────────────
    #[test]
    fn human_size_formats() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MB");
    }

    // ── parse_cpu_pct ─────────────────────────────
    #[test]
    fn cpu_pct_fifty_percent() {
        // Craft two /proc/stat snapshots where busy advances by 50 jiffies out of 100 total.
        // Fields: user nice system idle iowait irq softirq steal
        // prev: total=1000, idle+iowait=500  (50% busy so far — absolute values don't matter)
        // now:  total=1100, idle+iowait=550  → Δtotal=100, Δidle=50 → 50%
        let prev = "cpu  400 0 100 450 50 0 0 0\ncpu0 200 0 50 225 25 0 0 0\ncpu1 200 0 50 225 25 0 0 0\n";
        let now  = "cpu  450 0 110 490 60 0 0 0\ncpu0 225 0 55 245 30 0 0 0\ncpu1 225 0 55 245 30 0 0 0\n";
        // Δtotal = (450+110+490+60) - (400+100+450+50) = 1110 - 1000 = 110
        // Δidle  = (490+60) - (450+50) = 550 - 500 = 50
        // pct = 100 * (110-50)/110 = 100*60/110 ≈ 54.5%
        let pct = parse_cpu_pct(prev, now);
        assert!((pct - 54.5).abs() < 0.2, "expected ~54.5%, got {}", pct);
    }

    #[test]
    fn cpu_pct_zero_on_identical_samples() {
        let stat = "cpu  400 0 100 500 0 0 0 0\n";
        assert_eq!(parse_cpu_pct(stat, stat), 0.0);
    }

    #[test]
    fn cpu_pct_malformed_returns_zero() {
        assert_eq!(parse_cpu_pct("garbage\n", "more garbage\n"), 0.0);
    }

    // ── parse_cpu_cores ───────────────────────────
    #[test]
    fn cpu_cores_counts_numbered_lines() {
        let stat = "cpu  400 0 100 500 0 0 0 0\ncpu0 200 0 50 250 0 0 0 0\ncpu1 200 0 50 250 0 0 0 0\ncpu2 200 0 50 250 0 0 0 0\ncpu3 200 0 50 250 0 0 0 0\n";
        assert_eq!(parse_cpu_cores(stat), 4);
    }

    #[test]
    fn cpu_cores_zero_if_no_numbered_lines() {
        let stat = "cpu  400 0 100 500 0 0 0 0\n";
        assert_eq!(parse_cpu_cores(stat), 0);
    }

    // ── parse_mem ─────────────────────────────────
    #[test]
    fn mem_fifty_percent() {
        let meminfo = "MemTotal:       16384000 kB\nMemFree:         4096000 kB\nMemAvailable:    8192000 kB\nBuffers:          512000 kB\n";
        let (pct, total_str, used_str) = parse_mem(meminfo);
        assert!((pct - 50.0).abs() < 0.2, "expected ~50%, got {}", pct);
        // total = 16384000 kB = 16384000 * 1024 bytes = 16 GiB
        assert_eq!(total_str, human_size(16384000u64 * 1024));
        // used = 16384000 - 8192000 = 8192000 kB = 8 GiB
        assert_eq!(used_str, human_size(8192000u64 * 1024));
    }

    #[test]
    fn mem_zero_on_missing_fields() {
        let (pct, total_str, _) = parse_mem("SomeOtherField: 1234 kB\n");
        assert_eq!(pct, 0.0);
        assert_eq!(total_str, "0 B");
    }

    // ── parse_net_mbps ────────────────────────────
    #[test]
    fn net_mbps_known_delta() {
        // eth0: rx_bytes=0, tx_bytes=0 in prev; rx=1048576, tx=1048576 in now
        // Total delta = 2 MiB over 1 second → 2.0 MB/s
        let prev = "Inter-|   Receive                                                |  Transmit\n \
                     face |bytes    packets errs drop fifo frame compressed multicast|\
                     bytes    packets errs drop fifo colls carrier compressed\n \
                     lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n \
                     eth0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n";
        let now  = "Inter-|   Receive                                                |  Transmit\n \
                     face |bytes    packets errs drop fifo frame compressed multicast|\
                     bytes    packets errs drop fifo colls carrier compressed\n \
                     lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n \
                     eth0: 1048576       0    0    0    0     0          0         0  1048576       0    0    0    0     0       0          0\n";
        let mbps = parse_net_mbps(prev, now, 1.0);
        assert!((mbps - 2.0).abs() < 0.05, "expected 2.0 MB/s, got {}", mbps);
    }

    #[test]
    fn net_mbps_ignores_loopback() {
        // Only lo has bytes; result should be 0
        let prev = "Inter-|...\n face|...\n lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n";
        let now  = "Inter-|...\n face|...\n lo: 1048576       0    0    0    0     0          0         0  1048576       0    0    0    0     0       0          0\n";
        assert_eq!(parse_net_mbps(prev, now, 1.0), 0.0);
    }

    #[test]
    fn net_mbps_zero_on_non_positive_secs() {
        let s = "eth0:  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0\n";
        assert_eq!(parse_net_mbps(s, s, 0.0), 0.0);
        assert_eq!(parse_net_mbps(s, s, -1.0), 0.0);
    }

    // ── parse_disk_pct ────────────────────────────
    #[test]
    fn disk_pct_root_filesystem() {
        let df = "Filesystem      1024-blocks      Used Available Capacity Mounted on\n\
                  /dev/sda1            102400     75000     27000      73%          /\n";
        assert_eq!(parse_disk_pct(df), 73);
    }

    #[test]
    fn disk_pct_ignores_non_root_mounts() {
        let df = "Filesystem      1024-blocks      Used Available Capacity Mounted on\n\
                  /dev/sdb1            102400     10000     92000      10%  /data\n\
                  /dev/sda1            102400     75000     27000      73%     /\n";
        assert_eq!(parse_disk_pct(df), 73);
    }

    #[test]
    fn disk_pct_zero_when_no_root() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                  /dev/sdb1   100  10  90  10% /data\n";
        assert_eq!(parse_disk_pct(df), 0);
    }

    // ── parse_procs ───────────────────────────────
    #[test]
    fn procs_parses_rows_and_respects_limit() {
        let ps = "  PID COMM         %CPU %MEM\n\
                   1234 firefox      45.2  3.1\n\
                    567 code          8.5  2.0\n\
                     89 bash          0.1  0.1\n";
        let procs = parse_procs(ps, 2);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].cmd, "firefox");
        assert!((procs[0].cpu - 45.2).abs() < 0.01);
        assert!((procs[0].mem - 3.1).abs() < 0.01);
        assert_eq!(procs[1].pid, 567);
    }

    #[test]
    fn procs_empty_on_header_only() {
        let ps = "  PID COMM %CPU %MEM\n";
        assert_eq!(parse_procs(ps, 10), vec![]);
    }

    #[test]
    fn procs_skips_malformed_lines() {
        let ps = "  PID COMM %CPU %MEM\n\
                   not_a_pid proc 1.0 0.5\n\
                   999 valid 2.0 1.0\n";
        let procs = parse_procs(ps, 10);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, 999);
    }

    // ── parse_gpus ────────────────────────────────
    #[test]
    fn gpu_parses_single_card() {
        let csv = "0, NVIDIA GeForce RTX 4090, 45, 8192, 24564, 62, 210.5, 450.0, 55\n";
        let gpus = parse_gpus(csv);
        assert_eq!(gpus.len(), 1);
        let g = &gpus[0];
        assert_eq!(g.idx, 0);
        assert_eq!(g.name, "NVIDIA GeForce RTX 4090");
        assert_eq!(g.util_now, 45);
        assert_eq!(g.util, vec![45]);
        // 8192 MiB / 1024 = 8 GB
        assert_eq!(g.mem_used, 8);
        // 24564 MiB / 1024 ≈ 24 GB
        assert_eq!(g.mem_total, 24);
        assert_eq!(g.temp, 62);
        assert_eq!(g.power, 211); // 210.5 rounded
        assert_eq!(g.power_cap, 450);
        assert_eq!(g.fan, 55);
        assert_eq!(g.procs, "");
    }

    #[test]
    fn gpu_parses_two_cards() {
        let csv = "0, NVIDIA A100, 80, 40960, 81920, 70, 300.0, 400.0, 40\n\
                   1, NVIDIA RTX 3090, 20, 4096, 24576, 45, 120.0, 350.0, 30\n";
        let gpus = parse_gpus(csv);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].idx, 0);
        assert_eq!(gpus[1].idx, 1);
        assert_eq!(gpus[0].mem_total, 80); // 81920/1024 = 80
        assert_eq!(gpus[1].mem_total, 24); // 24576/1024 = 24
    }

    #[test]
    fn gpu_empty_on_empty_input() {
        assert_eq!(parse_gpus(""), vec![]);
        assert_eq!(parse_gpus("\n\n"), vec![]);
    }

    #[test]
    fn gpu_util_vec_matches_util_now() {
        let csv = "0, Tesla T4, 33, 2048, 16384, 50, 55.0, 70.0, 0\n";
        let gpus = parse_gpus(csv);
        assert_eq!(gpus[0].util, vec![gpus[0].util_now]);
    }
}
