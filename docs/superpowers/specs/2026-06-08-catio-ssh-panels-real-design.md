# Catio SSH 周边面板真实化 — 设计文档（子项目 2 增量）

- 归属：子项目 2（SSH/终端后端）的延伸增量；分支 `catio-ui-shell`。
- 目标：把 SSH 相关的侧边栏面板**全部接真实数据/功能，去除所有 mock**：Agent、SFTP、端口转发/ProxyJump、片段库、历史。数据库面板属子项目 3，不在此范围。
- 用户决策（已确认）：Agent = 真实对话 + 生成命令一键插入终端；历史 = 真实执行过的 shell 命令（+ 将来 SQL）；ProxyJump 做真实跳板；删除连接需二次确认（已做）。

## 0. 调研结论（命令历史/执行审计）

裸 PTY 字节流正则切分命令不可靠（ANSI、行编辑、历史调用、输出混杂、无退出码/cwd）。业界标准是 **shell 集成 + OSC 标记序列**：

- **VS Code OSC 633**（开源，`shellIntegration-bash.sh`/`-rc.zsh`）；**FinalTerm/iTerm2 OSC 133**。序列（OSC=`ESC ]`，ST=`BEL`=`\a`）：
  - `\e]633;A\a` 提示符开始 · `\e]633;B\a` 提示符结束 · `\e]633;C\a` 命令开始执行
  - `\e]633;D;<exit>\a` 命令结束 + 退出码（无命令时 `\e]633;D\a`）
  - `\e]633;E;<escaped-cmd>;<nonce>\a` 显式命令行
  - `\e]633;P;Cwd=<escaped-pwd>\a` 当前目录
  - 理想顺序 A,B,E,C,D。`OSC 133;A/B/C/D` 同义（无 E，退化模式）。
- **转义规则**（E 与 Cwd 的值）：`\`→`\\`，`;`(0x3b)→`\x3b`，字节 <0x20 →`\xNN`。客户端解析时反转义。
- **bash 机制**：`trap '... "$_"' DEBUG`（带 `in_command_execution` 守卫，保证每条命令行只触发一次 preexec）→ 用 `history 1`（解析别名）取命令 → 发 `E`+`C`；`PROMPT_COMMAND` 先存 `$?` → 发 `D;<exit>`+`Cwd`。
- **zsh 机制**：`add-zsh-hook preexec`（命令=`$1`）发 `E`+`C`；`add-zsh-hook precmd`（`$?`）发 `D`+`Cwd`。

## 1. 范围

### 做（真实，无 mock）
1. **空态清理**：SFTP / 端口转发 / 监控面板在**无活动会话时不再回退 mock**，显示「先连接一个主机」空态。
2. **片段库**：本地持久化（localStorage）+ 增/删/改 + 复制 + **插入到当前终端**（`term_write`）。
3. **Agent**：接 Settings 里配的 Ollama/OpenAI 端点+模型，真实流式对话；当回复含 shell 命令块时提供「插入到当前终端」按钮。
4. **历史（命令审计）**：shell 集成（OSC 633/133）捕获真实执行过的 shell 命令 + 退出码 + cwd + 耗时；持久化；面板接真。SQL 历史预留接口给子项目 3。
5. **ProxyJump 跳板**：真实经堡垒机多跳连接（russh direct-tcpip 串接）；新建/编辑表单配置；隧道面板的 ProxyJump 链显示真实跳板链。

### 不做
- 数据库连接/SQL（子项目 3）。SQL 历史本期只留事件接口。
- 加密保险库 / OS keychain（子项目 4）；历史与片段本期明文存 localStorage。

## 2. 各面板设计

### 2.1 空态清理（SFTP / Tunnels / Monitor）
- `services/ssh.ts` 的 `getSftp/getTunnels/getMonitor` 在「非 Tauri 或无 sessionId」时**不再返回 `DATA.*`**，而是返回空（`{path:'/',items:[]}` / `[]` / 空 Monitor）或由面板渲染统一空态组件。
- 各面板：`sessionId` 缺失时渲染「无活动会话 · 先从 Vault 连接一个主机」空态（复用现有空态风格，如 EmptyWorkbench/HomeView 的空态），不显示假数据。
- 浏览器 demo（非 Tauri）下同样显示空态（不再用 mock 充数）。`mockData.ts` 仅保留给单测使用。

### 2.2 片段库（Snippets）
- 新建 `src/state/snippets.ts`：`Snippet { id, scope, desc, icon, code }`；`loadSnippets/saveSnippet/deleteSnippet`（localStorage key `catio-snippets`），初始为空（去除 `DATA.snippets` 种子）。
- `SnippetsPanel`：列表来自真实存储；**新增/编辑/删除**（编辑/删除带行内操作；删除二次确认复用 `ConfirmModal`）；**复制**到剪贴板；**插入到当前终端**——通过 App 传入的 `onInsert(code)`，App 对活动终端 tab 调 `termWrite(sessionId, chanId, base64(code))`（写入 PTY，不自动回车，由用户确认执行）。无活动终端时「插入」禁用并提示。
- App：维护当前活动终端的 `chanId`（TerminalPane 打开 PTY 后通过回调上报，或 App 持有 sessionId→chanId 映射）。

### 2.3 Agent（真实推理）
- 复用现有 `src/state/agentConfig.ts`（provider/endpoint/key/model）+ `src/services/models.ts`（`resolveFetch`、Ollama `/api/chat`、OpenAI `/v1/chat/completions`）。
- 新建 `src/services/agent.ts`：`chat(messages, cfg, { onToken })` 流式调用：
  - Ollama：`POST {base}/api/chat` `{model, messages, stream:true}`，逐行 JSON（`{message:{content}}`）累积。
  - OpenAI 兼容：`POST {base}/v1/chat/completions` `{model, messages, stream:true}` + `Authorization: Bearer`，SSE `data:` 行解析 `choices[0].delta.content`。
  - 用 `resolveFetch()`（Tauri HTTP 插件绕过 CORS）。流式读取用 response body reader。
- `AIPanel`：去除 mock `DATA.aiThread/aiSql/aiShell`；真实对话状态（用户消息 + 流式 assistant 回复）；输入框发送 → `agent.chat`；
  - 回复渲染：检测代码块（```sh/```bash/```shell 或通用），对 shell 代码块显示「插入到当前终端」按钮（接 2.2 的 onInsert）。SQL 代码块的「执行」留给子项目 3（本期可显示但「插入/执行」对 SQL 暂禁用或仅复制）。
  - 系统提示：注入当前会话上下文（host、cwd 若有、shell 模式），让回答贴合「shell 助手」。
  - 未配置模型时：面板提示「去设置配置模型」（链接到设置）。
