//! 无代理（agentless）系统监控：通过 SSH exec channel 跑标准命令
//! （`cat /proc/stat` 等），用 D1 的纯函数解析，组装 `Monitor`，并周期性地
//! 经 `monitor://{sessionId}` 事件发往前端；cpu/mem/net/rx/tx 维护滚动 sparkline 窗口。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use serde::Serialize;

use crate::events::EventSink;
use crate::ssh::conn::ClientHandler;
use crate::ssh::exec::run_cmd;
use crate::ssh::manager::SessionManager;
use crate::ssh::parse::{
    parse_cpu_breakdown, parse_cpu_cores, parse_cpu_pct, parse_disk, parse_disk_io, parse_disks,
    parse_gpus, parse_host_info, parse_mem, parse_memory_info, parse_net_mbps, parse_network_info,
    parse_process_count, parse_procs, CpuInfo, DiskIo, DiskUsage, Gpu, MemoryInfo, NetworkInfo,
    Proc, SystemInfo,
};
use crate::ssh::SshError;

/// 滚动窗口容量（cpu/mem/net/gpu util 各保留最近 N 个采样点）。
const WINDOW_CAP: usize = 60;
/// 进程列表上限。
const PROC_LIMIT: usize = 10;

// ────────────────────────────────────────────────
// Monitor 快照（serde camelCase 匹配前端 src/services/types.ts）
// ────────────────────────────────────────────────

/// 一次（或一段窗口的）监控快照。
/// `cpu`/`mem`/`net`/`net_rx`/`net_tx` 是 sparkline 历史；单次采样时为单元素向量，
/// 周期任务会替换为完整滚动窗口。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub host: String,
    pub cpu: Vec<f64>,
    pub mem: Vec<f64>,
    pub net: Vec<f64>,
    pub net_rx: Vec<f64>,
    pub net_tx: Vec<f64>,
    pub disk: u8,
    pub disk_total: String,
    pub disk_used: String,
    pub cores: usize,
    pub mem_total: String,
    pub mem_used: String,
    pub gpus: Vec<Gpu>,
    pub procs: Vec<Proc>,
    pub system: SystemInfo,
    pub cpu_info: CpuInfo,
    pub memory_info: MemoryInfo,
    pub network_info: NetworkInfo,
    pub disks: Vec<DiskUsage>,
    pub disk_io: DiskIo,
}

// ────────────────────────────────────────────────
// assemble_monitor —— 纯函数单次采样组装器（单元可测）
// ────────────────────────────────────────────────

/// 纯函数：用两次 /proc/stat、/proc/net/dev 快照与各 cat 输出组装一个单次采样
/// `Monitor`，其 cpu/mem/net 为单元素窗口。可用样本字符串单测。
#[allow(clippy::too_many_arguments)]
pub fn assemble_monitor(
    host: &str,
    stat_prev: &str,
    stat_now: &str,
    meminfo: &str,
    netdev_prev: &str,
    netdev_now: &str,
    secs: f64,
    df: &str,
    ps: &str,
    nvidia_csv: &str,
) -> Monitor {
    assemble_monitor_detailed(
        host,
        stat_prev,
        stat_now,
        meminfo,
        netdev_prev,
        netdev_now,
        secs,
        df,
        "",
        "",
        ps,
        nvidia_csv,
        "",
        "",
    )
}

