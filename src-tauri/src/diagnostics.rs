use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const LOG_FILE: &str = "catio-diagnostics.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_EVENT_LEN: usize = 64;
const MAX_CHANNEL_ID_LEN: usize = 128;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticArea {
    Terminal,
    Agent,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSource {
    ShellLifecycle,
    AgentCapture,
    BusyCheck,
    SplitRequest,
}

/// Deliberately narrow: raw commands, terminal bytes, hosts and arbitrary
/// payloads have no accepted field and are rejected by `deny_unknown_fields`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticEvent {
    level: DiagnosticLevel,
    area: DiagnosticArea,
    event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<DiagnosticSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    busy: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRecord<'a> {
    timestamp_ms: u64,
    #[serde(flatten)]
    event: &'a DiagnosticEvent,
}

fn write_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

fn validate_label(name: &str, value: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > max_len {
        return Err(format!("{name} must contain 1..={max_len} characters"));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{name} contains unsupported characters"));
    }
    Ok(())
}

fn validate_event(event: &DiagnosticEvent) -> Result<(), String> {
    validate_label("event", &event.event, MAX_EVENT_LEN)?;
    if let Some(channel_id) = event.channel_id.as_deref() {
        validate_label("channelId", channel_id, MAX_CHANNEL_ID_LEN)?;
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("log.1")
}

fn append_rotating(path: &Path, line: &[u8], max_bytes: u64) -> std::io::Result<()> {
    let current_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current_bytes > 0 && current_bytes.saturating_add(line.len() as u64) > max_bytes {
        let backup = backup_path(path);
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        fs::rename(path, backup)?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line)
}

fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map_err(|error| format!("resolve diagnostics log directory: {error}"))
}

#[tauri::command]
pub fn diagnostics_log(app: tauri::AppHandle, event: DiagnosticEvent) -> Result<(), String> {
    validate_event(&event)?;

    let dir = log_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("create diagnostics log directory: {error}"))?;

    let record = DiagnosticRecord {
        timestamp_ms: now_ms(),
        event: &event,
    };
    let mut line = serde_json::to_vec(&record)
        .map_err(|error| format!("serialize diagnostics event: {error}"))?;
    line.push(b'\n');

    let _guard = write_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    append_rotating(&dir.join(LOG_FILE), &line, MAX_LOG_BYTES)
        .map_err(|error| format!("write diagnostics log: {error}"))
}

#[tauri::command]
pub fn diagnostics_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = log_dir(&app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("create diagnostics log directory: {error}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_or_unsafe_fields() {
        let unknown = serde_json::from_value::<DiagnosticEvent>(json!({
            "level": "debug",
            "area": "terminal",
            "event": "busy-detected",
            "command": "cat /etc/shadow"
        }));
        assert!(unknown.is_err());

        let unsafe_event = serde_json::from_value::<DiagnosticEvent>(json!({
            "level": "debug",
            "area": "terminal",
            "event": "command:cat /etc/shadow"
        }))
        .unwrap();
        assert!(validate_event(&unsafe_event).is_err());
    }

    #[test]
    fn rotates_one_backup_before_exceeding_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        fs::write(&path, b"first\n").unwrap();

        append_rotating(&path, b"second\n", 8).unwrap();
        assert_eq!(fs::read(backup_path(&path)).unwrap(), b"first\n");
        assert_eq!(fs::read(&path).unwrap(), b"second\n");

        append_rotating(&path, b"third\n", 8).unwrap();
        assert_eq!(fs::read(backup_path(&path)).unwrap(), b"second\n");
        assert_eq!(fs::read(&path).unwrap(), b"third\n");
    }
}
