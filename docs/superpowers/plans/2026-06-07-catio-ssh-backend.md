# Catio SSH/终端后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真实 SSH（连接/认证、交互式 PTY 终端、SFTP、L/R/D 端口转发隧道、无 agent 系统监控、多机广播执行）接入 Catio，替换 UI 外壳中的 mock，前端组件树与像素呈现不变。

**Architecture:** Rust `src-tauri/src/ssh/` 用 `russh`/`russh-sftp` 暴露一组 Tauri commands + events；前端 `src/services/ssh.ts` 包装这些 command，非 Tauri 环境回退现有 mock（沿用 `services/models.ts` 的 `isTauri` 探测模式）。终端中间表面换成 xterm.js，工具栏/头部 chrome 保持不变。

**Tech Stack:** Rust + russh + russh-sftp + tokio + thiserror + base64；React 18 + TypeScript + `@xterm/xterm` + `@xterm/addon-fit`；Vitest（前端）+ `cargo test` 进程内 russh server（Rust 集成测试）。

**Spec:** `docs/superpowers/specs/2026-06-07-catio-ssh-backend-design.md`

---

## 实现者须读：russh API 漂移说明（非占位符，是工程指令）

russh 是快速演进的 crate。本计划的 Rust 代码基于 russh 当前 `main`（2025–2026 的 0.5x 系列）API 写成：`client::connect` / `Handler::check_server_key` / `authenticate_password` / `authenticate_publickey` / `channel_open_session` / `channel.exec` / `channel.wait() → ChannelMsg::Data` / `russh-sftp` 的 `SftpSession`。

**如果某个签名与你 `cargo add` 装到的版本对不上**：以编译器与该版本 docs.rs 为准微调签名（参数顺序、`PrivateKeyWithHashAlg` 的构造、`Handler` 方法名），**语义不变**。每个 Rust 任务都带编译 + 测试步骤，漂移会在那里暴露并修正。不要把对不上的地方留成 TODO——查该版本 docs 改对。

参考实现：Reach（github.com/alexandrosnt/Reach，MIT）的 `src-tauri` russh 代码。逐段拷贝时在文件头注明 `// adapted from Reach src-tauri/<file>, MIT`。

---

## 文件结构

### Rust 后端 `src-tauri/src/ssh/`

| 文件 | 职责 |
| --- | --- |
| `mod.rs` | 模块导出；`SshError`（thiserror，serde 标签联合）；`SessionManager` 类型别名 |
| `ids.rs` | 单调 ID 生成器（`sess-N`/`chan-N`/`tun-N`/`run-N`），纯函数可单测 |
| `manager.rs` | `SessionManager`：`Mutex<HashMap<SessionId, Session>>`，`Session` 持 `client::Handle<ClientHandler>` + 元信息 + 子句柄表 |
| `conn.rs` | `ssh_connect` / `ssh_disconnect` / `ssh_trust_host` + `ClientHandler`(check_server_key) |
| `knownhosts.rs` | `known_hosts` 读/写/比对 + 指纹格式化，纯函数可单测 |
| `term.rs` | `term_open` / `term_write` / `term_resize` / `term_close` + `term://{chanId}` 事件 |
| `sftp.rs` | `sftp_list/download/upload/mkdir/rename/delete` + `sftp-progress://{op}` 事件 |
| `tunnel.rs` | `tunnel_open`(L/R/D) / `tunnel_close` / `tunnel_list` + `tunnel://{id}` 事件 |
| `monitor.rs` | `monitor_start/stop` + `monitor://{sessionId}` 事件 |
| `multiexec.rs` | `multiexec_run` + `multiexec://{runId}` 事件 |
| `parse.rs` | 纯解析：监控输出（/proc/stat、free、net/dev、df、ps、nvidia-smi）、sftp 属性 → SftpItem、字节数格式化。可单测 |
| `tests/common/test_server.rs` | 进程内 russh server 测试夹具（逐阶段扩展：auth+shell+exec → sftp → forward） |

### 前端 `src/`

| 文件 | 职责 |
| --- | --- |
| `services/ssh.ts`（新） | 包装所有 ssh command + 事件订阅 helper；`isTauri` 假时回退 mock |
| `services/index.ts`（改） | `getTermBuffer/getSftp/getTunnels/getMonitor` 内部转调 ssh.ts，签名不变 |
| `state/connections.ts`（新） | 连接档案（非敏感）localStorage 读写，key `catio-connections` |
| `components/workbench/TerminalPane.tsx`（改） | 中间表面换 xterm.js；chrome 不变；接 term_*；Multi-Exec 接 multiexec_run |
| `components/panels/SftpPanel.tsx`（改） | 接 sftp_* + 进度 |
| `components/panels/TunnelsPanel.tsx`（改） | 接 tunnel_* + 字节事件 |
| `components/panels/MonitorPanel.tsx`（改） | 接 monitor_* + 事件订阅 |
| `components/modals/NewConnectionModal.tsx`（改） | 认证方式字段（密钥文件路径 / 密码） |
| `components/modals/ConnectSecretPrompt.tsx`（新） | 连接时密码/passphrase 弹框，秘密仅内存 |

### Tauri 权限

`src-tauri/capabilities/default.json` 不新增插件权限（ssh 走自定义 command，core 默认即可）。若用 `tauri-plugin-dialog` 选密钥文件，则在该任务追加其权限。

---

# 阶段 A：连接 + 终端

## Task A1: Rust ssh 模块骨架 + 依赖 + 错误类型

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加依赖**

Run（在 `src-tauri/`）：
```bash
cd src-tauri
cargo add russh russh-sftp thiserror base64
cargo add tokio --features rt-multi-thread,macros,net,io-util,sync,time,process
cargo add serde --features derive
```
Expected: `Cargo.toml` 出现 `russh`、`russh-sftp`、`thiserror`、`base64`、`tokio`。

- [ ] **Step 2: 写 `SshError`（先让它编译）**

Create `src-tauri/src/ssh/mod.rs`:
```rust
//! Catio SSH backend (sub-project 2). russh-based.
pub mod ids;

use serde::Serialize;

/// 序列化成前端可判别的标签联合：{ kind: "AuthFailed", message: "..." }
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("authentication failed")]
    AuthFailed,
    #[error("host unreachable: {0}")]
    HostUnreachable(String),
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("channel closed")]
    ChannelClosed,
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("sftp error: {0}")]
    Sftp(String),
    #[error("tunnel error: {0}")]
    Tunnel(String),
    #[error("io error: {0}")]
    Io(String),
}

impl Serialize for SshError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            SshError::AuthFailed => ("AuthFailed", self.to_string()),
            SshError::HostUnreachable(_) => ("HostUnreachable", self.to_string()),
            SshError::HostKeyMismatch => ("HostKeyMismatch", self.to_string()),
            SshError::ChannelClosed => ("ChannelClosed", self.to_string()),
            SshError::NotFound(_) => ("NotFound", self.to_string()),
            SshError::Sftp(_) => ("Sftp", self.to_string()),
            SshError::Tunnel(_) => ("Tunnel", self.to_string()),
            SshError::Io(_) => ("Io", self.to_string()),
        };
        let mut st = s.serialize_struct("SshError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}
```

- [ ] **Step 3: 在 lib.rs 挂模块（暂不注册 command）**

Modify `src-tauri/src/lib.rs`：在 `pub fn run()` 上方加 `mod ssh;`。

- [ ] **Step 4: 编译**

Run: `cd src-tauri && cargo build`
Expected: 编译通过（warnings about unused 可接受）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ssh/mod.rs src-tauri/src/lib.rs
git commit -m "feat(ssh): module skeleton + deps + SshError"
```

---

## Task A2: ID 生成器（纯函数 TDD）

**Files:**
- Create: `src-tauri/src/ssh/ids.rs`

- [ ] **Step 1: 写失败测试**

Create `src-tauri/src/ssh/ids.rs`:
```rust
use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调 ID 生成器。prefix 形如 "sess" → "sess-1","sess-2"...
pub struct IdGen {
    prefix: &'static str,
    n: AtomicU64,
}

