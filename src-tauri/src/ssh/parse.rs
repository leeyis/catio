//! SFTP 列表项 + 纯函数格式化（人类可读字节）。
//! Also: pure monitor-output parsers for cpu/mem/net/disk/procs/gpu (Task D1).
use std::collections::{BTreeMap, BTreeSet};

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
#[derive(Serialize, Debug, PartialEq, Clone)]
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
    /// NVIDIA driver version reported by nvidia-smi (empty on older payloads).
    pub driver: String,
}

/// Static and slowly-changing host metadata shown in the monitor header.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub kernel: String,
    pub uptime_seconds: u64,
    pub process_count: usize,
}

/// CPU topology and the latest detailed utilisation breakdown.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub model: String,
    pub sockets: usize,
    pub physical_cores: usize,
    pub threads: usize,
    pub frequency_mhz: Option<f64>,
    pub l3_cache: String,
    pub temperature_c: Option<f64>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub user_pct: f64,
    pub system_pct: f64,
    pub iowait_pct: f64,
}

/// Human-readable memory and swap details. The legacy percentage history remains on `Monitor`.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total: String,
    pub used: String,
    pub available: String,
    pub cache: String,
    pub swap_total: String,
    pub swap_used: String,
    pub active: String,
    pub inactive: String,
    pub slab: String,
    pub dirty: String,
    pub writeback: String,
    pub pressure_some_pct: Option<f64>,
    pub pressure_full_pct: Option<f64>,
}

/// Latest aggregate network telemetry plus metadata for the busiest non-loopback interface.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub interface: String,
    pub interface_count: usize,
    pub rx_mbps: f64,
    pub tx_mbps: f64,
    pub link_speed_mbps: Option<u64>,
    pub duplex: String,
    pub ipv4: String,
    pub packets_per_second: f64,
    pub tcp_connections: usize,
    pub drops: u64,
    pub errors: u64,
}

/// One real filesystem row returned by `df`, including inode pressure when available.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub device: String,
    pub fs_type: String,
    pub mount: String,
    pub total: String,
    pub used: String,
    pub available: String,
    pub used_pct: u8,
    pub inode_pct: Option<u8>,
}

/// Aggregate physical block-device throughput from two `/proc/diskstats` snapshots.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskIo {
    pub read_mbps: f64,
    pub write_mbps: f64,
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
            let idle = fields.get(3).copied().unwrap_or(0) + fields.get(4).copied().unwrap_or(0); // idle + iowait
                                                                                                  // guest/guest_nice are already included in user/nice; summing them again inflates total.
            let total: u64 = fields.iter().take(8).sum();
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

