# Catio Agent Rust Turn Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Catio 当前由 React 驱动的 provider/tool loop 收敛为 Rust `AgentRuntime`，通过统一 typed events 在 desktop 与 server mode 中保持现有 Agent 与 PTY 体验。

**Architecture:** Rust `AgentRuntime` 持有 active Turn registry，并把 provider-neutral `TurnEngine`、`ToolPolicy`、provider adapters、审批/工具 response broker 和 ordered event sink 隐藏在一个 deep module 内。React 先订阅 `agent://events`，再调用 start/respond/cancel；`ToolExecutionRequested` 仍由现有 `executeAgentCommand` 执行，以保留 PTY busy、split 与 capture 语义。

**Tech Stack:** Rust 2021、Tokio、async-trait、reqwest streaming、Serde、Tauri 2、Axum/WebSocket、React 19、TypeScript、Vitest。

**Spec:** `docs/superpowers/specs/2026-08-15-catio-agent-rust-turn-engine-design.md`

## Global Constraints

- 开始前完整阅读本计划与 Spec；发现两者冲突时以 Spec 为准并停止该 Task，先报告冲突。
- 代码发现优先使用 `codebase-memory-mcp`：`search_graph` → `trace_path` → `get_code_snippet` → `query_graph`；仅在图结果不足或查询非代码文件时使用 `rg`。
- 所有 shell 命令通过 `rtk` 前缀执行；文件修改使用 `apply_patch`，不使用 shell 重定向写文件。
- 每个 Task 必须执行 red → green → refactor：先看到指定测试因缺失行为失败，再写最少实现，再运行指定回归测试。
- 每个 Task 只提交其列出的逻辑变更，commit 使用英文语义化前缀和中文说明；不得修改或提交 `.happycode/` 与 `src-tauri/gen/schemas/macOS-schema.json`。
- automated tests 只能使用 scripted provider 与 raw fixtures；不得调用真实 provider、读取真实 API key 或依赖外网。
- `owner_id` 只能由 desktop/server transport 注入；前端 payload 不得出现可覆盖 owner 的字段。
- API key 仅存在于 `StartTurnRequest` 与 provider adapter 的本 Turn 内存中；禁止进入 `Debug`、events、错误正文、日志和 conversation persistence。
- P0 不实现 typed transcript/event persistence、engine resource lease、可证明的远端停止、DB tools、Skills、Memory、Reflection、goal loop 或 subagent。
- 不新增页面；新增用户可见文案必须同步修改 `src/i18n/zh.json` 与 `src/i18n/en.json`，现有主题 token 与页面结构保持不变。
- 不为了本功能重构无关模块；旧 `chat`/Markdown loop 只在新路径测试通过后删除。

## File Responsibility Map

```text
src-tauri/src/agent/
├── mod.rs                 # 唯一公共 module surface 与 re-exports
├── types.rs               # provider-neutral messages、request/response、events、errors
├── runtime.rs             # active Turn registry、owner/state/idempotency/cancel routing
├── engine.rs              # provider/tool rounds、event sequencing、terminal invariant
├── policy.rs              # manual/ask/auto 与敏感命令分类
├── bridge.rs              # approval/tool response broker 与 client ToolHost
├── legacy.rs              # fenced command → synthetic ToolUse
├── commands.rs            # Tauri command adapters 与 desktop event sink
└── provider/
    ├── mod.rs             # Provider/ProviderFactory ports、wire-neutral round types
    ├── openai.rs          # OpenAI-compatible request/SSE decoder
    ├── anthropic.rs       # Anthropic request/SSE decoder
    └── ollama.rs          # Ollama request/NDJSON decoder

src-tauri/tests/agent_runtime.rs          # public AgentRuntime contract
src-tauri/tests/agent_provider_*.rs       # raw provider contract fixtures
src-tauri/tests/server_agent.rs           # authenticated owner isolation/parity
src-tauri/tests/fixtures/agent/           # raw streams、scripted rounds、policy cases
src/services/agentRuntime.ts              # typed start/respond/cancel/subscribe client
src/services/agentProjector.ts            # ordered event → conversation state/effects
src/services/agentRuntime.test.ts         # transport client tests
src/services/agentProjector.test.ts       # pure projection/invariant tests
src/App.tsx                               # context assembly、subscription、PTY effect adapter
```

## Spec Coverage Matrix

| Spec requirement | Implementing tasks |
|---|---|
| Core types、redacted credential、stable events | 1、3 |
| manual/ask/auto policy 与 legacy parser | 2、4、8 |
| provider-neutral text/tool loop、pairing、round cap | 3、4 |
| owner/state/idempotency/cancellation | 5 |
| OpenAI-compatible、Anthropic、Ollama | 6、7、8 |
| Desktop Tauri adapter | 9 |
| Server authenticated adapter、owner-scoped events、parity | 10 |
| React transport、ordered projector | 11 |
| PTY bridge、i18n、现有 UI compatibility | 12 |
| Dead-code removal、全量测试、安全验收 | 13 |

P0 非目标由 Global Constraints 明确禁止，任何 Task 都不创建 persistence、resource lease、DB tool、Skills/Memory/Reflection 或 subagent surface。

---

### Task 1: 固定 Rust 公共 contracts 与 redacted credential

**Files:**
- Create: `src-tauri/src/agent/mod.rs`
- Create: `src-tauri/src/agent/types.rs`
- Create: `src-tauri/tests/agent_types.rs`
- Modify: `src-tauri/src/lib.rs:1-78`

**Interfaces:**
- Produces: `ActorContext`, `StartTurnRequest`, `TurnHandle`, `ClientTurnResponse`, `AgentMessage`, `ContentBlock`, `ToolUse`, `ToolResult`, `AgentEventEnvelope`, `AgentEvent`, `AgentError`。
- Produces: `ApiCredential::expose(&self) -> &str`；`ApiCredential` 实现 redacted `Debug`，不实现 `Serialize`。

- [ ] **Step 1: 写 contracts 的失败测试**

