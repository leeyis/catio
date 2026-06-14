# Multi-Exec 多机广播 — 完整实现设计

- 日期：2026-06-14
- 状态：设计已确认，待实现
- 范围：纯前端改造 + 复用现有建连逻辑（后端不改）

## 一、背景与问题诊断

工作台终端右上角的 `Multi-Exec` 广播功能目前表现像"模拟功能"。逐项核实后：

- **后端是真的**：`src-tauri/src/ssh/multiexec.rs` 的 `multiexec_run` 能在多条 SSH 会话上并发
  exec 同一条命令，并通过 `multiexec://{runId}` 事件流式回传 `running/done/error`。
- **前端 seam 已接上**：`App.tsx:1194` 已把 `resolveSessionId` 传给 `TerminalPane`。
- **真正"假"的根因在候选列表**（`TerminalPane.tsx:146-147`）：
  1. 候选来自全部 `D.connections`（mock 数据：prod-web-01/02、db-bastion 等），而非"当前真正
     建立了 live session 的连接"。勾选这些 mock 主机点广播时，`resolveSessionId(connId)`
     返回 `undefined` → 目标被**静默丢弃**，命令根本没在它上面执行。
  2. 默认预勾选前 2 台（`.slice(0,2)`）——对危险操作是反模式。
  3. 没有任何「敏感命令」防护——任何命令都直接一次性 exec 出去。

## 二、需求（用户诉求）

1. **激活状态标识**：多机执行处于"已激活/armed"时要有醒目标识。
2. **逐条手工触发**：不能所有命令自动广播，每次都要显式触发。
3. **敏感操作防护**：破坏性命令要有额外确认，避免误操作打穿多台机器。

## 三、已确认的关键决策

| 决策点 | 选定方案 |
| --- | --- |
| 广播目标范围 | **全部同协议连接 + 广播时自动建连**（不限于当前已连接的会话） |
| 确认机制 | **普通命令轻确认 + 敏感命令强警告**（强警告需二次输入确认） |
| 敏感识别 | **内置破坏性模式库** |
| 激活/编排方式 | **专用广播输入条 + 显式发送** |
| 认证中断处理 | 能静默连的自动连；连不上的**不阻塞广播**，结果面板标「需认证」+ 一键连接 |
| 自动建连的会话形态 | **开成真实终端标签页**（用户要"看到执行结果"） |

## 四、设计详述

### 4.1 数据源修正（修掉"模拟"的根因）

- 广播候选不再来自 `D.connections`（mock），改为由 `App.tsx` 传入真实候选 `mxCandidates`：
  来自 `profiles`（已保存连接）+ `liveConns`（在线会话），过滤 `kind === 'host'` 且与当前
  标签同协议（`proto`）。
- 每个候选用 `resolveSessionId(connId)` 判定「已连接 / 未连接」并显示状态徽标。
- **取消默认预勾选**：初始选中集合改为 `[]`，危险操作不该帮用户预选目标。
- 当前会话（`conn`）仍为锁定目标，始终包含在广播中（保留现有「当前会话 · 已锁定」UI）。

### 4.2 激活状态标识（诉求①）

广播处于 armed 状态时，三重视觉信号：

1. 顶部 `Multi-Exec` chip 高亮 + 显示「· N 台」（已有，保留）。
2. **终端外圈加一圈高亮描边**（accent 色 outline）——新增，最醒目的「我正处于多机模式」标识。
3. 底部常驻 armed 横条列出全部目标 chip（已有，保留）。

### 4.3 激活/编排方式（诉求②③）

保留**专用广播输入条 + 显式发送**：命令在独立输入条里敲，回车或点「广播到 N 台」=
**一次广播**，主终端不受影响。天然逐条手工触发，绝不会"所有命令都广播"。

### 4.4 确认与敏感防护（诉求③）

每次发送前走确认网关（新增 `BroadcastConfirmModal.tsx`）：

- **普通命令**：轻确认框，列出「将执行的命令 + 具体目标主机清单」，点确认才发。
- **敏感/破坏性命令**：确认框变红、列出命中的危险原因，需**二次输入确认**（输入 `yes`）
  才解锁发送按钮。
- 识别用**内置破坏性模式库**，新增 `src/components/workbench/sensitiveCommands.ts`，导出
  `isSensitiveCommand(cmd) → { sensitive: boolean; reasons: string[] }`。初版模式库覆盖：
  - `rm -rf` / `rm -fr` / `rm ... -rf`
  - `dd`、`mkfs.*`、`> /dev/sd*`、`:> /dev/...`
  - `shutdown` / `reboot` / `poweroff` / `halt` / `init 0` / `init 6`
  - `kill -9`、`pkill -9`、`killall`
  - `chmod -R` / `chown -R`（含 `/` 根路径时尤为危险）
  - fork bomb `:(){ :|:& };:`
  - 覆盖重定向到关键路径：`> /etc/...`、`> ~/.ssh/...` 等
  - SQL/DB：`drop database`、`drop table`、`truncate`（同协议为 DB 时）
  - `mv ... /` / `> ` 清空文件等高风险重定向