impl IdGen {
    pub const fn new(prefix: &'static str) -> Self {
        Self { prefix, n: AtomicU64::new(0) }
    }
    pub fn next(&self) -> String {
        let v = self.n.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{}-{}", self.prefix, v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_monotonic_and_prefixed() {
        let g = IdGen::new("sess");
        assert_eq!(g.next(), "sess-1");
        assert_eq!(g.next(), "sess-2");
        assert_eq!(g.next(), "sess-3");
    }
}
```

- [ ] **Step 2: 运行测试确认失败→通过**

Run: `cd src-tauri && cargo test ids_are_monotonic`
Expected: PASS（首次写即实现，PASS 即可）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ssh/ids.rs
git commit -m "feat(ssh): monotonic id generator"
```

---

## Task A3: 进程内 russh 测试 server 夹具（auth + shell echo + exec）

这是后续所有集成测试的地基。它是一个最小 russh server，监听随机本地端口，接受固定密码 `catio-test-pw`（用户 `tester`）与一把固定测试公钥，shell 把收到的字节回显（echo），exec 把命令字符串原样回吐到 stdout 再退出。

**Files:**
- Create: `src-tauri/tests/common/mod.rs`
- Create: `src-tauri/tests/common/test_server.rs`
- Create: `src-tauri/tests/ssh_conn.rs`（占位集成测试，确认夹具能起停）

- [ ] **Step 1: 写测试 server 夹具**

Create `src-tauri/tests/common/test_server.rs`:
```rust
// 进程内 russh 测试 server。仅用于集成测试。
use std::sync::Arc;
use russh::server::{Auth, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, CryptoVec};
use russh::keys::PrivateKey;

pub const TEST_USER: &str = "tester";
pub const TEST_PW: &str = "catio-test-pw";

#[derive(Clone)]
pub struct TestServer;

pub struct TestHandler {
    // 每个 channel 是否已进入 shell（用于 echo）
    shell_on: std::collections::HashSet<ChannelId>,
}

impl Server for TestServer {
    type Handler = TestHandler;
    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> TestHandler {
        TestHandler { shell_on: Default::default() }
    }
}

impl Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_USER && password == TEST_PW {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(&mut self, user: &str, _key: &russh::keys::ssh_key::PublicKey)
        -> Result<Auth, Self::Error> {
        // 测试夹具：接受任意公钥的 tester（密钥认证路径用）
        if user == TEST_USER { Ok(Auth::Accept) } else { Ok(Auth::reject()) }
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, _session: &mut Session)
        -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn pty_request(&mut self, _channel: ChannelId, _term: &str, _w: u32, _h: u32,
        _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], _session: &mut Session)
        -> Result<(), Self::Error> { Ok(()) }

    async fn shell_request(&mut self, channel: ChannelId, _session: &mut Session)
        -> Result<(), Self::Error> {
        self.shell_on.insert(channel);
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session)
        -> Result<(), Self::Error> {
        // 把命令原样回吐，再发 exit-status 0 并关闭
        let mut out = CryptoVec::new();
        out.extend(data);
        out.extend(b"\n");
        session.data(channel, out)?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session)
        -> Result<(), Self::Error> {
        // shell echo：把输入回显出去
        if self.shell_on.contains(&channel) {
            let mut out = CryptoVec::new();
            out.extend(data);
            session.data(channel, out)?;
        }
        Ok(())
    }
}

/// 起一个测试 server，返回监听地址。后台 tokio task 持续 accept。
pub async fn start() -> std::net::SocketAddr {
    let key = PrivateKey::random(&mut rand_core::OsRng, russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut server = TestServer;
        loop {
            let (socket, peer) = match listener.accept().await { Ok(v) => v, Err(_) => break };
            let handler = server.new_client(Some(peer));
            let cfg = config.clone();
            tokio::spawn(async move {
                let _ = russh::server::run_stream(cfg, socket, handler).await;
            });
        }
    });
    addr
}
```

Create `src-tauri/tests/common/mod.rs`:
```rust
pub mod test_server;
```

- [ ] **Step 2: 占位集成测试，确认夹具起得来**

Create `src-tauri/tests/ssh_conn.rs`:
```rust
mod common;
use common::test_server;

#[tokio::test]
async fn test_server_starts_and_binds() {
    let addr = test_server::start().await;
    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert!(addr.port() > 0);
}
```

- [ ] **Step 3: 加测试用依赖**

Run:
```bash
cd src-tauri
cargo add --dev tokio --features rt-multi-thread,macros,net,io-util,time
cargo add --dev rand_core --features getrandom
```

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --test ssh_conn`
Expected: `test_server_starts_and_binds` PASS。若 `run_stream` / `PrivateKey::random` / `Auth::reject` 签名漂移，依该版本 docs 修正（见顶部漂移说明）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "test(ssh): in-process russh test server fixture (auth+shell echo+exec)"
```

---

## Task A4: SessionManager + ssh_connect（密码认证）+ ClientHandler

**Files:**
- Create: `src-tauri/src/ssh/manager.rs`
- Create: `src-tauri/src/ssh/conn.rs`
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/ssh_conn.rs`

- [ ] **Step 1: SessionManager**

Create `src-tauri/src/ssh/manager.rs`:
```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::ssh::conn::ClientHandler;

pub struct Session {
    pub handle: russh::client::Handle<ClientHandler>,
    pub host: String,
    pub user: String,
}

#[derive(Default)]
pub struct SessionManager {
    pub sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl SessionManager {
    pub async fn insert(&self, id: String, sess: Session) {
        self.sessions.lock().await.insert(id, Arc::new(Mutex::new(sess)));
    }
    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.get(id).cloned()
    }
    pub async fn remove(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.remove(id)
    }
}
```

- [ ] **Step 2: ClientHandler + ssh_connect（密码）**

Create `src-tauri/src/ssh/conn.rs`:
```rust
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use russh::client;
use crate::ssh::{SshError, ids::IdGen, manager::{Session, SessionManager}};

static SESS_IDS: IdGen = IdGen::new("sess");

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    KeyFile { path: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// 密码或私钥 passphrase；仅内存，不落盘，不回前端
    pub secret: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub host_key_fingerprint: String,
    pub host_key_trusted: bool,
}

/// 连接握手期间记录服务器公钥指纹；TOFU 判定在 Task A5 接入。
pub struct ClientHandler {
    pub fingerprint: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(Default::default()).to_string();
        *self.fingerprint.lock().unwrap() = Some(fp);
        Ok(true) // A5 会换成 known_hosts 判定
    }
}