```rust
use catio_lib::agent::{
    AgentEvent, AgentEventEnvelope, ApiCredential, ContentBlock, ToolResultStatus,
};

#[test]
fn credential_debug_is_redacted() {
    let credential = ApiCredential::from("sk-secret-value".to_string());
    assert_eq!(format!("{credential:?}"), "ApiCredential([REDACTED])");
    assert_eq!(credential.expose(), "sk-secret-value");
}

#[test]
fn event_envelope_uses_camel_case_without_secret_fields() {
    let event = AgentEventEnvelope {
        owner_id: "local".into(),
        conversation_id: "conv-1".into(),
        turn_id: "turn-1".into(),
        sequence: 1,
        event: AgentEvent::TurnStarted,
    };
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["conversationId"], "conv-1");
    assert_eq!(value["event"]["type"], "turnStarted");
    assert!(!value.to_string().contains("credential"));
}

#[test]
fn tool_result_status_serializes_stably() {
    let block = ContentBlock::ToolResult {
        tool_use_id: "tool-1".into(),
        content: "exit 0".into(),
        status: ToolResultStatus::Succeeded,
    };
    assert_eq!(serde_json::to_value(block).unwrap()["status"], "succeeded");
}
```

- [ ] **Step 2: 运行测试并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_types`

Expected: FAIL，错误包含 `could not find agent in catio_lib`。

- [ ] **Step 3: 实现最小 contracts**

`types.rs` 使用如下稳定 wire 形状；所有 enum 使用 `#[serde(tag = "type", rename_all = "camelCase")]`，所有 struct 使用 `#[serde(rename_all = "camelCase")]`：

```rust
#[derive(Clone, Deserialize)]
pub struct ApiCredential(String);

impl From<String> for ApiCredential {
    fn from(value: String) -> Self { Self(value) }
}

impl ApiCredential {
    pub fn expose(&self) -> &str { &self.0 }
}

impl std::fmt::Debug for ApiCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiCredential([REDACTED])")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { tool_use_id: String, content: String, status: ToolResultStatus },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolResultStatus {
    Succeeded, Failed, Denied, Blocked, Cancelled, OutcomeUnknown, Unsupported,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionStatus {
    Succeeded, Failed, Blocked, Cancelled, OutcomeUnknown, Unsupported,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionOutcome {
    pub content: String,
    pub status: ToolExecutionStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientTurnResponse {
    ApprovalDecision { tool_use_id: String, decision: ApprovalDecision },
    ToolExecutionResult { tool_use_id: String, outcome: ToolExecutionOutcome },
}
```

`StartTurnRequest` 精确包含 `conversation_id`、text-only `messages`、`system_prompt`、`terminal_context`、`target_ref`、`provider: ProviderConfig`、`execution_mode`、`single_line_commands` 和 `round_cap`；`ProviderConfig` 精确包含 `protocol`、`base_url`、`model`、`credential`、`anthropic_auth_mode`。`StartTurnRequest` 使用 `#[serde(deny_unknown_fields)]`，确保注入 `ownerId` 之类的 transport-owned 字段直接失败。`ActorContext` 只包含 transport 注入的 `owner_id`，不属于 `StartTurnRequest`。

同时定义 `ProviderProtocol::{Openai,Anthropic,Ollama}`、`AnthropicAuthMode::{Auto,ApiKey,AuthToken}`、`ExecutionMode::{Manual,Ask,Auto}`、`ApprovalDecision::{Allow,Deny}` 与 Spec 第 8 节全部 `AgentEvent` variants。`round_cap` 反序列化后必须限制在 `1..=20`，空 `conversation_id`、空 model、空 base URL 由 `StartTurnRequest::validate()` 返回 `AgentError::InvalidRequest`。

- [ ] **Step 4: 运行 contracts 与格式检查并确认 green**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_types`

Expected: PASS，3 tests passed。

Run: `rtk cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent src-tauri/src/lib.rs src-tauri/tests/agent_types.rs
rtk git commit -m "feat: 定义 Agent 运行时协议"
```

### Task 2: 迁移敏感命令 policy 与 legacy parser

**Files:**
- Create: `src-tauri/src/agent/policy.rs`
- Create: `src-tauri/src/agent/legacy.rs`
- Create: `src-tauri/tests/fixtures/agent/policy_commands.json`
- Create: `src/components/workbench/sensitiveCommands.test.ts`
- Modify: `src-tauri/src/agent/mod.rs`
- Test: `src-tauri/tests/agent_policy.rs`

**Interfaces:**
- Consumes: `ExecutionMode`、`ToolUse`、`AgentError` from Task 1。
- Produces: `ToolPolicy::authorize(mode, command) -> PolicyDecision`，其中 decision 仅为 `Hidden`、`Allowed { risk }`、`ApprovalRequired { risk, reason }`。
- Produces: `legacy::first_shell_tool(markdown, single_line) -> Result<Option<ToolUse>, LegacyParseError>`。

- [ ] **Step 1: 建立共享 policy fixture 与失败测试**

Fixture 每个现有 `RiskCode` 至少一个命令，并包含普通命令：

```json
[
  {"command":"ls -la","sensitive":false,"reasons":[]},
  {"command":"rm -rf /tmp/demo","sensitive":true,"reasons":["fileDelete"]},
  {"command":"mv ./build /opt/app","sensitive":true,"reasons":["fileMove"]},
  {"command":"dd if=/dev/zero of=/dev/sda","sensitive":true,"reasons":["diskWrite"]},
  {"command":"shutdown -h now","sensitive":true,"reasons":["power"]},
  {"command":"kill 1234","sensitive":true,"reasons":["kill"]},
  {"command":"docker compose down","sensitive":true,"reasons":["service"]},
  {"command":"chmod -R 777 /opt/app","sensitive":true,"reasons":["chmodR"]},
  {"command":":(){ :|:& };:","sensitive":true,"reasons":["forkbomb"]},
  {"command":"echo broken > /etc/hosts","sensitive":true,"reasons":["overwrite"]},
  {"command":"DROP TABLE users","sensitive":true,"reasons":["dbDrop"]},
  {"command":"terraform destroy","sensitive":true,"reasons":["infra"]},
  {"command":"git reset --hard HEAD~1","sensitive":true,"reasons":["gitDestructive"]},
  {"command":"cat ~/.ssh/id_rsa","sensitive":true,"reasons":["secretAccess"]}
]
```

Rust test 逐条断言 risk codes；TypeScript test 用 `readFileSync(new URL('../../src-tauri/tests/fixtures/agent/policy_commands.json', import.meta.url))` 逐条断言 `isSensitiveCommand`。另加 legacy tests：manual 不调用 parser、仅识别第一个闭合 `sh|bash|shell|powershell|ps1` fence、single-line=true 拒绝多行、拒绝空 command。

- [ ] **Step 2: 运行两端测试并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_policy`

