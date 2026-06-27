//! RDP remote desktop via the platform's native RDP client.
//!
//! A fully embedded RDP viewer (ironrdp: TLS + CredSSP/NLA + bitmap codecs) is a
//! large separate effort; this launches the OS RDP client so catio can initiate an
//! RDP session today (same "delegate to the system client" pattern as Mosh):
//!   - Windows: `mstsc /v:host:port`
//!   - Linux:   `xfreerdp /v:host:port [/u:user]`, falling back to `rdesktop`
//!   - macOS:   `open rdp://host:port` (Microsoft Remote Desktop URL scheme)
//!
//! Args are passed as discrete argv (no shell), and the host/user are embedded in
//! `/v:` / `/u:` value tokens, so a leading `-`/`/` can't become a separate option.

use crate::ssh::SshError;

/// Conservative host validation: blocks chars that could turn the host into a
/// separate CLI option (rdesktop's bare positional arg) or skew the macOS `rdp://`
/// URL — `/ ? # @ space`, a leading `-`, and control chars. Allows hostnames, IPv4,
/// and bracketed IPv6.
fn valid_rdp_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']'))
}

/// Launch the system RDP client against `host:port` (optionally pre-filling `user`).
#[tauri::command]
pub fn rdp_launch(host: String, port: u16, user: String) -> Result<(), SshError> {
    let host = host.trim();
    if !valid_rdp_host(host) {
        return Err(SshError::Io("invalid RDP host".into()));
    }
    let target = format!("{host}:{port}");

    #[cfg(windows)]
    {
        let _ = &user; // mstsc takes creds in its own dialog; user not passed on argv.
        // Absolute path (don't trust PATH for the built-in client).
        let mstsc = format!("{}\\System32\\mstsc.exe", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()));
        std::process::Command::new(mstsc)
            .arg(format!("/v:{target}"))
            .spawn()
            .map_err(|e| SshError::Io(format!("failed to launch mstsc: {e}")))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let _ = &user;
        std::process::Command::new("open")
            .arg(format!("rdp://{target}"))
            .spawn()
            .map_err(|e| SshError::Io(format!("failed to open rdp url: {e}")))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("xfreerdp");
        cmd.arg(format!("/v:{target}"));
        if !user.trim().is_empty() {
            cmd.arg(format!("/u:{user}"));
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        // Fall back to rdesktop.
        let mut r = std::process::Command::new("rdesktop");
        if !user.trim().is_empty() {
            r.arg("-u").arg(&user);
        }
        r.arg(&target)
            .spawn()
            .map_err(|e| SshError::Io(format!("no RDP client found (tried xfreerdp/rdesktop): {e}")))?;
        return Ok(());
    }
}