- 安全：API key 仍只存 `agentConfig`（localStorage，子项目 4 再加密）；不把 key 写日志。
- 范围限制：**仅生成 + 插入**，不直接执行（用户选的「对话 + 插入」档）。

### 2.4 历史（命令审计，OSC 633/133）

**后端（Rust）：**
1. **注入 shell 集成**（`term.rs`，`term_open` 在 `request_shell` 后）：
   - 生成每会话随机 `nonce`。
   - 向 PTY 写入一行一次性 bootstrap：`<空格>eval "$(printf %s '<base64>' | base64 -d)"\n`（前导空格 + `HISTCONTROL=ignorespace` 避免进 history）。`<base64>` 是一段 **自检 bash/zsh** 的集成脚本（改写自 VS Code MIT 脚本，文件头标注来源）：
     - bash：装 DEBUG trap（带 in_command_execution 守卫）+ `PROMPT_COMMAND`，发 `\e]633;E;<esc cmd>;<nonce>\a`、`\e]633;C\a`、`\e]633;D;<exit>\a`、`\e]633;P;Cwd=<esc pwd>\a`。
     - zsh：`add-zsh-hook preexec/precmd` 同义。
     - 转义函数同 VS Code（`\`→`\\`、`;`→`\x3b`、<0x20→`\xNN`）。
   - 非 bash/zsh 或脚本失败：不发标记 → 该会话无命令审计（不做不可靠的启发式）。
2. **解析 + 剥离**（`term.rs` owner 任务的读循环，新增 `osc.rs` 纯解析模块）：
   - 在转发字节给 xterm 前，扫描并**移除** `\e]633;…\a` 与 `\e]133;…\a` 序列（跨读块边界需缓冲半截序列）。
   - `E;<cmd>;<nonce>`：校验 nonce，反转义 → 记当前命令 + 开始时间戳。
   - `D[;<exit>]`：与当前命令配对 → emit `history://{sessionId}` 事件 `{ command, exitCode, cwd, startedAt, durationMs, host }`。
   - `P;Cwd=<dir>`：更新当前 cwd。
   - nonce 不符的 E/D 一律忽略（防远端程序伪造历史）。
3. `osc.rs` 纯函数单测：给定含 OSC 序列的字节块，断言「剥离后的可见字节」+「抽出的命令/退出码/cwd」+「跨块边界缓冲」+「nonce 不符被拒」。

**前端：**
- `services/ssh.ts`：订阅 `history://{sessionId}`；`getHistory()` 从持久化读。
- 新建 `src/state/history.ts`：环形持久化（localStorage key `catio-history`，上限如 1000 条），`appendHistory(entry)`、`loadHistory()`、`clearHistory()`。App 订阅 `history://` → append。
- `HistoryPanel`：去 mock；显示真实 `{kind:'shell'|'sql', target, text, when, dur, exitCode}`（kind 由来源决定，shell 来自审计；sql 来自子项目 3）；支持「插入到终端」「加为片段」（已有 onAddSnippet）「清空历史」。退出码非 0 标红。
- **SQL 历史接口**：`appendHistory` 通用，子项目 3 跑 SQL 时调同一函数写 `kind:'sql'`。