/// Rich monitor assembler used by the live sampler. The original `assemble_monitor` remains as a
/// compatibility wrapper for existing callers and tests.
#[allow(clippy::too_many_arguments)]
pub fn assemble_monitor_detailed(
    host: &str,
    stat_prev: &str,
    stat_now: &str,
    meminfo: &str,
    netdev_prev: &str,
    netdev_now: &str,
    secs: f64,
    df: &str,
    diskstats_prev: &str,
    diskstats_now: &str,
    ps: &str,
    nvidia_csv: &str,
    host_info: &str,
    net_info: &str,
) -> Monitor {
    let cpu_pct = parse_cpu_pct(stat_prev, stat_now);
    let cores = parse_cpu_cores(stat_now);
    let (mem_pct, mem_total, mem_used) = parse_mem(meminfo);
    let memory_info = parse_memory_info(meminfo);
    let net_mbps = parse_net_mbps(netdev_prev, netdev_now, secs);
    let network_info = parse_network_info(netdev_prev, netdev_now, secs, net_info);
    let (disk, disk_total, disk_used) = parse_disk(df);
    let disks = parse_disks(df);
    let disk_io = parse_disk_io(diskstats_prev, diskstats_now, secs);
    let procs = parse_procs(ps, PROC_LIMIT);
    let process_count = parse_process_count(ps);
    let gpus = parse_gpus(nvidia_csv);
    let (system, mut cpu_info) = parse_host_info(host_info, cores, process_count);
    let (user_pct, system_pct, iowait_pct) = parse_cpu_breakdown(stat_prev, stat_now);
    cpu_info.user_pct = user_pct;
    cpu_info.system_pct = system_pct;
    cpu_info.iowait_pct = iowait_pct;

    Monitor {
        host: host.to_string(),
        cpu: vec![cpu_pct],
        mem: vec![mem_pct],
        net: vec![net_mbps],
        net_rx: vec![network_info.rx_mbps],
        net_tx: vec![network_info.tx_mbps],
        disk,
        disk_total,
        disk_used,
        cores,
        mem_total,
        mem_used,
        gpus,
        procs,
        system,
        cpu_info,
        memory_info,
        network_info,
        disks,
        disk_io,
    }
}

// ────────────────────────────────────────────────
// 3. sample —— 通过 SSH 采集一次（exec → 解析 → assemble）
// ────────────────────────────────────────────────

/// 监控所用的标准命令集（agentless）。
const CMD_STAT: &str = "cat /proc/stat";
const CMD_NETDEV: &str = "cat /proc/net/dev";
const CMD_DISKSTATS: &str = "cat /proc/diskstats";
const CMD_MEMINFO: &str = "cat /proc/meminfo";
const CMD_DF: &str = concat!(
    "{ df -PT -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -P 2>/dev/null; ",
    "printf '__CATIO_INODES__\\n'; ",
    "df -Pi -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || true; }"
);
const CMD_PS: &str = "ps -eo pid,comm,%cpu,%mem --sort=-%cpu";
const CMD_NVIDIA: &str = "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,driver_version --format=csv,noheader,nounits";
const CMD_HOSTINFO: &str = concat!(
    "printf '__CATIO_OS__\\n'; cat /etc/os-release 2>/dev/null; ",
    "printf '__CATIO_KERNEL__\\n'; uname -r 2>/dev/null; ",
    "printf '__CATIO_UPTIME__\\n'; cat /proc/uptime 2>/dev/null; ",
    "printf '__CATIO_LOAD__\\n'; cat /proc/loadavg 2>/dev/null; ",
    "printf '__CATIO_LSCPU__\\n'; LC_ALL=C lscpu 2>/dev/null; ",
    "printf '__CATIO_FREQ__\\n'; ",
    "cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null; ",
    "printf '__CATIO_CPU_FALLBACK__\\n'; ",
    "grep -m1 -E '^(model name|Hardware|Processor)' /proc/cpuinfo 2>/dev/null; ",
    "printf '__CATIO_TEMP__\\n'; ",
    "for f in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$f\" ] && cat \"$f\"; done"
);
const CMD_NETINFO: &str = concat!(
    "for p in /sys/class/net/*; do [ -d \"$p\" ] || continue; ",
    "i=${p##*/}; [ \"$i\" = lo ] && continue; ",
    "speed=$(cat \"$p/speed\" 2>/dev/null); ",
    "duplex=$(cat \"$p/duplex\" 2>/dev/null); ",
    "addr=$(ip -o -4 addr show dev \"$i\" scope global 2>/dev/null | awk 'NR==1 {print $4}'); ",
    "printf '%s|%s|%s|%s\\n' \"$i\" \"$speed\" \"$duplex\" \"$addr\"; ",
    "done; printf '__CATIO_TCP__|'; ",
    "awk 'FNR>1 {n++} END {print n+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null"
);