/// Return `(user, system, iowait)` percentages from two aggregate `/proc/stat` samples.
/// The three values intentionally do not need to add up to the legacy total CPU percentage:
/// idle, steal and other kernel buckets remain visible through that total.
pub fn parse_cpu_breakdown(prev: &str, now: &str) -> (f64, f64, f64) {
    fn fields(stat: &str) -> Vec<u64> {
        stat.lines()
            .find(|line| line.starts_with("cpu "))
            .map(|line| {
                line.split_whitespace()
                    .skip(1)
                    .filter_map(|value| value.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    let before = fields(prev);
    let after = fields(now);
    // The first eight columns are the independent counters. guest/guest_nice duplicate user/nice.
    let width = before.len().max(after.len()).min(8);
    let delta = |index: usize| {
        after
            .get(index)
            .copied()
            .unwrap_or(0)
            .saturating_sub(before.get(index).copied().unwrap_or(0))
    };
    let total: u64 = (0..width).map(delta).sum();
    if total == 0 {
        return (0.0, 0.0, 0.0);
    }

    let pct = |value: u64| ((1000.0 * value as f64 / total as f64).round()) / 10.0;
    let user = delta(0).saturating_add(delta(1));
    let system = delta(2).saturating_add(delta(5)).saturating_add(delta(6));
    (pct(user), pct(system), pct(delta(4)))
}

/// Count logical CPU cores from /proc/stat (lines matching `cpu0`, `cpu1`, …).
pub fn parse_cpu_cores(stat: &str) -> usize {
    stat.lines()
        .filter(|l| {
            // Starts with "cpu" followed by at least one digit
            l.starts_with("cpu")
                && l.len() > 3
                && l.as_bytes().get(3).is_some_and(|b| b.is_ascii_digit())
        })
        .count()
}

// ────────────────────────────────────────────────
// 2. Memory — /proc/meminfo
// ────────────────────────────────────────────────

fn meminfo_kb(meminfo: &str, key: &str) -> u64 {
    meminfo
        .lines()
        .find(|line| line.starts_with(key))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn memory_pressure_avg10(input: &str, kind: &str) -> Option<f64> {
    input
        .lines()
        .map(str::trim)
        .find(|line| line.split_whitespace().next() == Some(kind))
        .and_then(|line| {
            line.split_whitespace()
                .find_map(|field| field.strip_prefix("avg10="))
        })
        .and_then(|value| value.parse().ok())
}

/// Parse the full memory/swap detail used by the dense monitor card.
pub fn parse_memory_info(meminfo: &str) -> MemoryInfo {
    let pressure = meminfo
        .split_once("__CATIO_MEMORY_PSI__")
        .map(|(_, pressure)| pressure)
        .unwrap_or("");
    let total_kb = meminfo_kb(meminfo, "MemTotal:");
    let available_kb = meminfo_kb(meminfo, "MemAvailable:");
    let used_kb = total_kb.saturating_sub(available_kb);
    let cache_kb = meminfo_kb(meminfo, "Cached:")
        .saturating_add(meminfo_kb(meminfo, "SReclaimable:"))
        .saturating_add(meminfo_kb(meminfo, "Buffers:"));
    let swap_total_kb = meminfo_kb(meminfo, "SwapTotal:");
    let swap_used_kb = swap_total_kb.saturating_sub(meminfo_kb(meminfo, "SwapFree:"));

    MemoryInfo {
        total: human_size(total_kb * 1024),
        used: human_size(used_kb * 1024),
        available: human_size(available_kb * 1024),
        cache: human_size(cache_kb * 1024),
        swap_total: human_size(swap_total_kb * 1024),
        swap_used: human_size(swap_used_kb * 1024),
        active: human_size(meminfo_kb(meminfo, "Active:") * 1024),
        inactive: human_size(meminfo_kb(meminfo, "Inactive:") * 1024),
        slab: human_size(meminfo_kb(meminfo, "Slab:") * 1024),
        dirty: human_size(meminfo_kb(meminfo, "Dirty:") * 1024),
        writeback: human_size(meminfo_kb(meminfo, "Writeback:") * 1024),
        pressure_some_pct: memory_pressure_avg10(pressure, "some"),
        pressure_full_pct: memory_pressure_avg10(pressure, "full"),
    }
}

/// Parse /proc/meminfo.
/// Returns `(used_pct, total_str, used_str)`.
/// `used = MemTotal - MemAvailable`. Strings are human-readable (e.g. "15.6 GB").
pub fn parse_mem(meminfo: &str) -> (f64, String, String) {
    let total_kb = meminfo_kb(meminfo, "MemTotal:");
    let available_kb = meminfo_kb(meminfo, "MemAvailable:");
    if total_kb == 0 {
        return (0.0, "0 B".to_string(), "0 B".to_string());
    }

    let used_kb = total_kb.saturating_sub(available_kb);
    let pct = ((1000.0 * used_kb as f64 / total_kb as f64).round()) / 10.0;
    (pct, human_size(total_kb * 1024), human_size(used_kb * 1024))
}

// ────────────────────────────────────────────────
// 3. Network throughput — two /proc/net/dev samples
// ────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
struct NetCounters {
    rx_bytes: u64,
    rx_packets: u64,
    rx_errors: u64,
    rx_drops: u64,
    tx_bytes: u64,
    tx_packets: u64,
    tx_errors: u64,
    tx_drops: u64,
}

fn parse_net_devices(dev: &str) -> BTreeMap<String, NetCounters> {
    let mut interfaces = BTreeMap::new();
    for line in dev.lines() {
        let trimmed = line.trim();
        let Some(colon_pos) = trimmed.find(':') else {
            continue;
        };
        let interface = trimmed[..colon_pos].trim();
        if interface == "lo" || interface.is_empty() {
            continue;
        }
        let fields: Vec<u64> = trimmed[colon_pos + 1..]
            .split_whitespace()
            .filter_map(|value| value.parse().ok())
            .collect();
        if fields.len() < 12 {
            continue;
        }
        interfaces.insert(
            interface.to_string(),
            NetCounters {
                rx_bytes: fields[0],
                rx_packets: fields[1],
                rx_errors: fields[2],
                rx_drops: fields[3],
                tx_bytes: fields[8],
                tx_packets: fields[9],
                tx_errors: fields[10],
                tx_drops: fields[11],
            },
        );
    }
    interfaces
}

#[derive(Default)]
struct NetMeta {
    speed_mbps: Option<u64>,
    duplex: String,
    ipv4: String,
}

fn parse_net_metadata(metadata: &str) -> (BTreeMap<String, NetMeta>, usize) {
    let mut interfaces = BTreeMap::new();
    let mut tcp_connections = 0;
    for line in metadata
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line.strip_prefix("__CATIO_TCP__|") {
            tcp_connections = value.trim().parse().unwrap_or(0);
            continue;
        }
        let mut fields = line.splitn(4, '|');
        let Some(interface) = fields.next() else {
            continue;
        };
        if interface.is_empty() || interface == "lo" {
            continue;
        }
        let speed_mbps = fields
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value > 0)
            .map(|value| value as u64);
        let duplex = fields.next().unwrap_or_default().trim().to_string();
        let ipv4 = fields.next().unwrap_or_default().trim().to_string();
        interfaces.insert(
            interface.to_string(),
            NetMeta {
                speed_mbps,
                duplex,
                ipv4,
            },
        );
    }
    (interfaces, tcp_connections)
}

fn round_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Parse separate receive/transmit speeds plus interface health from two `/proc/net/dev` samples.
pub fn parse_network_info(prev: &str, now: &str, secs: f64, metadata: &str) -> NetworkInfo {
    let before = parse_net_devices(prev);
    let after = parse_net_devices(now);
    let (meta, tcp_connections) = parse_net_metadata(metadata);
    let elapsed = if secs > 0.0 { secs } else { 1.0 };

    let mut rx_delta = 0_u64;
    let mut tx_delta = 0_u64;
    let mut packet_delta = 0_u64;
    let mut drops = 0_u64;
    let mut errors = 0_u64;
    let mut primary = String::new();
    let mut primary_delta = 0_u64;
    let mut primary_total = 0_u64;

    for (name, current) in &after {
        let previous = before.get(name).copied().unwrap_or_default();
        let interface_rx = current.rx_bytes.saturating_sub(previous.rx_bytes);
        let interface_tx = current.tx_bytes.saturating_sub(previous.tx_bytes);
        let interface_delta = interface_rx.saturating_add(interface_tx);
        let current_total = current.rx_bytes.saturating_add(current.tx_bytes);

        rx_delta = rx_delta.saturating_add(interface_rx);
        tx_delta = tx_delta.saturating_add(interface_tx);
        packet_delta = packet_delta
            .saturating_add(current.rx_packets.saturating_sub(previous.rx_packets))
            .saturating_add(current.tx_packets.saturating_sub(previous.tx_packets));
        drops = drops
            .saturating_add(current.rx_drops)
            .saturating_add(current.tx_drops);
        errors = errors
            .saturating_add(current.rx_errors)
            .saturating_add(current.tx_errors);

        if interface_delta > primary_delta || (primary_delta == 0 && current_total > primary_total)
        {
            primary = name.clone();
            primary_delta = interface_delta;
            primary_total = current_total;
        }
    }

    let selected_meta = meta.get(&primary);
    NetworkInfo {
        interface: primary,
        interface_count: after.len(),
        rx_mbps: if secs > 0.0 {
            round_two(rx_delta as f64 / elapsed / (1024.0 * 1024.0))
        } else {
            0.0
        },
        tx_mbps: if secs > 0.0 {
            round_two(tx_delta as f64 / elapsed / (1024.0 * 1024.0))
        } else {
            0.0
        },
        link_speed_mbps: selected_meta.and_then(|value| value.speed_mbps),
        duplex: selected_meta
            .map(|value| value.duplex.clone())
            .unwrap_or_default(),
        ipv4: selected_meta
            .map(|value| value.ipv4.clone())
            .unwrap_or_default(),
        packets_per_second: if secs > 0.0 {
            round_two(packet_delta as f64 / elapsed)
        } else {
            0.0
        },
        tcp_connections,
        drops,
        errors,
    }
}

/// Returns combined rx+tx throughput in MB/s across all non-loopback interfaces.
/// Kept for backwards compatibility with the original monitor payload.
pub fn parse_net_mbps(prev: &str, now: &str, secs: f64) -> f64 {
    let network = parse_network_info(prev, now, secs, "");
    ((network.rx_mbps + network.tx_mbps) * 10.0).round() / 10.0
}

// ────────────────────────────────────────────────
// 4. Disk % — df -P output
// ────────────────────────────────────────────────

fn is_pseudo_filesystem(fs_type: &str) -> bool {
    matches!(
        fs_type,
        "tmpfs"
            | "devtmpfs"
            | "squashfs"
            | "proc"
            | "sysfs"
            | "cgroup"
            | "cgroup2"
            | "tracefs"
            | "debugfs"
            | "securityfs"
            | "pstore"
            | "efivarfs"
            | "mqueue"
            | "hugetlbfs"
            | "fusectl"
            | "configfs"
    )
}

/// Docker/Podman overlay layers repeat backing-disk capacity for every container. Keep `/` when
/// the SSH target itself is a container, but hide its internal non-root layer mounts.
fn is_container_overlay_mount(device: &str, fs_type: &str, mount: &str) -> bool {
    mount != "/"
        && (matches!(fs_type, "overlay" | "fuse.overlayfs" | "fuse-overlayfs")
            || (fs_type.is_empty() && matches!(device, "overlay" | "fuse-overlayfs")))
}

fn parse_inode_usage(inode_output: &str) -> BTreeMap<String, u8> {
    let mut usages = BTreeMap::new();
    for line in inode_output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 || fields[0] == "Filesystem" {
            continue;
        }
        let mount = fields[5..].join(" ");
        let pct = fields[4].trim_end_matches('%').parse().ok();
        if let Some(pct) = pct {
            usages.insert(mount, pct);
        }
    }
    usages
}

/// Parse all real filesystem rows from a combined `df -PT` + `df -Pi` response.
pub fn parse_disks(df_out: &str) -> Vec<DiskUsage> {
    let (capacity_output, inode_output) = df_out
        .split_once("__CATIO_INODES__")
        .unwrap_or((df_out, ""));
    let inode_usage = parse_inode_usage(inode_output);
    let mut disks = Vec::new();
    let mut seen_mounts = BTreeSet::new();

    for line in capacity_output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 || fields[0] == "Filesystem" {
            continue;
        }

        // GNU `df -PT` includes a filesystem type column. The fallback `df -P` does not.
        let has_type = fields
            .get(1)
            .is_some_and(|value| value.parse::<u64>().is_err());
        let (fs_type, total_idx, used_idx, available_idx, pct_idx, mount_idx) = if has_type {
            if fields.len() < 7 {
                continue;
            }
            (fields[1], 2, 3, 4, 5, 6)
        } else {
            ("", 1, 2, 3, 4, 5)
        };
        let mount = fields[mount_idx..].join(" ");
        if is_pseudo_filesystem(fs_type)
            || is_container_overlay_mount(fields[0], fs_type, &mount)
            || mount.is_empty()
            || !seen_mounts.insert(mount.clone())
        {
            continue;
        }
        let total_kb: u64 = fields[total_idx].parse().unwrap_or(0);
        let used_kb: u64 = fields[used_idx].parse().unwrap_or(0);
        let available_kb: u64 = fields[available_idx].parse().unwrap_or(0);
        let used_pct = fields[pct_idx].trim_end_matches('%').parse().unwrap_or(0);

        disks.push(DiskUsage {
            device: fields[0].to_string(),
            fs_type: fs_type.to_string(),
            mount: mount.clone(),
            total: human_size(total_kb * 1024),
            used: human_size(used_kb * 1024),
            available: human_size(available_kb * 1024),
            used_pct,
            inode_pct: inode_usage.get(&mount).copied(),
        });
    }

    disks.sort_by(|left, right| {
        let left_root = left.mount == "/";
        let right_root = right.mount == "/";
        right_root
            .cmp(&left_root)
            .then_with(|| left.mount.cmp(&right.mount))
    });
    disks
}

/// Parse the legacy root-filesystem summary from the richer multi-filesystem response.
pub fn parse_disk(df_out: &str) -> (u8, String, String) {
    parse_disks(df_out)
        .into_iter()
        .find(|disk| disk.mount == "/")
        .map(|disk| (disk.used_pct, disk.total, disk.used))
        .unwrap_or_else(|| (0, "0 B".to_string(), "0 B".to_string()))
}

fn is_whole_disk(name: &str) -> bool {
    if ["sd", "vd", "xvd", "hd"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return name
            .chars()
            .last()
            .is_some_and(|value| value.is_ascii_alphabetic());
    }
    if name.starts_with("nvme") {
        return name.rsplit_once('n').is_some_and(|(_, suffix)| {
            !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
        });
    }
    if let Some(suffix) = name.strip_prefix("mmcblk") {
        return !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit());
    }
    false
}

