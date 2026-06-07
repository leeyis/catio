# Catio SSH/终端后端 — 设计文档（子项目 2）

- 子项目：2 / 4（SSH/终端后端）
- 前置：子项目 1（UI 外壳）已完成，建立了 `src/services/` 数据接缝层。
- **Reach**（github.com/alexandrosnt/Reach）— Tauri v2 + Rust(`russh`) + Svelte 5，MIT。本子项目复用其 russh Rust 栈，作参考实现。

## 0. 范围决策（来自 brainstorming）

| 决策 | 选择 |
| --- | --- |
| v1 范围 | **全做**：终端(PTY) + SFTP + 隧道 + 监控 |
| 终端渲染 | **引入 xterm.js**（替换自制行渲染器） |
| 凭据处理 | **密钥文件 + 连接时提示密码，不持久化秘密**（加密保险库留子项目 4） |
| 复用方式 | **参考重写**，按 Catio `services/` 接缝套；Reach 作参考（MIT，逐段拷代码并标注出处） |

### 默认子决策（brainstorming 中确认）

1. **主机密钥**：TOFU（Trust On First Use），`known_hosts` 存 app 数据目录，首次连接弹指纹信任框。
2. **连接档案持久化**：非敏感连接元信息（host/port/user/认证方式/密钥路径）存 localStorage（真正加密保险库是子项目 4）；现有 mock `DATA.connections` 降级为示例种子。
3. **不引入 ssh-agent**（v1 仅密钥文件 + 密码提示；agent 留后续增量）。

## 1. 本子项目目标与非目标

### 目标

1. 真实 SSH 连接 + 认证（密钥文件 / 密码），替换 UI 外壳中的 mock。
2. 真实交互式终端（PTY），可跑 `vim`/`htop`/`top`/`less` 等全屏程序。
3. 真实 SFTP 文件浏览 + 上传 / 下载 / mkdir / rename / delete。
4. 真实端口转发隧道：本地(L) / 远程(R) / 动态 SOCKS(D)。
5. 无 agent 的远端系统监控（CPU/mem/net/disk/进程，GPU 可选）。
6. 多会话广播执行（Multi-Exec）接真实多会话。
7. **不改动 UI 组件树的结构与像素呈现**（仅把终端表面换成 xterm.js，工具栏/头部 chrome 保持像素不变）。

### 非目标

- 加密保险库 / OS keychain（子项目 4）。
- 数据库后端（子项目 3）。
- Catio Agent 推理逻辑（子项目 4）。
- ssh-agent / Pageant 集成、自动重连、会话录制回放（后续增量）。
- 终端之外的 ANSI 主题深度定制（v1 仅匹配设计令牌配色）。

## 2. 总体架构

前端不改契约，后端把 `services/` 接缝层的 mock 换成 Tauri IPC：

```
React UI（组件树不动）
   │  services/ssh.ts —— 包装 Tauri invoke；非 Tauri 环境回退 mock
   │                     （沿用 services/models.ts 的 resolveFetch 探测模式）
   ▼  Tauri IPC（commands + events）
Rust src-tauri/src/ssh/
   ├── mod.rs       模块导出 + 错误类型 SshError
   ├── manager.rs   SessionManager: State<Mutex<HashMap<SessionId, Session>>>
   │                每个 Session 持有 russh client::Handle + 元信息 + 子通道句柄表
   ├── conn.rs      connect / auth / disconnect + 主机密钥校验(TOFU)
   ├── term.rs      PTY 通道：open / write / resize / close + `term://{chanId}` 字节事件
   ├── sftp.rs      russh-sftp：list / upload / download / mkdir / rename / delete + 进度事件
   ├── tunnel.rs    L/R/D 三种转发 + `tunnel://{id}` 字节计数事件
   ├── monitor.rs   无 agent 周期采样：exec 跑紧凑统计命令 → 解析成 Monitor 形状 → `monitor://{sessionId}` 事件
   ├── multiexec.rs 多会话广播执行 + `multiexec://{runId}` 逐目标输出事件
   └── parse.rs     纯函数：监控输出解析 / sftp 条目映射（便于单测）
