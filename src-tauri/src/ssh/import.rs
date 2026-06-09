//! Best-effort `~/.ssh/config` parser → importable host profiles.
//!
//! Supports the common subset: `Host` blocks with `HostName`, `User`, `Port`,
//! `IdentityFile`, and `ProxyJump`. Wildcard host patterns (`*`, `?`) are skipped
//! (they are defaults, not concrete hosts). `Include` directives are not followed.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedJump {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_file: Option<String>,
    pub jump: Option<ImportedJump>,
}

fn ssh_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".ssh").join("config"))
}

#[derive(Default, Clone)]
struct RawBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

/// Split an ssh_config line into (keyword, value). Supports both `Key value`
/// and `Key=value` forms; trims surrounding quotes on the value.
fn split_kv(line: &str) -> (&str, &str) {
    let sep = line
        .char_indices()
        .find(|&(_, c)| c == '=' || c.is_whitespace())
        .map(|(i, _)| i);
    match sep {
        Some(i) => {
            let key = line[..i].trim();
            let rest = line[i..].trim_start_matches(|c: char| c == '=' || c.is_whitespace());
            (key, rest.trim().trim_matches('"'))
        }
        None => (line, ""),
    }
}

/// Parse `[user@]host[:port]` into a jump hop (used for literal ProxyJump specs).
fn parse_jump_literal(spec: &str) -> ImportedJump {
    let (user, hostport) = match spec.split_once('@') {
        Some((u, h)) => (u.to_string(), h),
        None => (String::new(), spec),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(22)),
        None => (hostport.to_string(), 22),
    };
    ImportedJump { host, port, user, identity_file: None }
}

pub fn parse_ssh_config(content: &str) -> Vec<ImportedHost> {
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut cur: Option<RawBlock> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_kv(line);
        let key_lc = key.to_ascii_lowercase();
        if key_lc == "host" {
            if let Some(b) = cur.take() {
                blocks.push(b);
            }
            let aliases = value.split_whitespace().map(|s| s.to_string()).collect();
            cur = Some(RawBlock { aliases, ..Default::default() });
        } else if let Some(b) = cur.as_mut() {
            match key_lc.as_str() {
                "hostname" => b.hostname = Some(value.to_string()),
                "user" => b.user = Some(value.to_string()),
                "port" => b.port = value.parse().ok(),
                // Honor only the first IdentityFile.
                "identityfile" if b.identity_file.is_none() => {
                    b.identity_file = Some(value.to_string())
                }
                "proxyjump" => {
                    let first = value.split(',').next().unwrap_or("").trim();
                    if !first.is_empty() && !first.eq_ignore_ascii_case("none") {
                        b.proxy_jump = Some(first.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(b) = cur.take() {
        blocks.push(b);
    }

    // Index every concrete alias so a ProxyJump that names another Host block
    // resolves to that block's real HostName/User/Port.
    let mut by_alias: HashMap<String, RawBlock> = HashMap::new();
    for b in &blocks {
        for a in &b.aliases {
            by_alias.entry(a.clone()).or_insert_with(|| b.clone());
        }
    }

    let mut out: Vec<ImportedHost> = Vec::new();
    for b in &blocks {
        for alias in &b.aliases {
            if alias.contains('*') || alias.contains('?') {
                continue;
            }
            let jump = b.proxy_jump.as_ref().map(|pj| match by_alias.get(pj) {
                Some(jb) => ImportedJump {
                    host: jb.hostname.clone().unwrap_or_else(|| pj.clone()),
                    port: jb.port.unwrap_or(22),
                    user: jb.user.clone().unwrap_or_default(),
                    identity_file: jb.identity_file.clone(),
                },
                None => parse_jump_literal(pj),
            });
            out.push(ImportedHost {
                alias: alias.clone(),
                host: b.hostname.clone().unwrap_or_else(|| alias.clone()),
                port: b.port.unwrap_or(22),
                user: b.user.clone().unwrap_or_default(),
                identity_file: b.identity_file.clone(),
                jump,
            });
        }
    }
    out
}

/// Read and parse `~/.ssh/config`. Missing file → empty list (not an error).
#[tauri::command]
pub fn import_ssh_config() -> Result<Vec<ImportedHost>, String> {
    let path = match ssh_config_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(parse_ssh_config(&content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("读取 {} 失败: {}", path.display(), e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_blocks_and_skips_wildcards() {
        let cfg = "\
Host *
    User default

Host prod-web
    HostName 10.0.0.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host bastion
    HostName bastion.example.com
    User ec2-user

Host behind
    HostName 10.0.0.9
    ProxyJump bastion
";
        let hosts = parse_ssh_config(cfg);
        // wildcard "*" skipped → 3 concrete hosts
        assert_eq!(hosts.len(), 3);

        let prod = hosts.iter().find(|h| h.alias == "prod-web").unwrap();
        assert_eq!(prod.host, "10.0.0.5");
        assert_eq!(prod.user, "deploy");
        assert_eq!(prod.port, 2222);
        assert_eq!(prod.identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
        assert!(prod.jump.is_none());

        let behind = hosts.iter().find(|h| h.alias == "behind").unwrap();
        let jump = behind.jump.as_ref().unwrap();
        assert_eq!(jump.host, "bastion.example.com");
        assert_eq!(jump.user, "ec2-user");
        assert_eq!(jump.port, 22);
    }

    #[test]
    fn handles_equals_form_and_literal_proxyjump() {
        let cfg = "Host=db\nHostName=db.internal\nProxyJump=jumper@gw.example.com:2200\n";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 1);
        let jump = hosts[0].jump.as_ref().unwrap();
        assert_eq!(jump.host, "gw.example.com");
        assert_eq!(jump.user, "jumper");
        assert_eq!(jump.port, 2200);
    }
}
