//! SSH 客户端连接路径：ClientHandler + connect/authenticate 核心 + Tauri 命令。
//!
//! russh 0.61.2（ring 后端）已确认的客户端 API：
//!   * `russh::client::connect(Arc<Config>, addrs, handler) -> Result<Handle<H>, H::Error>`
//!   * `Handler::check_server_key(&mut self, &russh::keys::ssh_key::PublicKey)
//!      -> impl Future<Output = Result<bool, Self::Error>> + Send`（默认拒绝所有 key）
//!   * `handle.authenticate_password(user, pw) -> Result<AuthResult, russh::Error>`，
//!      成功判定用 `AuthResult::success()`。
//!   * `pubkey.fingerprint(HashAlg::default())` → `Fingerprint`，`Display` 形如
//!      `SHA256:...`。
//!   * `handle.disconnect(Disconnect::ByApplication, "", "en") -> Result<(), russh::Error>`。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use russh::client::{self, Handle};
use russh::keys::ssh_key;
use russh::keys::PrivateKeyWithHashAlg;

use crate::ssh::ids::IdGen;
use crate::ssh::manager::{Session, SessionManager};
use crate::ssh::SshError;

static SESS_IDS: IdGen = IdGen::new("sess");

/// 认证方式。serde 判别联合：{ "method": "password" } / { "method": "keyFile", "path": "..." }
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    KeyFile { path: String },
}

/// 连接参数。`secret` 是密码或私钥口令——仅驻留内存，绝不持久化、绝不回传。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub secret: Option<String>,
}

// 手写 Debug 以遮蔽 secret——避免密码经 panic/trace/崩溃上报泄露。
impl std::fmt::Debug for ConnectArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectArgs")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("auth", &self.auth)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// 连接结果。不含任何 secret。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub host_key_fingerprint: String,
    pub host_key_trusted: bool,
}

/// R（远程/反向）转发的路由表：远端 bind 端口 → 该端口的隧道任务接收端。
/// 服务端为每个反向连接打开一个 `forwarded-tcpip` channel 到本客户端，
/// `server_channel_open_forwarded_tcpip` 据 `connected_port` 查表后把 channel
/// 投递给对应隧道任务。空表（默认）时所有 forwarded channel 都被丢弃，因此
/// 仅做连接/PTY/SFTP 的会话不受影响。
pub type ForwardedRoutes = Arc<
    std::sync::Mutex<HashMap<u32, tokio::sync::mpsc::UnboundedSender<russh::Channel<client::Msg>>>>,
>;

/// 客户端 Handler：在 `check_server_key` 中捕获服务端主机密钥指纹；并持有
/// R 转发路由表，用以把服务端发起的 forwarded-tcpip channel 路由到隧道任务。
#[derive(Clone, Default)]
pub struct ClientHandler {
    pub fingerprint: Arc<std::sync::Mutex<Option<String>>>,
    pub forwarded: ForwardedRoutes,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 形如 "SHA256:..."。HashAlg::default() == Sha256。
        let fp = server_public_key
            .fingerprint(ssh_key::HashAlg::default())
            .to_string();
        // 可靠写入：本槽仅此一处写、单写者，poison 只可能源于他处 panic，
        // 此时宁可显式 panic 也不要静默丢指纹。
        *self.fingerprint.lock().expect("fingerprint mutex poisoned") = Some(fp);
        // 一律接受（TOFU 校验在 connect_checked 层完成）。
        Ok(true)
    }

    /// 服务端为远程转发新连接打开 forwarded-tcpip channel 时被调用。按
    /// `connected_port`（远端 bind 端口）查路由表，命中则把 channel 交给该
    /// 隧道任务；无路由则丢弃（返回 Ok，不报错、不 panic、不阻塞）。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // 锁仅用于查表+clone sender，立即释放；send 在锁外执行。
        let tx = self
            .forwarded
            .lock()
            .ok()
            .and_then(|map| map.get(&connected_port).cloned());
        if let Some(tx) = tx {
            // 接收端关闭即隧道已撤销：忽略 send 失败，丢弃 channel。
            let _ = tx.send(channel);
        }
        Ok(())
    }
}

// ─── 私有共享核心：只做 TCP 握手 + 认证 ─────────────────────────────────────