#[tauri::command]
pub async fn ssh_connect(
    args: ConnectArgs,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<ConnectResult, SshError> {
    let config = Arc::new(client::Config::default());
    let fingerprint = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler { fingerprint: fingerprint.clone() };

    let mut handle = client::connect(config, (args.host.as_str(), args.port), handler)
        .await
        .map_err(|e| SshError::HostUnreachable(e.to_string()))?;

    let ok = match &args.auth {
        AuthMethod::Password => {
            let pw = args.secret.clone().unwrap_or_default();
            handle.authenticate_password(&args.user, pw)
                .await.map_err(|e| SshError::Io(e.to_string()))?
                .success()
        }
        AuthMethod::KeyFile { .. } => false, // Task A6 接入
    };
    if !ok { return Err(SshError::AuthFailed); }

    let id = SESS_IDS.next();
    let fp = fingerprint.lock().unwrap().clone().unwrap_or_default();
    mgr.insert(id.clone(), Session { handle, host: args.host.clone(), user: args.user.clone() }).await;
    Ok(ConnectResult { session_id: id, host_key_fingerprint: fp, host_key_trusted: true })
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    if let Some(sess) = mgr.remove(&session_id).await {
        let s = sess.lock().await;
        let _ = s.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        Ok(())
    } else {
        Err(SshError::NotFound(session_id))
    }
}
```

- [ ] **Step 3: 导出 + 注册 state 与 command**

Modify `src-tauri/src/ssh/mod.rs`：加 `pub mod manager; pub mod conn;`

Modify `src-tauri/src/lib.rs`：
```rust
mod ssh;
use ssh::manager::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            ssh::conn::ssh_connect,
            ssh::conn::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: 集成测试：连接 + 密码认证**

为了在集成测试里直接调认证逻辑而不经过 Tauri State，把核心连接逻辑抽到一个可测函数。在 `conn.rs` 加：
```rust
/// 可测核心：建立已认证的 handle（集成测试与 command 共用）
pub async fn connect_authenticated(args: &ConnectArgs)
    -> Result<(russh::client::Handle<ClientHandler>, String), SshError> {
    let config = Arc::new(client::Config::default());
    let fingerprint = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler { fingerprint: fingerprint.clone() };
    let mut handle = client::connect(config, (args.host.as_str(), args.port), handler)
        .await.map_err(|e| SshError::HostUnreachable(e.to_string()))?;
    let ok = match &args.auth {
        AuthMethod::Password => handle
            .authenticate_password(&args.user, args.secret.clone().unwrap_or_default())
            .await.map_err(|e| SshError::Io(e.to_string()))?.success(),
        AuthMethod::KeyFile { .. } => false,
    };
    if !ok { return Err(SshError::AuthFailed); }
    let fp = fingerprint.lock().unwrap().clone().unwrap_or_default();
    Ok((handle, fp))
}
```
并把 `ssh_connect` 改成调用 `connect_authenticated`（DRY）。

把集成测试库设为可见：在 `src-tauri/Cargo.toml` 确认 `[lib] name = "catio_lib"` 已存在（是）。测试通过 `catio_lib::ssh::...` 访问——为此 `ssh` 模块需 `pub`。Modify `lib.rs` 的 `mod ssh;` → `pub mod ssh;`，且 `mod.rs` 各子模块 `pub`。

Append to `src-tauri/tests/ssh_conn.rs`:
```rust
use catio_lib::ssh::conn::{connect_authenticated, ConnectArgs, AuthMethod};

#[tokio::test]
async fn connects_with_password() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(), port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, fp) = connect_authenticated(&args).await.expect("should connect");
    assert!(!fp.is_empty(), "fingerprint captured");
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
}

#[tokio::test]
async fn rejects_wrong_password() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(), port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some("wrong".into()),
    };
    assert!(connect_authenticated(&args).await.is_err());
}
```

- [ ] **Step 5: 跑测试**

Run: `cd src-tauri && cargo test --test ssh_conn`
Expected: `connects_with_password`、`rejects_wrong_password` 均 PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests/ssh_conn.rs
git commit -m "feat(ssh): SessionManager + ssh_connect (password) + ClientHandler"
```

---

## Task A5: 主机密钥 TOFU（known_hosts）

**Files:**
- Create: `src-tauri/src/ssh/knownhosts.rs`
- Modify: `src-tauri/src/ssh/conn.rs`
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 纯函数 TDD — known_hosts 读写比对**

Create `src-tauri/src/ssh/knownhosts.rs`:
```rust
use std::collections::HashMap;

/// known_hosts 极简格式：每行 `host:port fingerprint`。
/// 返回 host:port → fingerprint 映射。
pub fn parse(contents: &str) -> HashMap<String, String> {
    contents.lines().filter_map(|l| {
        let l = l.trim();
        if l.is_empty() || l.starts_with('#') { return None; }
        let (h, f) = l.split_once(' ')?;
        Some((h.to_string(), f.to_string()))
    }).collect()
}

pub fn serialize(map: &HashMap<String, String>) -> String {
    let mut lines: Vec<String> = map.iter().map(|(h, f)| format!("{h} {f}")).collect();
    lines.sort();
    lines.join("\n") + "\n"
}

pub enum Verdict { Trusted, Unknown, Mismatch }

pub fn verify(map: &HashMap<String, String>, host_port: &str, fp: &str) -> Verdict {
    match map.get(host_port) {
        Some(known) if known == fp => Verdict::Trusted,
        Some(_) => Verdict::Mismatch,
        None => Verdict::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_verify() {
        let mut m = HashMap::new();
        m.insert("h:22".to_string(), "SHA256:abc".to_string());
        let s = serialize(&m);
        let m2 = parse(&s);
        assert_eq!(m, m2);
        assert!(matches!(verify(&m2, "h:22", "SHA256:abc"), Verdict::Trusted));
        assert!(matches!(verify(&m2, "h:22", "SHA256:xxx"), Verdict::Mismatch));
        assert!(matches!(verify(&m2, "other:22", "SHA256:abc"), Verdict::Unknown));
    }
}
```

- [ ] **Step 2: 跑纯函数测试**

Run: `cd src-tauri && cargo test roundtrip_and_verify`
Expected: PASS。

- [ ] **Step 3: 接入连接流程 + ssh_trust_host**

在 `conn.rs`：`connect_authenticated` 取得 `fp` 后，读 app 数据目录 `known_hosts`（command 版用 `tauri::Manager::path()`；核心函数版接收一个 `known_hosts_dir: Option<&Path>` 参数，测试传临时目录）。判定：
- `Trusted` → `host_key_trusted=true`
- `Unknown` → `host_key_trusted=false`（仍返回 session，前端弹信任框；信任后调 `ssh_trust_host` 写入）
- `Mismatch` → 断开并 `Err(SshError::HostKeyMismatch)`

加 command：
```rust
#[tauri::command]
pub async fn ssh_trust_host(
    host_port: String, fingerprint: String, app: tauri::AppHandle,
) -> Result<(), SshError> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| SshError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| SshError::Io(e.to_string()))?;
    let path = dir.join("known_hosts");
    let mut map = std::fs::read_to_string(&path).map(|s| crate::ssh::knownhosts::parse(&s)).unwrap_or_default();
    map.insert(host_port, fingerprint);
    std::fs::write(&path, crate::ssh::knownhosts::serialize(&map)).map_err(|e| SshError::Io(e.to_string()))?;
    Ok(())
}
```
在 `lib.rs` 的 `generate_handler!` 注册 `ssh::conn::ssh_trust_host`。`mod.rs` 加 `pub mod knownhosts;`。

- [ ] **Step 4: 集成测试 — 不匹配拒绝**

Append to `tests/ssh_conn.rs`：写一个测试，往临时 `known_hosts` 预置 `addr → "SHA256:bogus"`，调带该目录的核心连接函数，断言返回 `HostKeyMismatch`。
```rust
use catio_lib::ssh::knownhosts;
#[tokio::test]
async fn rejects_host_key_mismatch() {
    let dir = std::env::temp_dir().join(format!("catio-kh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let addr = test_server::start().await;
    let hp = format!("{}:{}", addr.ip(), addr.port());
    std::fs::write(dir.join("known_hosts"), format!("{hp} SHA256:bogus\n")).unwrap();
    let args = ConnectArgs { host: addr.ip().to_string(), port: addr.port(),
        user: test_server::TEST_USER.into(), auth: AuthMethod::Password, secret: Some(test_server::TEST_PW.into()) };
    let res = catio_lib::ssh::conn::connect_checked(&args, Some(dir.as_path())).await;
    assert!(matches!(res, Err(catio_lib::ssh::SshError::HostKeyMismatch)));
    let _ = std::fs::remove_dir_all(&dir);
}
```
（实现 `connect_checked(args, known_hosts_dir)`：内部调 `connect_authenticated` 风格逻辑但在握手后用 `knownhosts::verify` 判定；`connect_authenticated` 保留为「接受任意主机」的便捷版，或让它委托 `connect_checked(args, None)`。）

- [ ] **Step 5: 跑测试 + 编译**

Run: `cd src-tauri && cargo test --test ssh_conn && cargo build`
Expected: 全 PASS，编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests/ssh_conn.rs
git commit -m "feat(ssh): TOFU host-key verification via known_hosts"
```

---

## Task A6: 密钥文件认证

**Files:**
- Modify: `src-tauri/src/ssh/conn.rs`
- Modify: `src-tauri/tests/ssh_conn.rs`
- Create: `src-tauri/tests/fixtures/`（生成测试密钥）

- [ ] **Step 1: 生成测试私钥（一次性，提交进 fixtures）**

Run:
```bash
mkdir -p src-tauri/tests/fixtures
ssh-keygen -t ed25519 -N "" -f src-tauri/tests/fixtures/id_test -C catio-test
```
Expected: 生成 `id_test`（私钥）与 `id_test.pub`。

- [ ] **Step 2: 实现密钥认证分支**

在 `conn.rs` 的认证 `match` 里把 `KeyFile { path }` 实现为：
```rust
AuthMethod::KeyFile { path } => {
    let key = russh::keys::load_secret_key(path, args.secret.as_deref())
        .map_err(|e| SshError::Io(e.to_string()))?;
    let with = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
    handle.authenticate_publickey(&args.user, with)
        .await.map_err(|e| SshError::Io(e.to_string()))?.success()
}
```
（若该 russh 版本 `authenticate_publickey` 签名不同，按 docs 调整；语义=用私钥认证。）

- [ ] **Step 3: 集成测试 — 密钥认证**

Append to `tests/ssh_conn.rs`：
```rust
#[tokio::test]
async fn connects_with_key_file() {
    let addr = test_server::start().await;
    let key_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/id_test");
    let args = ConnectArgs { host: addr.ip().to_string(), port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::KeyFile { path: key_path.into() }, secret: None };
    let (handle, _fp) = connect_authenticated(&args).await.expect("key auth");
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
}
```

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --test ssh_conn connects_with_key_file`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ssh/conn.rs src-tauri/tests
git commit -m "feat(ssh): private-key-file authentication"
```

---

## Task A7: 终端 PTY（term_open/write/resize/close + term:// 事件）

**Files:**
- Create: `src-tauri/src/ssh/term.rs`
- Modify: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/ssh/manager.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/ssh_term.rs`

设计：**每个终端通道一个 owner 任务**，用 `tokio::select!` 在「读 `channel.wait()` → emit」与「收 mpsc 指令（写/resize/关）」之间二选一。channel 由该任务独占，无锁、无死锁。manager 只存指令发送端 `mpsc::UnboundedSender<TermCmd>`。

- [ ] **Step 1: manager 存终端指令发送端**

Modify `manager.rs`：`Session` 加字段 `pub terms: HashMap<String, tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>>`。**同时改 `conn.rs` 里构造 `Session` 的结构体字面量**（A4 的 `Session { handle, host: ..., user: ... }`）补上 `terms: HashMap::new()`，否则缺字段编译报错。加方法：
```rust
pub fn insert_term(&mut self, id: String, tx: tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>) {
    self.terms.insert(id, tx);
}
pub fn get_term(&self, id: &str) -> Option<tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>> {
    self.terms.get(id).cloned() // UnboundedSender clone 很廉价
}
pub fn remove_term(&mut self, id: &str) -> Option<tokio::sync::mpsc::UnboundedSender<crate::ssh::term::TermCmd>> {
    self.terms.remove(id)
}
```

- [ ] **Step 2: term.rs（owner 任务 + 四个 command）**

Create `src-tauri/src/ssh/term.rs`:
```rust
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use tauri::Emitter;
use tokio::sync::mpsc;
use russh::ChannelMsg;
use crate::ssh::{SshError, ids::IdGen, manager::SessionManager};

static CHAN_IDS: IdGen = IdGen::new("chan");

/// 发给「拥有 channel 的 owner 任务」的指令
pub enum TermCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[tauri::command]
pub async fn term_open(
    session_id: String, cols: u32, rows: u32,
    app: tauri::AppHandle, mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    let sess = mgr.get(&session_id).await.ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    let mut channel = {
        let s = sess.lock().await;
        s.handle.channel_open_session().await.map_err(|e| SshError::Io(e.to_string()))?
    };
    channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await
        .map_err(|e| SshError::Io(e.to_string()))?;
    channel.request_shell(false).await.map_err(|e| SshError::Io(e.to_string()))?;

    let chan_id = CHAN_IDS.next();
    let evt = format!("term://{chan_id}");
    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();

    // 单一 owner 任务独占 channel：select 读事件 vs 收指令。无锁、无死锁。
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) =>
                        { let _ = app.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(data) })); }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) =>
                        { let _ = app.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(data) })); }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        let _ = app.emit(&evt, serde_json::json!({ "closed": true }));
                        break;
                    }
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(TermCmd::Write(bytes)) => { let _ = channel.data(&bytes[..]).await; }
                    Some(TermCmd::Resize(c, r)) => { let _ = channel.window_change(c, r, 0, 0).await; }
                    Some(TermCmd::Close) | None => { let _ = channel.eof().await; break; }
                },
            }
        }
    });

    sess.lock().await.insert_term(chan_id.clone(), tx);
    Ok(chan_id)
}