**安全/隐私**：命令历史可能含敏感参数（密码在命令行等）——本期明文存 localStorage，文档标注；提供「清空历史」；后续可纳入子项目 4 的加密。nonce 防伪造。

### 2.5 ProxyJump 跳板（真实多跳）
- **后端**（`conn.rs`）：`ConnectArgs` 增加可选 `jump: Option<JumpSpec>`（`JumpSpec { host, port, user, auth, secret? }`，可链式 `Vec` 支持多跳；v1 先支持单跳堡垒机，结构留多跳）。`connect_core`：
  - 先连第一跳（jump host）认证；
  - 对每一跳 `channel_open_direct_tcpip(next_host, next_port, ...)` 取得到下一跳的通道流；
  - 用 russh 在该通道流上建立下一层 SSH（russh 支持在任意 `AsyncRead+AsyncWrite` 流上 `connect_stream`/类似 API — 需核实 0.61.2 的「在已有流上建连」API；若无直接 API，则用 direct-tcpip 流作为传输层手动驱动）。最终对目标主机认证。
  - 主机密钥 TOFU 对**目标主机**校验（跳板主机密钥也应校验，键名区分）。
- **前端**：新建/编辑表单的「ProxyJump 跳板」开关打开后，展开跳板配置（host/port/user/认证）；保存进 `ConnectionProfile.jump`（非敏感，跳板 secret 同样连接时提示，不落盘）。隧道面板 `jumpChain` 改为显示该连接真实的「本地 → 跳板… → 目标」链（来自档案 + 活动会话）。
- 测试：测试 server 支持作为「跳板」——接受 direct-tcpip 到一个**第二个进程内 russh server**（目标），验证经跳板建立到目标的会话能 exec/echo。

## 3. 文件结构（增量）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/ssh/osc.rs`（新） | OSC 633/133 解析 + 剥离纯函数 + 单测 |
| `src-tauri/src/ssh/term.rs` | 注入 shell 集成 bootstrap；读循环接 osc 解析、emit `history://`、剥离序列 |
| `src-tauri/src/ssh/conn.rs` | `JumpSpec` + `connect_core` 多跳；目标/跳板 TOFU |
| `src-tauri/tests/` | osc 单测、ProxyJump 集成测试（双 server）、shell 集成注入集成测试 |
| `src/services/ssh.ts` | 空态化 getSftp/getTunnels/getMonitor；`getHistory` + `history://` 订阅 helper |
| `src/services/agent.ts`（新） | 流式 chat（Ollama/OpenAI） |
| `src/state/snippets.ts`（新） | 片段持久化 CRUD |
| `src/state/history.ts`（新） | 历史持久化（环形） |
| `src/components/panels/SftpPanel/TunnelsPanel/MonitorPanel.tsx` | 空态 |
| `src/components/panels/SnippetsPanel.tsx` | 真实 CRUD + 插入/复制 |
| `src/components/panels/AIPanel.tsx` | 真实流式对话 + 插入命令 |
| `src/components/panels/HistoryPanel.tsx` | 真实历史 + 清空/插入/加片段 |
| `src/components/modals/NewConnectionModal.tsx` | ProxyJump 配置真实保存 |
| `src/App.tsx` | sessionId→chanId 映射、onInsert、history 订阅、面板 sessionId 透传 |

## 4. 错误处理 / 边界
- Agent：端点不可达/鉴权失败/未配模型 → 面板内明确错误（不崩）。流式中断可重试。
- 历史：shell 集成不可用（非 bash/zsh、受限 shell、容器无 base64）→ 该会话静默无审计，面板对该会话不报错（可选提示「该会话未启用命令审计」）。
- ProxyJump：任一跳连接/认证失败 → 明确指出哪一跳失败；目标主机密钥不匹配硬拒。

## 5. 测试策略
- **Rust**：`osc.rs` 纯函数单测（解析/剥离/边界/nonce）；进程内 server 验证注入后能收到 OSC 标记并解析出命令+退出码（exec 路径或 shell 路径模拟）；ProxyJump 双 server 集成测试。
- **前端**：`agent.ts` mock fetch 流式测试；snippets/history 持久化单测；各面板空态 + 真实数据渲染（mock services）。沿用既有 vitest 模式。
- **手动 QA（Docker sshd）**：真实终端跑命令 → 历史面板出现该命令+退出码+cwd；Agent 真实对话 + 插入命令；片段插入；ProxyJump 经堡垒机连内网机。

## 6. 复用许可
- shell 集成脚本改写自 **VS Code（MIT）** 的 `shellIntegration-bash.sh`/`-rc.zsh`；OSC 633 由 VS Code 定义、OSC 133 由 FinalTerm/iTerm2 定义。注入脚本文件头标注来源与 MIT。russh 复用同子项目 2。