/// 建立 TCP+SSH 连接、完成认证，成功后返回 (handle, fingerprint)。
/// 不含 TOFU / known_hosts 逻辑——由 connect_checked 上层处理。
async fn connect_core(
    args: &ConnectArgs,
) -> Result<(Handle<ClientHandler>, String, ForwardedRoutes), SshError> {
    let config = Arc::new(client::Config::default());
    let handler = ClientHandler::default();
    // 在 handler 被 connect 消费前，留住指纹槽与 R 转发路由表的共享句柄。
    let fp_slot = handler.fingerprint.clone();
    let forwarded = handler.forwarded.clone();

    let mut handle = client::connect(config, (args.host.as_str(), args.port), handler)
        .await
        .map_err(|e| SshError::HostUnreachable(e.to_string()))?;

    // check_server_key 在握手中已运行，此时指纹应已被捕获。
    let fingerprint = fp_slot
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();

    let authed = match &args.auth {
        AuthMethod::Password => {
            let secret = args.secret.as_deref().unwrap_or("");
            handle
                .authenticate_password(args.user.as_str(), secret)
                .await
                .map_err(|e| SshError::Io(e.to_string()))?
                .success()
        }
        AuthMethod::KeyFile { path } => {
            let key = russh::keys::load_secret_key(Path::new(path), args.secret.as_deref())
                .map_err(|e| SshError::Io(e.to_string()))?;
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(args.user.as_str(), key_with_alg)
                .await
                .map_err(|e| SshError::Io(e.to_string()))?
                .success()
        }
    };

    if !authed {
        return Err(SshError::AuthFailed);
    }

    Ok((handle, fingerprint, forwarded))
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/// 可测试核心：建立 TCP+SSH 连接、完成认证，成功后返回 (handle, fingerprint)。
/// 命令与集成测试共用此函数（DRY）。
/// 包装 `connect_checked(args, None)` 并丢弃 trusted 布尔。
pub async fn connect_authenticated(
    args: &ConnectArgs,
) -> Result<(Handle<ClientHandler>, String, ForwardedRoutes), SshError> {
    let (handle, fp, forwarded, _trusted) = connect_checked(args, None).await?;
    Ok((handle, fp, forwarded))
}

/// 带 TOFU 校验的连接函数。
///
/// - `known_hosts_dir = None` → accept-any（等同 A4 行为，保留向后兼容）。
/// - `known_hosts_dir = Some(dir)` → 读取 `dir/known_hosts`，执行 verify：
///   - `Trusted`  → `Ok((handle, fp, true))`
///   - `Unknown`  → `Ok((handle, fp, false))`（前端将提示用户信任）
///   - `Mismatch` → 断开连接，返回 `Err(SshError::HostKeyMismatch)`
pub async fn connect_checked(
    args: &ConnectArgs,
    known_hosts_dir: Option<&std::path::Path>,
) -> Result<(Handle<ClientHandler>, String, ForwardedRoutes, bool), SshError> {
    let (handle, fingerprint, forwarded) = connect_core(args).await?;

    let trusted = match known_hosts_dir {
        None => true,
        Some(dir) => {
            let host_port = format!("{}:{}", args.host, args.port);
            let path = dir.join("known_hosts");
            let map = std::fs::read_to_string(&path)
                .map(|s| crate::ssh::knownhosts::parse(&s))
                .unwrap_or_default();
            match crate::ssh::knownhosts::verify(&map, &host_port, &fingerprint) {
                crate::ssh::knownhosts::Verdict::Trusted => true,
                crate::ssh::knownhosts::Verdict::Unknown => false,
                crate::ssh::knownhosts::Verdict::Mismatch => {
                    handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await
                        .ok();
                    return Err(SshError::HostKeyMismatch);
                }
            }
        }
    };

    Ok((handle, fingerprint, forwarded, trusted))
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 建立 SSH 连接（密码认证）。成功后存入 SessionManager 并返回会话信息。
#[tauri::command]
pub async fn ssh_connect(
    args: ConnectArgs,
    mgr: tauri::State<'_, SessionManager>,
    app: tauri::AppHandle,
) -> Result<ConnectResult, SshError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SshError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| SshError::Io(e.to_string()))?;

    let (handle, fingerprint, forwarded, host_key_trusted) =
        connect_checked(&args, Some(dir.as_path())).await?;

    let session_id = SESS_IDS.next();
    mgr.insert(
        session_id.clone(),
        Session {
            handle,
            host: args.host.clone(),
            user: args.user.clone(),
            terms: std::collections::HashMap::new(),
            forwarded,
        },
    )
    .await;

    Ok(ConnectResult {
        session_id,
        host_key_fingerprint: fingerprint,
        host_key_trusted,
    })
}

/// 断开并移除一条会话。会话不存在时返回 NotFound。
#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sess = mgr
        .remove(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    let sess = sess.lock().await;
    sess.handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
    Ok(())
}

/// 将主机密钥指纹写入 known_hosts（TOFU 信任操作）。
#[tauri::command]
pub async fn ssh_trust_host(
    host_port: String,
    fingerprint: String,
    app: tauri::AppHandle,
) -> Result<(), SshError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SshError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| SshError::Io(e.to_string()))?;
    let path = dir.join("known_hosts");
    let mut map = std::fs::read_to_string(&path)
        .map(|s| crate::ssh::knownhosts::parse(&s))
        .unwrap_or_default();
    map.insert(host_port, fingerprint);
    std::fs::write(&path, crate::ssh::knownhosts::serialize(&map))
        .map_err(|e| SshError::Io(e.to_string()))?;
    Ok(())
}
