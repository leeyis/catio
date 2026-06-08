// Integration test for the ssh_sysinfo core (run_cmd path).
//
// The test server echoes any command that is not one of the five canned monitor
// commands and does not start with "nvidia-smi". The sysinfo compound command is
// not among those, so the server echoes it back verbatim (with a trailing "\n").
// We call `run_cmd` directly (the Tauri command needs AppHandle/State which are
// not available in integration tests) and assert:
//   1. The call returns Ok.
//   2. The output is non-empty (the server echoed something).
//
// This mirrors the pattern used in ssh_multiexec.rs (run_on) and
// ssh_monitor.rs (run_cmd_nonzero_exit_returns_empty_ok).

mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::monitor::run_cmd;

#[tokio::test]
async fn ssh_sysinfo_run_cmd_returns_ok_nonempty() {
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

    // The sysinfo compound command — same string the Tauri command uses.
    let sysinfo_cmd = concat!(
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

    let result = run_cmd(&handle, sysinfo_cmd).await;
    assert!(result.is_ok(), "ssh_sysinfo run_cmd failed: {:?}", result.err());
    let out = result.unwrap();
    // The test server echoes the command back — so output must be non-empty.
    assert!(!out.is_empty(), "expected non-empty output from echo server");
}