Expected: FAIL，缺少 `agent::policy` 与 `agent::legacy`。

Run: `rtk npm test -- src/components/workbench/sensitiveCommands.test.ts`

Expected: PASS for existing TypeScript classifier；这一步建立迁移基线。

- [ ] **Step 3: 实现 Rust policy 与 parser**

把 `sensitiveCommands.ts` 的 13 类 regex 语义逐项迁移到 Rust；只为 Rust regex 增加 `regex = "1"` dependency。Policy matrix 固定为：

```rust
match mode {
    ExecutionMode::Manual => PolicyDecision::Hidden,
    ExecutionMode::Ask if risk.sensitive => PolicyDecision::ApprovalRequired {
        risk,
        reason: "sensitiveCommand".into(),
    },
    ExecutionMode::Ask | ExecutionMode::Auto => PolicyDecision::Allowed { risk },
}
```

Legacy parser 不做 shell tokenization，只抽取 fenced block，生成名称固定为 `terminal_exec`、input 固定为 `json!({"command": command})` 的 synthetic `ToolUse`。ID 使用调用方传入的稳定 `tool_use_id`，不得随机生成后再丢失配对关系。

- [ ] **Step 4: 运行 policy、legacy 和现有前端测试**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_policy`

Expected: PASS。

Run: `rtk npm test -- src/components/workbench/sensitiveCommands.test.ts src/components/workbench/agentExecution.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/agent src-tauri/tests/agent_policy.rs src-tauri/tests/fixtures/agent/policy_commands.json src/components/workbench/sensitiveCommands.test.ts
rtk git commit -m "feat: 迁移 Agent 工具安全策略"
```

### Task 3: 建立 Provider port 与 text-only TurnEngine

**Files:**
- Create: `src-tauri/src/agent/provider/mod.rs`
- Create: `src-tauri/src/agent/engine.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Create: `src-tauri/tests/agent_runtime.rs`

**Interfaces:**
- Consumes: Task 1 messages/events/errors。
- Produces: `Provider::complete(&self, request: ProviderRequest, observer: &dyn ProviderObserver) -> Result<ProviderRound, ProviderError>`。
- Produces: `TurnEngine::run(TurnContext) -> Result<(), AgentError>`；`TurnContext` 注入 provider、event sink、client bridge、cancel token，不读取全局状态。

- [ ] **Step 1: 写 text-only scripted provider 失败测试**

```rust
#[tokio::test]
async fn text_only_turn_emits_ordered_single_terminal_sequence() {
    let provider = ScriptedProvider::new([ProviderRound::text(["hello ", "world"])]);
    let sink = RecordingSink::default();
    run_test_turn(provider, sink.clone()).await.unwrap();
    assert_eq!(sink.event_types(), [
        "turnStarted",
        "assistantMessageStarted",
        "textDelta",
        "textDelta",
        "assistantMessageFinished",
        "turnFinished",
    ]);
    assert_eq!(sink.sequences(), [1, 2, 3, 4, 5, 6]);
    assert_eq!(sink.terminal_count(), 1);
}
```

另测 provider unexpected EOF → `TurnFailed { code: "providerUnexpectedEof" }`，而不是 `TurnFinished`。

- [ ] **Step 2: 运行 engine test 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime text_only_turn`

Expected: FAIL，缺少 `Provider`、`TurnEngine`、`RecordingSink` 所需 public test seams。

- [ ] **Step 3: 实现 provider port、sequence emitter 与 text path**

Provider-neutral types 固定为：

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    async fn complete(
        &self,
        request: ProviderRequest,
        observer: &dyn ProviderObserver,
    ) -> Result<ProviderRound, ProviderError>;
}

pub trait ProviderObserver: Send + Sync {
    fn text_delta(&self, delta: &str);
    fn thinking_delta(&self, delta: &str);
}

pub struct ProviderRound {
    pub message: AgentMessage,
    pub stop: ProviderStop,
    pub usage: Option<TokenUsage>,
}
```

`SequenceEmitter` 是唯一能创建 `AgentEventEnvelope` 的组件；它在 terminal event 后拒绝 emit，并在 `Drop` 中 debug-assert terminal 已发出。Engine 必须先发 `AssistantMessageStarted`，observer delta 按抵达顺序 emit，完成 message 后发 `AssistantMessageFinished`，最后根据 result 发唯一 terminal event。

- [ ] **Step 4: 运行 engine contract tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime text_only_turn provider_eof`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent src-tauri/tests/agent_runtime.rs
rtk git commit -m "feat: 建立 Agent 文本 Turn Engine"
```

### Task 4: 完成 structured terminal_exec、审批与 synthesis loop

**Files:**
- Create: `src-tauri/src/agent/bridge.rs`
- Modify: `src-tauri/src/agent/engine.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/tests/agent_runtime.rs`

**Interfaces:**
- Consumes: `ToolPolicy`、`ProviderRound`、`ClientTurnResponse`。
- Produces: `ClientBridge::request_approval` 与 `ClientBridge::execute_tool` async ports。
- Guarantees: 每个 `ToolUse` 一个 `ToolResult`、未授权不 dispatch、Deny/round cap 只进行一次 tools-disabled synthesis。

- [ ] **Step 1: 写 tool loop 状态表的失败测试**

至少加入以下具名 tests：