fn diskstats_sectors(snapshot: &str) -> (u64, u64) {
    let mut read_sectors = 0_u64;
    let mut write_sectors = 0_u64;
    for line in snapshot.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || !is_whole_disk(fields[2]) {
            continue;
        }
        read_sectors = read_sectors.saturating_add(fields[5].parse().unwrap_or(0));
        write_sectors = write_sectors.saturating_add(fields[9].parse().unwrap_or(0));
    }
    (read_sectors, write_sectors)
}

/// Parse aggregate read/write throughput. Linux diskstats sectors are 512 bytes.
pub fn parse_disk_io(prev: &str, now: &str, secs: f64) -> DiskIo {
    if secs <= 0.0 {
        return DiskIo::default();
    }
    let (read_before, write_before) = diskstats_sectors(prev);
    let (read_after, write_after) = diskstats_sectors(now);
    let bytes_per_sector = 512.0;
    DiskIo {
        read_mbps: round_two(
            read_after.saturating_sub(read_before) as f64 * bytes_per_sector
                / secs
                / (1024.0 * 1024.0),
        ),
        write_mbps: round_two(
            write_after.saturating_sub(write_before) as f64 * bytes_per_sector
                / secs
                / (1024.0 * 1024.0),
        ),
    }
}

// ────────────────────────────────────────────────
// 5. Host and CPU metadata — tagged os-release/lscpu/proc output
// ────────────────────────────────────────────────

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_number(value: &str) -> Option<f64> {
    value
        .split_whitespace()
        .next()
        .and_then(|part| part.replace(',', "").parse().ok())
}