```

**Crates**：`russh`、`russh-sftp`、`russh-keys`、`tokio`（已随 Tauri 引入）、`serde`、`base64`、`thiserror`。

**标识符**：`SessionId`、`ChannelId`、`TunnelId`、`RunId` 均为字符串（Rust 端用计数器 + 前缀生成，如 `sess-1`/`chan-1`），前端透明持有。

## 3. 后端 IPC 契约

### 3.1 连接

```rust
// 入参：非敏感档案 + 本次连接的瞬时秘密（仅内存，不落盘）
struct ConnectArgs {
    host: String, port: u16, user: String,
    auth: AuthMethod,            // KeyFile{path} | Password
    secret: Option<String>,      // 密码 或 私钥 passphrase；用后清零，不返回前端
}
#[tauri::command] async fn ssh_connect(args, state) -> Result<ConnectResult, SshError>;
// ConnectResult { sessionId, serverBanner, hostKeyFingerprint, hostKeyTrusted }
#[tauri::command] async fn ssh_disconnect(sessionId, state) -> Result<(), SshError>;
#[tauri::command] async fn ssh_trust_host(sessionId, fingerprint, state) -> Result<(), SshError>; // 写 known_hosts
```

**主机密钥校验（TOFU）**：连接握手取服务器公钥指纹，比对 app 数据目录下 `known_hosts`：
- 已知且匹配 → 直接放行。
- 未知 → `ConnectResult.hostKeyTrusted=false`，前端弹指纹信任框；用户确认后调 `ssh_trust_host` 写入再继续。
- 已知但不匹配 → 返回 `SshError::HostKeyMismatch`，前端红色告警，拒绝连接。

### 3.2 终端（PTY）

```rust
#[tauri::command] async fn term_open(sessionId, cols, rows, state) -> Result<ChannelId, SshError>;
//   russh: channel_open_session → request_pty("xterm-256color",cols,rows) → request_shell
//   spawn 读循环：channel data → emit `term://{chanId}` { bytesBase64 }
#[tauri::command] async fn term_write(chanId, dataBase64, state) -> Result<(), SshError>;
#[tauri::command] async fn term_resize(chanId, cols, rows, state) -> Result<(), SshError>; // window-change
#[tauri::command] async fn term_close(chanId, state) -> Result<(), SshError>;
```

字节用 base64 在 IPC 上传输（保留二进制与 ANSI 转义不失真）。

### 3.3 SFTP

```rust
#[tauri::command] async fn sftp_list(sessionId, path, state) -> Result<Vec<SftpItem>, SshError>;
#[tauri::command] async fn sftp_download(sessionId, remotePath, localPath, state) -> Result<(), SshError>;
#[tauri::command] async fn sftp_upload(sessionId, localPath, remotePath, state) -> Result<(), SshError>;
#[tauri::command] async fn sftp_mkdir(sessionId, path, state) -> Result<(), SshError>;
#[tauri::command] async fn sftp_rename(sessionId, from, to, state) -> Result<(), SshError>;
#[tauri::command] async fn sftp_delete(sessionId, path, isDir, state) -> Result<(), SshError>;
```

`SftpItem` 映射到现有前端类型 `{ name, type:'up'|'dir'|'file', size?, mod? }`（`parse.rs` 负责把 sftp 属性格式化成 UI 期望的 size/mod 文本）。上传/下载发 `sftp-progress://{op}` 进度事件 `{ done, total }`。

### 3.4 隧道

```rust
struct TunnelSpec { kind: 'L'|'R'|'D', bind: String, target: Option<String> }
#[tauri::command] async fn tunnel_open(sessionId, spec, state) -> Result<TunnelId, SshError>;
#[tauri::command] async fn tunnel_close(tunnelId, state) -> Result<(), SshError>;
#[tauri::command] async fn tunnel_list(state) -> Result<Vec<TunnelStatus>, SshError>;
```

- **L（本地转发）**：本地 `TcpListener` 绑定 `bind`，每个入站连接开 `direct-tcpip` 通道转发到远端 `target`。
- **R（远程转发）**：向服务器发 `tcpip-forward` 请求，接受被转发通道，管到本地 `target`。
- **D（动态 SOCKS）**：本地起 SOCKS5 代理，按请求开 `direct-tcpip`。

读写双向字节累加，周期 emit `tunnel://{id}` `{ bytesUp, bytesDown }`，喂 UI `Tunnel.bytes`。

### 3.5 监控（无 agent）