```rust
#[tokio::test]
async fn sensitive_ask_waits_for_allow_before_tool_dispatch() {
    let bridge = ScriptedBridge::allow_then_succeed("exit 0");
    let sink = RecordingSink::default();
    run_tool_turn(ExecutionMode::Ask, "rm -rf /tmp/demo", bridge.clone(), sink.clone())
        .await
        .unwrap();
    assert_eq!(bridge.approval_requests(), ["tool-1"]);
    assert_eq!(bridge.executions(), ["tool-1"]);
    assert!(sink.precedes("approvalRequested", "toolExecutionRequested"));
}

#[tokio::test]
async fn denied_tool_gets_one_result_and_one_tools_disabled_synthesis() {
    let bridge = ScriptedBridge::deny();
    let provider = ScriptedProvider::tool_then_text("rm -rf /tmp/demo", "已取消执行。");
    let sink = RecordingSink::default();
    run_tool_turn_with_provider(ExecutionMode::Ask, provider.clone(), bridge, sink.clone())
        .await
        .unwrap();
    assert_eq!(provider.request_count(), 2);
    assert!(provider.request(1).tools.is_empty());
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::Denied]);
}

#[tokio::test]
async fn auto_dispatches_sensitive_tool_without_approval_event() {
    let bridge = ScriptedBridge::succeed("exit 0");
    let sink = RecordingSink::default();
    run_tool_turn(ExecutionMode::Auto, "rm -rf /tmp/demo", bridge.clone(), sink.clone())
        .await
        .unwrap();
    assert!(bridge.approval_requests().is_empty());
    assert_eq!(bridge.executions(), ["tool-1"]);
    assert!(!sink.event_types().contains(&"approvalRequested"));
}

#[tokio::test]
async fn manual_never_exposes_terminal_tool() {
    let provider = ScriptedProvider::text("只回答，不执行。");
    run_text_turn_with_mode(ExecutionMode::Manual, provider.clone()).await.unwrap();
    assert!(provider.request(0).tools.is_empty());
}

#[tokio::test]
async fn invalid_and_unknown_tools_are_not_executed() {
    let bridge = ScriptedBridge::panic_on_execute();
    let sink = RecordingSink::default();
    run_invalid_tools_turn(bridge, sink.clone()).await.unwrap();
    assert_eq!(sink.tool_finished_statuses(), [
        ToolResultStatus::Failed,
        ToolResultStatus::Unsupported,
    ]);
    assert_eq!(sink.tool_use_ids(), sink.tool_result_ids());
}
```

这些 tests 不访问 engine private state，只通过 `TurnEngine`/public test builder 与 recorded requests/events 断言。

- [ ] **Step 2: 运行 tool tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime tool`

Expected: FAIL，当前 engine 尚不处理 `ContentBlock::ToolUse`。

- [ ] **Step 3: 实现最小 tool loop**

对每个 provider round 使用以下固定 transition：

```text
provider complete
  ├─ no ToolUse → TurnFinished
  └─ ToolUse
       → validate name/input
       → ToolProposed
       → policy Hidden | Allowed | ApprovalRequired
       → optional ApprovalRequested + await decision
       → ToolExecutionRequested
       → ToolStarted after sink accepted dispatch
       → await ToolExecutionOutcome
       → ToolFinished with engine-created ToolResult
       → append typed assistant + tool result messages
       → next provider round
```

`terminal_exec` schema 只接受 object 中非空 string `command`，single-line=true 时拒绝包含换行。Deny、approval unavailable、invalid input、unknown tool 都生成配对 result；Deny 与达到 `round_cap` 后把 `request.tools` 置空，只调用一次 final synthesis。Synthesis 仍提出工具时返回 `TurnFailed { code: "toolsDisabledSynthesisViolated" }`。

- [ ] **Step 4: 运行全部 runtime tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime`

Expected: PASS；事件序列、pairing、policy matrix、round cap 全部通过。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent src-tauri/tests/agent_runtime.rs
rtk git commit -m "feat: 实现 Agent 结构化工具循环"
```

### Task 5: 实现 AgentRuntime registry、幂等响应与 cancellation

**Files:**
- Create: `src-tauri/src/agent/runtime.rs`
- Modify: `src-tauri/src/agent/bridge.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/tests/agent_runtime.rs`

**Interfaces:**
- Produces: Spec 第 6 节唯一公共入口 `AgentRuntime::{start_turn,respond,cancel}`。
- Produces: `ProviderFactory::create(&ProviderConfig) -> Result<Arc<dyn Provider>, AgentError>`。
- Owns: `Arc<Mutex<HashMap<TurnId, ActiveTurn>>>`；`ActiveTurn` 保存 owner、expected response、dedupe digest、cancel token 与 task handle。

- [ ] **Step 1: 写 owner/state/idempotency/cancel 失败测试**

```rust
#[tokio::test]
async fn wrong_owner_cannot_respond_or_cancel() {
    let (runtime, turn) = runtime_waiting_for_approval(actor("owner-a")).await;
    let response = allow_response("tool-1");
    assert_eq!(runtime.respond(actor("owner-b"), turn.clone(), response).await,
        Err(AgentError::OwnerMismatch));
    assert_eq!(runtime.cancel(actor("owner-b"), turn).await,
        Err(AgentError::OwnerMismatch));
}

#[tokio::test]
async fn duplicate_equal_response_is_noop_but_conflict_fails() {
    let (runtime, turn, bridge) = runtime_waiting_for_approval(actor("owner-a")).await;
    runtime.respond(actor("owner-a"), turn.clone(), allow_response("tool-1")).await.unwrap();
    runtime.respond(actor("owner-a"), turn.clone(), allow_response("tool-1")).await.unwrap();
    assert_eq!(runtime.respond(actor("owner-a"), turn, deny_response("tool-1")).await,
        Err(AgentError::ResponseConflict));
    assert_eq!(bridge.executions(), ["tool-1"]);
}

