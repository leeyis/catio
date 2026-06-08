# Catio SSH 周边面板真实化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SSH 相关侧边栏面板（Agent / SFTP / 端口转发+ProxyJump / 片段库 / 历史）全部接真实数据/功能，去除 mock；历史用 OSC 633/133 shell 集成做真实命令审计。

**Architecture:** 后端 `src-tauri/src/ssh/` 新增 `osc.rs`（OSC 序列解析/剥离纯函数），`term.rs` 注入 shell 集成并在读循环里解析命令审计、emit `history://`、剥离序列；`conn.rs` 用 russh `connect_stream` 做 ProxyJump 多跳。前端新增 `services/agent.ts`（流式 LLM）、`state/snippets.ts`、`state/history.ts`，各面板从 `useData()` mock 改为真实 state/事件，App 透传 sessionId + 提供「插入到终端」。

**Tech Stack:** russh 0.61.2（`connect_stream`/`channel.into_stream`/`ChannelStream`）；OSC 633（VS Code，MIT）/ OSC 133（FinalTerm）；React 18 + TS strict + Vitest；Ollama `/api/chat` + OpenAI `/v1/chat/completions` 流式。

**Spec:** `docs/superpowers/specs/2026-06-08-catio-ssh-panels-real-design.md`

---

## 已确认的关键事实（实现者照此）

- russh 0.61.2：`pub async fn connect_stream<H,R: AsyncRead+AsyncWrite+Unpin+Send>(config: Arc<Config>, stream: R, handler: H) -> Result<Handle<H>,...>`（client/mod.rs:982；`connect()` 内部即调它）。`channel.into_stream() -> ChannelStream<S>`（AsyncRead+AsyncWrite，channels/mod.rs:661）。`channel_open_direct_tcpip(host,port,orig,oport)` 已在 tunnel.rs 用过。
- OSC：`ESC ]`=`\x1b]`，ST=BEL=`\x07`（`\a`）。`\e]633;A\a`/`B`/`C`、`\e]633;D[;<exit>]\a`、`\e]633;E;<escCmd>;<nonce>\a`、`\e]633;P;Cwd=<escPwd>\a`；`OSC 133;A/B/C/D` 同义（无 E）。转义：`\`→`\\`、`;`→`\x3b`、<0x20→`\xNN`。
- 前端面板现状：`AIPanel`/`SnippetsPanel`/`HistoryPanel` 均读 `useData()` 的 mock（`D.aiSql/aiShell`、`D.snippets`、`D.history`）。`SnippetsPanel` 已有 hover「插入(catio-insert 事件)/复制」按钮、`HistoryPanel` 已有过滤+SaveSnippetModal+插入/复制/存片段按钮（部分 inert）。`AIPanel` 有 composer + SnippetCard（插入/执行按钮目前是假动作）。
- 终端审计**无法用进程内 server 端到端测**（其 shell 是假 echo，非真 bash）。因此：**osc.rs 解析逻辑用纯函数单测全覆盖**；shell 集成注入脚本的真实生效靠 Docker sshd 手动 QA。
- 秘密处理沿用子项目 2：连接时提示、仅内存、不落盘。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/ssh/osc.rs`（新） | 纯函数：扫描字节流，抽取 OSC 633/133 事件 + 返回剥离后的可见字节；跨块缓冲；unescape；nonce 校验。单测 |
| `src-tauri/src/ssh/term.rs`（改） | term_open 注入 shell 集成 bootstrap；读循环接 osc::Scanner，emit `history://`，转发剥离后的字节 |
| `src-tauri/src/ssh/conn.rs`（改） | `JumpSpec`；`connect_core` 经 jump 用 connect_stream 多跳；目标/跳板 TOFU |
| `src-tauri/src/ssh/shell_integration.rs`（新） | 内嵌 bash/zsh 集成脚本常量 + 生成带 nonce 的 bootstrap 行 |
| `src/services/agent.ts`（新） | 流式 chat（Ollama/OpenAI），`chat(messages,cfg,{onToken,signal})` |
| `src/state/snippets.ts`（新） | 片段持久化 CRUD（localStorage `catio-snippets`） |
| `src/state/history.ts`（新） | 历史持久化环形（localStorage `catio-history`，上限 1000） |
| `src/services/ssh.ts`（改） | getSftp/getTunnels/getMonitor 空态化；`onHistory(sessionId,cb)` 订阅；agent/proxyjump 透传 |
| `src/components/panels/*`（改） | 5 面板接真 + 空态 |
| `src/components/modals/NewConnectionModal.tsx`（改） | ProxyJump 配置持久化 |
| `src/App.tsx`（改） | sessionId→chanId 映射、`onInsert`、history 订阅、面板 sessionId 透传 |

---

# 阶段 R：空态清理

## Task R1: SFTP/隧道/监控 无会话空态

**Files:** Modify `src/services/ssh.ts`, `src/components/panels/SftpPanel.tsx`, `TunnelsPanel.tsx`, `MonitorPanel.tsx`; create `src/components/panels/PanelEmpty.tsx`; tests alongside.