/// 通过 SSH 采集一次监控快照：
/// - 先取 `stat_prev` / `net_prev` / `diskstats_prev`；
/// - sleep `interval`；
/// - 再取动态快照与 meminfo/df/ps/host/network/nvidia 元数据；
/// - 调 `assemble_monitor_detailed`，`secs = interval` 的秒数。
///
/// nvidia 命令出错时（理论上 `run_cmd` 不会因退出码报错，仅 I/O 故障才报）
/// 用 `""` 兜底，使 `parse_gpus("")` → 空列表。
pub async fn sample(
    handle: &Handle<ClientHandler>,
    host: &str,
    interval: Duration,
) -> Result<Monitor, SshError> {
    let stat_prev = run_cmd(handle, CMD_STAT).await?;
    let net_prev = run_cmd(handle, CMD_NETDEV).await?;
    let diskstats_prev = run_cmd(handle, CMD_DISKSTATS).await.unwrap_or_default();

    tokio::time::sleep(interval).await;

    let stat_now = run_cmd(handle, CMD_STAT).await?;
    let net_now = run_cmd(handle, CMD_NETDEV).await?;
    let diskstats_now = run_cmd(handle, CMD_DISKSTATS).await.unwrap_or_default();
    let meminfo = run_cmd(handle, CMD_MEMINFO).await?;
    let df = run_cmd(handle, CMD_DF).await?;
    let ps = run_cmd(handle, CMD_PS).await?;
    let host_info = run_cmd(handle, CMD_HOSTINFO).await.unwrap_or_default();
    let net_info = run_cmd(handle, CMD_NETINFO).await.unwrap_or_default();
    // nvidia：无 GPU 时退出非零且无 stdout → run_cmd 返回 Ok("")；I/O 故障兜底为 ""。
    let nvidia = run_cmd(handle, CMD_NVIDIA).await.unwrap_or_default();

    let secs = interval.as_secs_f64();
    Ok(assemble_monitor_detailed(
        host,
        &stat_prev,
        &stat_now,
        &meminfo,
        &net_prev,
        &net_now,
        secs,
        &df,
        &diskstats_prev,
        &diskstats_now,
        &ps,
        &nvidia,
        &host_info,
        &net_info,
    ))
}

// ────────────────────────────────────────────────
// 4. 滚动窗口辅助
// ────────────────────────────────────────────────

/// 把 `v` 推入 `win`，超出容量则从头部弹出，并返回当前窗口的快照向量。
fn push_window<T: Clone>(win: &mut VecDeque<T>, v: T, cap: usize) -> Vec<T> {
    win.push_back(v);
    while win.len() > cap {
        win.pop_front();
    }
    win.iter().cloned().collect()
}

// ────────────────────────────────────────────────
// 5. Tauri 命令：monitor_start / monitor_stop
// ────────────────────────────────────────────────

/// 采一条监控命令。锁只覆盖 `channel_open_session`，命令执行/收流在锁外
/// （见 `ssh::exec::run_on_session`），`sleep(interval)` 本就在锁外——
/// 故监控任务不会阻塞同会话的 term/sftp/tunnel 操作。
async fn run_cmd_locked(
    sess: &tokio::sync::Mutex<crate::ssh::manager::Session>,
    cmd: &str,
) -> Result<String, SshError> {
    crate::ssh::exec::run_on_session(sess, cmd, None).await
}