#[tokio::test]
async fn cancel_before_dispatch_is_cancelled() {
    let (runtime, turn, sink) = runtime_blocked_in_provider(actor("owner-a")).await;
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
    sink.wait_for_terminal().await;
    assert_eq!(sink.terminal_types(), ["turnCancelled"]);
}

#[tokio::test]
async fn cancel_after_dispatch_without_stop_proof_is_outcome_unknown() {
    let (runtime, turn, sink) = runtime_waiting_for_tool_result(actor("owner-a")).await;
    runtime.cancel(actor("owner-a"), turn).await.unwrap();
    sink.wait_for_terminal().await;
    assert_eq!(sink.tool_finished_statuses(), [ToolResultStatus::OutcomeUnknown]);
    assert_eq!(sink.terminal_count(), 1);
}

#[tokio::test]
async fn terminal_turn_cannot_be_reactivated() {
    let (runtime, turn) = completed_runtime(actor("owner-a")).await;
    assert_eq!(runtime.respond(actor("owner-a"), turn.clone(), allow_response("tool-1")).await,
        Err(AgentError::TurnNotFound));
    assert_eq!(runtime.cancel(actor("owner-a"), turn).await,
        Err(AgentError::TurnNotFound));
}
```

- [ ] **Step 2: 运行 runtime routing tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime wrong_owner duplicate cancel terminal_turn`

Expected: FAIL，缺少 runtime registry。

- [ ] **Step 3: 实现 registry 与 response broker**

`respond` 的判定顺序固定为 owner → active entry → `(response kind, tool_use_id)` dedupe key → duplicate digest → 当前 expected response。这样状态已经前进后重放的相同 response 仍是 no-op，而同 key 不同 digest 返回 `AgentError::ResponseConflict`。Digest 对 canonical JSON response 求稳定 hash。`cancel` 设置 `CancellationToken` 并唤醒 approval/tool waiters；因此为 `tokio-util` 增加 `rt` feature，不新引入 cancellation crate。

Bridge timeout 在 dispatch 前返回 `Cancelled/Blocked`，dispatch 后返回 `OutcomeUnknown`。Runtime task 无论成功、失败或 panic 都必须移除 active entry；terminal event 之后不保留 credential 或 provider request。

- [ ] **Step 4: 运行 runtime 与 leak-oriented tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime`

Expected: PASS，且测试用 weak reference 证明 terminal 后 provider/request 被 drop。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/agent src-tauri/tests/agent_runtime.rs
rtk git commit -m "feat: 管理 Agent Turn 生命周期"
```

### Task 6: 实现 OpenAI-compatible native tool adapter

**Files:**
- Create: `src-tauri/src/agent/provider/openai.rs`
- Create: `src-tauri/tests/agent_provider_openai.rs`
- Create: `src-tauri/tests/fixtures/agent/openai_text.sse`
- Create: `src-tauri/tests/fixtures/agent/openai_tool.sse`
- Create: `src-tauri/tests/fixtures/agent/openai_invalid_args.sse`
- Modify: `src-tauri/src/agent/provider/mod.rs`

**Interfaces:**
- Consumes: `ProviderRequest`、`ProviderObserver`、`ProviderRound`。
- Produces: `OpenAiProvider::new(reqwest::Client, ProviderConfig)` 与 pure `decode_sse_chunks` test seam。
- Guarantees: tool-call fragments 按 index/ID 重组，`[DONE]` 必需，arguments 最终必须为 JSON object。

- [ ] **Step 1: 写 raw SSE fixture 与失败 tests**

`openai_tool.sse` 至少按多个 chunk 拆开 arguments：

```text
data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_exec","arguments":"{\"com"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

```

Tests 以故意拆开的 UTF-8 byte chunks 输入 decoder，断言 text delta、tool ID/name/input、usage、finish reason；缺 `[DONE]`、缺 ID/name、invalid JSON、`length`、`content_filter` 分别得到稳定 protocol error。

- [ ] **Step 2: 运行 OpenAI tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_openai`

Expected: FAIL，缺少 `provider::openai`。

- [ ] **Step 3: 实现 request encoder 与 incremental SSE decoder**

Endpoint 固定为 `${base_url_without_trailing_slash}/chat/completions`；headers 为 `Content-Type: application/json` 与 `Authorization: Bearer <credential>`。Request body 包含 `model`、provider-neutral messages、`stream:true`、`stream_options:{"include_usage":true}`，只有 tools 非空时包含 function tools。

Decoder 使用单个 `String` line buffer 和 `String::from_utf8_lossy` 之外的严格 UTF-8 incremental decoder；malformed JSON data event 返回 protocol error，不静默跳过。HTTP 4xx/5xx 按 auth/rate-limit/http 分类；只有明确 capability response 归一化为 `ProviderError::ToolsUnsupported`。

- [ ] **Step 4: 运行 OpenAI contract tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_openai`

Expected: PASS，且 fixture tests 不发网络请求。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent/provider src-tauri/tests/agent_provider_openai.rs src-tauri/tests/fixtures/agent/openai_*.sse
rtk git commit -m "feat: 支持 OpenAI 原生工具流"
```

### Task 7: 实现 Anthropic native tool adapter

**Files:**
- Create: `src-tauri/src/agent/provider/anthropic.rs`
- Create: `src-tauri/tests/agent_provider_anthropic.rs`
- Create: `src-tauri/tests/fixtures/agent/anthropic_text.sse`
- Create: `src-tauri/tests/fixtures/agent/anthropic_tool.sse`
- Modify: `src-tauri/src/agent/provider/mod.rs`

**Interfaces:**
- Produces: `AnthropicProvider::new(reqwest::Client, ProviderConfig)` 与 pure `decode_sse_chunks`。
- Guarantees: system/messages 分离；partial JSON 只在 `content_block_stop` 解析；未知未来 event 与 ping 忽略；stream `error` 失败。

- [ ] **Step 1: 写 Anthropic raw fixture 与失败 tests**

Tool fixture 包含 `message_start`、`content_block_start` type `tool_use`、两个 `input_json_delta`、`content_block_stop`、`message_delta` stop_reason `tool_use`、`message_stop`。Tests 覆盖 text/thinking/tool blocks、unknown event、ping、stream error、`max_tokens`、缺 `message_stop` 与跨 byte chunk UTF-8。

核心断言：

```rust
assert_eq!(round.stop, ProviderStop::ToolUse);
assert_eq!(round.message.content, vec![ContentBlock::ToolUse {
    id: "toolu_1".into(),
    name: "terminal_exec".into(),
    input: serde_json::json!({"command": "pwd"}),
}]);
```

- [ ] **Step 2: 运行 Anthropic tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_anthropic`