- [ ] **Step 1: 失败测试** `src/components/panels/PanelEmpty.test.tsx`
```tsx
import { render } from '@testing-library/react'
import { PanelEmpty } from './PanelEmpty'
import { describe, it, expect } from 'vitest'
describe('PanelEmpty', () => {
  it('renders the hint', () => {
    const { getByText } = render(<PanelEmpty icon="folder" text="先连接一个主机" />)
    expect(getByText('先连接一个主机')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 实现 PanelEmpty** `src/components/panels/PanelEmpty.tsx`
```tsx
import { Icon } from '../Icon'
export interface PanelEmptyProps { icon: string; text: string }
export function PanelEmpty({ icon, text }: PanelEmptyProps) {
  return (
    <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-faint)', padding: 24 }}>
      <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--surface-sunken)' }}><Icon name={icon} size={20} /></div>
      <span style={{ fontSize: 12.5, textAlign: 'center' }}>{text}</span>
    </div>
  )
}
```

- [ ] **Step 3: services 空态化**
In `src/services/ssh.ts`, change the three getters so that WITHOUT a real session they return EMPTY, not `DATA.*`:
```ts
export async function getSftp(sessionId?: string, path?: string): Promise<Sftp> {
  if (isTauri() && sessionId) {
    const items = await invoke<SftpItem[]>('sftp_list', { sessionId, path: path ?? '.' })
    return { path: path ?? '.', items }
  }
  return { path: '', items: [] }
}
export async function getTunnels(sessionId?: string): Promise<Tunnel[]> {
  if (isTauri() && sessionId) { /* existing tunnel_list mapping */ return mapWire(await invoke('tunnel_list')) }
  return []
}
export async function getMonitor(_sessionId?: string): Promise<Monitor> {
  return EMPTY_MONITOR // a const with zeroed arrays/fields
}
```
Define `const EMPTY_MONITOR: Monitor = { host: '', cpu: [], mem: [], net: [], disk: 0, cores: 0, memTotal: '', memUsed: '', gpus: [], procs: [] }`. Remove the `DATA.*` fallbacks from these three. (Keep `getTermBuffer` as-is or also empty — terminal demo handled separately by TerminalPane.)

- [ ] **Step 4: 面板空态**
In `SftpPanel`/`TunnelsPanel`/`MonitorPanel`: when `!sessionId` (no active live session) render `<PanelEmpty icon=... text={t('panels.noSessionHint')} />` for the body instead of the data list. Keep the `PanelShell` header. Add i18n key `panels.noSessionHint` (zh: 「无活动会话 · 从 Vault 连接一个主机后这里会显示实时数据」, en equivalent) to both locales.

- [ ] **Step 5: 跑测试** `npm test` (full) green; `npx tsc --noEmit` clean. Update any panel tests that asserted mock data (now empty without sessionId) to pass a sessionId + mocked getter, or assert the empty state.

- [ ] **Step 6: Commit**
```bash
git add src/services/ssh.ts src/components/panels/PanelEmpty.tsx src/components/panels/PanelEmpty.test.tsx src/components/panels/SftpPanel.tsx src/components/panels/TunnelsPanel.tsx src/components/panels/MonitorPanel.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(ssh/fe): empty state for SFTP/tunnels/monitor when no active session (drop mock fallback)"
```

---

# 阶段 S：片段库

## Task S1: snippets 持久化 (state/snippets.ts)

**Files:** Create `src/state/snippets.ts`, `src/state/snippets.test.ts`.

- [ ] **Step 1: 失败测试**
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadSnippets, saveSnippet, deleteSnippet } from './snippets'
beforeEach(() => localStorage.clear())
describe('snippets store', () => {
  it('adds and loads', () => {
    saveSnippet({ id: 's1', scope: 'Shell', desc: 'list', icon: 'terminal', code: 'ls -la' })
    const l = loadSnippets()
    expect(l).toHaveLength(1); expect(l[0].code).toBe('ls -la')
  })
  it('updates by id then deletes', () => {
    saveSnippet({ id: 's1', scope: 'Shell', desc: 'a', icon: 'terminal', code: 'x' })
    saveSnippet({ id: 's1', scope: 'Shell', desc: 'b', icon: 'terminal', code: 'y' })
    expect(loadSnippets()).toHaveLength(1)
    expect(loadSnippets()[0].desc).toBe('b')
    deleteSnippet('s1'); expect(loadSnippets()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 实现** `src/state/snippets.ts`
```ts
import type { Snippet } from '../services/types'
const KEY = 'catio-snippets'
export function loadSnippets(): Snippet[] {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as Snippet[]) : [] } catch { return [] }
}
export function saveSnippet(s: Snippet): void {
  const l = loadSnippets().filter(x => x.id !== s.id); l.unshift(s)
  localStorage.setItem(KEY, JSON.stringify(l))
}
export function deleteSnippet(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadSnippets().filter(x => x.id !== id)))
}
export function newSnippetId(): string { return 's-' + Math.floor(performance.now() * 1000).toString(36) }
```

- [ ] **Step 3: 跑** `npm test -- src/state/snippets.test.ts` → pass.
- [ ] **Step 4: Commit** `git add src/state/snippets.ts src/state/snippets.test.ts && git commit -m "feat(ssh/fe): snippets persistence store"`

## Task S2: SnippetsPanel 真实 CRUD + 插入终端

**Files:** Modify `src/components/panels/SnippetsPanel.tsx`, `src/App.tsx`; create/extend `SnippetsPanel.test.tsx`; reuse `ConfirmModal`.

- [ ] **Step 1: App 提供 onInsert + 活动 chanId**
In `App.tsx`: track the active terminal's channel id. TerminalPane already opens a channel internally; add an `onChannel?(chanId: string)` callback prop to TerminalPane that fires after `termOpen` succeeds, and store `activeChanId` per active tab (a `Record<sessionId, chanId>` or just the current). Provide:
```ts
async function insertToTerminal(code: string) {
  const sid = cur?.sessionId; const chan = sid ? chanMap[sid] : undefined
  if (!sid || !chan) return // disabled when no live terminal
  const { termWrite } = await import('./services/ssh')
  await termWrite(sid, chan, btoa(unescape(encodeURIComponent(code))))
}
```
(UTF-8 → base64; do NOT append newline — user presses Enter.) Pass `onInsert={insertToTerminal}` and `canInsert={!!cur?.sessionId}` to `SnippetsPanel`, `HistoryPanel`, and `AIPanel`.

- [ ] **Step 2: 失败测试** `SnippetsPanel.test.tsx`: mock `state/snippets`, render with `snippets` from store + `onInsert` spy; assert a saved snippet renders; clicking insert calls `onInsert(code)`; the `+` adds (opens an editor row/modal) — assert `saveSnippet` called; delete → ConfirmModal → `deleteSnippet`.

- [ ] **Step 3: 改 SnippetsPanel**
- Source list from a `snippets` prop (App passes `loadSnippets()` result + a `reload` callback) instead of `D.snippets`.
- Replace the `catio-insert` window-event in `insert()` with the `onInsert(code)` prop (disable/hide when `!canInsert`). Keep `copy` (clipboard).
- The `+` action: open a small inline editor (reuse the SaveSnippetModal pattern from HistoryPanel, or a compact form) to create/edit a snippet → `saveSnippet` + reload. Add per-row edit + delete (delete → `ConfirmModal`). Keep the existing row layout/pixels; add edit/delete to the hover action group.
- i18n new strings (zh+en): `panels.newSnippet`, `panels.editSnippet`, `panels.deleteSnippet`, `panels.snippetDeleteConfirm`.

- [ ] **Step 4: 跑** `npm test` green, `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `git add src/components/panels/SnippetsPanel.tsx src/components/panels/SnippetsPanel.test.tsx src/App.tsx src/components/workbench/TerminalPane.tsx src/i18n/*.json && git commit -m "feat(ssh/fe): real snippets CRUD + insert into active terminal"`