/// 通过会话锁（每条命令单独加锁）采集一次监控快照。
/// `sleep(interval)` 在任何锁之外执行，不阻塞同会话其他操作。
async fn sample_locked(
    sess: &tokio::sync::Mutex<crate::ssh::manager::Session>,
    host: &str,
    interval: Duration,
) -> Result<Monitor, SshError> {
    let stat_prev = run_cmd_locked(sess, CMD_STAT).await?;
    let net_prev = run_cmd_locked(sess, CMD_NETDEV).await?;
    let diskstats_prev = run_cmd_locked(sess, CMD_DISKSTATS)
        .await
        .unwrap_or_default();

    // sleep 在锁外——其他操作（term/sftp/tunnel）可在此期间自由获取会话锁。
    tokio::time::sleep(interval).await;

    let stat_now = run_cmd_locked(sess, CMD_STAT).await?;
    let net_now = run_cmd_locked(sess, CMD_NETDEV).await?;
    let diskstats_now = run_cmd_locked(sess, CMD_DISKSTATS)
        .await
        .unwrap_or_default();
    let meminfo = run_cmd_locked(sess, CMD_MEMINFO).await?;
    let df = run_cmd_locked(sess, CMD_DF).await?;
    let ps = run_cmd_locked(sess, CMD_PS).await?;
    let host_info = run_cmd_locked(sess, CMD_HOSTINFO).await.unwrap_or_default();
    let net_info = run_cmd_locked(sess, CMD_NETINFO).await.unwrap_or_default();
    let nvidia = run_cmd_locked(sess, CMD_NVIDIA).await.unwrap_or_default();

    let secs = interval.as_secs_f64();
    Ok(assemble_monitor_detailed(
        host,
        &stat_prev,
        &stat_now,
        &meminfo,
        &net_prev,
        &net_now,
        secs,
        &df,
        &diskstats_prev,
        &diskstats_now,
        &ps,
        &nvidia,
        &host_info,
        &net_info,
    ))
}

/// 启动一个会话的周期监控任务。每 `interval_ms` 调一次 `sample_locked`，把新值压入
/// cpu/mem/net/rx/tx（及每个 gpu idx 的 util）滚动窗口（容量 60），用完整窗口构建
/// `Monitor` 后经 `monitor://{session_id}` 发出。任务的 AbortHandle 存入 manager。
/// 同一会话再次启动会先停掉旧任务。
///
/// 修复并发 bug：会话锁仅在每条 `run_cmd` 调用期间持有（微秒级），
/// `sleep(interval)` 在锁外执行，不再阻塞 term/sftp/tunnel 的锁等待。
#[tauri::command]
pub async fn monitor_start(
    session_id: String,
    interval_ms: u64,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    monitor_start_core(session_id, interval_ms, Arc::new(crate::events::TauriSink(app)), &mgr).await
}