Expected: FAIL，缺少 `provider::anthropic`。

- [ ] **Step 3: 实现 Anthropic encoder/decoder**

Endpoint 固定为 `${base_url_without_trailing_slash}/v1/messages`（若 base URL 已以 `/v1` 结尾则不重复）。`AnthropicAuthMode::ApiKey` 使用 `x-api-key`，`AuthToken` 使用 bearer Authorization，`Auto` 与现有 `models.ts::apiHeaders` heuristic 保持一致；始终带 `anthropic-version: 2023-06-01`。Tool result block 使用匹配 `tool_use_id`，非 Succeeded status 设置 `is_error:true`。

- [ ] **Step 4: 运行 Anthropic contract tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_anthropic`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent/provider src-tauri/tests/agent_provider_anthropic.rs src-tauri/tests/fixtures/agent/anthropic_*.sse
rtk git commit -m "feat: 支持 Anthropic 原生工具流"
```

### Task 8: 实现 Ollama adapter、provider factory 与显式 legacy fallback

**Files:**
- Create: `src-tauri/src/agent/provider/ollama.rs`
- Create: `src-tauri/tests/agent_provider_ollama.rs`
- Create: `src-tauri/tests/fixtures/agent/ollama_text.ndjson`
- Create: `src-tauri/tests/fixtures/agent/ollama_tool.ndjson`
- Modify: `src-tauri/src/agent/provider/mod.rs`
- Modify: `src-tauri/src/agent/engine.rs`
- Modify: `src-tauri/src/agent/runtime.rs`
- Modify: `src-tauri/tests/agent_runtime.rs`

**Interfaces:**
- Produces: `OllamaProvider`、`ReqwestProviderFactory`。
- Guarantees: Ollama synthetic tool IDs 稳定为 `ollama-{round}-{index}`；只有 `ToolsUnsupported` 进入 legacy fallback。

- [ ] **Step 1: 写 Ollama 与 fallback 失败 tests**

NDJSON fixture 每行完整 JSON，至少包含分段 `thinking`、`content`、两个同名 tool calls 和末尾 `done:true`。Tests 断言完整 assistant message 三类字段进入下一轮；malformed line、缺 `done`、跨 byte chunk UTF-8 均失败。

Runtime tests 固定为：明确 `ToolsUnsupported` → 发一次 `CompatibilityFallbackActivated` → tools-disabled response 中首个合法 fence 变 synthetic ToolUse；auth、429、network、generic 500、malformed stream 均不 fallback。

- [ ] **Step 2: 运行 Ollama/fallback tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_ollama`

Expected: FAIL，缺少 Ollama adapter。

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_runtime compatibility_fallback`

Expected: FAIL，engine 尚未激活 fallback。

- [ ] **Step 3: 实现 Ollama、factory 与 fallback**

Endpoint 固定为 `${base_url_without_trailing_slash}/api/chat`。Ollama request 发送 `model/messages/stream:true`，tools 非空时发送 tools；result wire message 使用 `role:"tool"` 和 `tool_name`。Factory 按 `ProviderProtocol` 构造三个 production adapters，并复用一个 configured `reqwest::Client`。

Fallback 只捕获 `ProviderError::ToolsUnsupported`，同一 round 只重试一次；manual 不执行 parser。Fallback synthetic ID 由 `turn_id + round + 0` 稳定构造，仍走 Task 4 的 policy/bridge/result 路径。

- [ ] **Step 4: 运行所有 provider/runtime tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_provider_openai --test agent_provider_anthropic --test agent_provider_ollama --test agent_runtime`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent src-tauri/tests/agent_provider_ollama.rs src-tauri/tests/agent_runtime.rs src-tauri/tests/fixtures/agent/ollama_*.ndjson
rtk git commit -m "feat: 完成 Agent Provider 兼容层"
```

### Task 9: 接入 Tauri commands 与 desktop event sink

**Files:**
- Create: `src-tauri/src/agent/commands.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/lib.rs:79-170`
- Create: `src-tauri/tests/agent_commands.rs`

**Interfaces:**
- Produces Tauri commands: `agent_start_turn(request) -> TurnHandle`、`agent_respond(turn_id,response)`、`agent_cancel(turn_id)`。
- Produces: fixed desktop actor `{ owner_id: "local" }` 与 `TauriAgentEventSink` topic `agent://events`。

- [ ] **Step 1: 写 adapter 失败测试**

把 command body 提取为不依赖 Tauri macro 的 `start_turn_for_actor`、`respond_for_actor`、`cancel_for_actor`，测试固定 local actor、请求中无法反序列化 owner、sink payload 与 runtime recording sink 序列化完全相同。

```rust
let mut payload = valid_start_turn_json();
payload["ownerId"] = json!("attacker");
assert!(serde_json::from_value::<StartTurnRequest>(payload).is_err());
```