#[tauri::command]
pub async fn term_write(
    session_id: String, chan_id: String, data_base64: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sess = mgr.get(&session_id).await.ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    let bytes = B64.decode(data_base64.as_bytes()).map_err(|e| SshError::Io(e.to_string()))?;
    let tx = sess.lock().await.get_term(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Write(bytes)).map_err(|_| SshError::ChannelClosed)
}

#[tauri::command]
pub async fn term_resize(
    session_id: String, chan_id: String, cols: u32, rows: u32,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sess = mgr.get(&session_id).await.ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    let tx = sess.lock().await.get_term(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Resize(cols, rows)).map_err(|_| SshError::ChannelClosed)
}

#[tauri::command]
pub async fn term_close(
    session_id: String, chan_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    let sess = mgr.get(&session_id).await.ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    if let Some(tx) = sess.lock().await.remove_term(&chan_id) {
        let _ = tx.send(TermCmd::Close); // owner 任务收到后 eof + 退出，drop channel
    }
    Ok(())
}
```
（若该 russh 版本 `ChannelMsg` 变体名/`window_change`/`channel.data` 签名不同，按 docs 微调；语义=收 shell 字节、写键击、改窗口、关闭。`mod.rs` 加 `pub mod term;`。）

- [ ] **Step 3: 注册 command + 集成测试**

`lib.rs` 的 `generate_handler!` 注册 `term_open/term_write/term_resize/term_close`。`mod.rs` 加 `pub mod term;`（若 Step 2 已加则跳过）。

集成测试不经 Tauri（无 AppHandle 易测），所以把「打开 pty-shell、写字节、收回显」的核心逻辑抽成 `term::open_shell_channel(handle) -> Channel` 等可测函数，测试里：连接 test server → 开 shell 通道 → 写 `b"hello"` → `wait()` 收到含 `hello` 的 `ChannelMsg::Data`。

Create `src-tauri/tests/ssh_term.rs`:
```rust
mod common;
use common::test_server;
use catio_lib::ssh::conn::{connect_authenticated, ConnectArgs, AuthMethod};

#[tokio::test]
async fn pty_shell_echoes_input() {
    let addr = test_server::start().await;
    let args = ConnectArgs { host: addr.ip().to_string(), port: addr.port(),
        user: test_server::TEST_USER.into(), auth: AuthMethod::Password, secret: Some(test_server::TEST_PW.into()) };
    let (handle, _) = connect_authenticated(&args).await.unwrap();
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await.unwrap();
    ch.request_shell(false).await.unwrap();
    ch.data(&b"hello"[..]).await.unwrap();
    let mut got = Vec::new();
    while let Some(msg) = ch.wait().await {
        if let russh::ChannelMsg::Data { ref data } = msg {
            got.extend_from_slice(data);
            if got.windows(5).any(|w| w == b"hello") { break; }
        }
    }
    assert!(got.windows(5).any(|w| w == b"hello"));
}
```

- [ ] **Step 4: 跑测试 + 编译**

Run: `cd src-tauri && cargo test --test ssh_term && cargo build`
Expected: `pty_shell_echoes_input` PASS，`cargo build` 通过（command 实现完整无 `todo!`）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests/ssh_term.rs
git commit -m "feat(ssh): interactive PTY terminal commands + term:// events"
```

---

## Task A8: 前端 services/ssh.ts（包装 + mock 回退）

**Files:**
- Create: `src/services/ssh.ts`
- Create: `src/services/ssh.test.ts`
- Modify: `src/services/index.ts`

- [ ] **Step 1: 写失败测试（mock invoke）**

Create `src/services/ssh.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模拟 Tauri 环境与 invoke
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('services/ssh', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('sshConnect forwards args to invoke under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ sessionId: 'sess-1', hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true })
    const { sshConnect } = await import('./ssh')
    const r = await sshConnect({ host: 'h', port: 22, user: 'u', auth: { method: 'password' }, secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('ssh_connect', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.sessionId).toBe('sess-1')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('getSftp falls back to mock DATA outside Tauri', async () => {
    const { getSftp } = await import('./ssh')
    const s = await getSftp('any')
    expect(s.items.length).toBeGreaterThan(0) // 来自 mockData
  })
})
```

- [ ] **Step 2: 实现 ssh.ts**

