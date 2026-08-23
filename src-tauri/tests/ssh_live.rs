//! Live SSH verification against a real sshd container.
//!
//! Ignored by default (requires a local container):
//!   docker run -d --name catio-ssh-test -p 2222:22 ubuntu:24.04 sleep infinity
//!   docker exec catio-ssh-test sh -c "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server && mkdir -p /run/sshd && echo 'root:testpass123' | chpasswd && sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && /usr/sbin/sshd"
//! Then run: `cargo test --test ssh_live -- --ignored`

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::exec::run_cmd;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "root";
const PASS: &str = "testpass123";

#[tokio::test]
#[ignore = "requires a local sshd container on 127.0.0.1:2222"]
async fn live_ssh_executes_commands_on_ubuntu_container() {
    let args = ConnectArgs {
        host: HOST.into(),
        port: PORT,
        user: USER.into(),
        auth: AuthMethod::Password,
        secret: Some(PASS.into()),
        jump: None,
    };
    let (handle, fp, _fwd, _jump) = connect_authenticated(&args).await.expect("connect failed");
    assert!(!fp.is_empty(), "host key fingerprint captured");

    let out = run_cmd(&handle, "hostname && whoami && echo hello-catio").await.expect("exec failed");
    assert!(out.contains("root"), "whoami should be root, got: {out}");
    assert!(out.contains("hello-catio"), "command echo missing, got: {out}");
}

#[tokio::test]
#[ignore = "requires a local sshd container on 127.0.0.1:2222"]
async fn live_ssh_runs_a_real_shell_command() {
    let args = ConnectArgs {
        host: HOST.into(),
        port: PORT,
        user: USER.into(),
        auth: AuthMethod::Password,
        secret: Some(PASS.into()),
        jump: None,
    };
    let (handle, _, _, _) = connect_authenticated(&args).await.expect("connect failed");
    // A multi-word pipeline exercises a real shell (not just a single binary).
    let out = run_cmd(&handle, "df -h / | tail -1 && uname -a").await.expect("exec failed");
    assert!(!out.trim().is_empty());
    assert!(out.contains("Linux"), "uname should report Linux, got: {out}");
}