### 4.5 自动建连（"全部连接 + 自动建连 + 开标签页"）

`App.tsx` 新增 `ensureBroadcastSession(connId): Promise<string | 'needs-auth' | 'failed'>`：

1. **复用优先**：`sessionMap[connId]` 已存在 → **直接返回现成 sessionId，不重连、不开新标签**。
2. 否则取 `profiles` 里的 profile，构造 `SshConnectArgs`；若**有缓存凭据**（`cachedSecret`）
   **且 host key 已信任** → `sshConnect` 静默连上 → **复用 `openLiveTab` 开成真实终端标签页**
   → 返回新 sessionId。
3. 连不上（需密码/密钥、首次 host key 信任）→ 返回 `'needs-auth'`，**不阻塞广播**；其他异常
   返回 `'failed'`。

**复用与重建的边界**（明确写入实现）：

- "自动建连"只在**首次**或**会话已断开**（`sessionMap` 无此 connId）时发生。
- 标签还在、连接还活着 → 后续广播一律**复用**现成 session（`openLiveTab` 在 `App.tsx:417-425`
  已对同一 connId 做 MRU 去重，不会重复开标签，只刷新 sessionId）。
- 某台标签被用户**手动关掉**（session teardown、`sessionMap` 移除）→ 下次广播视为"未连接"，
  重新静默建连 + 重开标签。
- 标签还在但**底层连接掉线** → exec 返回 error，结果面板对该台显示 error；**本次不自动重连**，
  用户重连后可再广播（避免静默重连的不确定性）。

### 4.6 广播执行流程（TerminalPane）

```
发送（回车 / 点按钮）
  → isSensitiveCommand(cmd) 检测
  → 确认网关（轻 / 强）            // 用户取消则中止
  → 对每个目标 ensureBroadcastSession(connId)：
        sessionId          → 收集进 ready 列表，记录 sessionId↔connId 映射
        'needs-auth'/'failed' → 在结果面板标记该 connId，不参与本次 exec
  → multiexecRun(ready 的 sessionIds, cmd)
  → listen('multiexec://' + runId)，按 sessionId↔connId 映射回填结果面板
```

- 结果面板（已有，`TerminalPane.tsx:871-889`）扩展：新增 `needs-auth` 状态行，带「连接」
  按钮——点击走正常交互建连流程（`connectProfile`），连上后用户可重新广播。
- 结果回填不再依赖 `mxHosts.find(resolveSessionId === ev.sessionId)`（自动建连的新 session
  当时不在 `mxHosts→sessionMap` 映射里），改为广播时构建的 `sessionId→connId` 直接映射。

### 4.7 语义边界（实现说明，非 bug）

广播是**一次性 exec channel 并发执行**（非交互 PTY），多条广播之间**不保留 shell 状态**
（`cd` 后再广播 `ls` 不在同一 cwd）。这是 multi-exec 的固有语义，会在确认框/文案里点明。

## 五、改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/App.tsx` | 构建 `mxCandidates`；新增 `ensureBroadcastSession`；传给 `TerminalPane` |
| `src/components/workbench/TerminalPane.tsx` | 候选改用 prop；取消预选；armed 描边；确认网关；结果面板 needs-auth；结果映射改用 sessionId↔connId |
| `src/components/workbench/sensitiveCommands.ts` | **新增**：敏感模式库 + `isSensitiveCommand` |
| `src/components/workbench/BroadcastConfirmModal.tsx` | **新增**：轻 / 强确认框 |
| `src/i18n/zh.json` + `src/i18n/en.json` | 新增文案（双语同步） |
| 后端 | **不改** |

## 六、成功标准（验证点）

1. 广播候选列表只显示真实可连接的同协议主机，不再出现 mock 数据；未连接的可选并能自动建连。
2. 打开 Multi-Exec 默认不预选任何目标。
3. armed 状态下终端外圈有醒目描边 + chip 高亮 + 底部目标横条。
4. 每次广播都需在确认框点确认；敏感命令需二次输入 `yes` 才能发送。
5. 首次广播对未连接目标自动建连并开标签；第二次广播复用现成会话，不重连、不重复开标签。
6. 连不上的目标在结果面板标「需认证」并提供一键连接，且不阻塞其余目标的执行。
7. 所有新增文案在中英文下均正常显示；主题色切换下 armed 描边/确认框配色正常。