```rust
#[tauri::command] async fn monitor_start(sessionId, intervalMs, state) -> Result<(), SshError>;
#[tauri::command] async fn monitor_stop(sessionId, state) -> Result<(), SshError>;
//   周期 exec 一条紧凑统计命令（cat /proc/stat; free; cat /proc/net/dev; df; ps; nvidia-smi --query…）
//   parse.rs 解析为 Monitor 形状 → emit `monitor://{sessionId}` { Monitor }
```

CPU/mem/net 维护滑动窗口数组（与 UI sparkline 形状一致）。GPU 仅在远端有 `nvidia-smi` 时填充，否则 `gpus: []`。**假定远端 Linux**；命令缺失或解析失败时该字段优雅降级（保留上一帧或置零），不崩。

### 3.6 多会话广播

```rust
#[tauri::command] async fn multiexec_run(sessionIds: Vec<SessionId>, cmd, state) -> Result<RunId, SshError>;
//   对每个 session 开 exec 通道跑 cmd，逐目标 emit `multiexec://{runId}` { sessionId, state, chunk }
```

映射到 TerminalPane 的 Multi-Exec 广播 UI（`MultiExecTarget { id,name,state,out }`）。

## 4. 前端改动

| 文件 | 改动 |
| --- | --- |
| `src/services/ssh.ts`（新） | 包装上述 commands；`isTauri()` 为假时回退现有 mock（终端回退 canned，其余回退 DATA） |
| `src/services/index.ts` | 把 `getTermBuffer/getSftp/getTunnels/getMonitor` 内部指向 ssh.ts；保留签名 |
| `src/components/workbench/TerminalPane.tsx` | 中间文本表面换成 xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）；工具栏/头部/选择栏/广播条 **像素不变**；接 term_*；Multi-Exec 接 multiexec_run |
| `src/components/panels/*`（SFTP/Tunnels/Monitor 面板） | 接真实 command + 订阅对应事件 |
| `src/components/modals/NewConnectionModal.tsx` | 增加认证方式（密钥文件路径 / 密码）字段 |
| 连接时密码/passphrase 提示 | 新建轻量 `ConnectSecretPrompt` 弹框，秘密仅内存 |
| 连接档案存储 | 新建 `src/state/connections.ts`，非敏感档案存 localStorage（key `catio-connections`），秘密永不入此存储 |

**xterm.js 主题**：背景 `--term-bg`、前景 `--term-fg`、字体 Geist Mono、字号 12.5（与原型一致）；FitAddon 跟随容器尺寸，resize 时回调 `term_resize`。

## 5. 错误处理

`SshError`（`thiserror`）→ serde 到前端的标签联合：

| 变体 | 前端表现 |
| --- | --- |
| `AuthFailed` | 连接框红字「认证失败」，可重输 |
| `HostUnreachable` | 「主机不可达 / 超时」 |
| `HostKeyMismatch` | 红色安全告警，拒绝连接 |
| `ChannelClosed` | 终端显示「连接已断开」横幅，提供手动重连按钮 |
| `Sftp(msg)` / `Tunnel(msg)` / `Io(msg)` | 对应面板 toast |

v1 **手动重连**，不做自动重连 / keepalive 退避。

## 6. 测试策略

1. **Rust 集成测试用进程内 russh server**：russh 自带 server 端，测试里起一个 in-process sshd（固定测试密钥），客户端连它跑 connect / exec / pty echo / sftp 往返 / 端口转发，**无外部依赖、确定性强、跨平台**。
2. **Rust 纯函数单测**（`parse.rs`）：监控输出解析（`/proc/stat`、`free`、`net/dev`、`df`、`ps`、`nvidia-smi` 样本字符串 → Monitor）、sftp 属性 → SftpItem 映射、隧道 spec 解析、known_hosts 读写。
3. **前端 vitest**：mock 掉 Tauri invoke 层，测 `services/ssh.ts` 包装（Tauri 路径调 invoke、非 Tauri 路径回退 mock）+ TerminalPane 接线 + 面板订阅；沿用 `services/models.test.ts` 的 mock 模式。
4. **实连 QA 清单**（手动，GUI 无法无头跑）：vim/htop 全屏渲染、SFTP 上传下载进度、L/R/D 隧道连通、监控刷新、Multi-Exec 广播、主机密钥首信任与不匹配告警。

## 7. 安全注记

- **秘密不落盘**：密码 / passphrase 仅在 `ssh_connect` 调用期间存在于内存，用后清零（`zeroize` 可选），绝不写 localStorage、日志或返回前端。
- **连接档案**非敏感，localStorage 明文可接受（与子项目 1 的 AI key 同等临时方案）；真正加密保险库（XChaCha20）是子项目 4。
- **主机密钥 TOFU**：防中间人；不匹配硬拒。
- **Reach 代码复用**：MIT，逐段拷贝处在文件头注明来源（`// adapted from Reach src-tauri/...，MIT`）。

## 8. 实现计划分阶段（写 plan 时据此排任务，均在本 spec/plan 内）

1. **阶段 A 连接 + 终端**：crates 接入、SessionManager、ssh_connect/disconnect、TOFU、term_*、xterm.js 接线、连接档案 + 密码提示。
2. **阶段 B SFTP**：sftp_* + 进度事件 + SftpPanel 接真。
3. **阶段 C 隧道**：tunnel_* L/R/D + 字节计数 + TunnelsPanel 接真。
4. **阶段 D 监控 + 多机执行**：monitor_* + parse、multiexec_run + 对应 UI 接真。

每阶段结束应得到可运行、可测的软件。

## 9. 与后续子项目的关系

- 子项目 3（数据库后端）独立，经各自 `services/` 接缝接入，不依赖本子项目。
- 子项目 4 把本子项目的「连接档案 localStorage + 内存秘密」升级为加密保险库 + OS keychain，并接管认证门禁。
