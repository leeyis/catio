# SSH 终端命令历史自动补全 — 设计文档

- 日期:2026-06-12
- 状态:已确认,待实现
- 范围:catio SSH 终端(`TerminalPane`)新增「输入时自动生成历史命令候选」功能

## 1. 目标

用户在已连接的 SSH 终端里输入命令时,catio 实时给出**匹配的历史命令候选**:

- **行内幽灵文本**:在光标后以灰色虚显最佳候选的剩余部分(fish / zsh-autosuggestions 风格)。
- **下拉候选列表**:在光标下方弹出匹配到的历史命令列表,可上下键选择。
- 输入字符越多,候选逐步收窄;候选**去重**;**最近使用的命令优先**展示。

### 成功标准

- 在装有 shell integration 的远程主机上,敲入若干字符后能看到匹配候选(下拉 + 幽灵)。
- 候选按主机隔离:连到 A 主机只看到 A 主机的历史。
- 候选去重、最近优先、随输入收窄。
- 一切非补全交互的按键原样透传给远程 shell,不破坏正常终端行为。
- 无 shell integration 的主机上功能静默不启用,终端照常工作。

## 2. 关键约束与既有事实

catio 是**终端模拟器(xterm.js)**,坐在远程 shell 外面;真正的行编辑发生在远程 shell 里。因此不能像 fish/zsh 那样在 shell 内部直接掌控命令行缓冲区。本设计采用 **VS Code 终端补全**的思路:借助 OSC 633 shell integration 标记 + 读取 xterm 缓冲区来还原「当前输入行」。

既有基础设施(已存在,直接复用):

- `src-tauri/src/ssh/osc.rs` — OSC 633/133 扫描器,已解析出命令审计事件;但对 `B`(提示符结束 / 输入起点)仅剥离、**不发事件**。
- `src-tauri/src/ssh/term.rs` — PTY owner 任务;已在每条命令完成时发 `history://{sessionId}` 事件,payload 含 `{ id, command, exitCode, cwd, durationMs, host }`。
- `src/state/history.ts` — `loadHistory()` 等;`history://` 事件落入 localStorage `catio-history`,容量 1000。
- `src/services/types.ts` — `HistoryItem { id, kind: 'sql'|'shell', target, text, when, dur, exitCode?, ts? }`。
- `src/components/dbviews/mongoCompletion.ts` — 纯函数补全规划范式,本设计的补全引擎仿此实现。
- `src/components/workbench/TerminalPane.tsx` — xterm 集成;`pop-in col` + `--surface-elevated` / `--shadow-dropdown` 的下拉浮层样式(见 `TerminalPane.tsx:450`)可复用。
- `src/i18n/{zh,en}.json` + `t()` — 国际化方案。

## 3. 数据流

```
远程 shell 回显输入
  → 后端 OSC 扫描器:命令起点(B)透出「输入起点」信号(随字节流按序到达前端)
  → 前端 TerminalPane:收到信号时用 xterm registerMarker() 标记命令起点行 + 记录起始列
  → 每次按键(term.onData)后:读 xterm 缓冲区 [命令起点 → 光标] = 当前输入串
  → 当前输入串喂给纯函数补全引擎
  → 引擎返回:① 排序后的候选列表 ② 最佳候选的「幽灵后缀」
  → 渲染:下拉列表(Phase 1) + 行内幽灵文本(Phase 2)
```

### 候选数据来源

补全时从既有数据派生,无需新增存储:

1. `loadHistory()` 读 `catio-history`。
2. 筛 `kind === 'shell'`。
3. 筛 `target === 当前连接主机`(按主机隔离)。
4. 按命令文本**去重**,保留最近一条。
5. 按时间倒序(**最近优先**)。

## 4. 组件与改动点

| 层 | 文件 | 改动 |
|----|------|------|
| 后端 | `src-tauri/src/ssh/osc.rs` | 新增 `OscEvent::InputStart`,在 `B` 时发出(现仅剥离);保留现有 A/C/D/E 行为 |
| 后端 | `src-tauri/src/ssh/term.rs` | 把 `InputStart` 按序透传给前端(随 `term://` 字节流顺序,保证与可见字节的先后关系) |
| 前端 | 新建 `src/components/shell/historyCompletion.ts` | 纯函数补全引擎 |
| 前端 | 新建 `src/components/shell/HistorySuggest.tsx` | 下拉候选浮层(复用现成 `pop-in` 下拉样式) |
| 前端 | `src/components/workbench/TerminalPane.tsx` | 接线:标记命令起点、读输入、键盘交互、渲染下拉与幽灵 |
| i18n | `src/i18n/{zh,en}.json` | 新增本功能 UI 文案(空态/提示),同步所有语言文件 |

### 4.1 补全引擎 `historyCompletion.ts`(纯函数)

- 入参:`(input: string, entries: ShellHistoryEntry[])`,其中 `entries` 已按主机筛好、去重、最近优先。
- 匹配策略:**前缀匹配优先**(排最前,fish 风格)→ **子串匹配兜底**(排后面);组内保持「最近优先」次序。
- 出参:`{ items: Match[]; ghost: string | null }`
  - `items` 给下拉列表使用。
  - `ghost` = `items[0]` 去掉已输入前缀后的剩余串;**仅当 `items[0]` 为前缀命中**时给出,否则为 `null`。