- [ ] **Step 2: 运行 command tests 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_commands`

Expected: FAIL，commands 尚未注册。

- [ ] **Step 3: 实现 command adapter 并注册 state/handlers**

`lib.rs::run` 增加 `.manage(AgentRuntime::production())`，并在 `tauri::generate_handler!` 加入三个 commands。Tauri sink 只序列化 `AgentEventEnvelope` 并 emit；emit 失败必须返回 sink error 让 Turn 失败，不能静默吞掉首个/terminal event。

- [ ] **Step 4: 运行 desktop adapter 与现有 Rust tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --test agent_commands --test agent_runtime`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/agent src-tauri/src/lib.rs src-tauri/tests/agent_commands.rs
rtk git commit -m "feat: 接入桌面 Agent 运行时"
```

### Task 10: 接入 authenticated server commands 与 owner-scoped WebSocket

**Files:**
- Modify: `src-tauri/src/server_ws.rs:20-105`
- Modify: `src-tauri/src/server.rs:60-1479`
- Create: `src-tauri/tests/server_agent.rs`
- Modify: `src-tauri/tests/server_ws.rs`

**Interfaces:**
- Consumes: production `AgentRuntime` 与 authenticated `User`。
- Produces: `WsHub::register(tx, owner_id)`、`WsHub::emit_to_owner(owner_id, topic, payload)`、`OwnedWsAgentSink`。
- Adds HTTP dispatch commands: `agent_start_turn`、`agent_respond`、`agent_cancel`。

- [ ] **Step 1: 写 owner isolation 与 parity 失败 tests**

使用现有 server test bootstrap/cookie/WS helpers：user A 与 B 分别连 WS 并订阅 `agent://events`；A start 后只有 A 收到；B respond/cancel 得 400 owner mismatch；admin 默认也收不到 A event。用 scripted provider factory 注入 `AppState`，对同一 fixture 比较 desktop recording sink 与 server WS payload 的 ordered envelopes 完全相等。

```rust
assert_eq!(desktop_envelopes, server_envelopes);
assert!(serde_json::to_string(&server_envelopes).unwrap().find("sk-test").is_none());
```

- [ ] **Step 2: 运行 server_agent 并确认 red**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --features server --test server_agent`

Expected: FAIL，当前 `WsHub::Conn` 没有 owner。

- [ ] **Step 3: 实现 owner-aware WS 与 server dispatch**

`ws_handler` 在 upgrade 前取得 `User`，把 `actor.id.to_string()` 传给 `WsHub::register`。保留现有 topic set 与 bounded `try_send` 行为；新增 delivery filter 必须同时满足 `conn.owner_id == owner_id` 和 `conn.topics.contains(topic)`。`AppState` 增加 `Arc<AgentRuntime>` 并在 `build_router` production constructor 初始化；tests 可注入 scripted runtime。

Server `dispatch` 只从 authenticated `actor` 构造 `ActorContext`，忽略/拒绝 args 中任何 `ownerId`。`agent_start_turn` 使用 `OwnedWsAgentSink`；respond/cancel 再次走 runtime owner 校验。

- [ ] **Step 4: 运行 server、WS 与 isolation tests**

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --features server --test server_agent --test server_ws --test server_isolation`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src-tauri/src/server.rs src-tauri/src/server_ws.rs src-tauri/tests/server_agent.rs src-tauri/tests/server_ws.rs
rtk git commit -m "feat: 隔离服务端 Agent 事件"
```

### Task 11: 建立 TypeScript runtime client 与 pure projector

**Files:**
- Create: `src/services/agentRuntime.ts`
- Create: `src/services/agentRuntime.test.ts`
- Create: `src/services/agentProjector.ts`
- Create: `src/services/agentProjector.test.ts`

**Interfaces:**
- Produces: `subscribeAgentEvents`、`startAgentTurn`、`respondToAgentTurn`、`cancelAgentTurn`。
- Produces: `projectAgentEvent(state, envelope) -> { state, effects }`；effects 仅为 `requestApproval`、`executeTool`、`showWarning`、`turnSettled`。

- [ ] **Step 1: 写 transport/projector 失败 tests**

Runtime client test mock `rpc`/`subscribe`，分别断言 `subscribeAgentEvents` 固定订阅 `agent://events`，以及 wire commands/args 精确为 `agent_start_turn {request}`、`agent_respond {turnId,response}`、`agent_cancel {turnId}`。subscribe 完成早于 start 的组合顺序由 Task 12 的 App integration test 负责。

Projector test 输入 sequence 1..N，断言两个 text deltas 只追加到对应 `messageId`；duplicate sequence 不重复执行 effect；gap/out-of-order 返回 `showWarning { code:'agentEventOrder' }`；`ApprovalRequested`/`ToolExecutionRequested` 每个 tool ID 只产生一次 effect；三种 terminal event 都把 busy 置 false。

```ts
expect(result.effects).toEqual([{ type: 'executeTool', turnId: 't1', toolUseId: 'u1', target, input }])
expect(replay.effects).toEqual([])
```

- [ ] **Step 2: 运行前端 service tests 并确认 red**

Run: `rtk npm test -- src/services/agentRuntime.test.ts src/services/agentProjector.test.ts`

Expected: FAIL，两个 modules 尚不存在。

- [ ] **Step 3: 实现 runtime guards 与 projector reducer**

所有 unknown payload 先经 type guards；缺 owner/conversation/turn/sequence/event type 的 payload 丢弃并调用 injected diagnostic hook。Projector state 明确保存 `lastSequenceByTurn`、`handledApprovalIds`、`handledExecutionIds`、`activeMessageByTurn`，以 plain object/array 表达，便于 tests 深比较。

`subscribeAgentEvents` 固定订阅 `agent://events`。Runtime client 不保存 credential；start promise resolve 后调用方立即清除构造出的 request reference。

- [ ] **Step 4: 运行前端 service tests**

Run: `rtk npm test -- src/services/agentRuntime.test.ts src/services/agentProjector.test.ts src/services/transport.test.ts src/services/transport.ws.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
rtk git add src/services/agentRuntime.ts src/services/agentRuntime.test.ts src/services/agentProjector.ts src/services/agentProjector.test.ts
rtk git commit -m "feat: 投影 Agent 运行时事件"
```

### Task 12: 将 App.tsx 切换到 Rust loop 并复用 PTY ToolHost