Create `src/services/ssh.ts`:
```ts
import { DATA } from './mockData'
import type { Sftp, Tunnel, Monitor, TermLine } from './types'

const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export type AuthMethod = { method: 'password' } | { method: 'keyFile'; path: string }

export interface SshConnectArgs {
  host: string; port: number; user: string; auth: AuthMethod; secret?: string
}
export interface SshConnectResult {
  sessionId: string; hostKeyFingerprint: string; hostKeyTrusted: boolean
}

export async function sshConnect(args: SshConnectArgs): Promise<SshConnectResult> {
  return invoke<SshConnectResult>('ssh_connect', { args })
}
export async function sshDisconnect(sessionId: string): Promise<void> {
  return invoke('ssh_disconnect', { sessionId })
}
export async function sshTrustHost(hostPort: string, fingerprint: string): Promise<void> {
  return invoke('ssh_trust_host', { hostPort, fingerprint })
}

// 终端
export async function termOpen(sessionId: string, cols: number, rows: number): Promise<string> {
  return invoke<string>('term_open', { sessionId, cols, rows })
}
export async function termWrite(sessionId: string, chanId: string, dataBase64: string): Promise<void> {
  return invoke('term_write', { sessionId, chanId, dataBase64 })
}
export async function termResize(sessionId: string, chanId: string, cols: number, rows: number): Promise<void> {
  return invoke('term_resize', { sessionId, chanId, cols, rows })
}
export async function termClose(sessionId: string, chanId: string): Promise<void> {
  return invoke('term_close', { sessionId, chanId })
}

// 事件订阅 helper（非 Tauri 环境返回 no-op）
export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, e => cb(e.payload))
}

// ---- mock 回退（非 Tauri 时供面板用，签名同 services/index.ts） ----
export async function getSftp(_id: string): Promise<Sftp> { return DATA.sftp }
export async function getTunnels(_id: string): Promise<Tunnel[]> { return DATA.tunnels }
export async function getMonitor(_id: string): Promise<Monitor> { return DATA.monitor }
export async function getTermBuffer(_id: string): Promise<TermLine[]> { return DATA.termLines }
```
（B/C/D 阶段会把 getSftp/getTunnels/getMonitor 在 Tauri 下改为真 invoke；此处先回退 mock，保证非 Tauri 与测试可用。）

- [ ] **Step 3: index.ts 转调**

Modify `src/services/index.ts`：把 `getTermBuffer/getSftp/getTunnels/getMonitor` 改为 `export { ... } from './ssh'`（删掉本地 mock 实现，保留其余 DB getters 不动）。

- [ ] **Step 4: 跑测试**

Run: `npm test -- src/services/ssh.test.ts`
Expected: 2 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/ssh.ts src/services/ssh.test.ts src/services/index.ts
git commit -m "feat(ssh/fe): services/ssh.ts wrapper with mock fallback"
```

---

## Task A9: 连接档案 state + NewConnectionModal 认证字段 + ConnectSecretPrompt

**Files:**
- Create: `src/state/connections.ts`
- Create: `src/state/connections.test.ts`
- Modify: `src/components/modals/NewConnectionModal.tsx`
- Create: `src/components/modals/ConnectSecretPrompt.tsx`

- [ ] **Step 1: 失败测试 — 档案 localStorage 读写**

Create `src/state/connections.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadProfiles, saveProfile, deleteProfile } from './connections'

beforeEach(() => localStorage.clear())