/// Parse the tagged host information command output. `threads` and `process_count` come from
/// already-collected `/proc/stat` and `ps`, so the metadata command stays small and portable.
pub fn parse_host_info(raw: &str, threads: usize, process_count: usize) -> (SystemInfo, CpuInfo) {
    let mut section = "";
    let mut os = String::new();
    let mut os_fallback = String::new();
    let mut kernel = String::new();
    let mut uptime_seconds = 0_u64;
    let mut load = [0.0_f64; 3];
    let mut model = String::new();
    let mut sockets = 0_usize;
    let mut cores_per_socket = 0_usize;
    let mut lscpu_threads = 0_usize;
    let mut frequency_mhz = None;
    let mut l3_cache = String::new();
    let mut fallback_model = String::new();
    let mut temperatures = Vec::new();

    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if line.starts_with("__CATIO_") {
            section = line;
            continue;
        }
        if line.is_empty() {
            continue;
        }

        match section {
            "__CATIO_OS__" => {
                if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
                    os = unquote(value);
                } else if let Some(value) = line.strip_prefix("NAME=") {
                    os_fallback = unquote(value);
                }
            }
            "__CATIO_KERNEL__" if kernel.is_empty() => kernel = line.to_string(),
            "__CATIO_UPTIME__" => {
                uptime_seconds = parse_number(line).unwrap_or(0.0).max(0.0) as u64;
            }
            "__CATIO_LOAD__" => {
                for (index, value) in line
                    .split_whitespace()
                    .take(3)
                    .filter_map(|value| value.parse().ok())
                    .enumerate()
                {
                    load[index] = value;
                }
            }
            "__CATIO_LSCPU__" => {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let value = value.trim();
                match key.trim() {
                    "Model name" => model = value.to_string(),
                    "Socket(s)" => sockets = value.parse().unwrap_or(0),
                    "Core(s) per socket" => cores_per_socket = value.parse().unwrap_or(0),
                    "CPU(s)" => lscpu_threads = value.parse().unwrap_or(0),
                    "CPU MHz" | "CPU max MHz" if frequency_mhz.is_none() => {
                        frequency_mhz = parse_number(value)
                    }
                    "L3 cache" => l3_cache = value.to_string(),
                    _ => {}
                }
            }
            "__CATIO_FREQ__" => {
                if let Some(khz) = parse_number(line) {
                    if khz > 0.0 {
                        frequency_mhz = Some(((khz / 1000.0) * 10.0).round() / 10.0);
                    }
                }
            }
            "__CATIO_CPU_FALLBACK__" => {
                if fallback_model.is_empty() {
                    fallback_model = line
                        .split_once(':')
                        .map(|(_, value)| value.trim())
                        .unwrap_or(line)
                        .to_string();
                }
            }
            "__CATIO_TEMP__" => {
                if let Some(mut value) = parse_number(line) {
                    if value > 1000.0 {
                        value /= 1000.0;
                    }
                    if (0.0..=150.0).contains(&value) {
                        temperatures.push(value);
                    }
                }
            }
            _ => {}
        }
    }

    if os.is_empty() {
        os = os_fallback;
    }
    if model.is_empty() {
        model = fallback_model;
    }
    let threads = if threads > 0 { threads } else { lscpu_threads };
    let physical_cores = if sockets > 0 && cores_per_socket > 0 {
        sockets.saturating_mul(cores_per_socket)
    } else {
        threads
    };
    let temperature_c = temperatures
        .into_iter()
        .reduce(f64::max)
        .map(|value| (value * 10.0).round() / 10.0);

    (
        SystemInfo {
            os,
            kernel,
            uptime_seconds,
            process_count,
        },
        CpuInfo {
            model,
            sockets,
            physical_cores,
            threads,
            frequency_mhz,
            l3_cache,
            temperature_c,
            load1: load[0],
            load5: load[1],
            load15: load[2],
            ..CpuInfo::default()
        },
    )
}