---

# 阶段 H：历史（命令审计）

## Task H1: osc.rs 解析/剥离纯函数 (TDD)

**Files:** Create `src-tauri/src/ssh/osc.rs`; Modify `src-tauri/src/ssh/mod.rs` (`pub mod osc;`).

- [ ] **Step 1: 失败测试 + 类型** `src-tauri/src/ssh/osc.rs`
```rust
//! OSC 633 (VS Code) / OSC 133 (FinalTerm) shell-integration parsing.
//! Scans a byte stream, extracts command-audit events, and returns the bytes
//! with the OSC 633/133 sequences removed (so they never reach the terminal UI).

#[derive(Debug, PartialEq, Clone)]
pub enum OscEvent {
    /// Command line text (from 633;E), with the verified nonce.
    CommandLine(String),
    /// Pre-execution mark (633/133;C).
    ExecStart,
    /// Execution finished with optional exit code (633/133;D).
    ExecEnd(Option<i32>),
    /// Cwd property (633;P;Cwd=...).
    Cwd(String),
}

/// Unescape the VS Code value encoding: `\\`->`\`, `\xAB`->byte.
pub fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            match b[i + 1] {
                b'\\' => { out.push(b'\\'); i += 2; }
                b'x' | b'X' if i + 3 < b.len() => {
                    let hex = std::str::from_utf8(&b[i + 2..i + 4]).unwrap_or("");
                    if let Ok(v) = u8::from_str_radix(hex, 16) { out.push(v); i += 4; }
                    else { out.push(b[i]); i += 1; }
                }
                _ => { out.push(b[i]); i += 1; }
            }
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stateful scanner: feed it chunks; it emits events and returns visible bytes
/// (input minus any complete OSC 633/133 sequences). Buffers a partial sequence
/// across chunk boundaries. `nonce` gates 633;E (mismatched nonce → ignored).
pub struct Scanner { nonce: String, pending: Vec<u8> }

impl Scanner {
    pub fn new(nonce: impl Into<String>) -> Self { Self { nonce: nonce.into(), pending: Vec::new() } }

    /// Returns (visible_bytes, events).
    pub fn feed(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<OscEvent>) {
        // Implementation: append chunk to a working buffer; walk it. When we see
        // ESC ] ("\x1b]"), look for the terminator BEL (0x07) or ST (ESC \).
        //   - If the OSC payload starts with "633;" or "133;": parse it into an
        //     event (do NOT emit these bytes as visible). 
        //   - Other OSC (e.g. 0;title, 1337;...): keep as visible (pass through).
        //   - If no terminator yet (sequence split across chunks): stash the
        //     tail (from ESC]) into `pending` and stop; prepend it next feed.
        // Parse payload by ';' split: ["633","A"], ["633","D","0"],
        //   ["633","E","<esccmd>","<nonce>"], ["633","P","Cwd=<escpwd>"].
        unimplemented!("see Step 3")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }

    #[test] fn unescape_basic() {
        assert_eq!(unescape("ls\\x3b cat"), "ls; cat");
        assert_eq!(unescape("a\\\\b"), "a\\b");
        assert_eq!(unescape("x\\x0ay"), "x\ny");
    }
    #[test] fn extracts_command_and_exit_and_strips() {
        let mut sc = Scanner::new("N");
        let input = b"\x1b]633;E;ls\\x3b cat;N\x07\x1b]633;C\x07hello\r\n\x1b]633;D;0\x07$ ";
        let (vis, ev) = sc.feed(input);
        assert_eq!(s(&vis), "hello\r\n$ "); // OSC stripped, normal output kept
        assert!(ev.contains(&OscEvent::CommandLine("ls; cat".into())));
        assert!(ev.contains(&OscEvent::ExecStart));
        assert!(ev.contains(&OscEvent::ExecEnd(Some(0))));
    }
    #[test] fn rejects_wrong_nonce() {
        let mut sc = Scanner::new("GOOD");
        let (_v, ev) = sc.feed(b"\x1b]633;E;whoami;BAD\x07");
        assert!(!ev.iter().any(|e| matches!(e, OscEvent::CommandLine(_))));
    }
    #[test] fn buffers_split_sequence() {
        let mut sc = Scanner::new("N");
        let (v1, e1) = sc.feed(b"out\x1b]633;D;1"); // no terminator yet
        assert_eq!(s(&v1), "out"); assert!(e1.is_empty());
        let (v2, e2) = sc.feed(b"3\x07more"); // completes ;D;13
        assert_eq!(s(&v2), "more");
        assert!(e2.contains(&OscEvent::ExecEnd(Some(13))));
    }
    #[test] fn passes_through_other_osc() {
        let mut sc = Scanner::new("N");
        let (v, _e) = sc.feed(b"\x1b]0;my title\x07X"); // window title OSC kept
        assert_eq!(s(&v), "\x1b]0;my title\x07X");
    }
    #[test] fn osc133_exit() {
        let mut sc = Scanner::new("N");
        let (_v, ev) = sc.feed(b"\x1b]133;D;2\x07");
        assert!(ev.contains(&OscEvent::ExecEnd(Some(2))));
    }
    #[test] fn cwd_event() {
        let mut sc = Scanner::new("N");
        let (_v, ev) = sc.feed(b"\x1b]633;P;Cwd=/home/u\x07");
        assert!(ev.contains(&OscEvent::Cwd("/home/u".into())));
    }
}
```

