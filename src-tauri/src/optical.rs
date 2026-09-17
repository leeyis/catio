//! Session-only optical export grants. No file payload or plaintext passphrase is persisted.
use crate::ssh::manager::SessionManager;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
const GRANT_TTL: Duration = Duration::from_secs(8 * 60 * 60);

#[derive(Clone)]
pub struct OpticalState {
    path: PathBuf,
    enabled: bool,
    inner: Arc<Mutex<Inner>>,
}
#[derive(Default)]
struct Inner {
    hash: Option<String>,
    config_error: bool,
    grants: HashMap<String, Grant>,
    failures: u8,
    retry_at: Option<Instant>,
}
struct Grant {
    scope: String,
    expires: Instant,
    cancel: CancellationToken,
    reads: HashMap<String, CancellationToken>,
    cancelled: VecDeque<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpticalStatus {
    pub visible: bool,
    pub configured: bool,
    pub can_configure: bool,
}
#[derive(Serialize)]
pub struct OpticalFile {
    pub name: String,
    pub data: String,
}

/// Installation-owned switch, read once at startup. Missing/invalid/duplicate keys stay off.
fn experimental_enabled(config: &str) -> bool {
    if config.len() > 65536 { return false; }
    let mut value = None;
    for line in config.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
        let Some((key, setting)) = line.split_once('=') else { return false; };
        if key.trim() == "Experiment_func" {
            if value.is_some() { return false; }
            value = Some(setting.trim() == "1");
        }
    }
    value == Some(true)
}
fn installation_config_path() -> PathBuf {
    // AppImage's executable lives in a temporary read-only mount; use its persistent location.
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE") { return PathBuf::from(image).with_file_name("catio.conf"); }
    std::env::current_exe().map(config_for_executable).unwrap_or_default()
}
fn config_for_executable(executable: PathBuf) -> PathBuf {
    // Do not write inside a signed macOS bundle: adding files invalidates its seal.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = executable.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        return bundle.with_file_name("catio.conf");
    }
    executable.with_file_name("catio.conf")
}

