# small-rust-hermes-v3 对 Catio Agent 后端的可复用性分析

> 研究日期：2026-08-15  
> Hermes 基线：[`bdd400deb8ba56e30c87b6916348db73f828aded`](https://github.com/leeyis/small-rust-hermes-v3/tree/bdd400deb8ba56e30c87b6916348db73f828aded)（仓库 `main` 在研究时的 HEAD）  
> Catio 基线：[`3adf8d984f54f6bfc01f3c7716a8e70bfa605f28`](https://github.com/leeyis/catio/tree/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28)  
> 资料范围：Hermes README、Cargo manifests、Rust 源码、许可证、提交历史；该仓库关闭了 GitHub Issues，研究时没有可用 issue。本文以 Agent 后端执行逻辑为主，同时评估 Catio 后续技能、记忆、反思与受控技能演进所需的架构预留。

## 结论

Hermes **可以显著优化 Catio Agent 后端**。在本项目明确为个人自用、非商业用途的前提下，PolyForm Noncommercial 允许研究、修改和复用，因此许可证不是本次决策阻碍。技术上可以选择性吸收其后端代码；但不建议把整个 Hermes workspace 直接作为 Catio 依赖或原样搬入，因为两者的执行目标、状态边界和已有基础设施不同，且 Hermes 核心路径仍有需要先修复的并发与取消缺陷。

最值得采用的是它的四个结构性设计：

1. 用 typed `ContentBlock::ToolUse/ToolResult` 和 JSON Schema 工具定义取代 Catio 目前的 Markdown fenced-code 解析。
2. 把 provider streaming、tool loop、权限决策、确认桥接、取消与事件输出收敛到一个与 UI 无关的 Rust `turn engine`。
3. 对一次模型响应中的只读/安全工具并行执行，对需确认的副作用工具串行执行，并始终按 tool-use ID 配对结果。
4. 以 typed event stream 向前端报告 `TextDelta`、`ToolExecStart`、`ToolUseResult`、`Usage`、`Error` 和 `Done`，让桌面与 server mode 复用同一执行内核。

但 Catio 不应照搬 Hermes 的 shell runner、server state 或权限实现：Hermes 的 Bash 工具并非沙箱，timeout/取消不保证杀死子进程；server 使用单 bearer token、进程级共享 session map，缺少 Catio 所需的多用户 owner 隔离；同 session 并发 turn 也没有显式互斥。许可证仅作为未来边界备注：当前个人非商业用途属于许可范围；如果以后改变为商业用途或要以 MIT 重新分发复制的 Hermes 代码，再单独处理授权或重写问题。[Hermes LICENSE L1-L28](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/LICENSE#L1-L28) [Catio LICENSE L1-L13](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/LICENSE#L1-L13)

### UI 兼容原则

本次优化应坚持 **UI-first 渐进迁移**：保留 Catio 当前 Agent 面板、conversation、terminal split、权限弹窗与流式 Markdown 体验，把后端输出映射回现有 UI 状态；只有当 typed tool lifecycle 引入现有界面无法表达的状态时，才增加 tool card、thinking、usage、取消结果未知等增量 UI。第一阶段不重做 Agent 页面，也不引入 Hermes GUI/Flutter。

技能和记忆是已明确的后续产品入口，但不应阻塞第一阶段后端迁移。界面上应在现有 `IconRail` 顶部区域新增 `skills` 与 `memory`，与 `snippets`、`history` 平级，并各自挂载独立 `SkillsPanel` / `MemoryPanel`；不应把它们藏进 Agent 设置或复用同一个混合面板。当前导航本来就是 rail item 驱动的平级 panel switch，因此这条演进路径与现有 UI 结构一致，且能自然继承主题变量与 i18n 机制。[Catio `Sidebar.tsx` L535-L584](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/components/shell/Sidebar.tsx#L535-L584) [Catio `App.tsx` L2117-L2118](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L2117-L2118)

四类数据需要保持清晰边界：片段是用户显式维护、可插入终端的命令或 SQL；历史是已经发生的活动记录；技能是可被 Agent 选择和执行的过程性说明；记忆是可检索、可固定、可淘汰或被新事实取代的长期上下文。它们可以共享搜索、标签和 owner scope 基础设施，但不应共享含混的数据模型。

代码吸收有三种方式：

1. **选择性移植（推荐）**：提取 Hermes 的 typed message/provider/turn loop 代码到 Catio 自有 `agent` module；第一阶段不带入 memory/reflection/subagent，接入 Catio 已有 MCP、SSH、DB 与事件基础设施，并在上线前修复本文列出的取消、fail-open 和并发问题。收益与改动面最平衡。
2. **直接依赖 Hermes crates**：最快做出 spike，但 private git dependency、Hermes 类型泄漏、无关 crate 演进和补丁维护会长期耦合两项目，不适合作为最终结构。
3. **完全重新实现**：接口最贴合 Catio，但会重复 provider streaming、tool pairing 和 round-cap 等已经存在的工作；除非未来许可前提改变，否则当前没有必要从零开始。

## 1. Hermes 架构

Hermes 是一个 15-crate Cargo workspace，核心 seam 清晰：`hermes-core` 定义消息、provider、session、tool host；`hermes-llm` 适配 Anthropic/OpenAI-compatible；`hermes-turn` 实现共享 turn/tool loop；`hermes-tools` 与 `hermes-mcp` 提供工具；`hermes-store` 做 JSONL session；CLI、Tauri GUI、Axum server 均位于外围。[workspace Cargo.toml L1-L16](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/Cargo.toml#L1-L16) [README L239-L255](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/README.md#L239-L255)

核心依赖是 Tokio、`futures`、Serde、`thiserror`/`anyhow`、`reqwest`/rustls、`rmcp`，server 使用 Axum；workspace 禁止 unsafe code。[Cargo.toml L25-L60](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/Cargo.toml#L25-L60) [Cargo.toml L80-L90](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/Cargo.toml#L80-L90)

这个分层比 Catio 当前 Agent 更适合作为长期后端。Catio 的请求/流解析在前端 [`src/services/agent.ts` L81-L216](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/services/agent.ts#L81-L216)，shell loop 在 [`agentExecution.ts` L21-L82](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/components/workbench/agentExecution.ts#L21-L82)，而编排、会话 patch、权限 UI 和终端调度集中在 [`App.tsx` L1786-L1949](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L1786-L1949)。这让桌面和 Web server 很难共享完全一致的 Agent 语义，也使 React 生命周期承担了业务编排职责。

## 2. Agent loop 与 tool execution

### 2.1 两层循环

Hermes 有两个不同层级：

- `run_turn()` 是面向一次用户 turn 的工具循环，默认最多 25 个 tool rounds；每轮向 provider 发送完整 typed history 和 tool schemas，消费流，加入 assistant message，执行 tool calls，再将 typed tool results 作为下一条 user message继续请求，直到模型不再以 `ToolUse` 停止。[`hermes-turn/src/lib.rs` L20-L20](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L20) [`lib.rs` L163-L199](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L163-L199) [`lib.rs` L270-L344](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L270-L344)
- `run_agent()` 是更外层的 goal loop：重复调用 `run_turn()`，注入进度检查，用文本 marker `[GOAL_COMPLETE]`/`[GOAL_FAILED]` 判定结束，默认最多 50 iterations，并在 turn 间做 context compaction。[`agent.rs` L1-L6](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L1-L6) [`agent.rs` L45-L74](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L45-L74) [`agent.rs` L193-L274](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L193-L274)

Catio 当前更接近 `run_turn()`：从 assistant Markdown 中找第一个 shell fenced block，执行并把结果伪装为 user 文本，再循环；最大步数可配置。[Catio `agentExecution.ts` L21-L59](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/components/workbench/agentExecution.ts#L21-L59) [Catio `App.tsx` L1855-L1925](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L1855-L1925)

**建议**：先只迁移 `run_turn()` 思想，不迁移外层 `run_agent()`。Catio 是交互式 SSH/DB 客户端，用户 turn 边界、权限确认和终端占用比“自主完成代码 goal”更重要。外层 agent 的完成 marker 仍是脆弱文本协议，而且其取消只在 iterations 之间检查，源码明确说明 inner turn 不会收到外层 cancel；不适合直接成为 Catio 的取消模型。[`agent.rs` L110-L126](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L110-L126) [`agent.rs` L151-L181](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L151-L181)

### 2.2 Typed tools 是最大收益点

Hermes 的 provider-neutral message 由 `Text`、`Thinking`、`ToolUse { id, name, input }`、`ToolResult { tool_use_id, content, is_error }` 等 block 组成；工具由 name、description、JSON Schema 和 `requires_confirmation` 定义。[`message.rs` L34-L69](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-core/src/message.rs#L34-L69) [`provider.rs` L31-L43](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-core/src/provider.rs#L31-L43)

OpenAI adapter 将同一模型翻译为 `tool_calls`/`role: tool`，Anthropic adapter 原生序列化 content blocks，因此 turn engine 无需理解供应商 wire protocol。[`openai.rs` L1-L13](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/openai.rs#L1-L13) [`openai.rs` L138-L179](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/openai.rs#L138-L179) [`anthropic.rs` L152-L174](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/anthropic.rs#L152-L174)

这会直接消除 Catio 当前协议的主要歧义：漏闭合 code fence、多命令 block、回答里多个 block、shell 方言识别与 Markdown 内容误触发。Catio 已经为这些问题写了 repair 分支，[`agentExecution.ts` L31-L59](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/components/workbench/agentExecution.ts#L31-L59)；迁移到 native tool calling 后，这类 repair 可退化为兼容不支持 tools 的 provider fallback，而不是主路径。

### 2.3 并行执行应采用，但必须加资源冲突域

Hermes 先做 `Deny/Allow/Prompt` 分类；safe calls 以 `join_all` 并行，需确认的 calls 逐个确认、逐个执行。[`hermes-turn/src/lib.rs` L346-L423](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L346-L423) [`lib.rs` L426-L506](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L426-L506)

这个原则适合 Catio 的 `sysinfo`、DB metadata、只读查询等工具，但不能把“无需用户确认”简单等同于“可并行”：两个读操作可能争用同一 PTY；事务内 SQL 即使只读也可能有顺序语义；SSH command 必须按 channel/session 仲裁。Catio 已有单 PTY capture 锁和 busy/split 策略，[`terminalCapture.ts` L23-L32](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/services/terminalCapture.ts#L23-L32) [`App.tsx` L1608-L1662](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L1608-L1662)，迁移后应保留并下沉为 `resource_key`（例如 `pty:{chan_id}`、`db:{connection_id}:{transaction_id}`）上的互斥，而不是复制 Hermes 的全量 `join_all`。

### 2.4 边界完整性处理值得原样重做

Hermes 对两个 API 易错边界处理得好：

- tool input 被 token limit 截断时，生成 error `ToolResult`，避免 orphan `tool_use`。[`lib.rs` L276-L340](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L276-L340)
- 取消发生在部分工具完成后时，为所有未配对 tool-use ID 补 `cancelled` result，使历史仍满足 Anthropic“assistant tool_use 后必须立即有 tool_result”的约束。[`lib.rs` L79-L121](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L79-L121) [`lib.rs` L409-L419](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L409-L419)

Catio 当前只持久化 user/assistant 文本，terminal result 仅存在内存 loop history，[`App.tsx` L1855-L1859](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L1855-L1859)，所以尚未遇到 typed history 配对问题；一旦支持原生工具调用，这一 invariant 必须从第一版就建模并测试。

## 3. Streaming 与事件模型

Hermes 定义 provider-neutral `StreamEvent`：message start、text/thinking delta、tool start/input delta、block stop、唯一 final；`LlmProvider::stream` 对不支持 native streaming 的 provider 还提供 buffered fallback。[`provider.rs` L93-L115](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-core/src/provider.rs#L93-L115) [`provider.rs` L117-L138](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-core/src/provider.rs#L117-L138)

`run_turn()` 再把 provider events 收敛为 UI-facing `TurnEvent`（text/thinking、tool lifecycle、usage、error、done），server 序列化成 tagged JSON WebSocket event。[`hermes-turn/src/lib.rs` L123-L144](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L123-L144) [`hermes-server/src/events.rs` L9-L53](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/events.rs#L9-L53)

**建议采用双层 event 模型**：provider event 只在 Rust 内部使用，向 Catio UI 暴露稳定的 domain events。推荐至少含 `TurnStarted`、`TextDelta`、`ToolProposed(input/risk)`、`ApprovalRequested`、`ToolStarted`、`ToolOutputDelta`、`ToolFinished(status/exit_code)`、`UsageUpdated`、`TurnFinished/Cancelled/Failed`，并给每个 event 增加 `turn_id`、`sequence`、`session_id`、`owner_id`。Hermes event 没有 turn/sequence envelope；同一 WS 上并发 turn 时事件不可可靠归属，这是 Catio 不应复制的缺口。[`chat.rs` L65-L78](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L65-L78) [`events.rs` L9-L53](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/events.rs#L9-L53)

还应避免照搬两个解析细节：Hermes Anthropic parser 对跨 chunk 的无效 UTF-8 使用逐 chunk lossy decode，理论上可能把一个恰好跨 chunk 的合法多字节字符替换为 `�`；Catio 当前 `TextDecoder.decode(value, { stream: true })` 更正确。[Hermes `anthropic.rs` L308-L367](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/anthropic.rs#L308-L367) [Catio `agent.ts` L45-L74](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/services/agent.ts#L45-L74)

## 4. Concurrency 与 cancellation

### Hermes 做对的部分

- 模型 streaming、并行 safe tools、等待确认、最终 synthesis 都通过 `tokio::select!` 响应 turn cancel。[`lib.rs` L213-L248](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L213-L248) [`lib.rs` L409-L423](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L409-L423) [`lib.rs` L450-L462](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L450-L462)
- server 在收到 WS cancel frame 后取出对应 sender 并触发取消；confirmation 也是以 tool-use ID 映射 oneshot sender。[`chat.rs` L26-L48](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L26-L48) [`chat.rs` L389-L420](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L389-L420)

### 不能复制的部分

1. **取消不等于停止副作用。** `select!` drop 掉 `host.call()` future，但 Bash 使用 `tokio::process::Command::output()`，未设置 `kill_on_drop(true)`；工具 timeout 也只是 `tokio::time::timeout` 包裹 future。因此父 future 停止等待后，OS 子进程可能继续运行。这一点对 Catio 远程 SSH 命令尤其危险。[`bash.rs` L59-L72](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/bash.rs#L59-L72) [`bash.rs` L102-L109](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/bash.rs#L102-L109)
2. **Agent outer loop 不能 mid-turn cancel。** 源码明确用一个永不触发的 per-turn channel，只在 iteration 边界检查外层 cancel。[`agent.rs` L151-L181](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/agent.rs#L151-L181)
3. **同 session 并发存在竞态风险（源码推断）。** 每个 `send` 都 `tokio::spawn` 一个 turn，cancel map 以 `session_id` 为唯一键，后来的 send 会覆盖旧 sender；多个 turn 会从相近 history snapshot 独立运行，结束时再追加各自消息。代码没有 per-session busy/turn lock。[`chat.rs` L247-L263](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L247-L263) [`chat.rs` L337-L386](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L337-L386)
4. WS outbound 使用 unbounded channel，慢客户端没有 backpressure/容量上限。[`chat.rs` L65-L75](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L65-L75)
5. `propose_messages`/`propose_queue` 是全局 AppState，而不是 session keyed；一个 session 会覆盖上下文，另一个完成中的 turn 可 drain 全局 queue，存在跨 session 串状态的风险（源码推断）。[`state.rs` L30-L48](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/state.rs#L30-L48) [`chat.rs` L242-L245](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L242-L245) [`chat.rs` L368-L383](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L368-L383)

**Catio 目标模型**应是：每个 `turn_id` 一个 `CancellationToken`；per-conversation 单写者；每个资源有独立 execution lease；provider request、权限等待、terminal capture 和真正的远程 command/process lifecycle 都接收同一取消信号；取消后执行显式 interrupt/close/kill（能力不足则返回 `cancel_requested_but_execution_may_continue`），而不是把 UI 停流误报成命令已停止。Catio 当前 `AbortController` 已贯穿模型、权限 UI 与 terminal capture，[`App.tsx` L1786-L1795](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/App.tsx#L1786-L1795) [`terminalCapture.ts` L162-L178](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/services/terminalCapture.ts#L162-L178)，迁移时不应丢失这条链路。

## 5. Session、state 与 error handling

Hermes session 是 `Meta/Message/Usage` 事件的 append-only JSONL；每次 append 都 `sync_data()`，读取时 replay，malformed line 会跳过并告警。[`hermes-store/src/session.rs` L1-L38](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-store/src/session.rs#L1-L38) [`session.rs` L81-L100](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-store/src/session.rs#L81-L100) [`session.rs` L109-L152](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-store/src/session.rs#L109-L152)

这个 event-log 思路适合提高 Catio 当前 localStorage 文本快照的可恢复性和可观测性，[Catio `conversations.ts` L1-L23](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/state/conversations.ts#L1-L23)；但不建议照搬“每 token/每事件 fsync”。推荐 server SQLite 内使用 append-only `agent_events`，以 turn 边界事务批量提交；桌面模式通过同一 Rust repository API 写 SQLite。event payload 应区分可持久化数据和瞬时 UI delta，避免把 secrets、完整终端输出、base64 图片或 reasoning 原样长期保存。

Hermes server 对 user message 先持久化，但 `run_turn` 产生的所有新消息是在 turn 返回后才批量 append；进程在中途崩溃会保留 user message，却丢失已执行工具的结果和 partial assistant state。[`chat.rs` L222-L240](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L222-L240) [`chat.rs` L351-L360](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L351-L360)。Catio 应在 `ToolStarted` 前写意图记录、`ToolFinished` 后写结果摘要，以便 crash recovery 明确呈现“执行状态未知”，不能简单重放。

错误处理方面，Hermes 的正确模式是 provider/turn 返回 typed `Result`，同时向 UI 发 `Error/Done`；单个 tool failure 被转换成 `ToolCallOutcome { is_error: true }` 反馈模型，从而允许 agent 自我修复。[`lib.rs` L202-L258](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L202-L258) [`lib.rs` L384-L405](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L384-L405)。不正确之处是 server 多处忽略 session append 错误，可能导致 UI 成功但历史未落盘。[`chat.rs` L234-L238](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L234-L238) [`chat.rs` L353-L357](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L353-L357)。Catio 应将“模型失败、工具失败、持久化失败、取消、权限拒绝、执行结果未知”作为不同终态。

Provider resilience 也没有统一：Anthropic 对 429/5xx/network 做三次 retry，支持 `Retry-After` 与 backoff，而 OpenAI adapter 没有 retry。Catio 若下沉 provider，应在 provider-neutral policy 中统一可重试分类、deadline、jitter 与幂等边界，不能让 UI 行为随供应商漂移。[`anthropic.rs` L20-L51](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/anthropic.rs#L20-L51) [`anthropic.rs` L177-L245](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/anthropic.rs#L177-L245) [`openai.rs` L107-L133](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-llm/src/openai.rs#L107-L133)

## 6. 安全边界

### 可借鉴

- 未知工具默认视为危险（fail-safe）。[`hermes-turn/src/lib.rs` L40-L50](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L40-L50)
- deny 规则优先于 allow，规则可按 tool 和关键参数 glob 匹配。[`permissions.rs` L27-L55](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/permissions.rs#L27-L55) [`permissions.rs` L81-L121](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/permissions.rs#L81-L121)
- 文件工具对 canonical path 做 workspace containment 校验，包含 `..` 和 symlink 边界。[`safety.rs` L8-L57](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/safety.rs#L8-L57)
- 工具输出有 head/tail 上限，防止上下文被无限 stdout 填满。[`bash.rs` L21-L40](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/bash.rs#L21-L40) [`bash.rs` L93-L100](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/bash.rs#L93-L100)

### 风险与不适用

- `bash` 的 workspace 只是 current directory，不是 capability sandbox；`sh -c 'cat /etc/passwd'`、网络访问、绝对路径和环境变量读取仍可发生。工具声明为需确认不能替代 OS/SSH 层约束。[`bash.rs` L43-L70](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/bash.rs#L43-L70)
- Hermes 的 allow rule 是字符串 glob，无法可靠理解 shell 管道、重定向、变量展开或多命令；Catio 当前敏感命令分类更丰富，但仍是 regex heuristic。[Hermes `permissions.rs` L98-L121](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/permissions.rs#L98-L121) [Catio `sensitiveCommands.ts` L29-L105](https://github.com/leeyis/catio/blob/3adf8d984f54f6bfc01f3c7716a8e70bfa605f28/src/components/workbench/sensitiveCommands.ts#L29-L105)。Catio 应保留“默认确认 + 风险分类”，只对结构化、范围明确的工具做持久 allow，避免 `bash:*` 级授权。
- server 是一个共享 bearer token；所有 sessions、tools、memories 位于一个 `AppState`，没有 `owner_id`。这不能用于 Catio server mode 的多用户边界。[`state.rs` L22-L49](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/state.rs#L22-L49) [`routes/mod.rs` L22-L78](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/mod.rs#L22-L78)
- bearer token 可出现在 WS query string，而且 server 启动时把完整 token 记到 info log；在代理、shell history 或日志采集中会泄露。服务本身没有 TLS 终止。[`auth.rs` L1-L7](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/auth.rs#L1-L7) [`hermes-server/src/lib.rs` L21-L38](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/lib.rs#L21-L38)
- `AlwaysAllow` 只按 tool name 加到整个 server 进程的集合，不按 user/session/target/argument scope；对 Catio 的远程主机命令权限过宽。[`state.rs` L26-L29](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/state.rs#L26-L29) [`chat.rs` L395-L419](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-server/src/routes/chat.rs#L395-L419)
- **确认通道缺失时 fail-open。** `confirm_tx == None` 时，分类为危险的工具会跳过确认直接执行；Catio 无头/server 模式必须反过来 fail-closed，只有显式 policy grant 才能绕过交互确认。[`hermes-turn/src/lib.rs` L426-L489](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L426-L489)
- **权限参数匹配存在实现错位。** `write`/`edit` 的 schema 参数名是 `path`，但 permission extractor 查询 `file_path`，所以文档/测试暗示的路径 glob 规则不能实际命中这些工具。这说明 Catio 不应让权限层自行猜测“关键参数”，而应由每个 `ToolSpec` 提供规范化 scope。[`write.rs` L24-L31](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-tools/src/write.rs#L24-L31) [`permissions.rs` L98-L121](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/permissions.rs#L98-L121)

## 7. 对 Catio 的推荐落地顺序

### P0：先建立 Rust agent-core seam（高收益、低产品风险）

保留现有 Catio Agent UI，在 `src-tauri` 内建立 Catio 自有 `agent` module；类型和 loop 可以从 Hermes 选择性移植并按 Catio 语义改造：

- `AgentMessage` / `ContentBlock` / `ToolCall` / `ToolResult`
- `ToolSpec` + JSON Schema
- `AgentEventEnvelope { owner_id, session_id, turn_id, sequence, event }`
- `Provider` trait 与 OpenAI/Anthropic/Ollama adapters
- `ToolHost` trait；第一阶段只有 `terminal_exec`、`terminal_context` 和 DB read-only tools

Rust engine 通过现有 Tauri command/event 与 server WS 暴露，再由兼容 adapter 映射到当前 React conversation/streaming 状态；React 逐步退化为渲染事件和提交用户决策。保留 Catio 当前 Markdown 解析作为 provider 不支持 tools 时的显式 fallback。

成功标准：桌面和 server mode 对同一 scripted provider fixture 产生完全相同的 ordered events；React 组件不再拥有 tool loop 状态机。

### P1：将执行 invariant 下沉

- per-conversation 单 active turn；重复 send 返回明确 busy/conflict。
- per-resource lease 保留现有 PTY busy/split 能力。
- typed cancellation 穿透 provider、approval、SSH/PTY/DB；区分“停止等待”和“已停止远端执行”。
- tool-use/result ID 配对、截断输入、round cap 后的无工具 final synthesis。Hermes 在 round cap 后强制追加一次无工具请求以给用户结论，这一点值得采用。[`hermes-turn/src/lib.rs` L515-L591](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-turn/src/lib.rs#L515-L591)

成功标准：属性测试保证每个已持久化 `ToolUse` 恰有一个 terminal `ToolResult`；取消、timeout、deny、断线、provider EOF 均不会产生无法重放的历史。

### P2：权限与持久化

- 权限键至少包含 `owner_id + target_id + tool + normalized_scope`；deny 永远优先。
- shell 仍默认 confirmation；只给真正结构化的只读工具 auto-allow。
- SQLite event/audit log 分开保存 transcript、执行意图、审批人、结果摘要；terminal output 做限长、secret redaction 和 retention。
- 技能和记忆的 owner scope、数据来源和命中理由必须进入审计信息；反思与技能演进安排在 turn engine 和知识模块之后，subagent 仍暂缓。

成功标准：两个 server 用户无法读取、取消、确认或复用对方的 turn/session/tool approval；crash 重启后能区分 completed、failed、cancelled 和 outcome-unknown。

### P3：新增技能与记忆模块，但不污染 turn engine

Hermes 已经把两类能力分别建模为 `SkillStore` 与 `MemoryStore`。前者提供按名称的 list/get/put/delete 和 user/project scope 覆盖；后者提供 active、pinned、superseded 与 top-k search。这两个 store seam 和相关 relevance 实现可以选择性吸收，但 Catio 应换成带 `owner_id` 的 repository，并优先复用现有 SQLite/server 数据层，而不是直接沿用单机文件目录。[Hermes `SkillStore` L45-L63](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-skills/src/store.rs#L45-L63) [Hermes `MemoryStore` L54-L75](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-memory/src/store.rs#L54-L75) [技能 relevance L62-L121](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-skills/src/relevance.rs#L62-L121) [记忆 relevance L31-L76](https://github.com/leeyis/small-rust-hermes-v3/blob/bdd400deb8ba56e30c87b6916348db73f828aded/crates/hermes-memory/src/relevance.rs#L31-L76)

建议的数据流是 `Skills/Memory Repository -> Context Assembler -> immutable TurnContext -> turn engine`。`run_turn()` 只接收本 turn 已选中的技能/记忆快照，不负责 CRUD、检索或自我写入。这样同一个上下文装配器可服务桌面与 server，UI 也能解释“本次用了哪些技能/记忆、为什么命中”，并允许用户在发起 turn 前固定、排除或编辑内容。

界面落地顺序：先增加两个 rail 入口和只读列表/详情，再增加编辑、标签与搜索，最后接 Agent 的自动检索和命中解释。所有新增文案同步更新语言文件，样式沿用现有 CSS variables；这能保证功能上线时继续满足 Catio 的 i18n 与主题切换约束。

成功标准：技能/记忆面板可以独立使用；关闭自动注入后 Agent 行为与 P0 完全一致；每个 turn 能重放当时实际使用的知识快照，而不会被后续编辑悄然改变。

### P4：异步反思与用户审核的技能演进

Catio 后续应从已验证的问题解决过程提炼经验，例如数据库巡检、服务器巡检和产品安装。采用混合触发：系统在成功且具有复用价值的 turn 后异步建议沉淀，用户也可从 Agent、历史或技能界面手动触发。两种入口都只生成候选技能；候选必须由用户审核后发布，不能静默进入 Agent 的可用技能集合。

技能同时支持通用和目标专属作用域。系统优先将主机、路径、数据库和版本等转换为参数；不能安全泛化的内容绑定原目标。发布技能只表示用户认可流程内容，不代表授予其中工具的执行权限，每次使用仍经过现有权限、敏感命令确认和目标范围校验。

反思管线使用不可变 turn event snapshot，依次完成结果验证、脱敏、参数化和已有技能匹配。没有相似项时生成 `CandidateSkill`；命中现有技能时生成带 diff 的 `CandidateRevision`。失败、取消或结果未知的经历可以进入记忆，但不能自动形成技能。完整设计见 [`2026-08-15-reflection-skill-evolution-design.md`](../superpowers/specs/2026-08-15-reflection-skill-evolution-design.md)。

成功标准：只有具备验证证据的自动候选可以进入审核队列；只有已发布版本参与 Agent 检索；所有来源、审核、版本与实际使用可追溯；关闭反思后基础 turn engine 行为不变。

## 8. 不建议采用的内容

| Hermes 设计 | 判断 | 原因 |
|---|---|---|
| `hermes-turn` 整体作为长期 git dependency | 不采用 | 个人用途许可允许复用，但类型与生命周期不贴合 Catio，且会把已知取消/并发缺陷和上游演进一起耦合进来；推荐选择性移植并修正。 |
| Markdown `[GOAL_COMPLETE]` 外层 agent loop | 暂不采用 | 仍是文本协议；取消只能在 iteration 间生效；Catio 当前需求是可靠 turn/tool execution。 |
| `bash` runner | 不采用 | 不是沙箱，timeout/cancel 不保证结束 OS process，也不符合 Catio 的 SSH/PTY 交互执行语义。 |
| 全部 safe tools `join_all` | 修改后采用 | 必须加 target/resource conflict key、并发上限和 backpressure。 |
| JSONL + 每条 `sync_data()` | 只借鉴 event sourcing | Catio 已有 SQLite 和多用户 server；事务批量写更合适。 |
| 单 bearer token + global `AppState` | 不采用 | 无 owner 隔离，token query/log 泄露面，不满足 Catio server mode。 |
| 全局按 tool name `AlwaysAllow` | 不采用 | scope 过宽，应绑定用户、目标和规范化参数范围。 |
| skills / memory | 后续阶段选择性采用 | 两者已有明确的平级 UI 入口规划；可吸收独立 store/relevance 思想，但需补 owner scope、SQLite repository、命中解释与快照审计，且不能耦合进 turn loop。 |
| reflection / skill evolution | 后续阶段受控采用 | 使用异步反思、secret redaction、不可变快照和用户审核形成候选技能或候选修订；禁止静默发布和隐式权限升级。 |

## 9. 验证与成熟度备注

- 研究固定在 2026-07-04 的 commit `bdd400d`；该 commit message 是 “add Flutter client + hermes-server (bearer-token auth)”，server 是很新的表层，不能把 README 的完整度等同于生产成熟度。[commit](https://github.com/leeyis/small-rust-hermes-v3/commit/bdd400deb8ba56e30c87b6916348db73f828aded)
- 本地对固定 commit 执行 `cargo test -p hermes-turn -p hermes-tools -p hermes-server`：54 tests / 8 suites 全部通过。测试能支持“核心模块有单元覆盖”，不能证明多用户隔离、同 session 并发、进程级取消或公网部署安全。
- GitHub Issues 在研究时关闭，因此没有可用于交叉验证已知缺陷或 roadmap 的 issue 资料。
- 后台研究 agent 另执行了完整 `cargo test --workspace`：184 passed、1 ignored、30 suites；仓库没有 `.github` CI workflow。完整测试结果提高了对纯函数与 happy-path 行为的信心，但不能替代并发、进程取消和安全集成测试。

## 最终建议

把 Hermes 当作**可选择性吸收的后端实现来源**，而不是整体运行时。Catio 下一轮 Agent 优化的最小正确切片应是：保持现有 UI 不变，在 `src-tauri` 新建一个 provider-neutral turn engine，先支持单个 structured `terminal_exec` tool，把 current `AbortController`、PTY capture、busy/split、敏感命令确认能力接入 Rust event loop，再用兼容 adapter 把 typed events 投影到当前 conversation UI。技能与记忆作为后续独立模块，在现有片段库/历史区域增加平级入口，并经 `Context Assembler` 向 turn 提供可审计的不可变快照；反思与技能演进再以异步、可关闭的外围管线接入，所有候选必须由用户审核发布。第一阶段只预留这些 seam，不提前把 memory、reflection 或 Hermes GUI 耦合进执行内核。