/// Transport-agnostic monitor loop — emits `monitor://{sessionId}` frames through an `EventSink`
/// (Tauri bus on desktop, WebSocket hub on the web head). Shared so the sampling/window logic
/// isn't duplicated.
pub async fn monitor_start_core(
    session_id: String,
    interval_ms: u64,
    sink: Arc<dyn EventSink>,
    mgr: &SessionManager,
) -> Result<(), SshError> {
    let sess = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    let host = { sess.lock().await.host.clone() };

    let interval = Duration::from_millis(interval_ms.max(1));
    let evt = format!("monitor://{session_id}");
    let sid = session_id.clone();

    let task = tokio::spawn(async move {
        // 跨 tick 维护的滚动窗口。
        let mut cpu_win: VecDeque<f64> = VecDeque::new();
        let mut mem_win: VecDeque<f64> = VecDeque::new();
        let mut net_win: VecDeque<f64> = VecDeque::new();
        let mut net_rx_win: VecDeque<f64> = VecDeque::new();
        let mut net_tx_win: VecDeque<f64> = VecDeque::new();
        // 每个 gpu idx 一个 util 窗口。
        let mut gpu_wins: HashMap<u32, VecDeque<u32>> = HashMap::new();

        loop {
            // 使用 sample_locked：每条命令单独短暂加锁，sleep 在锁外，
            // 不阻塞同会话的 term_write/term_resize/sftp_*/tunnel 操作。
            let snap = sample_locked(&sess, &host, interval).await;
            let snap = match snap {
                Ok(m) => m,
                // 采样失败（会话断开等）：结束监控任务。
                Err(_) => break,
            };

            // 把单次采样值压入滚动窗口。
            let cpu = push_window(&mut cpu_win, *snap.cpu.first().unwrap_or(&0.0), WINDOW_CAP);
            let mem = push_window(&mut mem_win, *snap.mem.first().unwrap_or(&0.0), WINDOW_CAP);
            let net = push_window(&mut net_win, *snap.net.first().unwrap_or(&0.0), WINDOW_CAP);
            let net_rx = push_window(
                &mut net_rx_win,
                *snap.net_rx.first().unwrap_or(&0.0),
                WINDOW_CAP,
            );
            let net_tx = push_window(
                &mut net_tx_win,
                *snap.net_tx.first().unwrap_or(&0.0),
                WINDOW_CAP,
            );

            // 每个 gpu 的 util 也做窗口（按 idx）。
            let mut monitor = snap;
            let gpus: Vec<Gpu> = std::mem::take(&mut monitor.gpus)
                .into_iter()
                .map(|mut g| {
                    let win = gpu_wins.entry(g.idx).or_default();
                    g.util = push_window(win, g.util_now, WINDOW_CAP);
                    g
                })
                .collect();

            monitor.host = host.clone();
            monitor.cpu = cpu;
            monitor.mem = mem;
            monitor.net = net;
            monitor.net_rx = net_rx;
            monitor.net_tx = net_tx;
            monitor.gpus = gpus;

            sink.emit(
                &evt,
                serde_json::to_value(&monitor).unwrap_or(serde_json::Value::Null),
            );
        }
    });

    mgr.insert_monitor(sid, task.abort_handle()).await;
    Ok(())
}

/// 停止一个会话的周期监控任务（中止 + 移除）。
#[tauri::command]
pub async fn monitor_stop(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    mgr.remove_monitor(&session_id).await;
    Ok(())
}

// ────────────────────────────────────────────────
// 6. Tauri 命令：ssh_sysinfo
// ────────────────────────────────────────────────

/// 通过 SSH 一次性采集主机紧凑摘要（OS/时间/CPU/内存/磁盘/GPU），
/// 以纯文本返回给调用方（前端注入 Agent 系统提示词）。
///
/// 仅运行一条组合 shell 命令，复用 `run_cmd`；锁仅在 exec 期间持有。
/// 对非 Linux/Bash 主机，命令中各段可能无输出，但仍返回 Ok（内容可能为空或稀疏）。
#[tauri::command]
pub async fn ssh_sysinfo(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    ssh_sysinfo_core(session_id, &mgr).await
}

/// Transport-agnostic host summary — shared by the Tauri command and the web dispatch.
pub async fn ssh_sysinfo_core(session_id: String, mgr: &SessionManager) -> Result<String, SshError> {
    let sess = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    const SYSINFO_CMD: &str = concat!(
        "{ ",
        "echo '## OS'; ",
        "(cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION)='); ",
        "uname -srm; ",
        "echo '## Time'; ",
        "date '+%Y-%m-%d %H:%M:%S %Z (%z)'; ",
        "echo '## CPU'; ",
        "echo \"cores: $(nproc 2>/dev/null)\"; ",
        "(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-); ",
        "echo '## Memory'; ",
        "(free -h 2>/dev/null | awk 'NR==1||/^Mem:/'); ",
        "echo '## Disk'; ",
        "(df -h / 2>/dev/null | awk 'NR==1||NR==2'); ",
        "echo '## GPU'; ",
        "(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'none'); ",
        "}",
    );

    // 锁只覆盖开 channel；exec/收流在锁外（run_on_session）。
    let out = crate::ssh::exec::run_on_session(&sess, SYSINFO_CMD, None).await?;
    Ok(out.trim().to_string())
}

