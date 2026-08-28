mod common;
use common::test_server;

use std::time::Duration;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::exec::run_cmd;
use catio_lib::ssh::monitor::sample;

/// Connect to the in-process test server and run one agentless `sample()` over
/// real SSH exec channels. Proves the exec → parse pipeline: the Monitor must
/// reflect the test server's CANNED /proc/stat, df, ps, meminfo output, and
/// report no GPU (nvidia-smi exits non-zero with no stdout).
#[tokio::test]
async fn sample_reflects_canned_monitor_data() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _, _, _) = connect_authenticated(&args).await.unwrap();

    let m = sample(&handle, "testhost", Duration::from_millis(50))
        .await
        .unwrap();

    // host echoed through
    assert_eq!(m.host, "testhost");
    // /proc/stat has cpu0 + cpu1 → 2 cores
    assert_eq!(m.cores, 2, "expected 2 cores from canned /proc/stat");
    // Root summary stays compatible while the rich payload includes both real mounts.
    assert_eq!(m.disk, 42, "expected disk 42% from canned df");
    assert_eq!(m.disks.len(), 2, "expected / and /data filesystems");
    assert_eq!(m.disks[0].mount, "/");
    assert_eq!(m.disks[0].inode_pct, Some(10));
    assert_eq!(m.disks[1].mount, "/data");
    // meminfo: used = 16384000 - 8192000 = 8192000 kB of 16384000 → 50%
    assert!(
        (m.mem[0] - 50.0).abs() < 0.5,
        "expected ~50% mem, got {}",
        m.mem[0]
    );
    // single sample → single-element windows
    assert_eq!(m.cpu.len(), 1);
    assert_eq!(m.net.len(), 1);
    assert_eq!(m.net_rx.len(), 1);
    assert_eq!(m.net_tx.len(), 1);
    assert_eq!(m.network_info.interface, "eth0");
    assert_eq!(m.network_info.link_speed_mbps, Some(1000));
    assert_eq!(m.network_info.ipv4, "10.0.0.12/24");
    assert_eq!(m.network_info.tcp_connections, 18);
    assert_eq!(m.system.os, "Ubuntu 24.04.1 LTS");
    assert_eq!(m.system.kernel, "6.8.0-51-generic");
    assert_eq!(m.system.process_count, 3);
    assert_eq!(m.cpu_info.model, "AMD EPYC 7763 64-Core Processor");
    assert_eq!(m.cpu_info.physical_cores, 2);
    assert_eq!(m.cpu_info.threads, 2);
    assert_eq!(m.cpu_info.frequency_mhz, Some(2450.0));
    assert_eq!(m.memory_info.swap_used, "1.0 GB");
    // procs parsed, first row is pid 1234 "firefox"
    assert!(!m.procs.is_empty(), "expected non-empty procs");
    assert_eq!(m.procs[0].pid, 1234);
    assert_eq!(m.procs[0].cmd, "firefox");
    // nvidia-smi exits non-zero with no stdout → no GPUs
    assert!(m.gpus.is_empty(), "expected no GPUs");
}

/// run_cmd contract: a command that exits NON-ZERO with no stdout still resolves
/// to Ok("") (it collects stdout and ignores the exit code). This is what makes
/// the GPU-less nvidia-smi path return empty rather than erroring.
#[tokio::test]
async fn run_cmd_nonzero_exit_returns_empty_ok() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _, _, _) = connect_authenticated(&args).await.unwrap();

    // nvidia-smi → test server: no stdout, exit 9
    let out = run_cmd(
        &handle,
        "nvidia-smi --query-gpu=index,name --format=csv,noheader,nounits",
    )
    .await
    .unwrap();
    assert_eq!(out, "", "non-zero exit with no stdout should be Ok(\"\")");

    // A non-monitor command still echoes (proves gating didn't break echo).
    let echoed = run_cmd(&handle, "echo-me").await.unwrap();
    assert!(
        echoed.contains("echo-me"),
        "non-monitor command should still echo, got {:?}",
        echoed
    );
}