### 4.2 输入提取(TerminalPane)

- 收到 `InputStart` 信号时,用 xterm `registerMarker()` 记录命令起点所在行,并记录起始列(此刻光标列)。
- 每次 `term.onData` 后(节流 30–50ms),读 xterm 活动缓冲区从命令起点到当前光标的文本 = 当前输入串。跨行/换行由 xterm 缓冲区处理后拼接。

## 5. 交互细节

### 显示 / 隐藏时机

- **显示**:处于提示符等待输入态(`InputStart` 之后、`ExecStart` 之前)且当前输入非空(≥1 字符)且有匹配。
- **隐藏**:命令执行(`ExecStart`)、输入清空、无匹配、按 `Esc`、终端失焦、或检测到 ↑/↓ 翻 shell 历史等非普通输入动作。

### 键盘交互(仅在下拉 / 幽灵激活时拦截,其余按键原样透传)

| 按键 | 行为 |
|------|------|
| `↑` / `↓` | 候选间移动高亮(不发给终端,阻止默认) |
| `Enter` / `Tab` | 把选中候选的**剩余差额**写入终端(只补差额,不重发已输入部分) |
| `Esc` | 关闭下拉(本次输入不再弹,直到下一次改动) |
| `→` / `Ctrl+E`(仅 Phase 2 幽灵态) | 接受行内幽灵文本 |
| 其它字符 | 透传给终端,触发重新匹配 |

### 下拉定位与样式

- 绝对定位于当前输入行光标下方(`cursorY/cursorX` + 行高换算像素);空间不足则翻到上方。
- 复用 `pop-in col` + `--surface-elevated` / `--border-hairline-alt` / `--shadow-dropdown`,`maxHeight: 240px` 滚动,选中项高亮,匹配前缀可加粗。

## 6. 分阶段交付

- **Phase 1(打底,价值主体)**:`osc.rs` 的 `InputStart` 透传 → 前端输入提取 → 补全引擎 → **下拉列表 + 键盘交互**。完整可用,不含幽灵文本。
- **Phase 2(叠加)**:**行内灰色幽灵文本** —— 以 dim SGR 写入 `items[0]` 的剩余后缀,用 DECSC/DECRC(`ESC 7` / `ESC 8`)保存恢复光标,在用户继续输入 / 接受 / 关闭前擦除。最 finicky,独立验证。

## 7. 边界处理

- **无 shell integration 的远程**(无 OSC 标记,3s 后 unmute):拿不到 `InputStart` → 功能**静默不启用**,终端照常工作,不报错。
- **行换行 / 宽字符(CJK)**:Phase 1 读缓冲区按 xterm 换行处理拼接,跨行也能还原;Phase 2 幽灵文本遇换行 / 接近行尾时**不渲染幽灵**(只保留下拉),避免错位。
- **粘贴多行**:含换行的输入不触发补全。
- **历史为空 / 无匹配**:不显示任何浮层。
- **性能**:候选筛选 + 排序 O(n)(n ≤ 1000);每次按键节流避免高频读缓冲区。

## 8. 测试策略

| 层 | 测试内容 |
|----|---------|
| `historyCompletion.ts`(单测) | 前缀优先于子串;去重保留最近一条;最近优先排序;空输入 / 无匹配返回空;ghost 仅前缀命中时给出且为正确剩余串;大小写处理 |
| `osc.rs`(Rust 单测) | 新增:`B` 标记发出 `InputStart`;不破坏现有 A/C/D/E 解析 |
| 输入提取 / 键盘交互 | 依赖 xterm + 真实终端,**手动验证**(不引入 E2E 框架) |

手动验证清单(连真实主机):敲 `np` 弹出含 `npm run tauri build` 的候选 → ↑↓ 选择 → Enter 补全差额 → Esc 关闭 → 执行后消失 → 切到另一主机候选隔离 → Phase 2 幽灵文本随输入变化、`→` 接受。

## 9. 规范遵循

- **i18n**:UI 文案(空态 / 提示)走 `t()`,同步更新 `zh.json` / `en.json`;候选命令文本本身不翻译。
- **主题色**:浮层与高亮全部用现有 CSS 变量,不写死颜色;幽灵文本用 dim / 次级文本色变量;天然跟随主题切换。
- **git 提交**:分逻辑提交(后端 InputStart `feat`、补全引擎 `feat`、下拉 UI 接线 `feat`、Phase 2 幽灵文本 `feat`),中文正文 + 英文前缀。

## 10. 非目标(YAGNI)

- 不读远程 `~/.bash_history` / `~/.zsh_history`(仅用 catio 本地审计历史)。
- 不做跨主机全局补全(按主机隔离)。
- 不自己拦截键盘重实现 readline(依赖 OSC 标记 + 缓冲区读取)。
- 不引入 E2E 测试框架。