// ────────────────────────────────────────────────
// 7. Tauri 命令：ssh_detect_os
// ────────────────────────────────────────────────

/// 连接成功后探测远端 OS，归一化为前端 LOGO 映射认得的 id：
/// ubuntu/debian/alpine/centos/fedora/arch/rhel/macos/linux。
///
/// 优先读 /etc/os-release 的 ID；非 Linux 退到 `uname -s`（Darwin → macos）；
/// 其余发行版统一归到 `linux`（前端有通用 Tux LOGO）。仅一条 shell，复用 run_cmd。
#[tauri::command]
pub async fn ssh_detect_os(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    ssh_detect_os_core(session_id, &mgr).await
}

/// Transport-agnostic OS detection — shared by the Tauri command and the web dispatch.
pub async fn ssh_detect_os_core(session_id: String, mgr: &SessionManager) -> Result<String, SshError> {
    let sess = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    const DETECT_CMD: &str = concat!(
        "if [ -r /etc/os-release ]; then . /etc/os-release; id=\"${ID:-}\"; ",
        "case \"$id\" in ",
        "ubuntu|debian|alpine|centos|fedora|arch|rhel) printf '%s' \"$id\";; ",
        "redhat) printf 'rhel';; ",
        "*) printf 'linux';; ",
        "esac; ",
        "else u=$(uname -s 2>/dev/null); ",
        "case \"$u\" in Darwin) printf 'macos';; *) printf 'linux';; esac; ",
        "fi",
    );

    let out = crate::ssh::exec::run_on_session(&sess, DETECT_CMD, None).await?;
    Ok(out.trim().to_string())
}