- [ ] **Step 2: 跑确认失败** `cd src-tauri && cargo test --lib osc` → fails (`unimplemented!`).

- [ ] **Step 3: 实现 `Scanner::feed`** so all tests pass. Algorithm:
  - Work on `buf = pending.drain() ++ chunk`. Iterate with index `i`, copying non-sequence bytes to `visible`.
  - When `buf[i..]` starts with `\x1b]`: scan forward for terminator `\x07` OR `\x1b\x5c` (ST). If none found, push `buf[i..]` to `pending` and break (partial). Else take payload between `\x1b]` and terminator.
    - If payload starts with `633;` or `133;`: parse → event(s); DROP from visible.
    - Else: copy the whole sequence (incl. ESC] and terminator) to visible (pass-through).
  - Parsing payload `633;...`: split on `;` into fields (note: the command in `E` is already escaped so it has no raw `;`; safe to split). `A`/`B`→ignore (no event needed for history) ; `C`→ExecStart; `D`→ExecEnd(None) / `D;<n>`→ExecEnd(parse i32); `E;<cmd>;<nonce>`→ if nonce matches → CommandLine(unescape(cmd)); `P;Cwd=<v>`→Cwd(unescape(v)). `133;` supports `C` and `D[;n]`.
  - Run: `cargo test --lib osc` → all pass.

- [ ] **Step 4: Commit** `git add src-tauri/src/ssh/osc.rs src-tauri/src/ssh/mod.rs && git commit -m "feat(ssh): OSC 633/133 shell-integration parser/stripper"`

## Task H2: shell 集成注入 + term.rs 接审计

**Files:** Create `src-tauri/src/ssh/shell_integration.rs`; Modify `src-tauri/src/ssh/term.rs`, `mod.rs`, `lib.rs`.