describe('connection profiles', () => {
  it('saves and loads non-secret profile', () => {
    saveProfile({ id: 'p1', name: 'prod', host: 'h', port: 22, user: 'u', auth: { method: 'password' } })
    const list = loadProfiles()
    expect(list).toHaveLength(1)
    expect(list[0].host).toBe('h')
    // 断言不含任何 secret 字段
    expect(JSON.stringify(list[0])).not.toContain('secret')
  })
  it('deletes a profile', () => {
    saveProfile({ id: 'p1', name: 'a', host: 'h', port: 22, user: 'u', auth: { method: 'password' } })
    deleteProfile('p1')
    expect(loadProfiles()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 实现 connections.ts**

Create `src/state/connections.ts`:
```ts
import type { AuthMethod } from '../services/ssh'

export interface ConnectionProfile {
  id: string; name: string; host: string; port: number; user: string; auth: AuthMethod
}

const KEY = 'catio-connections'

export function loadProfiles(): ConnectionProfile[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ConnectionProfile[]) : []
  } catch { return [] }
}
export function saveProfile(p: ConnectionProfile): void {
  const list = loadProfiles().filter(x => x.id !== p.id)
  list.push(p)
  localStorage.setItem(KEY, JSON.stringify(list))
}
export function deleteProfile(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadProfiles().filter(x => x.id !== id)))
}
```

- [ ] **Step 3: 跑测试**

Run: `npm test -- src/state/connections.test.ts`
Expected: PASS。

- [ ] **Step 4: NewConnectionModal 加认证方式字段**

Modify `NewConnectionModal.tsx`：在主机连接表单加一组「认证方式」单选（密码 / 密钥文件）+ 密钥路径输入（选密钥时显示）。**保持现有像素布局风格**（用现有的 field / Segmented 组件）。不在此存任何 secret。i18n key 加到 `modals` 命名空间（zh + en）。

- [ ] **Step 5: ConnectSecretPrompt 弹框**

Create `ConnectSecretPrompt.tsx`：一个轻量模态，输入密码或 passphrase，`onSubmit(secret)` 回调，秘密只在内存（组件 state），提交后调用方用完即丢。复用现有 modal 外壳样式（参考 NewConnectionModal 的遮罩/卡片）。i18n 化。

- [ ] **Step 6: 跑全量前端测试确保无回归**

Run: `npm test`
Expected: 既有 39 + 新增测试全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/state/connections.ts src/state/connections.test.ts src/components/modals
git commit -m "feat(ssh/fe): connection profiles + auth fields + secret prompt"
```

---

## Task A10: TerminalPane 换 xterm.js + 接 term_*

**Files:**
- Modify: `package.json`（加 `@xterm/xterm`, `@xterm/addon-fit`）
- Modify: `src/components/workbench/TerminalPane.tsx`
- Modify: `src/components/workbench/TerminalPane.test.tsx`（新建或扩展）

- [ ] **Step 1: 装 xterm**

Run: `npm i @xterm/xterm @xterm/addon-fit`
Expected: 出现在 dependencies。

- [ ] **Step 2: 失败测试 — 接线（mock services/ssh）**

Create `src/components/workbench/TerminalPane.test.tsx`：mock `../../services/ssh` 的 `termOpen/termWrite/listen`，渲染 `<TerminalPane conn={...}/>`，断言：挂载后调用了 `termOpen`，且 `listen('term://...')` 被订阅。（xterm 在 jsdom 下需 mock：`vi.mock('@xterm/xterm', ...)` 返回一个假的 Terminal 类，记录 `write`/`onData`。）
```ts
import { render, waitFor } from '@testing-library/react'
import { vi, describe, it, expect } from 'vitest'
const termOpen = vi.fn().mockResolvedValue('chan-1')
const listen = vi.fn().mockResolvedValue(() => {})
vi.mock('../../services/ssh', () => ({ termOpen, termWrite: vi.fn(), termResize: vi.fn(), termClose: vi.fn(), listen }))
const onData = vi.fn()
vi.mock('@xterm/xterm', () => ({ Terminal: class { open(){} write(){} onData(cb:unknown){onData(cb)} loadAddon(){} dispose(){} cols=80; rows=24 } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(){} activate(){} dispose(){} } }))
// ... render with a real-session prop, then:
// await waitFor(() => expect(termOpen).toHaveBeenCalled())
```

- [ ] **Step 3: 改 TerminalPane**

Modify `TerminalPane.tsx`：
- **保留** toolbar、Multi-Exec 下拉、选择栏、广播条等所有 chrome（像素不变）。
- **删除** 中间 `lines.map(... <TermLine/>)` 自制渲染与 `canned()`；改成一个 `<div ref={xtermHost}>` 容器，挂 xterm。
- 当 `conn` 是真实已连接 session（带 `sessionId`，从连接档案/连接动作传入）时：`termOpen` → 拿 `chanId` → `listen('term://'+chanId)` 把 `bytesBase64` 解码 `term.write` → `term.onData(d => termWrite(sessionId, chanId, base64(d)))` → ResizeObserver/FitAddon resize 时 `termResize`。
- xterm 主题：`theme: { background: getCssVar('--term-bg'), foreground: getCssVar('--term-fg') }`，`fontFamily: "'Geist Mono', monospace"`, `fontSize: 12.5`。
- 非 Tauri / 无真实 session（demo 模式）：保留一个只读欢迎 buffer（`getTermBuffer` 的 mock）写进 xterm，使纯前端 demo 仍有终端观感（不接 IPC）。
- 卸载时 `termClose` + `term.dispose()`。

- [ ] **Step 4: 跑测试**

Run: `npm test -- src/components/workbench/TerminalPane.test.tsx`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 无类型错误，构建通过。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/workbench/TerminalPane.tsx src/components/workbench/TerminalPane.test.tsx
git commit -m "feat(ssh/fe): swap terminal surface to xterm.js, wire term_* IPC"
```

---

## 阶段 A 验收

- [ ] `cd src-tauri && cargo test` 全 PASS（ids、knownhosts、conn、term）。
- [ ] `npm test` 全 PASS。`npx tsc --noEmit` 干净。`npm run build` 通过。
- [ ] **手动 QA**（`npm run tauri dev`）：新建一个指向真实可达 SSH 主机的连接（密码或密钥），打开终端，跑 `ls`、`vim`（确认全屏渲染与退出正常）、`htop`（确认颜色/刷新）、`top`，resize 窗口确认重排。记录结果于 PR 描述。

---

# 阶段 B：SFTP

## Task B1: sftp_list + parse（属性→SftpItem）

**Files:**
- Create: `src-tauri/src/ssh/sftp.rs`
- Create: `src-tauri/src/ssh/parse.rs`（先放 sftp 部分）
- Modify: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/common/test_server.rs`（加 sftp 子系统支持）
- Create: `src-tauri/tests/ssh_sftp.rs`

- [ ] **Step 1: 纯函数 TDD — 字节/时间格式化 + 条目映射**

Create `src-tauri/src/ssh/parse.rs`:
```rust
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpItem {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,   // "dir" | "file"
    pub size: Option<String>,
    pub r#mod: Option<String>,
}

/// 人类可读字节：1536 → "1.5 KB"
pub fn human_size(bytes: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64; let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 { v /= 1024.0; i += 1; }
    if i == 0 { format!("{} {}", bytes, U[0]) } else { format!("{:.1} {}", v, U[i]) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn human_size_formats() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MB");
    }
}
```

- [ ] **Step 2: 跑纯函数测试**

Run: `cd src-tauri && cargo test human_size_formats`
Expected: PASS。

- [ ] **Step 3: test server 加 sftp 子系统**

Modify `test_server.rs`：实现 `subsystem_request`，当 name=="sftp" 时用 `russh-sftp` 的 **server** 端（`russh_sftp::server`）挂一个最小内存/临时目录 SFTP 后端。若 `russh-sftp` server API 复杂，替代方案：server 端起一个临时目录、用 russh-sftp server handler 暴露真实临时目录（read_dir/open/read/write/remove/mkdir/rename）。在测试 fixtures 临时目录里预放两个文件 + 一个子目录供 list 断言。

- [ ] **Step 4: sftp.rs — sftp_list**

Create `src-tauri/src/ssh/sftp.rs`：核心可测函数 `async fn list(handle, path) -> Vec<SftpItem>`：
```rust
pub async fn open_sftp(handle: &russh::client::Handle<crate::ssh::conn::ClientHandler>)
    -> Result<russh_sftp::client::SftpSession, crate::ssh::SshError> {
    let ch = handle.channel_open_session().await.map_err(|e| crate::ssh::SshError::Io(e.to_string()))?;
    ch.request_subsystem(true, "sftp").await.map_err(|e| crate::ssh::SshError::Sftp(e.to_string()))?;
    russh_sftp::client::SftpSession::new(ch.into_stream()).await
        .map_err(|e| crate::ssh::SshError::Sftp(e.to_string()))
}

pub async fn list(sftp: &russh_sftp::client::SftpSession, path: &str)
    -> Result<Vec<crate::ssh::parse::SftpItem>, crate::ssh::SshError> {
    let entries = sftp.read_dir(path).await.map_err(|e| crate::ssh::SshError::Sftp(e.to_string()))?;
    let mut out = Vec::new();
    for e in entries {
        let meta = e.metadata();
        let is_dir = meta.is_dir();
        out.push(crate::ssh::parse::SftpItem {
            name: e.file_name(),
            kind: if is_dir { "dir".into() } else { "file".into() },
            size: if is_dir { None } else { Some(crate::ssh::parse::human_size(meta.size.unwrap_or(0))) },
            r#mod: None, // mtime 格式化可后续补；UI 容忍 None
        });
    }
    Ok(out)
}
```
（`read_dir` 返回类型、`metadata()`/`file_name()` 以 russh-sftp 该版本为准微调。）

加 command `sftp_list(session_id, path, mgr)`：取 session → `open_sftp` → `list`。注册到 `lib.rs`，`mod.rs` 加 `pub mod sftp; pub mod parse;`。

- [ ] **Step 5: 集成测试 — list 临时目录**

Create `src-tauri/tests/ssh_sftp.rs`：连 test server → `open_sftp` → `list("/...")` → 断言看到预置的两个文件名与子目录。

- [ ] **Step 6: 跑测试 + 编译**

Run: `cd src-tauri && cargo test --test ssh_sftp && cargo build`
Expected: PASS + 编译通过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests
git commit -m "feat(ssh): sftp_list + size formatting + sftp test-server backend"
```

---

## Task B2: sftp_download / sftp_upload + 进度事件

**Files:**
- Modify: `src-tauri/src/ssh/sftp.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/ssh_sftp.rs`

- [ ] **Step 1: 实现 download/upload（流式 + 进度）**

`sftp.rs` 加：`download(sftp, remote, local, on_progress)` 用 `sftp.open(remote)` 读、写本地文件，每块累加 `done` 调 `on_progress(done, total)`（total 来自 `metadata().size`）。`upload` 反向：本地读、`sftp.create(remote)` 写。command 版用 `app.emit("sftp-progress://download"/"upload", {done,total})`。核心函数收闭包，便于测试断言进度被调用。

- [ ] **Step 2: 集成测试 — 往返**

`ssh_sftp.rs` 加：upload 一个临时文件 → download 回另一路径 → 断言内容一致，且进度闭包至少被调用一次、最终 `done==total`。

- [ ] **Step 3: 跑测试 + 编译 + Commit**

Run: `cd src-tauri && cargo test --test ssh_sftp && cargo build`
```bash
git add src-tauri/src/ssh/sftp.rs src-tauri/src/lib.rs src-tauri/tests/ssh_sftp.rs
git commit -m "feat(ssh): sftp upload/download with progress events"
```

---

## Task B3: sftp_mkdir / rename / delete

**Files:**
- Modify: `src-tauri/src/ssh/sftp.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/ssh_sftp.rs`

- [ ] **Step 1: 实现三个 op**

`sftp.rs` 加 `mkdir(sftp,path)`=`sftp.create_dir`、`rename(sftp,from,to)`=`sftp.rename`、`delete(sftp,path,is_dir)`=`remove_dir`/`remove_file`。各加 command 注册。

- [ ] **Step 2: 集成测试**

`ssh_sftp.rs`：mkdir 新目录 → list 确认存在 → rename → list 确认改名 → delete → list 确认消失。

- [ ] **Step 3: 跑测试 + Commit**

Run: `cd src-tauri && cargo test --test ssh_sftp`
```bash
git add src-tauri/src/ssh/sftp.rs src-tauri/src/lib.rs src-tauri/tests/ssh_sftp.rs
git commit -m "feat(ssh): sftp mkdir/rename/delete"
```

---

## Task B4: SftpPanel 接真实 SFTP

**Files:**
- Modify: `src/services/ssh.ts`（getSftp 在 Tauri 下走 sftp_list；加 sftpUpload/Download/Mkdir/Rename/Delete 包装）
- Modify: `src/components/panels/SftpPanel.tsx`
- Create/Modify: `src/components/panels/SftpPanel.test.tsx`

- [ ] **Step 1: ssh.ts 加 SFTP 包装 + getSftp 真实化**

`getSftp(sessionId, path?)`：Tauri 下 `invoke('sftp_list', {sessionId, path})` 包成 `{path, items}`；非 Tauri 回退 `DATA.sftp`。加 `sftpUpload/sftpDownload/sftpMkdir/sftpRename/sftpDelete`。

- [ ] **Step 2: 失败测试 — 面板加载真实列表**

`SftpPanel.test.tsx`：mock `services/ssh` 的 `getSftp` 返回自定义 items，渲染面板（传一个带 sessionId 的 conn），`waitFor` 断言列表渲染了 mock 的文件名；点上传按钮触发 `sftpUpload`（mock）。

- [ ] **Step 3: 改 SftpPanel**

把 `D.sftp` 直读改为：`useState` + `useEffect(() => getSftp(sessionId, path))` 加载；path 变化重载；目录项点击进目录；`up` 项返回上级；上传/刷新按钮接 `sftpUpload`/重载。**保留全部像素布局**（行渲染、图标、hint 不变），仅数据来源换成 state。非 Tauri/demo 仍显示 `DATA.sftp`。文件选择用 `@tauri-apps/plugin-dialog`（若引入则在 capabilities 加权限并 `cargo`/`npm` 装）。

- [ ] **Step 4: 跑测试 + tsc + Commit**

Run: `npm test -- src/components/panels/SftpPanel.test.tsx && npx tsc --noEmit`
```bash
git add src/services/ssh.ts src/components/panels/SftpPanel.tsx src/components/panels/SftpPanel.test.tsx
git commit -m "feat(ssh/fe): SftpPanel wired to real SFTP"
```

---

## 阶段 B 验收

- [ ] `cargo test` 全 PASS。`npm test` + `tsc` + `build` 全绿。
- [ ] 手动 QA：真实主机上浏览目录、进入子目录、上传一个本地文件并看到进度、下载回来、新建/改名/删除目录。

---

# 阶段 C：隧道

## Task C1: tunnel_open L（本地转发）+ 字节计数事件

**Files:**
- Create: `src-tauri/src/ssh/tunnel.rs`
- Modify: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/ssh/manager.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/common/test_server.rs`（支持 direct-tcpip）
- Create: `src-tauri/tests/ssh_tunnel.rs`

- [ ] **Step 1: test server 支持 direct-tcpip**

Modify `test_server.rs`：实现 `channel_open_direct_tcpip`，把通道接到一个测试内的本地 TCP echo server（测试里另起一个 echo 监听，server handler 把 direct-tcpip 通道双向 copy 到该 echo 端）。或更简单：handler 内对 direct-tcpip 直接做「收到什么回什么」的 echo，省掉真实 connect。

- [ ] **Step 2: tunnel.rs — L 转发**

Create `tunnel.rs`：`tunnel_open` 对 `kind=L`：在本地 `bind` 起 `TcpListener`，每个入站连接调 `handle.channel_open_direct_tcpip(target_host, target_port, src_host, src_port)` 开通道，`tokio::io::copy` 双向桥接 socket↔channel.into_stream()，累加字节，周期（每 500ms 或每 N 字节）`app.emit("tunnel://{id}", {bytesUp, bytesDown})`。返回 `tun-N`。manager 存 `TunnelId → AbortHandle`（用于关闭）。

- [ ] **Step 3: 集成测试 — L 回环**

`ssh_tunnel.rs`：连 test server → `tunnel_open L bind=127.0.0.1:0 target=echo`（核心函数版返回实际本地端口）→ 用 `TcpStream` 连本地端口 → 写 `b"ping"` → 读回 `b"ping"`（经 server echo）→ 断言往返成功。

- [ ] **Step 4: 跑测试 + 编译 + Commit**

Run: `cd src-tauri && cargo test --test ssh_tunnel && cargo build`
```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests
git commit -m "feat(ssh): local (L) port-forward tunnel + byte counters"
```

---

## Task C2: tunnel_open R（远程转发）

**Files:**
- Modify: `src-tauri/src/ssh/tunnel.rs`, `src-tauri/tests/common/test_server.rs`, `src-tauri/tests/ssh_tunnel.rs`

- [ ] **Step 1: test server 支持 tcpip-forward**

Modify `test_server.rs`：实现 `tcpip_forward`（接受请求，记录），并提供测试触发：server 端开一个 forwarded-tcpip 通道回客户端（模拟远端有连接进来）。

- [ ] **Step 2: tunnel.rs — R 转发**

`tunnel_open` 对 `kind=R`：`handle` 发 `tcpip_forward(bind_host, bind_port)`，监听被转发通道（在 ClientHandler 的 `server_channel_open_forwarded_tcpip` 回调里），把通道桥接到本地 `target`。需要在 `ClientHandler` 加 forwarded-tcpip 处理 + 一个 channel/mpsc 把入站通道交给 tunnel 任务。

- [ ] **Step 3: 集成测试 R + 跑 + Commit**

`ssh_tunnel.rs` 加 R 用例（server 触发一个 forwarded 通道 → 客户端桥接到本地 echo → 断言数据流通）。
Run: `cd src-tauri && cargo test --test ssh_tunnel`
```bash
git add src-tauri/src/ssh/tunnel.rs src-tauri/src/ssh/conn.rs src-tauri/tests
git commit -m "feat(ssh): remote (R) port-forward tunnel"
```

---

## Task C3: tunnel_open D（动态 SOCKS5）

**Files:**
- Modify: `src-tauri/src/ssh/tunnel.rs`, `src-tauri/tests/ssh_tunnel.rs`

- [ ] **Step 1: 实现最小 SOCKS5**

`tunnel.rs` 对 `kind=D`：本地起 TCP 监听，按 SOCKS5（无认证）握手解析目标 host:port，再 `channel_open_direct_tcpip` 桥接。只需支持 CONNECT + 域名/IPv4（够用，YAGNI 不做 BIND/UDP）。

- [ ] **Step 2: 集成测试**

`ssh_tunnel.rs`：连 test server → `tunnel_open D` → 手写 SOCKS5 CONNECT 报文到本地端口请求连 `echo:1` → 写数据 → 读回 → 断言。

- [ ] **Step 3: 跑 + Commit**

Run: `cd src-tauri && cargo test --test ssh_tunnel`
```bash
git add src-tauri/src/ssh/tunnel.rs src-tauri/tests/ssh_tunnel.rs
git commit -m "feat(ssh): dynamic (D) SOCKS5 tunnel"
```

---

## Task C4: tunnel_close / tunnel_list

**Files:**
- Modify: `src-tauri/src/ssh/tunnel.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/ssh_tunnel.rs`

- [ ] **Step 1: 实现 close/list**

`tunnel_close(tunnelId)`：从 manager 取 AbortHandle abort + 移除。`tunnel_list()`：返回 `Vec<TunnelStatus{ id, kind, bind, target, bytesUp, bytesDown, status }>`。

- [ ] **Step 2: 集成测试 — 开→list 见到→close→list 消失 + 跑 + Commit**

Run: `cd src-tauri && cargo test --test ssh_tunnel`
```bash
git add src-tauri/src/ssh/tunnel.rs src-tauri/src/lib.rs src-tauri/tests/ssh_tunnel.rs
git commit -m "feat(ssh): tunnel_close + tunnel_list"
```

---

## Task C5: TunnelsPanel 接真实隧道

**Files:**
- Modify: `src/services/ssh.ts`, `src/components/panels/TunnelsPanel.tsx`
- Create/Modify: `src/components/panels/TunnelsPanel.test.tsx`

- [ ] **Step 1: ssh.ts 加 tunnel 包装**

`tunnelOpen(sessionId, spec)`、`tunnelClose(id)`、`getTunnels(sessionId)`（Tauri 下 `tunnel_list`，否则 mock）。订阅 `tunnel://{id}` 更新字节。

- [ ] **Step 2: 失败测试 — 面板渲染真实隧道 + toggle 关闭调用 tunnelClose**

`TunnelsPanel.test.tsx`：mock `getTunnels`、`tunnelClose`，断言列表渲染、Toggle off 调 `tunnelClose`。

- [ ] **Step 3: 改 TunnelsPanel**

`D.tunnels` 直读 → state（`getTunnels` 加载 + `listen('tunnel://...')` 更新 bytes）；Toggle 接 open/close；`+` 新建转发用一个小表单（L/R/D + bind + target）。**jumpChain 与卡片像素布局不变**。非 Tauri 用 `DATA.tunnels`。

- [ ] **Step 4: 跑测试 + tsc + Commit**

Run: `npm test -- src/components/panels/TunnelsPanel.test.tsx && npx tsc --noEmit`
```bash
git add src/services/ssh.ts src/components/panels/TunnelsPanel.tsx src/components/panels/TunnelsPanel.test.tsx
git commit -m "feat(ssh/fe): TunnelsPanel wired to real tunnels"
```

---

## 阶段 C 验收

- [ ] `cargo test` 全 PASS（L/R/D/close/list）。前端绿。
- [ ] 手动 QA：开一个 L 转发到远端服务（如远端 redis/web），本地访问通；开 D（SOCKS5）配浏览器代理能上网；R 转发回环验证。

---

# 阶段 D：监控 + 多机执行

## Task D1: parse.rs 监控解析（纯函数 TDD）

**Files:**
- Modify: `src-tauri/src/ssh/parse.rs`
- Create: `src-tauri/tests/parse_monitor.rs`（或放 parse.rs 的 `#[cfg(test)]`）

- [ ] **Step 1: 失败测试 — 解析样本**

在 `parse.rs` 加 `parse_monitor(raw: &MonitorRaw) -> Monitor` 及各子解析器，并写单测，用真实样本字符串：
- `/proc/stat` 两次采样算 CPU% （`parse_cpu_pct(prev, now) -> f64`）。
- `free -b` → mem 已用/总（`parse_mem(out) -> (usedPct, totalStr, usedStr)`）。
- `/proc/net/dev` 两次采样算 net MB/s。
- `df -P /` → disk%。
- `ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head` → `Vec<Proc>`。
- `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` → `Vec<Gpu>`。

每个写 1-2 个断言（给定固定样本，断言数值）。例如：
```rust
#[test]
fn parses_df_disk_pct() {
    let out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 73 27 73% /\n";
    assert_eq!(super::parse_disk_pct(out), 73);
}
```
（CPU/net 是两次采样差值函数，传两帧样本断言。）

- [ ] **Step 2: 实现解析器到测试通过**

Run: `cd src-tauri && cargo test parse_` （或对应测试名）
Expected: 全 PASS。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ssh/parse.rs
git commit -m "feat(ssh): monitor output parsers (cpu/mem/net/disk/procs/gpu)"
```

---

## Task D2: monitor_start / monitor_stop + monitor:// 事件

**Files:**
- Create: `src-tauri/src/ssh/monitor.rs`
- Modify: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/ssh/manager.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/common/test_server.rs`（exec 返回 canned 统计样本）
- Create: `src-tauri/tests/ssh_monitor.rs`

- [ ] **Step 1: test server exec 返回 canned 样本**

Modify `test_server.rs`：`exec_request` 对特定 marker 命令返回预置的统计输出样本（拼好的多段字符串），供监控解析。

- [ ] **Step 2: monitor.rs**

`monitor_start(session_id, interval_ms)`：spawn 周期任务，每次开 exec 通道跑统计命令、收输出、`parse::parse_monitor`、维护 CPU/mem/net 滑动窗口（保留最近 N 帧）、`app.emit("monitor://{session_id}", monitor)`。`monitor_stop` abort 该任务。manager 存 `session_id → AbortHandle`。核心采样函数 `sample_once(handle) -> Monitor` 可集成测试。

- [ ] **Step 3: 集成测试**

`ssh_monitor.rs`：连 test server（exec 返回 canned）→ `sample_once` → 断言返回的 Monitor 字段（cpu/mem/disk/procs/gpus）符合样本。

- [ ] **Step 4: 跑 + 编译 + Commit**

Run: `cd src-tauri && cargo test --test ssh_monitor && cargo build`
```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests
git commit -m "feat(ssh): agentless system monitor sampling + monitor:// events"
```

---

## Task D3: multiexec_run + multiexec:// 事件

**Files:**
- Create: `src-tauri/src/ssh/multiexec.rs`
- Modify: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/ssh_multiexec.rs`

- [ ] **Step 1: multiexec.rs**

`multiexec_run(session_ids, cmd)`：对每个 session 开 exec 通道跑 cmd，逐目标 `app.emit("multiexec://{run_id}", {sessionId, state, chunk})`，state ∈ running/done/error。返回 `run-N`。核心函数 `run_on(handle, cmd) -> (output, exitCode)` 可测。

- [ ] **Step 2: 集成测试**

`ssh_multiexec.rs`：起 test server（exec 回显命令）→ 连两个 session → `run_on` 各自 → 断言输出含命令字符串、退出码 0。

- [ ] **Step 3: 跑 + Commit**

Run: `cd src-tauri && cargo test --test ssh_multiexec`
```bash
git add src-tauri/src/ssh src-tauri/src/lib.rs src-tauri/tests/ssh_multiexec.rs
git commit -m "feat(ssh): multi-session broadcast exec + multiexec:// events"
```

---

## Task D4: MonitorPanel + TerminalPane Multi-Exec 接真

**Files:**
- Modify: `src/services/ssh.ts`, `src/components/panels/MonitorPanel.tsx`, `src/components/workbench/TerminalPane.tsx`
- Create/Modify: `src/components/panels/MonitorPanel.test.tsx`

- [ ] **Step 1: ssh.ts 加 monitor + multiexec 包装**

`monitorStart(sessionId, intervalMs)`、`monitorStop(sessionId)`、`getMonitor(sessionId)`（Tauri 下订阅 `monitor://`，非 Tauri 回退 `DATA.monitor`）；`multiexecRun(sessionIds, cmd)` + 订阅 `multiexec://`。

- [ ] **Step 2: 失败测试 — MonitorPanel 订阅更新**

`MonitorPanel.test.tsx`：mock `listen('monitor://...')` 推一帧自定义 Monitor，断言 sparkline/数值更新到该帧（如 disk%）。

- [ ] **Step 3: 改 MonitorPanel**

挂载 `monitorStart` + `listen('monitor://'+sessionId)` 把帧写入 state；卸载 `monitorStop`。**Stat/Spark/GpuCard/proc 表像素布局不变**，仅数据来源换 state。非 Tauri 用 `DATA.monitor`。

- [ ] **Step 4: 改 TerminalPane Multi-Exec**

把 Multi-Exec 「广播」按钮接 `multiexecRun(selectedSessionIds, cmd)`，逐目标输出经 `listen('multiexec://'+runId)` 收集展示（沿用现有 MultiExec UI 形状）。非 Tauri 维持现有 demo 行为。

- [ ] **Step 5: 跑测试 + tsc + build + Commit**

Run: `npm test && npx tsc --noEmit && npm run build`
```bash
git add src/services/ssh.ts src/components/panels/MonitorPanel.tsx src/components/panels/MonitorPanel.test.tsx src/components/workbench/TerminalPane.tsx
git commit -m "feat(ssh/fe): MonitorPanel + Multi-Exec wired to real backend"
```

---

## 阶段 D 验收

- [ ] `cargo test` 全 PASS。`npm test` + `tsc` + `build` 全绿。
- [ ] 手动 QA：真实 Linux 主机监控刷新（CPU/mem/net/disk/进程；有 N 卡则 GPU），Multi-Exec 对 2+ 主机广播一条命令看到各自输出。

---

# 全局收尾

## Task E1: 最终评审 + 文档

- [ ] **Step 1:** 跑全量：`cd src-tauri && cargo test && cargo clippy` ；根目录 `npm test && npx tsc --noEmit && npm run build`。全绿。
- [ ] **Step 2:** 更新 spec 顶部状态为「已实现」，在 README/docs 记录：SSH 后端命令清单、known_hosts 位置、连接档案存储位置、秘密不落盘说明。
- [ ] **Step 3:** 手动 QA 全清单走一遍（终端/SFTP/隧道/监控/多机），结果记录。
- [ ] **Step 4:** 用 superpowers:finishing-a-development-branch 收尾（合并/PR 决策交用户）。

---

## 测试与契约一致性备忘（自检结果）

- **命令名**前后端一致：`ssh_connect/ssh_disconnect/ssh_trust_host`、`term_open/term_write/term_resize/term_close`、`sftp_list/sftp_download/sftp_upload/sftp_mkdir/sftp_rename/sftp_delete`、`tunnel_open/tunnel_close/tunnel_list`、`monitor_start/monitor_stop`、`multiexec_run`。
- **事件名**：`term://{chanId}`、`sftp-progress://{op}`、`tunnel://{id}`、`monitor://{sessionId}`、`multiexec://{runId}`。
- **前端类型**沿用既有 `services/types.ts`（`Sftp/SftpItem/Tunnel/Monitor/Gpu/Proc/MultiExecTarget/TermLine`）——后端 `SftpItem` 的 `type/size/mod` 字段名与前端对齐（serde rename）。
- **秘密**：`secret` 仅出现在 `ssh_connect` 入参与连接核心函数，绝不写 localStorage（`connections.test.ts` 断言档案不含 secret）、不 emit、不 log、不回 `ConnectResult`。
- **像素不变**：所有面板改动仅换数据来源（DATA→state），不动 JSX 结构/内联样式；终端仅换中间表面为 xterm，chrome 保留。