**Files:**
- Modify: `src/App.tsx:80-95,1545-1950`
- Modify: `tests/app.test.tsx`
- Modify: `src/components/panels/AIPanel.test.tsx`
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`

**Interfaces:**
- Consumes: Task 11 runtime/projector effects。
- Retains: `resolveAgentRunTarget`、`executeAgentCommand`、`requestAgentRunPermission`、`requestAgentSplitPermission`、`patchConversation`。
- Removes ownership of: provider fetch/stream parsing、Markdown tool loop、round cap。

- [ ] **Step 1: 写 App integration 失败测试**

Mock `agentRuntime`：发送消息后断言 subscribe resolve 早于 `startAgentTurn`；TextDelta 更新现有 conversation；ApprovalRequested 调用现有 modal 并回传 Allow/Deny；ToolExecutionRequested 只调用一次 mocked PTY adapter 并回传 outcome；abort 调用 `cancelAgentTurn`；OutcomeUnknown 显示本地化 warning；tab/conversation 切换仍按 envelope `conversationId` 路由。

```ts
expect(order).toEqual(['subscribe', 'start'])
expect(respondToAgentTurn).toHaveBeenCalledWith('turn-1', {
  type: 'toolExecutionResult',
  toolUseId: 'tool-1',
  outcome: { status: 'succeeded', content: expect.stringContaining('exitCode') },
})
```

- [ ] **Step 2: 运行 App tests 并确认 red**

Run: `rtk npm test -- tests/app.test.tsx src/components/panels/AIPanel.test.tsx`

Expected: FAIL，App 仍直接调用 `chat`/`runAgentShellLoop`。

- [ ] **Step 3: 实现 subscription/effect runner 与 send/cancel 切换**

建立单例 subscription promise；`sendAgentMessage` 继续组装 system/sysinfo/terminal tail/prior messages/target snapshot，先 append user + empty assistant，再 `startAgentTurn`。Active map 按 `turnId` 和 `conversationId` 路由，不能只按当前 tab。

Effect runner 行为固定为：

```text
requestApproval → requestAgentRunPermission → respond ApprovalDecision
executeTool     → executeAgentCommand → normalize TerminalCommandResult → respond ToolExecutionResult
showWarning     → appendAgentRunWarning(localized key)
turnSettled     → clear abort/controller/busy state
```

若 execution request 已发出后 AbortSignal 中断且 `executeAgentCommand` 无可信 result，回传 `outcomeUnknown`，不能伪装 `cancelled`。新增 zh/en keys：`agentOutcomeUnknown`、`agentEventOrder`、`agentRuntimeDisconnected`，两种语言都非空。UI 不新增颜色或硬编码样式，继续使用现有 warning/modal/theme tokens。

- [ ] **Step 4: 运行 App、Agent panel 与 build**

Run: `rtk npm test -- tests/app.test.tsx src/components/panels/AIPanel.test.tsx src/services/agentRuntime.test.ts src/services/agentProjector.test.ts`

Expected: PASS。

Run: `rtk npm run build`

Expected: exit 0，无 TypeScript errors。

- [ ] **Step 5: 提交**

```bash
rtk git add src/App.tsx tests/app.test.tsx src/components/panels/AIPanel.test.tsx src/i18n/zh.json src/i18n/en.json
rtk git commit -m "feat: 切换 Agent 到 Rust 运行时"
```

### Task 13: 删除旧 loop、执行全量回归与安全验收

**Files:**
- Delete: `src/services/agent.ts`
- Delete: `src/services/agent.test.ts`
- Delete: `src/components/workbench/agentExecution.ts`
- Delete: `src/components/workbench/agentExecution.test.ts`
- Modify: imports in files found by `codebase-memory-mcp trace_path`。
- Modify: `docs/superpowers/specs/2026-08-15-catio-agent-rust-turn-engine-design.md`

**Interfaces:**
- Verifies: React 不再拥有 provider/tool loop；Rust public `AgentRuntime` 是唯一执行入口。

- [ ] **Step 1: 用 graph 证明旧入口无生产 caller**

Run through MCP: `trace_path(function_name="chat", direction="inbound")` and `trace_path(function_name="runAgentShellLoop", direction="inbound")`。

Expected: 仅剩待删除 tests 或 zero production callers；若仍有生产 caller，先把该 caller 切到 `agentRuntime` 并补对应测试。

- [ ] **Step 2: 删除 dead code 并运行 focused regressions**

删除四个旧文件和残留 imports；保留 `sensitiveCommands.ts`，因为广播确认网关仍使用它且共享 fixture test 负责 parity。

Run: `rtk npm test -- src/services/agentRuntime.test.ts src/services/agentProjector.test.ts tests/app.test.tsx`

Expected: PASS。

- [ ] **Step 3: 执行完整验收命令**

Run: `rtk npm test`

Expected: 全部 PASS。

Run: `rtk npm run build`

Expected: exit 0。

Run: `rtk cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0。

Run: `rtk cargo test --manifest-path src-tauri/Cargo.toml --features server`

Expected: 全部 PASS。

Run: `rtk cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features server -- -D warnings`

Expected: exit 0，无 warnings。

- [ ] **Step 4: 执行结构与 secret 验收**

用 `codebase-memory-mcp` 再查 `chat`、`runAgentShellLoop`、`sendAgentMessage` call paths；用文本检索仅验证 imports/secret literals：

```bash
rtk rg -n "from './services/agent'|runAgentShellLoop|chat\(" src/App.tsx src
rtk rg -n "apiKey|credential|Authorization|x-api-key" src-tauri/src/agent src/services/agentRuntime.ts
rtk git status --short --untracked-files=all
```

Expected: 第一条无旧 loop import/call；第二条只命中 request/provider header 构造与 redaction tests，不命中 event/log formatting；status 中 `.happycode/` 与 generated schema 仍为用户原有 untracked 且未 staged。

把 Spec 状态改为 `P0 实施完成，待主架构师验收`，不得宣称验收已经通过。

- [ ] **Step 5: 提交清理与实施完成状态**

```bash
rtk git add -u src src-tauri docs/superpowers/specs/2026-08-15-catio-agent-rust-turn-engine-design.md
rtk git commit -m "refactor: 移除旧 Agent 工具循环"
```

提交后向主架构师报告：13 个 Task 的 commit 列表、每个 red/green 命令结果、完整验收输出摘要、仍存在的风险与未跟踪文件状态。主架构师将独立重跑验收，不得由执行者替代最终验收结论。
