//! Startup/crash diagnostics, available before a WebView or AppHandle exists.
//! Never pass application data, error payloads or command arguments to `record`.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

pub fn directory() -> Option<&'static Path> {
    DIRECTORY.get().map(PathBuf::as_path)
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn prepare_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.join("catio-runtime.log"))?;
    Ok(())
}

pub fn init(identifier: &str) {
    #[cfg(target_os = "macos")]
    let preferred = dirs::home_dir().map(|p| p.join("Library/Logs").join(identifier));
    #[cfg(not(target_os = "macos"))]
    let preferred = dirs::data_local_dir().map(|p| p.join(identifier).join("logs"));
    let fallback = std::env::temp_dir().join(identifier).join("logs");
    for path in preferred.into_iter().chain(std::iter::once(fallback)) {
        if prepare_directory(&path).is_ok() {
            let _ = DIRECTORY.set(path);
            break;
        }
    }
    install_panic_hook();
    record(
        "process-start",
        json!({
            "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "debug": cfg!(debug_assertions)
        }),
    );
}

fn install_panic_hook() {
    // The hook writes synchronously, including release builds with panic=abort.
    // A separate file and try_lock avoid deadlocking if logging itself panics.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|loc| {
            json!({"file": Path::new(loc.file()).file_name().unwrap_or_default().to_string_lossy(),
                "line": loc.line(), "column": loc.column()})
        });
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let frames: Vec<_> = backtrace
            .lines()
            .filter(|line| {
                line.trim_start()
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_digit())
            })
            .take(40)
            .collect();
        // Deliberately omit info.payload(): it may contain passwords or SQL.
        if let Some(dir) = directory() {
            let _guard = WRITE_LOCK.try_lock();
            let line = encode(
                "rust-panic",
                json!({"location": location, "frames": frames}),
            );
            let path = dir.join("catio-panic.log");
            let _ = super::diagnostics::append_rotating(&path, &line, MAX_BYTES);
            if let Ok(file) = OpenOptions::new().append(true).open(path) {
                let _ = file.sync_data();
            }
        }
        previous(info);
    }));
}

fn encode(event: &str, data: Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({
        "timestampMs": timestamp_ms(), "pid": std::process::id(), "event": event, "data": data
    }))
    .unwrap_or_default();
    line.push(b'\n');
    line
}

pub fn record(event: &str, data: Value) {
    if let Some(dir) = directory() {
        let line = encode(event, data);
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Failure to write diagnostics must never prevent startup or recovery.
        let _ =
            super::diagnostics::append_rotating(&dir.join("catio-runtime.log"), &line, MAX_BYTES);
    }
}

pub fn record_result<E: std::fmt::Display>(event: &str, result: &Result<(), E>) {
    match result {
        Ok(()) => record(event, json!({"ok": true})),
        Err(error) => record(
            event,
            json!({"ok": false, "code": error_code(&error.to_string())}),
        ),
    }
}

// Preserve only numeric OS/HRESULT codes. Raw error text can contain secrets.
fn error_code(message: &str) -> Option<String> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(r"(?i)\b0x[0-9a-f]{8}\b|\bos error [0-9]{1,10}\b").unwrap()
        })
        .find(message)
        .map(|m| m.as_str().to_owned())
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FrontendEventKind {
    FrontendStarted,
    FrontendReady,
    JavascriptError,
    UnhandledRejection,
    ResourceError,
    ReactError,
    InvokeError,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendEvent {
    event: FrontendEventKind,
    error_type: Option<String>,
    code: Option<String>,
    operation: Option<String>,
    #[serde(default)]
    frames: Vec<String>,
}

impl FrontendEvent {
    fn validate(&self) -> Result<(), &'static str> {
        if let Some(kind) = self.error_type.as_deref() {
            if ![
                "Error",
                "TypeError",
                "ReferenceError",
                "SyntaxError",
                "RangeError",
                "URIError",
                "EvalError",
                "DOMException",
                "Unknown",
            ]
            .contains(&kind)
            {
                return Err("invalid error type");
            }
        }
        if let Some(code) = self.code.as_deref() {
            if ![
                "missing-structuredClone",
                "missing-randomUUID",
                "module-load-failed",
                "permission-denied",
                "network-error",
                "unknown",
            ]
            .contains(&code)
            {
                return Err("invalid error code");
            }
        }
        if let Some(operation) = &self.operation {
            if operation.len() > 80
                || !operation
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c == b'_')
            {
                return Err("invalid operation");
            }
        }
        static FRAME: OnceLock<regex::Regex> = OnceLock::new();
        let frame = FRAME.get_or_init(|| regex::Regex::new(r"^(?:assets/[A-Za-z0-9_-]+\.js|src/[A-Za-z0-9_./-]+\.[jt]sx?):[0-9]{1,8}:[0-9]{1,8}$").unwrap());
        if self.frames.len() > 12
            || self
                .frames
                .iter()
                .any(|f| f.len() > 240 || !frame.is_match(f) || f.contains(".."))
        {
            return Err("invalid stack frames");
        }
        Ok(())
    }
}

