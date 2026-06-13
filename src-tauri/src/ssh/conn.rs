//! SSH 客户端连接路径：ClientHandler + connect/authenticate 核心 + Tauri 命令。
//!
//! russh 0.61.2（ring 后端）已确认的客户端 API：
//!   * `russh::client::connect(Arc<Config>, addrs, handler) -> Result<Handle<H>, H::Error>`
//!   * `Handler::check_server_key(&mut self, &russh::keys::ssh_key::PublicKey)
//!     -> impl Future<Output = Result<bool, Self::Error>> + Send`（默认拒绝所有 key）
//!   * `handle.authenticate_password(user, pw) -> Result<AuthResult, russh::Error>`，
//!     成功判定用 `AuthResult::success()`。
//!   * `pubkey.fingerprint(HashAlg::default())` → `Fingerprint`，`Display` 形如
//!     `SHA256:...`。
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

/// 跳板（bastion / jump）主机参数。语义同 `ssh -J jump target`：先连跳板、认证，
/// 再经跳板的 direct-tcpip channel 连到最终目标。`secret` 同样仅驻留内存。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub secret: Option<String>,
}

// 手写 Debug 以遮蔽跳板 secret——理由同 ConnectArgs。
impl std::fmt::Debug for JumpSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JumpSpec")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("auth", &self.auth)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
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
    /// 可选跳板链（v1 仅支持单跳）。`None` → 直连（与历史行为逐字节等价）。
    #[serde(default)]
    pub jump: Option<JumpSpec>,
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
            .field("jump", &self.jump)
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

/// 对一个已建立的 handle 执行认证（密码或私钥），返回是否成功（`.success()`）。
/// 跳板与目标共用此逻辑，避免重复。`secret` 仅传入、不记录。
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    auth: &AuthMethod,
    secret: Option<&str>,
) -> Result<bool, SshError> {
    let ok = match auth {
        AuthMethod::Password => {
            let pw = secret.unwrap_or("");
            handle
                .authenticate_password(user, pw)
                .await
                .map_err(|e| SshError::Io(e.to_string()))?
                .success()
        }
        AuthMethod::KeyFile { path } => {
            let key = russh::keys::load_secret_key(Path::new(path), secret)
                .map_err(|e| SshError::Io(e.to_string()))?;
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(user, key_with_alg)
                .await
                .map_err(|e| SshError::Io(e.to_string()))?
                .success()
        }
    };
    Ok(ok)
}

/// 建立 SSH 连接、完成认证，成功后返回 (handle, fingerprint, forwarded, jump)。
/// 不含 TOFU / known_hosts 逻辑——由 connect_checked 上层处理。
///
/// - `args.jump = None` → 直连（与历史行为逐字节等价），`jump` 返回 `None`。
/// - `args.jump = Some(j)` → 先连+认证跳板，再经其 direct-tcpip channel
///   `connect_stream` 到目标并认证。返回的 jump handle 必须由调用方存活——
///   它一旦 drop，direct-tcpip channel/stream（即目标会话的传输）随之断开。
async fn connect_core(
    args: &ConnectArgs,
) -> Result<
    (
        Handle<ClientHandler>,
        String,
        ForwardedRoutes,
        Option<Handle<ClientHandler>>,
    ),
    SshError,