// ────────────────────────────────────────────────
// 6. Processes — ps -eo pid,comm,%cpu,%mem --sort=-%cpu
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

/// Count all non-empty process rows in the same `ps` response used for the Top list.
pub fn parse_process_count(ps_out: &str) -> usize {
    ps_out
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .count()
}

// ────────────────────────────────────────────────
// 7. GPUs — nvidia-smi CSV
// ────────────────────────────────────────────────

/// Parse `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,
/// temperature.gpu,power.draw,power.limit,fan.speed,driver_version
/// --format=csv,noheader,nounits`.
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
        let driver = fields
            .get(9)
            .map(|value| value.trim().to_string())
            .unwrap_or_default();

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
            driver,
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
        let prev =
            "cpu  400 0 100 450 50 0 0 0\ncpu0 200 0 50 225 25 0 0 0\ncpu1 200 0 50 225 25 0 0 0\n";
        let now =
            "cpu  450 0 110 490 60 0 0 0\ncpu0 225 0 55 245 30 0 0 0\ncpu1 225 0 55 245 30 0 0 0\n";
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

    #[test]
    fn cpu_pct_does_not_double_count_guest_time() {
        let prev = "cpu 100 0 0 100 0 0 0 0 50 0\n";
        let now = "cpu 200 0 0 200 0 0 0 0 100 0\n";
        assert_eq!(parse_cpu_pct(prev, now), 50.0);
    }

    #[test]
    fn cpu_breakdown_separates_user_system_and_iowait() {
        let prev = "cpu  100 10 20 500 5 2 3 0\n";
        let now = "cpu  140 20 40 520 15 4 8 0\n";
        let (user, system, iowait) = parse_cpu_breakdown(prev, now);
        // Total delta 107: user+nice 50, system+irq+softirq 27, iowait 10.
        assert!((user - 46.7).abs() < 0.2, "user {user}");
        assert!((system - 25.2).abs() < 0.2, "system {system}");
        assert!((iowait - 9.3).abs() < 0.2, "iowait {iowait}");
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

    #[test]
    fn memory_info_includes_operational_details_and_pressure() {
        let meminfo = "MemTotal: 8192000 kB\nMemAvailable: 4096000 kB\nBuffers: 1000 kB\nCached: 2000 kB\nSReclaimable: 500 kB\nSwapTotal: 2048000 kB\nSwapFree: 1536000 kB\nActive: 3072000 kB\nInactive: 1024000 kB\nSlab: 256000 kB\nDirty: 2048 kB\nWriteback: 512 kB\n__CATIO_MEMORY_PSI__\nsome avg10=0.18 avg60=0.12 avg300=0.08 total=1234\nfull avg10=0.03 avg60=0.01 avg300=0.00 total=456\n";
        let info = parse_memory_info(meminfo);
        assert_eq!(info.total, human_size(8192000 * 1024));
        assert_eq!(info.used, human_size(4096000 * 1024));
        assert_eq!(info.available, human_size(4096000 * 1024));
        assert_eq!(info.cache, human_size(3500 * 1024));
        assert_eq!(info.swap_used, human_size(512000 * 1024));
        assert_eq!(info.swap_total, human_size(2048000 * 1024));
        assert_eq!(info.active, human_size(3072000 * 1024));
        assert_eq!(info.inactive, human_size(1024000 * 1024));
        assert_eq!(info.slab, human_size(256000 * 1024));
        assert_eq!(info.dirty, human_size(2048 * 1024));
        assert_eq!(info.writeback, human_size(512 * 1024));
        assert_eq!(info.pressure_some_pct, Some(0.18));
        assert_eq!(info.pressure_full_pct, Some(0.03));
    }

    #[test]
    fn memory_info_tolerates_unavailable_pressure_metrics() {
        let info = parse_memory_info("MemTotal: 1024 kB\nMemAvailable: 512 kB\n");
        assert_eq!(info.pressure_some_pct, None);
        assert_eq!(info.pressure_full_pct, None);
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

    #[test]
    fn network_info_keeps_download_and_upload_separate() {
        let prev = "eth0: 0 100 1 2 0 0 0 0 0 200 3 4 0 0 0 0\n";
        let now = "eth0: 2097152 112 1 2 0 0 0 0 1048576 208 3 4 0 0 0 0\n";
        let info = parse_network_info(
            prev,
            now,
            2.0,
            "eth0|1000|full|192.168.1.8/24\n__CATIO_TCP__|23\n",
        );
        assert_eq!(info.interface, "eth0");
        assert_eq!(info.interface_count, 1);
        assert_eq!(info.rx_mbps, 1.0);
        assert_eq!(info.tx_mbps, 0.5);
        assert_eq!(info.link_speed_mbps, Some(1000));
        assert_eq!(info.duplex, "full");
        assert_eq!(info.ipv4, "192.168.1.8/24");
        assert_eq!(info.packets_per_second, 10.0);
        assert_eq!(info.tcp_connections, 23);
        assert_eq!(info.drops, 6);
        assert_eq!(info.errors, 4);
    }

    // ── parse_disk ────────────────────────────
    #[test]
    fn disk_root_filesystem_pct_and_sizes() {
        let df = "Filesystem      1024-blocks      Used Available Capacity Mounted on\n\
                  /dev/sda1            102400     75000     27000      73%          /\n";
        let (pct, total, used) = parse_disk(df);
        assert_eq!(pct, 73);
        assert_eq!(total, human_size(102400 * 1024)); // total blocks → bytes
        assert_eq!(used, human_size(75000 * 1024));
    }

    #[test]
    fn disks_include_real_mounts_and_inode_usage() {
        let df = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n\
                  /dev/sdb1 xfs 204800 51200 153600 25% /data\n\
                  /dev/sda1 ext4 102400 75000 27000 73% /\n\
                  tmpfs tmpfs 1000 1 999 1% /run\n\
                  __CATIO_INODES__\n\
                  Filesystem Inodes IUsed IFree IUse% Mounted on\n\
                  /dev/sda1 1000 120 880 12% /\n\
                  /dev/sdb1 2000 100 1900 5% /data\n";
        let disks = parse_disks(df);
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].fs_type, "ext4");
        assert_eq!(disks[0].used_pct, 73);
        assert_eq!(disks[0].inode_pct, Some(12));
        assert_eq!(disks[1].mount, "/data");
        assert_eq!(disks[1].inode_pct, Some(5));
        // Legacy root summary remains intact.
        assert_eq!(parse_disk(df).0, 73);
    }

    #[test]
    fn disks_exclude_container_overlay_mounts_but_keep_real_docker_storage() {
        let df = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n\
                  /dev/sda1 ext4 102400 75000 27000 73% /\n\
                  /dev/sdb1 xfs 204800 51200 153600 25% /var/lib/docker\n\
                  overlay overlay 102400 75000 27000 73% /var/lib/docker/overlay2/abc/merged\n\
                  overlay 102400 75000 27000 73% /var/lib/docker/overlay2/def/merged\n\
                  __CATIO_INODES__\n";

        let disks = parse_disks(df);
        let mounts: Vec<&str> = disks.iter().map(|disk| disk.mount.as_str()).collect();

        assert_eq!(mounts, vec!["/", "/var/lib/docker"]);
    }

    #[test]
    fn disks_keep_overlay_when_it_is_the_root_filesystem() {
        let df = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n\
                  overlay overlay 102400 75000 27000 73% /\n\
                  __CATIO_INODES__\n";

        let disks = parse_disks(df);

        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].fs_type, "overlay");
    }

    #[test]
    fn disk_zero_when_no_root() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                  /dev/sdb1   100  10  90  10% /data\n";
        let (pct, total, _) = parse_disk(df);
        assert_eq!(pct, 0);
        assert_eq!(total, "0 B");
    }

    #[test]
    fn disk_io_uses_separate_read_and_write_sector_deltas() {
        let prev = "8 0 sda 1 0 1000 0 1 0 2000 0 0 0 0\n8 1 sda1 1 0 900 0 1 0 1800 0 0 0 0\n";
        let now = "8 0 sda 1 0 5096 0 1 0 4048 0 0 0 0\n8 1 sda1 1 0 5000 0 1 0 4000 0 0 0 0\n";
        let io = parse_disk_io(prev, now, 2.0);
        // Whole disk only: 4096 sectors read = 2 MiB over 2s, 2048 written = 1 MiB over 2s.
        assert_eq!(io.read_mbps, 1.0);
        assert_eq!(io.write_mbps, 0.5);
    }

    #[test]
    fn host_info_parses_os_topology_load_frequency_and_temperature() {
        let raw = "__CATIO_OS__\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n__CATIO_KERNEL__\n6.8.0\n__CATIO_UPTIME__\n90061.4 0\n__CATIO_LOAD__\n1.20 0.80 0.40 1/100 1\n__CATIO_LSCPU__\nCPU(s): 32\nModel name: AMD EPYC 7543P\nSocket(s): 1\nCore(s) per socket: 16\nL3 cache: 256 MiB\n__CATIO_FREQ__\n2800000\n__CATIO_CPU_FALLBACK__\nmodel name : fallback\n__CATIO_TEMP__\n53000\n";
        let (system, cpu) = parse_host_info(raw, 32, 248);
        assert_eq!(system.os, "Ubuntu 24.04 LTS");
        assert_eq!(system.kernel, "6.8.0");
        assert_eq!(system.uptime_seconds, 90061);
        assert_eq!(system.process_count, 248);
        assert_eq!(cpu.model, "AMD EPYC 7543P");
        assert_eq!(cpu.sockets, 1);
        assert_eq!(cpu.physical_cores, 16);
        assert_eq!(cpu.threads, 32);
        assert_eq!(cpu.frequency_mhz, Some(2800.0));
        assert_eq!(cpu.l3_cache, "256 MiB");
        assert_eq!(cpu.temperature_c, Some(53.0));
        assert_eq!(cpu.load1, 1.2);
        assert_eq!(cpu.load5, 0.8);
        assert_eq!(cpu.load15, 0.4);
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
        assert_eq!(g.driver, "");
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

    #[test]
    fn gpu_parses_optional_driver_version() {
        let csv = "0, NVIDIA RTX 3090, 18, 4096, 24576, 48, 90.0, 350.0, 30, 550.54.15\n";
        assert_eq!(parse_gpus(csv)[0].driver, "550.54.15");
    }
}