#[tauri::command]
pub fn diagnostics_runtime_log(event: FrontendEvent) -> Result<(), String> {
    event.validate().map_err(str::to_owned)?;
    if event.event == FrontendEventKind::FrontendReady {
        FRONTEND_READY.store(true, Ordering::Relaxed);
    } else if event.event == FrontendEventKind::FrontendStarted {
        FRONTEND_READY.store(false, Ordering::Relaxed);
    }
    // A broken renderer must not fill the disk or flood synchronous IPC writes.
    static RATE: OnceLock<Mutex<(Instant, usize)>> = OnceLock::new();
    let mut rate = RATE
        .get_or_init(|| Mutex::new((Instant::now(), 0)))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if rate.0.elapsed().as_secs() >= 60 {
        *rate = (Instant::now(), 0);
    }
    if rate.1 >= 120 {
        return Ok(());
    }
    rate.1 += 1;
    drop(rate);
    record(
        "frontend",
        serde_json::to_value(event).map_err(|_| "invalid event")?,
    );
    Ok(())
}

pub fn frontend_ready() -> bool {
    FRONTEND_READY.load(Ordering::Relaxed)
}

/// JS cannot report a crashed/unresponsive renderer. Observe it from the host.
#[cfg(windows)]
pub fn attach_webview_diagnostics(window: &tauri::WebviewWindow) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
        ProcessFailedEventHandler,
    };
    let result = window.with_webview(|webview| unsafe {
        // Runs on the WebView UI thread. The WebView owns the handler and releases
        // it on destruction; the closure captures no WebView/AppHandle cycle.
        match webview.controller().CoreWebView2() {
            Ok(core) => {
                let mut token = 0;
                let result = core.add_ProcessFailed(
                    &ProcessFailedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            let result = args.ProcessFailedKind(&mut kind);
                            record(
                                "webview-process-failed",
                                json!({"kind": kind.0, "kindAvailable": result.is_ok()}),
                            );
                        }
                        Ok(())
                    })),
                    &mut token,
                );
                record_result("webview-process-hook", &result);
            }
            Err(error) => record_result("webview-process-hook", &Err::<(), _>(error)),
        }
    });
    record_result("webview-diagnostics-dispatch", &result);
}

/// Native command works even when the React tree or opener JS cannot load.
#[tauri::command]
pub fn diagnostics_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = directory().ok_or("diagnostic directory unavailable")?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|_| "cannot open diagnostic directory".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panic_child() {
        // Only the isolated child invoked below installs the process-global hook.
        let Some(dir) = std::env::var_os("CATIO_DIAG_PANIC_TEST_DIR") else {
            return;
        };
        DIRECTORY.set(PathBuf::from(dir)).unwrap();
        install_panic_hook();
        panic!("password=never-persist-this-test-payload");
    }

    #[test]
    fn panic_hook_persists_location_without_the_payload() {
        let dir = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime_diagnostics::tests::panic_child",
                "--nocapture",
            ])
            .env("CATIO_DIAG_PANIC_TEST_DIR", dir.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        let text = fs::read_to_string(dir.path().join("catio-panic.log")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["event"], "rust-panic");
        assert_eq!(value["data"]["location"]["file"], "runtime_diagnostics.rs");
        assert!(!text.contains("never-persist-this-test-payload"));
    }

    #[test]
    fn frontend_schema_rejects_payloads_and_private_paths() {
        assert!(serde_json::from_value::<FrontendEvent>(
            json!({"event":"react-error", "password":"secret"})
        )
        .is_err());
        for data in [
            json!({"event":"react-error", "errorType":"password=secret"}),
            json!({"event":"react-error", "code":"token=secret"}),
            json!({"event":"invoke-error", "operation":"ssh_connect password=secret"}),
            json!({"event":"javascript-error", "frames":["https://user:secret@host/app.js:1:2"]}),
            json!({"event":"javascript-error", "frames":["src/../../private.ts:1:2"]}),
        ] {
            assert!(serde_json::from_value::<FrontendEvent>(data)
                .unwrap()
                .validate()
                .is_err());
        }
        let event: FrontendEvent = serde_json::from_value(json!({"event":"javascript-error", "errorType":"ReferenceError", "code":"missing-structuredClone", "frames":["assets/index-abc.js:41:32"]})).unwrap();
        assert!(event.validate().is_ok());
    }

    #[test]
    fn extracts_only_numeric_error_codes() {
        assert_eq!(
            error_code("WebView failed 0x80070005 password=secret"),
            Some("0x80070005".into())
        );
        assert_eq!(
            error_code("private/path (os error 5)"),
            Some("os error 5".into())
        );
        assert_eq!(error_code("password=secret"), None);
    }

    #[test]
    fn writes_valid_records_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        prepare_directory(dir.path()).unwrap();
        let path = dir.path().join("catio-runtime.log");
        let line = encode("process-start", json!({"version":"test"}));
        super::super::diagnostics::append_rotating(&path, &line, line.len() as u64).unwrap();
        super::super::diagnostics::append_rotating(&path, &line, line.len() as u64).unwrap();
        assert_eq!(fs::read(path.with_extension("log.1")).unwrap(), line);
        let parsed: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(parsed["event"], "process-start");
        assert_eq!(parsed["pid"], std::process::id());
    }
}