> {
    // 启用 SSH keepalive:russh 默认 keepalive_interval=None、inactivity_timeout=None,
    // 即空闲时不发任何保活包,服务端的 SSH 空闲断开策略一触发连接就掉线(用户停下查看
    // 命令候选时尤为明显)。每 30s 发一次 keepalive 维持空闲连接;keepalive_max 用默认值
    // (连续多次无响应才判定断开)。注:这维持的是 SSH 传输层活跃,不影响远端 shell 的
    // TMOUT(那是终端输入空闲计时,需服务端配置)。
    let mut config = client::Config::default();
    config.keepalive_interval = Some(std::time::Duration::from_secs(30));
    let config = Arc::new(config);

    match &args.jump {
        // ── 直连路径（与历史行为等价）─────────────────────────────────────
        None => {
            let handler = ClientHandler::default();
            let fp_slot = handler.fingerprint.clone();
            let forwarded = handler.forwarded.clone();

            let mut handle = client::connect(config, (args.host.as_str(), args.port), handler)
                .await
                .map_err(|e| SshError::HostUnreachable(e.to_string()))?;

            let fingerprint = fp_slot
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default();

            if !authenticate(&mut handle, &args.user, &args.auth, args.secret.as_deref()).await? {
                return Err(SshError::AuthFailed);
            }

            Ok((handle, fingerprint, forwarded, None))
        }

        // ── 跳板路径：connect→auth(jump)→direct-tcpip→connect_stream→auth(target) ──
        Some(j) => {
            // 1. 连接 + 认证跳板主机。跳板主机密钥 TOFU 在 v1 暂接受任意 key
            //    （ClientHandler::default 的 check_server_key 返回 Ok(true) 并记录指纹）。
            //    跳板 TOFU 校验留作后续（follow-up）。
            let mut jump_handle = client::connect(
                config.clone(),
                (j.host.as_str(), j.port),
                ClientHandler::default(),
            )
            .await
            .map_err(|e| SshError::HostUnreachable(format!("jump: {e}")))?;

            if !authenticate(&mut jump_handle, &j.user, &j.auth, j.secret.as_deref()).await? {
                // 认证失败发生在跳板这一跳。
                return Err(SshError::AuthFailed);
            }

            // 2. 经跳板打开到目标的 direct-tcpip channel，取其字节流。
            let ch = jump_handle
                .channel_open_direct_tcpip(args.host.clone(), args.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| SshError::Tunnel(format!("jump->target: {e}")))?;
            let stream = ch.into_stream();

            // 3. 在该流上对目标运行一条全新的 SSH 客户端会话并认证。
            let target_handler = ClientHandler::default();
            let fp_slot = target_handler.fingerprint.clone();
            let forwarded = target_handler.forwarded.clone();

            let mut handle = client::connect_stream(config, stream, target_handler)
                .await
                .map_err(|e| SshError::HostUnreachable(format!("target: {e}")))?;

            let fingerprint = fp_slot
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default();

            if !authenticate(&mut handle, &args.user, &args.auth, args.secret.as_deref()).await? {
                return Err(SshError::AuthFailed);
            }

            // 4. 把跳板 handle 一并返回，由调用方保活，维持 direct-tcpip 通道。
            Ok((handle, fingerprint, forwarded, Some(jump_handle)))
        }
    }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/// 可测试核心：建立 SSH 连接、完成认证，成功后返回
/// (handle, fingerprint, forwarded, jump)。命令与集成测试共用此函数（DRY）。
/// 包装 `connect_checked(args, None)` 并丢弃 trusted 布尔。
///
/// 注意：跳板路径下第 4 个返回值 `Some(jump_handle)` **必须**被调用方保活
/// （存进 Session 或就地持有）——它一旦 drop，目标会话的传输（经跳板的
/// direct-tcpip 流）即断开。直连路径下为 `None`。
pub async fn connect_authenticated(
    args: &ConnectArgs,
) -> Result<
    (
        Handle<ClientHandler>,
        String,
        ForwardedRoutes,
        Option<Handle<ClientHandler>>,
    ),
    SshError,
> {
    let (handle, fp, forwarded, jump, _trusted) = connect_checked(args, None).await?;
    Ok((handle, fp, forwarded, jump))
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
) -> Result<
    (
        Handle<ClientHandler>,
        String,
        ForwardedRoutes,
        Option<Handle<ClientHandler>>,
        bool,
    ),
    SshError,
> {
    let (handle, fingerprint, forwarded, jump) = connect_core(args).await?;

    // TOFU 针对的是**目标**主机指纹，键为 target_host:target_port（行为不变）。
    // 跳板主机密钥的 TOFU 在 v1 暂接受任意 key（见 connect_core），后续再补。
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
                    // 跳板 handle 随作用域 drop，链路一并断开。
                    return Err(SshError::HostKeyMismatch);
                }
            }
        }
    };

    Ok((handle, fingerprint, forwarded, jump, trusted))
}

// ─── 连接测试 ───────────────────────────────────────────────────────────────

/// 连接测试结果。不含任何 secret。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// 可测试核心：用 `args`（含 secret）建立连接 + 认证，随即断开。
/// 不存会话、不写 known_hosts（connect_authenticated 接受任意主机密钥）、不记录 secret。
/// `ssh_test` 命令是它的薄包装，使其无需 Tauri State 即可被集成测试。
pub async fn test_connection(args: ConnectArgs) -> TestResult {
    let start = std::time::Instant::now();
    match connect_authenticated(&args).await {
        Ok((handle, _fp, _forwarded, _jump)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            // _jump 在此作用域结束时 drop——连接测试随即断开，无需保活。
            TestResult {
                ok: true,
                latency_ms: start.elapsed().as_millis() as u64,
                error: None,
            }
        }
        Err(e) => TestResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
        },
    }
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 测试一条 SSH 连接：连接 + 认证后立即断开，返回是否成功与往返耗时。
/// 不存会话、不写 known_hosts、不回传也不记录 secret。
#[tauri::command]
pub async fn ssh_test(args: ConnectArgs) -> Result<TestResult, SshError> {
    Ok(test_connection(args).await)
}

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

    let (handle, fingerprint, forwarded, jump, host_key_trusted) =
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
            // 保活跳板 handle（若有），维持目标会话经跳板的 direct-tcpip 传输。
            _jump: jump,
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
///
/// 清理顺序：先中止并移除该会话的周期监控任务（若有；无则 no-op），
/// 再从 manager 移除会话本身。移除 `Session` 会 drop 其 `terms` 中的所有
/// mpsc 发送端——各终端 owner 任务在 channel 关闭时自行结束，故无需显式处理。
///
/// 已知限制：隧道（tunnels）以隧道 id 为键、不与会话生命周期绑定，故断开会话
/// 时**不会**自动关闭其隧道。用户须经 `tunnel_close` 主动关闭。
#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    // 先中止监控任务，避免它在已死的 handle 上继续 exec。无监控任务时为 no-op。
    mgr.remove_monitor(&session_id).await;

    // 再移除会话；不存在则 NotFound（监控已在上一步清理）。
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
