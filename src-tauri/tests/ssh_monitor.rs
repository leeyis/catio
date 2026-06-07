mod common;
use common::test_server;

use std::time::Duration;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::monitor::{run_cmd, sample};

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
    };
    let (handle, _, _) = connect_authenticated(&args).await.unwrap();

    let m = sample(&handle, "testhost", Duration::from_millis(50))
        .await
        .unwrap();

    // host echoed through
    assert_eq!(m.host, "testhost");
    // /proc/stat has cpu0 + cpu1 → 2 cores
    assert_eq!(m.cores, 2, "expected 2 cores from canned /proc/stat");
    // df -P / canned row is 42%
    assert_eq!(m.disk, 42, "expected disk 42% from canned df");
    // meminfo: used = 16384000 - 8192000 = 8192000 kB of 16384000 → 50%
    assert!(
        (m.mem[0] - 50.0).abs() < 0.5,
        "expected ~50% mem, got {}",
        m.mem[0]
    );
    // single sample → single-element windows
    assert_eq!(m.cpu.len(), 1);
    assert_eq!(m.net.len(), 1);
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
    };
    let (handle, _, _) = connect_authenticated(&args).await.unwrap();

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