impl OpticalState {
    pub fn new(path: PathBuf) -> Self {
        let config = path.with_file_name("catio.conf");
        Self::with_config(path, config)
    }
    pub fn from_installation(path: PathBuf) -> Self {
        let config = installation_config_path();
        // Never overwrite an operator's configuration. Read-only installs fail closed.
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).create_new(true).open(&config) {
            use std::io::Write;
            let _ = file.write_all(b"# Restart Catio after editing.\nExperiment_func=0\n");
        }
        Self::with_config(path, config)
    }
    pub fn with_config(path: PathBuf, config: PathBuf) -> Self {
        let enabled = std::fs::read_to_string(config).ok().is_some_and(|s| experimental_enabled(&s));
        // A broken optional feature must not prevent SSH or the application from starting.
        // Keep the feature locked; never treat an unreadable existing hash as first-run setup.
        let (hash, config_error) = match std::fs::read_to_string(&path) {
            Ok(s) if PasswordHash::new(s.trim()).is_ok() => (Some(s.trim().to_owned()), false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, false),
            _ => (None, true),
        };
        Self {
            path,
            enabled,
            inner: Arc::new(Mutex::new(Inner {
                hash,
                config_error,
                ..Inner::default()
            })),
        }
    }
    pub fn status(&self, can_configure: bool) -> Result<OpticalStatus, String> {
        let inner = self.inner.lock().unwrap();
        if self.enabled && inner.config_error {
            return Err("optical.configError".into());
        }
        Ok(OpticalStatus {
            visible: self.enabled,
            configured: self.enabled && inner.hash.is_some(),
            can_configure: self.enabled && can_configure,
        })
    }
    /// Hashing happens off the async executor; the lock also serializes first-run setup.
    pub async fn unlock(
        &self,
        scope: String,
        passphrase: String,
        setup: bool,
        can_configure: bool,
    ) -> Result<String, String> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            state.unlock_sync(scope, passphrase, setup, can_configure)
        })
        .await
        .map_err(|_| "optical.configError".to_string())?
    }
    fn unlock_sync(
        &self,
        scope: String,
        passphrase: String,
        setup: bool,
        can_configure: bool,
    ) -> Result<String, String> {
        if !self.enabled { return Err("optical.disabled".into()); }
        if passphrase.len() > 1024 || passphrase.chars().count() < 8 {
            return Err("optical.passphraseLength".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.config_error {
            return Err("optical.configError".into());
        }
        if inner.retry_at.is_some_and(|t| t > Instant::now()) {
            return Err("optical.tryLater".into());
        }
        if setup {
            if !can_configure {
                return Err("optical.adminRequired".into());
            }
            if inner.hash.is_some() {
                return Err("optical.alreadyConfigured".into());
            }
            let salt = SaltString::generate(&mut OsRng);
            let hash = Argon2::default()
                .hash_password(passphrase.as_bytes(), &salt)
                .map_err(|_| "optical.configError")?
                .to_string();
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "optical.configError")?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&self.path)
                .map_err(|_| "optical.configError")?;
            use std::io::Write;
            file.write_all(hash.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| "optical.configError")?;
            inner.hash = Some(hash);
        } else {
            let hash = inner.hash.as_ref().ok_or("optical.notConfigured")?;
            let parsed = PasswordHash::new(hash).map_err(|_| "optical.configError")?;
            if Argon2::default()
                .verify_password(passphrase.as_bytes(), &parsed)
                .is_err()
            {
                inner.failures += 1;
                if inner.failures >= 5 {
                    inner.retry_at = Some(Instant::now() + Duration::from_secs(30));
                    inner.failures = 0;
                }
                return Err("optical.wrongPassphrase".into());
            }
        }
        inner.failures = 0;
        inner.retry_at = None;
        inner.grants.retain(|_, g| {
            let keep = g.expires > Instant::now();
            if !keep {
                g.cancel.cancel();
            }
            keep
        });
        // A reload loses the in-memory frontend capability. Successful password verification
        // can replace the oldest grant instead of locking the user out until its eight-hour TTL.
        if inner.grants.values().filter(|g| g.scope == scope).count() >= 8 {
            let oldest = inner
                .grants
                .iter()
                .filter(|(_, g)| g.scope == scope)
                .min_by_key(|(_, g)| g.expires)
                .map(|(token, _)| token.clone());
            if let Some(g) = oldest.and_then(|token| inner.grants.remove(&token)) {
                g.cancel.cancel();
            }
        }
        let token = crate::auth::new_session_token();
        inner.grants.insert(
            token.clone(),
            Grant {
                scope,
                expires: Instant::now() + GRANT_TTL,
                cancel: CancellationToken::new(),
                reads: HashMap::new(),
                cancelled: VecDeque::new(),
            },
        );
        Ok(token)
    }
    pub fn lock(&self, scope: &str, token: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.grants.get(token).is_some_and(|g| g.scope == scope) {
            if let Some(g) = inner.grants.remove(token) {
                g.cancel.cancel();
            }
        }
    }
    pub fn lock_scope(&self, scope: &str) {
        self.inner.lock().unwrap().grants.retain(|_, g| {
            if g.scope == scope {
                g.cancel.cancel();
                false
            } else {
                true
            }
        });
    }
    pub fn valid(&self, scope: &str, token: &str) -> bool {
        self.enabled && self.inner
            .lock()
            .unwrap()
            .grants
            .get(token)
            .is_some_and(|g| {
                g.scope == scope && g.expires > Instant::now() && !g.cancel.is_cancelled()
            })
    }
    pub fn cancel(&self, scope: &str, token: &str, request_id: &str) {
        if request_id.is_empty() || request_id.len() > 128 {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if let Some(g) = inner.grants.get_mut(token).filter(|g| g.scope == scope) {
            if let Some(c) = g.reads.get(request_id) {
                c.cancel();
            }
            // Remember cancellation arriving before the read RPC (HTTP requests may reorder).
            if g.cancelled.len() == 64 {
                g.cancelled.pop_front();
            }
            g.cancelled.push_back(request_id.to_owned());
        }
    }
    fn begin_read(&self, scope: &str, token: &str, request_id: &str) -> Result<ReadLease, String> {
        if !self.enabled { return Err("optical.disabled".into()); }
        let mut inner = self.inner.lock().unwrap();
        let g = inner
            .grants
            .get_mut(token)
            .filter(|g| g.scope == scope && g.expires > Instant::now())
            .ok_or("optical.locked")?;
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("optical.invalidRequest".into());
        }
        if g.cancelled.iter().any(|id| id == request_id) {
            return Err("optical.cancelled".into());
        }
        if !g.reads.is_empty() {
            return Err("optical.busy".into());
        }
        let cancel = g.cancel.child_token();
        g.reads.insert(request_id.to_owned(), cancel.clone());
        Ok(ReadLease {
            state: self.clone(),
            token: token.to_owned(),
            request_id: request_id.to_owned(),
            cancel,
            expires: g.expires,
        })
    }
    pub async fn read(
        &self,
        mgr: &SessionManager,
        scope: &str,
        token: &str,
        request_id: &str,
        session_id: &str,
        path: &str,
    ) -> Result<OpticalFile, String> {
        let lease = self.begin_read(scope, token, request_id)?;
        let result = tokio::select! {
            biased;
            _ = lease.cancel.cancelled() => Err("optical.cancelled".into()),
            _ = tokio::time::sleep_until(lease.expires.into()) => Err("optical.locked".into()),
            r = tokio::time::timeout(Duration::from_secs(90), read_file(mgr, session_id, path)) => r.unwrap_or_else(|_| Err("optical.readTimeout".into())),
        };
        if lease.cancel.is_cancelled() || !self.valid(scope, token) {
            return Err("optical.locked".into());
        }
        result
    }
}