// ────────────────────────────────────────────────
// 单元测试（assemble_monitor 纯函数）
// ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const STAT_PREV: &str = "cpu  400 0 100 450 50 0 0 0\ncpu0 200 0 50 225 25 0 0 0\ncpu1 200 0 50 225 25 0 0 0\n";
    const STAT_NOW: &str = "cpu  450 0 110 490 60 0 0 0\ncpu0 225 0 55 245 30 0 0 0\ncpu1 225 0 55 245 30 0 0 0\n";
    const MEMINFO: &str = "MemTotal:       16384000 kB\nMemFree:         4096000 kB\nMemAvailable:    8192000 kB\n";
    const NET_PREV: &str = "Inter-|...\n face|...\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
    const NET_NOW: &str = "Inter-|...\n face|...\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n eth0: 1048576 0 0 0 0 0 0 0 1048576 0 0 0 0 0 0 0\n";
    const DF: &str = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 102400 43000 59400 42% /\n";
    const PS: &str = "  PID COMM         %CPU %MEM\n 1234 firefox      45.2  3.1\n  567 code          8.5  2.0\n   89 bash          0.1  0.1\n";
    const HOST_INFO: &str = "__CATIO_OS__\nPRETTY_NAME=\"Debian GNU/Linux 12\"\n__CATIO_KERNEL__\n6.1.0\n__CATIO_UPTIME__\n3600.5 0\n__CATIO_LOAD__\n0.50 0.25 0.10\n__CATIO_LSCPU__\nCPU(s): 2\nModel name: Test CPU\nSocket(s): 1\nCore(s) per socket: 1\nL3 cache: 8 MiB\n__CATIO_FREQ__\n3200000\n__CATIO_TEMP__\n42000\n";
    const NET_INFO: &str = "eth0|1000|full|192.168.1.5/24\n__CATIO_TCP__|7\n";

    #[test]
    fn assemble_single_sample_no_gpu() {
        let m = assemble_monitor(
            "testhost", STAT_PREV, STAT_NOW, MEMINFO, NET_PREV, NET_NOW, 1.0, DF, PS, "",
        );
        assert_eq!(m.host, "testhost");
        // 2 个 cpuN 行 → 2 核
        assert_eq!(m.cores, 2);
        // df 行的 / 是 42%
        assert_eq!(m.disk, 42);
        // 单次采样 → 单元素窗口
        assert_eq!(m.cpu.len(), 1);
        assert_eq!(m.mem.len(), 1);
        assert_eq!(m.net.len(), 1);
        // mem：used = 16384000-8192000 = 8192000 kB → 50%
        assert!((m.mem[0] - 50.0).abs() < 0.2, "mem pct {}", m.mem[0]);
        // net：2 MiB / 1s → 2.0 MB/s
        assert!((m.net[0] - 2.0).abs() < 0.05, "net {}", m.net[0]);
        // procs 解析了 3 行
        assert_eq!(m.procs.len(), 3);
        assert_eq!(m.procs[0].pid, 1234);
        assert_eq!(m.procs[0].cmd, "firefox");
        // nvidia="" → 无 GPU
        assert!(m.gpus.is_empty());
    }

    #[test]
    fn assemble_with_one_gpu() {
        let csv = "0, NVIDIA GeForce RTX 4090, 45, 8192, 24564, 62, 210.5, 450.0, 55\n";
        let m = assemble_monitor(
            "h", STAT_PREV, STAT_NOW, MEMINFO, NET_PREV, NET_NOW, 1.0, DF, PS, csv,
        );
        assert_eq!(m.gpus.len(), 1);
        assert_eq!(m.gpus[0].idx, 0);
        assert_eq!(m.gpus[0].util_now, 45);
        // 单次采样 util 窗口为单元素
        assert_eq!(m.gpus[0].util, vec![45]);
    }

    #[test]
    fn assemble_detailed_populates_rich_monitor_fields() {
        let df = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 102400 43000 59400 42% /\n/dev/sdb1 xfs 204800 102400 102400 50% /data\n__CATIO_INODES__\nFilesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 1000 100 900 10% /\n/dev/sdb1 1000 200 800 20% /data\n";
        let disk_prev = "8 0 sda 1 0 1000 0 1 0 1000 0 0 0 0\n";
        let disk_now = "8 0 sda 1 0 3048 0 1 0 5096 0 0 0 0\n";
        let m = assemble_monitor_detailed(
            "rich-host",
            STAT_PREV,
            STAT_NOW,
            MEMINFO,
            NET_PREV,
            NET_NOW,
            1.0,
            df,
            disk_prev,
            disk_now,
            PS,
            "",
            HOST_INFO,
            NET_INFO,
        );

        assert_eq!(m.system.os, "Debian GNU/Linux 12");
        assert_eq!(m.system.process_count, 3);
        assert_eq!(m.cpu_info.model, "Test CPU");
        assert_eq!(m.cpu_info.sockets, 1);
        assert_eq!(m.cpu_info.physical_cores, 1);
        assert_eq!(m.cpu_info.threads, 2);
        assert_eq!(m.net_rx, vec![1.0]);
        assert_eq!(m.net_tx, vec![1.0]);
        assert_eq!(m.network_info.interface, "eth0");
        assert_eq!(m.disks.len(), 2);
        assert_eq!(m.disks[1].mount, "/data");
        assert_eq!(m.disk_io.read_mbps, 1.0);
        assert_eq!(m.disk_io.write_mbps, 2.0);
    }

    #[test]
    fn push_window_caps_and_orders() {
        let mut w: VecDeque<f64> = VecDeque::new();
        for i in 0..65 {
            push_window(&mut w, i as f64, WINDOW_CAP);
        }
        assert_eq!(w.len(), WINDOW_CAP);
        // 最旧的 5 个（0..5）被弹出，首元素应为 5.0
        assert_eq!(*w.front().unwrap(), 5.0);
        assert_eq!(*w.back().unwrap(), 64.0);
    }
}