- [ ] **Step 1: 集成脚本常量** `src-tauri/src/ssh/shell_integration.rs`
```rust
//! Shell-integration bootstrap injected into the remote PTY shell.
//! Adapted from VS Code shellIntegration-bash.sh / -rc.zsh (MIT). Emits OSC 633
//! markers (command line E, pre-exec C, finished D+exit, Cwd) with a per-session nonce.

/// The integration body. `__CATIO_NONCE__` is replaced with the session nonce.
const SCRIPT: &str = r#"
if [ -n "${ZSH_VERSION:-}" ]; then
  __catio_n='__CATIO_NONCE__'
  __catio_esc(){ local s=${1//\\/\\\\}; s=${s//;/\\x3b}; s=${s//$'\n'/\\x0a}; print -rn -- "$s"; }
  __catio_pe(){ print -rn -- $'\e]633;E;'"$(__catio_esc "$1")"';'"$__catio_n"$'\a\e]633;C\a'; }
  __catio_pc(){ local e=$?; print -rn -- $'\e]633;D;'"$e"$'\a\e]633;P;Cwd='"$(__catio_esc "$PWD")"$'\a'; }
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec __catio_pe; add-zsh-hook precmd __catio_pc
elif [ -n "${BASH_VERSION:-}" ]; then
  __catio_n='__CATIO_NONCE__'
  __catio_esc(){ local s=${1//\\/\\\\}; s=${s//;/\\x3b}; s=${s//$'\n'/\\x0a}; printf '%s' "$s"; }
  __catio_in=0
  __catio_pe(){ if [ "$__catio_in" = 0 ]; then __catio_in=1; local c; c=$(builtin history 1 | sed 's/ *[0-9][0-9]* *//'); printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__catio_esc "$c")" "$__catio_n"; fi; }
  __catio_pc(){ local e=$?; printf '\e]633;D;%s\a\e]633;P;Cwd=%s\a' "$e" "$(__catio_esc "$PWD")"; __catio_in=0; }
  trap '__catio_pe' DEBUG
  case "${PROMPT_COMMAND:-}" in *__catio_pc*) ;; *) PROMPT_COMMAND="__catio_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
fi
"#;

/// Build the one-shot line to write to the PTY. Leading space keeps it out of
/// history (when HISTCONTROL has ignorespace, which we also set). base64 avoids
/// quoting/echo issues; the line self-erases nothing but is harmless.
pub fn bootstrap_line(nonce: &str) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    let body = SCRIPT.replace("__CATIO_NONCE__", nonce);
    let b64 = B64.encode(body.as_bytes());
    // leading space + set ignorespace + eval the decoded script.
    format!(" export HISTCONTROL=ignorespace; eval \"$(printf %s {} | base64 -d 2>/dev/null || printf %s {} | base64 --decode)\"\n", )
        .replace("{}", &format!("'{}'", b64))
}
```
(If the `format!`/replace is awkward, build the string plainly; the GOAL: a single PTY line `space + export HISTCONTROL=ignorespace; eval "$(printf %s '<b64>' | base64 -d)"` + `\n`. Handle base64 `-d` vs `--decode` portability.)

- [ ] **Step 2: term.rs 注入 + 解析**
In `term_open`, after `request_shell`:
- generate `let nonce = format!("{:x}", <random u64>)` — use the existing `rand` (already a dep) or a counter+pid; nonce just needs to be unguessable-enough per session. Store nothing extra; pass nonce into the owner task.
- write the bootstrap once: `channel.data(shell_integration::bootstrap_line(&nonce).as_bytes()).await`.
- In the owner task, create `let mut scanner = osc::Scanner::new(nonce);`. On each `ChannelMsg::Data { data }`: `let (visible, events) = scanner.feed(&data); ` → emit `term://{chan}` with base64 of `visible` (instead of raw data); for each event update audit state:
  - `CommandLine(cmd)` → remember `cur_cmd = cmd`, `cur_start = Instant::now()`, `cur_cwd`.
  - `Cwd(d)` → `cur_cwd = d`.
  - `ExecEnd(code)` → if `cur_cmd` set, `app.emit("history://{session_id}", json!({ "command": cur_cmd, "exitCode": code, "cwd": cur_cwd, "durationMs": elapsed, "host": host }))`; clear `cur_cmd`.
  (Pass `session_id` + `host` into the owner task; currently it has `app` + `evt`. Add them.)
- If `visible` is empty, skip emitting the term event.