struct ReadLease {
    state: OpticalState,
    token: String,
    request_id: String,
    cancel: CancellationToken,
    expires: Instant,
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        if let Some(g) = self.state.inner.lock().unwrap().grants.get_mut(&self.token) {
            g.reads.remove(&self.request_id);
        }
    }
}

fn validate_file(attrs: &russh_sftp::protocol::FileAttributes) -> Result<u64, String> {
    if attrs.permissions.map(|p| p & 0o170000) != Some(0o100000) {
        return Err("optical.notFile".into());
    }
    let size = attrs.size.ok_or("optical.unknownSize")?;
    if size > MAX_BYTES as u64 {
        return Err("optical.tooLarge".into());
    }
    Ok(size)
}
async fn bounded_read<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "optical.readFailed")?;
    if bytes.len() > MAX_BYTES {
        return Err("optical.tooLarge".into());
    }
    Ok(bytes)
}
async fn read_file(
    mgr: &SessionManager,
    session_id: &str,
    path: &str,
) -> Result<OpticalFile, String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;
    let name = path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .ok_or("optical.invalidRequest")?;
    let sftp = crate::ssh::sftp_transfer::open_sftp(mgr, session_id)
        .await
        .map_err(|_| "optical.readFailed")?;
    let attrs = sftp
        .symlink_metadata(path)
        .await
        .map_err(|_| "optical.readFailed")?;
    validate_file(&attrs)?;
    let mut file = sftp
        .open_with_flags(path, OpenFlags::READ)
        .await
        .map_err(|_| "optical.readFailed")?;
    // fstat the opened handle, not only the path that may have changed since listing.
    let before = file.metadata().await.map_err(|_| "optical.readFailed")?;
    let expected = validate_file(&before)?;
    let bytes = bounded_read(&mut file).await?;
    let after = file.metadata().await.map_err(|_| "optical.readFailed")?;
    if validate_file(&after)? != expected
        || bytes.len() as u64 != expected
        || before.mtime != after.mtime
    {
        return Err("optical.fileChanged".into());
    }
    file.shutdown().await.map_err(|_| "optical.readFailed")?;
    Ok(OpticalFile {
        name: name.to_owned(),
        data: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub fn optical_status(state: tauri::State<'_, OpticalState>) -> Result<OpticalStatus, String> {
    state.status(true)
}
#[tauri::command]
pub async fn optical_unlock(
    passphrase: String,
    setup: bool,
    state: tauri::State<'_, OpticalState>,
) -> Result<String, String> {
    state
        .unlock("desktop".into(), passphrase, setup, true)
        .await
}
#[tauri::command]
pub fn optical_lock(token: String, state: tauri::State<'_, OpticalState>) {
    state.lock("desktop", &token);
}
#[tauri::command]
pub fn optical_cancel(token: String, request_id: String, state: tauri::State<'_, OpticalState>) {
    state.cancel("desktop", &token, &request_id);
}
#[tauri::command]
pub fn optical_check(token: String, state: tauri::State<'_, OpticalState>) -> bool {
    state.valid("desktop", &token)
}
#[tauri::command]
pub async fn optical_read(
    token: String,
    request_id: String,
    session_id: String,
    path: String,
    state: tauri::State<'_, OpticalState>,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<OpticalFile, String> {
    state
        .read(&mgr, "desktop", &token, &request_id, &session_id, &path)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    const PASSWORD: &str = "test-only-passphrase";
    #[tokio::test]
    async fn installation_switch_fails_closed_and_cannot_be_bypassed() {
        for text in [None, Some("Experiment_func=0"), Some("Experiment_func=true"), Some("Experiment_func=1\nExperiment_func=0")] {
            let tmp = tempfile::tempdir().unwrap();
            if let Some(text) = text { std::fs::write(tmp.path().join("catio.conf"), text).unwrap(); }
            let state = OpticalState::new(tmp.path().join("hash"));
            assert!(!state.status(true).unwrap().visible);
            assert_eq!(state.unlock("a".into(), PASSWORD.into(), true, true).await.unwrap_err(), "optical.disabled");
            assert!(!state.valid("a", "forged"));
            assert!(state.begin_read("a", "forged", "id").is_err());
            assert!(!tmp.path().join("hash").exists());
        }
        assert!(experimental_enabled("# optional\nExperiment_func = 1\n"));
        assert!(!experimental_enabled("Experiment_func=1\nbroken"));
    }
    #[tokio::test]
    async fn grants_are_session_bound_revocable_and_not_persisted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("catio.conf"), "Experiment_func=1\n").unwrap();
        let path = tmp.path().join("optical.hash");
        let state = OpticalState::new(path.clone());
        assert!(!state.status(true).unwrap().configured);
        assert!(state
            .unlock("a".into(), PASSWORD.into(), true, false)
            .await
            .is_err());
        let token = state
            .unlock("a".into(), PASSWORD.into(), true, true)
            .await
            .unwrap();
        assert!(state.valid("a", &token));
        assert!(!state.valid("b", &token));
        assert!(state
            .unlock("b".into(), "wrong-password".into(), false, false)
            .await
            .is_err());
        assert!(state
            .unlock("b".into(), PASSWORD.into(), true, true)
            .await
            .is_err());
        assert!(!std::fs::read_to_string(&path).unwrap().contains(PASSWORD));
        assert!(!OpticalState::new(path).valid("a", &token));
        let lease = state.begin_read("a", &token, "request").unwrap();
        state.lock("b", &token);
        assert!(!lease.cancel.is_cancelled());
        state.lock("a", &token);
        assert!(lease.cancel.is_cancelled());
        assert!(!state.valid("a", &token));
    }
    #[tokio::test]
    async fn cancellation_before_read_and_concurrency_are_enforced() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("catio.conf"), "Experiment_func=1\n").unwrap();
        let state = OpticalState::new(tmp.path().join("hash"));
        let token = state
            .unlock("a".into(), PASSWORD.into(), true, true)
            .await
            .unwrap();
        state.cancel("a", &token, "early");
        assert!(state.begin_read("a", &token, "early").is_err());
        let lease = state.begin_read("a", &token, "one").unwrap();
        assert!(state.begin_read("a", &token, "two").is_err());
        state.cancel("a", &token, "one");
        assert!(lease.cancel.is_cancelled());
        drop(lease);
        assert!(state.begin_read("a", &token, "two").is_ok());
    }
    #[tokio::test]
    async fn actual_byte_limit_and_binary_integrity() {
        let data: Vec<u8> = (0..MAX_BYTES).map(|i| (i % 256) as u8).collect();
        assert_eq!(bounded_read(&mut data.as_slice()).await.unwrap(), data);
        assert!(bounded_read(&mut vec![0; MAX_BYTES + 1].as_slice())
            .await
            .is_err());
        assert!(bounded_read(&mut &b""[..]).await.unwrap().is_empty());
    }
    #[test]
    fn reject_links_devices_unknown_and_oversize() {
        let mut attrs = russh_sftp::protocol::FileAttributes::default();
        attrs.size = Some(MAX_BYTES as u64);
        attrs.permissions = Some(0o100644);
        assert_eq!(validate_file(&attrs).unwrap(), MAX_BYTES as u64);
        attrs.size = Some(MAX_BYTES as u64 + 1);
        assert!(validate_file(&attrs).is_err());
        attrs.size = Some(1);
        for mode in [0o040755, 0o120777, 0o020644, 0o010644] {
            attrs.permissions = Some(mode);
            assert!(validate_file(&attrs).is_err());
        }
        attrs.permissions = None;
        assert!(validate_file(&attrs).is_err());
        attrs.permissions = Some(0o100644);
        attrs.size = None;
        assert!(validate_file(&attrs).is_err());
    }
    #[tokio::test]
    async fn invalid_optional_config_fails_closed_without_blocking_startup() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("catio.conf"), "Experiment_func=1\n").unwrap();
        let path = tmp.path().join("hash");
        std::fs::write(&path, "broken-hash").unwrap();
        let state = OpticalState::new(path.clone());
        assert!(state.status(true).is_err());
        assert!(state
            .unlock("a".into(), PASSWORD.into(), true, true)
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken-hash");
    }
    #[tokio::test]
    async fn repeated_reloads_replace_old_grants_and_cancel_their_reads() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("catio.conf"), "Experiment_func=1\n").unwrap();
        let state = OpticalState::new(tmp.path().join("hash"));
        let first = state
            .unlock("a".into(), PASSWORD.into(), true, true)
            .await
            .unwrap();
        let lease = state.begin_read("a", &first, "read").unwrap();
        for _ in 0..8 {
            let next = state
                .unlock("a".into(), PASSWORD.into(), false, true)
                .await
                .unwrap();
            assert!(state.valid("a", &next));
        }
        assert!(!state.valid("a", &first));
        assert!(lease.cancel.is_cancelled());
        assert_eq!(state.inner.lock().unwrap().grants.len(), 8);
    }
}
