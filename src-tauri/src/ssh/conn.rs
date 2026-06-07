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

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use russh::client::{self, Handle};
use russh::keys::ssh_key;

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
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub secret: Option<String>,
}

/// 连接结果。不含任何 secret。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub host_key_fingerprint: String,
    pub host_key_trusted: bool,
}

/// 客户端 Handler：在 `check_server_key` 中捕获服务端主机密钥指纹。
/// A5 会在此基础上加入 TOFU / known_hosts 校验。
#[derive(Clone, Default)]
pub struct ClientHandler {
    pub fingerprint: Arc<std::sync::Mutex<Option<String>>>,
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
        if let Ok(mut slot) = self.fingerprint.lock() {
            *slot = Some(fp);
        }
        // TOFU 校验在 A5。当前一律接受。
        Ok(true)
    }
}

/// 可测试核心：建立 TCP+SSH 连接、完成认证，成功后返回 (handle, fingerprint)。
/// 命令与集成测试共用此函数（DRY）。
pub async fn connect_authenticated(
    args: &ConnectArgs,
) -> Result<(Handle<ClientHandler>, String), SshError> {
    let config = Arc::new(client::Config::default());
    let handler = ClientHandler::default();
    // 在 handler 被 connect 消费前，留住指纹槽的共享句柄。
    let fp_slot = handler.fingerprint.clone();

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
        // 密钥文件认证在 A6 实现。
        AuthMethod::KeyFile { .. } => false,
    };

    if !authed {
        return Err(SshError::AuthFailed);
    }

    Ok((handle, fingerprint))
}

/// 建立 SSH 连接（密码认证）。成功后存入 SessionManager 并返回会话信息。
#[tauri::command]
pub async fn ssh_connect(
    args: ConnectArgs,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<ConnectResult, SshError> {
    let (handle, fingerprint) = connect_authenticated(&args).await?;

    let session_id = SESS_IDS.next();
    mgr.insert(
        session_id.clone(),
        Session {
            handle,
            host: args.host.clone(),
            user: args.user.clone(),
        },
    )
    .await;

    Ok(ConnectResult {
        session_id,
        host_key_fingerprint: fingerprint,
        host_key_trusted: true,
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