- [ ] **Step 3: 测试**
- `osc.rs` already unit-tested (H1).
- Add a term integration test that DOESN'T need a real shell: unit-test the audit state machine by feeding a scripted byte sequence through a small helper `fn audit_from_events(events) -> Option<HistoryEntry>` if you extract one; OR rely on H1's Scanner tests + a manual-QA note. Minimum: `cargo build` + existing `ssh_term` test still green (the injected bootstrap is just bytes written to the fake echo server — ensure `pty_shell_echoes_input` still passes; the echo server will echo the bootstrap line back, which the scanner passes through as visible since it's not an OSC sequence — verify the test still asserts it sees "hello").
  - NOTE in the commit/PR: real OSC emission is validated via Docker sshd manual QA (the in-process server has no real shell).

- [ ] **Step 4: 跑** `cd src-tauri && cargo test && cargo build` green.
- [ ] **Step 5: Commit** `git add src-tauri/src/ssh && git commit -m "feat(ssh): inject shell integration + command audit via OSC, emit history://"`

## Task H3: history 持久化 + App 订阅

**Files:** Create `src/state/history.ts`, `src/state/history.test.ts`; Modify `src/services/ssh.ts`, `src/App.tsx`.

- [ ] **Step 1: 失败测试** `history.test.ts`
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { appendHistory, loadHistory, clearHistory } from './history'
beforeEach(() => localStorage.clear())
it('appends newest-first and caps', () => {
  for (let i = 0; i < 5; i++) appendHistory({ kind: 'shell', target: 'h', text: 'cmd'+i, when: 'now', dur: '1ms', exitCode: 0 })
  const l = loadHistory()
  expect(l[0].text).toBe('cmd4')
  expect(l.length).toBe(5)
  clearHistory(); expect(loadHistory()).toHaveLength(0)
})
```

- [ ] **Step 2: 实现** `src/state/history.ts`
```ts
import type { HistoryItem } from '../services/types'
const KEY = 'catio-history'; const CAP = 1000
export function loadHistory(): HistoryItem[] {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as HistoryItem[]) : [] } catch { return [] }
}
export function appendHistory(h: Omit<HistoryItem, 'id'>): void {
  const item: HistoryItem = { ...h, id: 'h-' + Math.floor(performance.now() * 1000).toString(36) }
  const l = [item, ...loadHistory()].slice(0, CAP)
  localStorage.setItem(KEY, JSON.stringify(l))
}
export function clearHistory(): void { localStorage.removeItem(KEY) }
```
(`HistoryItem` may need an optional `exitCode?: number` field added to `services/types.ts` — add it.)

- [ ] **Step 3: services 订阅 helper** in `ssh.ts`:
```ts
export interface HistoryEvent { command: string; exitCode: number | null; cwd: string; durationMs: number; host: string }
export async function onHistory(sessionId: string, cb: (e: HistoryEvent) => void): Promise<() => void> {
  return listen<HistoryEvent>(`history://${sessionId}`, cb)
}
```

- [ ] **Step 4: App 订阅** when a live session opens (in `openLiveTab` or an effect over `sessionMap`): `onHistory(sessionId, e => appendHistory({ kind: 'shell', target: host, text: e.command, when: <now formatted>, dur: e.durationMs + 'ms', exitCode: e.exitCode ?? undefined }))`. Unsubscribe on disconnect.

- [ ] **Step 5: 跑 + Commit** `npm test`, `tsc`; `git add src/state/history.* src/services/ssh.ts src/services/types.ts src/App.tsx && git commit -m "feat(ssh/fe): history persistence + subscribe history:// audit events"`

## Task H4: HistoryPanel 接真

**Files:** Modify `src/components/panels/HistoryPanel.tsx`; extend its test.

- [ ] **Step 1: 改 HistoryPanel** source rows from `loadHistory()` (App passes `history` + `reload`), not `D.history`. Wire the (currently inert) insert button → `onInsert(h.text)` (prop from App, disabled when no live terminal); keep copy + save-to-snippet. Add a 「清空历史」 action (footer or header) → `ConfirmModal` → `clearHistory()` + reload. Exit-code: if `h.exitCode != null && h.exitCode !== 0` render the row's command in danger tone. Keep filters/search/SaveSnippetModal layout. The `byName`/targets logic: derive from the real history's targets (no `D.connections` dependency for grouping — use `target` strings).
- i18n: `panels.clearHistory`, `panels.clearHistoryConfirm` (zh+en).

- [ ] **Step 2: 测试** mock `state/history` with 2 entries (one exit!=0); assert rows render, exit!=0 styled, insert calls onInsert, clear → confirm → clearHistory.
- [ ] **Step 3: 跑 + Commit** `npm test`, `tsc`; `git add src/components/panels/HistoryPanel.tsx src/components/panels/HistoryPanel.test.tsx src/i18n/*.json && git commit -m "feat(ssh/fe): HistoryPanel real audit data + clear/insert"`

---

# 阶段 A：Agent 真实推理

## Task A1: services/agent.ts 流式对话

**Files:** Create `src/services/agent.ts`, `src/services/agent.test.ts`.

- [ ] **Step 1: 失败测试** (mock fetch streaming)
```ts
import { describe, it, expect, vi } from 'vitest'
// helper to build a ReadableStream from chunks
function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder()
  const rs = new ReadableStream({ start(c) { chunks.forEach(s => c.enqueue(enc.encode(s))); c.close() } })
  return new Response(rs, { status: 200 })
}
describe('agent.chat', () => {
  it('ollama streams tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamOf([
      '{"message":{"content":"Hel"}}\n', '{"message":{"content":"lo"}}\n', '{"done":true}\n']))
    vi.stubGlobal('fetch', fetchMock)
    const { chat } = await import('./agent')
    let out = ''
    const reply = await chat([{ role: 'user', content: 'hi' }],
      { provider: 'ollama', ollamaBaseUrl: 'http://x', openaiBaseUrl: '', openaiKey: '', model: 'm' },
      { onToken: t => { out += t } })
    expect(out).toBe('Hello'); expect(reply).toBe('Hello')
  })
})
```

- [ ] **Step 2: 实现** `src/services/agent.ts` — use `resolveFetch()` from models.ts (export it if not already). Ollama: POST `/api/chat` `{model, messages, stream:true}`, read body reader, split on `\n`, JSON.parse each line, accumulate `message.content`, call `onToken`. OpenAI: POST `/v1/chat/completions` `{model, messages, stream:true}` + Bearer, parse SSE `data: {...}` lines, `choices[0].delta.content`. Stop on `[DONE]`/`done`. Return the full text. Accept `AbortSignal`. No `any` (type the minimal shapes). Handle non-200 → throw with status+body snippet.

- [ ] **Step 3: 跑** `npm test -- src/services/agent.test.ts` → pass.
- [ ] **Step 4: Commit** `git add src/services/agent.ts src/services/agent.test.ts src/services/models.ts && git commit -m "feat(agent): streaming chat for Ollama + OpenAI-compatible"`

## Task A2: AIPanel 真实对话 + 插入命令

**Files:** Modify `src/components/panels/AIPanel.tsx`, `src/App.tsx`; extend test.

- [ ] **Step 1: 改 AIPanel**
- Replace mock `thread = D.aiSql/aiShell` with local state `const [msgs, setMsgs] = useState<{role:'user'|'assistant';content:string}[]>([])`.
- Read `useAgentConfig()` (from `state/agentConfig`). If no `model` configured → show a hint「去设置配置模型」（link/button to open settings; reuse the existing settings nav — App can pass an `onOpenSettings`).
- Send: on submit, push user msg + an empty assistant msg; call `agent.chat(allMsgs, cfg, { onToken })` updating the streaming assistant msg; on error set the assistant msg to an error line.
- Inject a system message describing context: shell mode + `conn?.name`/host (so it answers as a shell assistant for that host).
- Render assistant content with the existing markdown-ish renderer; detect ```fenced code blocks; for shell blocks render an 「插入到当前终端」 button → `onInsert(code)` (prop, disabled when `!canInsert`). SQL blocks: show + copy only (execution is sub-project 3).
- Keep the composer + attachment UI. Remove the fake SnippetCard exec animation path (or keep SnippetCard only for rendering, with real insert + no fake "execute").
- i18n: `panels.agentNoModel`, `panels.insertToTerminal` (reuse existing if present), `panels.agentError`.

- [ ] **Step 2: 测试** mock `services/agent` `chat` to call onToken then resolve; mock `state/agentConfig` with a model; render, type, send → assert streamed text appears; a shell code block shows an insert button that calls `onInsert`. Also: no model configured → hint shown.

- [ ] **Step 3: 跑** `npm test`, `tsc`, `npm run build`.
- [ ] **Step 4: Commit** `git add src/components/panels/AIPanel.tsx src/App.tsx src/i18n/*.json && git commit -m "feat(agent): real streaming chat in AIPanel + insert generated command into terminal"`

---

# 阶段 P：ProxyJump 跳板

## Task P1: 后端多跳 connect (conn.rs)

**Files:** Modify `src-tauri/src/ssh/conn.rs`; Modify `src-tauri/tests/common/test_server.rs` (already supports direct-tcpip echo from C1 — extend to forward to a second server); Create `src-tauri/tests/ssh_proxyjump.rs`.

- [ ] **Step 1: 类型** in `conn.rs`:
```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpSpec {
    pub host: String, pub port: u16, pub user: String,
    pub auth: AuthMethod, pub secret: Option<String>,
}
```
Add `pub jump: Option<JumpSpec>` to `ConnectArgs` (serde; optional → existing callers/tests unaffected).

- [ ] **Step 2: connect_core 多跳**
Refactor `connect_core` so when `args.jump` is `Some(j)`:
1. Connect+auth to the jump host first (reuse the same connect+auth logic — extract a helper `connect_one(host,port,user,auth,secret,config) -> (Handle, fp)` used for both jump and direct).
2. `let ch = jump_handle.channel_open_direct_tcpip(&args.host, args.port as u32, "127.0.0.1", 0).await?;`
3. `let stream = ch.into_stream();`
4. `let target_handler = ClientHandler::default(); let fp_slot = target_handler.fingerprint.clone(); let mut handle = russh::client::connect_stream(config.clone(), stream, target_handler).await.map_err(...)?;`
5. authenticate to the target (`args.user`/`args.auth`/`args.secret`).
6. **Keep the jump handle alive** for the session lifetime: store it on the `Session` (add `pub _jump: Option<Handle<ClientHandler>>`) so the direct-tcpip channel (and thus the target transport) isn't dropped.
TOFU: verify the TARGET fingerprint against known_hosts (host:port of target). The jump host's key is captured via its own handler; v1 may accept jump key (document) or also verify (`<jumphost:port>` entry) — verify both, keying by their host:port.

- [ ] **Step 3: test server 支持转发到第二 server**
In `test_server.rs`, change `channel_open_direct_tcpip` so that instead of echo, it CONNECTS (tokio TcpStream) to the requested `host_to_connect:port_to_connect` and pipes bytes both ways. Then the proxyjump test can stand up a SECOND `test_server::start()` as the target, and the first server forwards direct-tcpip to it. (Keep an `echo` variant if other tunnel tests depend on echo — check C1/C3 tests; if they rely on echo, add a separate `start_forwarding()` server variant rather than changing the default.)

- [ ] **Step 4: 集成测试** `src-tauri/tests/ssh_proxyjump.rs`
```rust
mod common; use common::test_server;
use catio_lib::ssh::conn::{connect_authenticated, ConnectArgs, AuthMethod, JumpSpec};
#[tokio::test]
async fn connects_through_jump() {
    let target = test_server::start().await;        // final target
    let jump = test_server::start_forwarding().await; // forwards direct-tcpip → real TCP
    let args = ConnectArgs {
        host: target.ip().to_string(), port: target.port(),
        user: test_server::TEST_USER.into(), auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: Some(JumpSpec { host: jump.ip().to_string(), port: jump.port(),
            user: test_server::TEST_USER.into(), auth: AuthMethod::Password,
            secret: Some(test_server::TEST_PW.into()) }),
    };
    let (handle, _fp) = connect_authenticated(&args).await.expect("jump connect");
    // prove the target session works: open exec, get echo
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.exec(true, "marker-cmd").await.unwrap();
    let mut got = Vec::new();
    while let Some(m) = ch.wait().await { if let russh::ChannelMsg::Data{ref data}=m { got.extend_from_slice(data); } if got.windows(10).any(|w| w==b"marker-cmd") { break } }
    assert!(got.windows(10).any(|w| w==b"marker-cmd"));
}
```
(`connect_authenticated` must thread `jump` through `connect_core`. `start_forwarding` = a test server whose direct-tcpip pipes to the real target addr.)

- [ ] **Step 5: 跑** `cd src-tauri && cargo test --test ssh_proxyjump && cargo test && cargo build` green.
- [ ] **Step 6: Commit** `git add src-tauri/src/ssh/conn.rs src-tauri/tests && git commit -m "feat(ssh): ProxyJump multi-hop connect via connect_stream"`

## Task P2: 前端 ProxyJump 配置 + 隧道面板跳板链

**Files:** Modify `src/services/ssh.ts` (SshConnectArgs + jump), `src/state/connections.ts` (ConnectionProfile.jump), `src/components/modals/NewConnectionModal.tsx`, `src/components/panels/TunnelsPanel.tsx`, `src/App.tsx`.

- [ ] **Step 1: 类型透传** `ssh.ts`: add `jump?: { host; port; user; auth; secret? }` to `SshConnectArgs` (passed inside the `ssh_connect` args object). `connections.ts`: add `jump?: Omit<JumpSpec,'secret'>` to `ConnectionProfile` (non-secret; jump secret prompted at connect, not stored).
- [ ] **Step 2: 模态配置** NewConnectionModal: the existing 「ProxyJump 跳板」 toggle, when ON, reveals jump host/port/user/auth fields. On save, persist `jump` (non-secret) into the profile; on connect, prompt for the jump secret too if needed (extend `ConnectSecretPrompt` flow to collect jump secret when `jump` present and password/passphrase needed — simplest: one prompt for target, one for jump, or a combined prompt). Keep pixels; default toggle OFF (already done).
- [ ] **Step 3: 隧道面板跳板链** TunnelsPanel `jumpChain`: derive from the active connection's profile `jump` (+ the connection itself as target, local as origin) instead of mock `D.jumpChain`. When no jump configured, show just `本地 → 目标` or hide the ProxyJump section.
- [ ] **Step 4: 测试 + 跑** modal: toggling ProxyJump reveals fields + saved into profile (mock saveProfile); TunnelsPanel renders the real chain. `npm test`, `tsc`, `npm run build`.
- [ ] **Step 5: Commit** `git add src/services/ssh.ts src/state/connections.ts src/components/modals/NewConnectionModal.tsx src/components/panels/TunnelsPanel.tsx src/App.tsx src/i18n/*.json && git commit -m "feat(ssh/fe): ProxyJump config in connection form + real jump chain in tunnels panel"`

---

# 阶段 F：收尾

## Task F1: 全量校验 + 文档 + QA 清单

- [ ] **Step 1:** `cd src-tauri && cargo test && cargo clippy --all-targets`（修琐碎警告）；根目录 `npm test && npx tsc --noEmit && npm run build`。全绿。
- [ ] **Step 2:** 更新 spec 顶部「实现状态」：列出新增命令/事件（`history://`）、shell 集成注入位置、ProxyJump 支持、片段/历史 localStorage key、隐私注记（历史明文、可清空）。
- [ ] **Step 3:** 手动 QA（Docker sshd）清单：
  - 历史：终端跑 `ls`/`false`/`cd /tmp` → 历史面板出现命令 + 退出码（`false` 标红）+ cwd；非 bash/zsh 会话无审计不报错。
  - Agent：配置 Ollama/OpenAI → 真实对话流式；生成 shell 命令 → 插入到终端。
  - 片段：新建/编辑/删除（二次确认）/复制/插入终端。
  - SFTP/隧道/监控：无会话空态；有会话真实数据。
  - ProxyJump：经堡垒机连内网目标主机，终端可用；隧道面板显示跳板链。
- [ ] **Step 4:** superpowers:finishing-a-development-branch 收尾（合并交用户）。

---

## 自检（spec 覆盖 / 一致性）

- 空态(R1)、片段(S1/S2)、历史(H1–H4)、Agent(A1/A2)、ProxyJump(P1/P2) 全部对应 spec 第 2 节五块。
- 事件名：`history://{sessionId}`（新）；既有 `term://`/`sftp-progress://`/`tunnel://`/`monitor://`/`multiexec://` 不变。
- 命令/类型一致：`osc::Scanner`/`OscEvent`、`HistoryEvent{command,exitCode,cwd,durationMs,host}`、`appendHistory`、`ConnectionProfile.jump`、`JumpSpec`、`SshConnectArgs.jump` 跨任务一致。
- 秘密：Agent key 仅 agentConfig；jump/target secret 连接时提示、不入 profile；历史明文 localStorage（已在隐私注记标注）。
- 无占位符：osc.rs `feed` 在 H1 Step3 给出完整算法（实现者据此写出，测试驱动）；其余代码块完整。
- ProxyJump API 已核实（connect_stream / into_stream，0.61.2）。
- 终端审计无法进程内端到端测 → osc.rs 纯函数全测 + Docker 手动 QA（已在 H2 标注）。
