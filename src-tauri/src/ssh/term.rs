//! 交互式终端：每个 PTY+shell channel 由单个 owner 任务独占。
//!
//! owner 任务在 `channel.wait()`（来自服务端的数据 → 发 Tauri 事件）与
//! 一个 mpsc 命令接收端（Write/Resize/Close）之间 `tokio::select!`。
//! channel 永不被共享或加锁——无死锁。`Session` 只保存每个 channel id
//! 对应的 mpsc `UnboundedSender<TermCmd>`。
//!
//! russh 0.61.2（ring 后端）已确认的 channel API：
//!   * `handle.channel_open_session().await -> Result<Channel<client::Msg>, _>`
//!   * `channel.request_pty(want_reply, term, col, row, pix_w, pix_h, &[(Pty,u32)]).await`
//!   * `channel.request_shell(want_reply).await`
//!   * `channel.data(impl AsyncRead).await`——`&bytes[..]` 即 `&[u8]` 实现 AsyncRead。
//!   * `channel.window_change(col, row, pix_w, pix_h).await`
//!   * `channel.eof().await`
//!   * `channel.wait().await -> Option<ChannelMsg>`；
//!     `ChannelMsg::Data { data: Bytes }`、`ExtendedData { data: Bytes, ext: u32 }`、
//!     `Eof`、`Close`。

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::ChannelMsg;
use tokio::sync::mpsc;

use crate::events::EventSink;
use crate::ssh::{ids::IdGen, manager::SessionManager, osc, shell_integration, SshError};

static CHAN_IDS: IdGen = IdGen::new("chan");
/// Process-wide monotonic id for emitted `history://` events so the frontend can
/// dedup a single backend command even if multiple listeners observe the event.
static HIST_IDS: IdGen = IdGen::new("hist");
/// How long to keep the terminal "muted" if no shell-integration marker arrives
/// (e.g. a shell without bash/zsh hooks). After this, output is shown unfiltered.
const MUTE_FALLBACK_MS: u64 = 3000;
/// Window within which an identical, consecutive command is treated as a
/// duplicate backend emission (shell emitting extra markers for one command) and
/// suppressed. A human cannot retype the exact same command this fast.
const DEDUP_WINDOW_MS: u64 = 800;
/// 合帧刷新间隔。高频输出(watch/top 等全屏重绘)经 SSH 会拆成大量小数据帧,逐帧 emit 一个
/// IPC 事件会淹没前端主线程(多分屏并发时连原生窗口按钮都点不动)。可见字节先攒进 pending
/// buffer,每 ~8ms(约 120fps)合并 emit 一帧,从源头把 IPC 事件量砍到可控;远低于可感知延迟。
/// inputStart/execStart 等时序敏感的控制帧仍立即 flush,交互语义不变。
const FLUSH_INTERVAL_MS: u64 = 8;

/// 把攒批的可见字节合并成单帧 emit 并清空 pending。`input_start` 为真时给该帧挂 inputStart
/// 标志(提示符字节写完前端才 beginInputCapture);pending 为空且 input_start 为真时单发
/// `{ inputStart: true }`(marker 跨批的兜底,与前端单发 inputStart 分支对齐)。
fn flush_pending(sink: &dyn EventSink, evt: &str, pending: &mut Vec<u8>, input_start: bool) {
    if pending.is_empty() {
        if input_start {
            sink.emit(evt, serde_json::json!({ "inputStart": true }));
        }
        return;
    }
    let mut frame = serde_json::json!({ "bytesBase64": B64.encode(&pending) });
    if input_start {
        frame["inputStart"] = serde_json::Value::Bool(true);
    }
    sink.emit(evt, frame);
    pending.clear();
}

/// Returns true if `cmd` matches the last-emitted command within `DEDUP_WINDOW_MS`,
/// i.e. it is a spurious duplicate that should be skipped.
fn is_duplicate_emit(last_emit: &Option<(String, std::time::Instant)>, cmd: &str) -> bool {
    matches!(
        last_emit,
        Some((c, t))
            if c == cmd && t.elapsed() < std::time::Duration::from_millis(DEDUP_WINDOW_MS)
    )
}

/// 发给「拥有 channel 的 owner 任务」的指令。
pub enum TermCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// 打开一个 PTY+shell channel，启动其 owner 任务，返回 channel id。
/// 来自服务端的字节经 `term://<chan_id>` 事件流向前端，payload 形如
/// `{ "bytesBase64": "<base64>" }`；channel 关闭时发 `{ "closed": true }`。
#[tauri::command]
pub async fn term_open(
    session_id: String,
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    term_open_core(session_id, cols, rows, Arc::new(crate::events::TauriSink(app)), &mgr, |_| {}).await
}

/// Transport-agnostic terminal open. Identical to the desktop command body, but emits frames
/// through an `EventSink` (Tauri webview bus on desktop, WebSocket hub on the web head) so the
/// owner task, OSC scanning, shell-integration audit and dedup logic are NOT duplicated.
///
/// `on_open(chan_id)` runs synchronously the instant the channel id exists and BEFORE the owner
/// task is spawned, so the web head can subscribe the connection to `term://{chanId}` with zero
/// chance of losing the first emitted frame to a subscribe-after-emit race. Desktop passes a
/// no-op (its event bus has no per-listener race).
pub async fn term_open_core(
    session_id: String,
    cols: u32,
    rows: u32,
    sink: Arc<dyn EventSink>,
    mgr: &SessionManager,
    on_open: impl FnOnce(&str),
) -> Result<String, SshError> {
    let sess = mgr
        .get(&session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;

    let (mut channel, host) = {
        let s = sess.lock().await;
        let channel = s
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Io(e.to_string()))?;
        (channel, s.host.clone())
    };
    // want_reply=true:让服务器对 pty/shell 请求回 Success/Failure。russh 把这些回复作为
    // ChannelMsg 经 channel.wait() 投递(不是方法返回值),故 owner task 的 select! 必须处理
    // Failure/OpenFailure——否则服务器拒绝(如达 MaxSessions 上限、同 session 多开 shell 被拒)
    // 会被静默吞掉,channel 开着却永无数据 → 前端空白闪光标、永不自愈(分屏复用同一 session 时
    // 尤其常见)。发送本身失败(传输层)仍即时返回 Err。
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;

    // Per-session nonce gates the OSC 633;E sequences so only our injected
    // shell-integration hooks are trusted as command-audit sources.
    let nonce = format!("{:016x}", rand::random::<u64>());
    // Inject the shell-integration bootstrap once into the live shell.
    channel
        .data(shell_integration::bootstrap_line(&nonce).as_bytes())
        .await
        .ok();

    let chan_id = CHAN_IDS.next();
    // Subscribe (web head) BEFORE spawning the owner task, so no early frame is dropped.
    on_open(&chan_id);
    let evt = format!("term://{chan_id}");
    let history_evt = format!("history://{session_id}");
    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    sess.lock().await.insert_term(chan_id.clone(), tx);

    let sess_for_owner = sess.clone();
    let chan_for_owner = chan_id.clone();
    tokio::spawn(async move {
        let mut scanner = osc::Scanner::new(nonce);
        // Audit state for the in-flight command.
        let mut cur_cmd: Option<String> = None;
        let mut cur_cwd = String::new();
        let mut cur_start = std::time::Instant::now();
        // Mute phase: from connect we drop visible output until shell integration
        // is live (first OSC marker arrives = first prompt reached). This swallows
        // the echoed bootstrap line (the base64 blob + eval) that the remote shell
        // echoes back before the first prompt. NOTE: any MOTD/banner printed in
        // these first moments is also suppressed — acceptable tradeoff for hiding
        // the injected bootstrap. A 3s fallback unmutes shells WITHOUT integration
        // (no markers ever arrive) so they aren't blank forever.
        let mut muted = true;
        // Backend dedup: the last command we actually emitted + when. If the shell
        // spews extra command/exit markers for ONE user command (duplicate ids),
        // we collapse identical consecutive commands within a short window. A human
        // cannot retype the exact same command within 800ms, so this is safe.
        let mut last_emit: Option<(String, std::time::Instant)> = None;
        // 定时器解除 mute 后补发回车,其回显的前导换行需在首批输出里剥掉(见 emit_scanned)。
        let mut strip_lead_nl = false;
        let started = std::time::Instant::now();
        // mute 兜底定时器。此前解除 mute 的 fallback 判定只在「收到数据」时(emit_scanned
        // 内)进行;不带 shell-integration 的 shell(如 ESXi 的 ash 永不发 OSC marker)发完
        // 初始提示符+引导回显便沉默,没有新数据触发判定 → mute 永不解除、终端一直空白,
        // 用户在空白里打的字还会进远端缓冲(mute 只挡显示不挡发送),造成命令拼接错乱。
        // 改用独立定时器:到点必解除;且这类 shell 不会自行重绘被丢弃的初始提示符,故解除
        // 时补发一个回车,促其打印一个干净的新提示符。bash 等会更早因 OSC marker 解除
        // (muted 已为 false),到点时不补回车,行为不变。
        let mute_fallback = tokio::time::sleep(std::time::Duration::from_millis(MUTE_FALLBACK_MS));
        tokio::pin!(mute_fallback);
        let mut fallback_fired = false;
        // 合帧待发缓冲:emit_scanned 把可见字节攒进这里,由 flush_tick 定时或控制帧即时 flush。
        let mut pending: Vec<u8> = Vec::new();
        let mut flush_tick =
            tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
        // 落后不追补:定时器只为「攒批到点就发」,错过的 tick 无需补发,避免突发时空转。
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = flush_tick.tick() => {
                    flush_pending(sink.as_ref(), &evt, &mut pending, false);
                }
                _ = &mut mute_fallback, if !fallback_fired => {
                    fallback_fired = true;
                    if muted {
                        muted = false;
                        // 非集成 shell:补发回车,让其显示一个干净提示符;并标记下一批输出
                        // 剥掉该回车回显出来的前导换行,避免提示符前多一个空行。
                        strip_lead_nl = true;
                        let _ = channel.data(&b"\r"[..]).await;
                    }
                }
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        emit_scanned(
                            sink.as_ref(), &evt, &history_evt, &host, &mut scanner, data,
                            &mut cur_cmd, &mut cur_cwd, &mut cur_start,
                            &mut muted, &started, &mut last_emit, &mut strip_lead_nl,
                            &mut pending,
                        );
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        emit_scanned(
                            sink.as_ref(), &evt, &history_evt, &host, &mut scanner, data,
                            &mut cur_cmd, &mut cur_cwd, &mut cur_start,
                            &mut muted, &started, &mut last_emit, &mut strip_lead_nl,
                            &mut pending,
                        );
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        flush_pending(sink.as_ref(), &evt, &mut pending, false);
                        sink.emit(&evt, serde_json::json!({ "closed": true }));
                        break;
                    }
                    // 服务器拒绝 pty/shell 请求(want_reply=true 才会收到)。此前落入 `_ => {}`
                    // 被静默吞掉 → channel 开着却无数据、前端空白闪光标永不自愈。改为把明确原因
                    // 写进终端并关闭,让失败可见而非假装连上。OpenFailure 同理(资源不足/达上限)。
                    Some(ChannelMsg::Failure) => {
                        let msg = "\r\n\x1b[31m[无法打开终端:服务器拒绝了 shell/PTY 请求(可能已达 sshd MaxSessions 上限,请调大服务器 MaxSessions 或减少同一连接的分屏数)]\x1b[0m\r\n";
                        sink.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(msg.as_bytes()) }));
                        sink.emit(&evt, serde_json::json!({ "closed": true }));
                        break;
                    }
                    Some(ChannelMsg::OpenFailure(reason)) => {
                        let msg = format!("\r\n\x1b[31m[无法打开终端通道:服务器拒绝(原因 {reason:?})]\x1b[0m\r\n");
                        sink.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(msg.as_bytes()) }));
                        sink.emit(&evt, serde_json::json!({ "closed": true }));
                        break;
                    }
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(TermCmd::Write(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            flush_pending(sink.as_ref(), &evt, &mut pending, false);
                            sink.emit(&evt, serde_json::json!({ "closed": true }));
                            break;
                        }
                    }
                    Some(TermCmd::Resize(c, r)) => {
                        if channel.window_change(c, r, 0, 0).await.is_err() {
                            flush_pending(sink.as_ref(), &evt, &mut pending, false);
                            sink.emit(&evt, serde_json::json!({ "closed": true }));
                            break;
                        }
                    }
                    Some(TermCmd::Close) | None => { let _ = channel.eof().await; break; }
                },
            }
        }
        sess_for_owner.lock().await.remove_term(&chan_for_owner);
    });
    Ok(chan_id)
}

/// Feed server bytes through the OSC scanner: forward the visible (stripped)
/// bytes to xterm via `term://`, and drive the command-audit state machine,
/// emitting `history://{sessionId}` on each completed command.
#[allow(clippy::too_many_arguments)]
fn emit_scanned(
    sink: &dyn EventSink,
    evt: &str,
    history_evt: &str,
    host: &str,
    scanner: &mut osc::Scanner,
    data: &[u8],
    cur_cmd: &mut Option<String>,
    cur_cwd: &mut String,
    cur_start: &mut std::time::Instant,
    muted: &mut bool,
    started: &std::time::Instant,
    last_emit: &mut Option<(String, std::time::Instant)>,
    strip_lead_nl: &mut bool,
    pending: &mut Vec<u8>,
) {
    let (mut visible, events, ready_offset) = scanner.feed(data);
    // Decide whether to show this batch's visible bytes.
    if *muted {
        // 只在收到「我们自己的、带 nonce 的就绪哨兵」(633;P;CatioReady=<nonce>)时解除 mute。
        // 关键:不能用「任意 633/133 marker」判断——很多主机(尤其 AI 开发机)已装了 VS Code
        // Remote 等自带 shell-integration,其登录首个 prompt 就带 OSC 633 标记。若见到任意标记
        // 就解除 mute,主机自带的标记会在我们的 bootstrap 回显到达之前解除 mute → 整段 base64
        // 引导回显全部泄漏到终端(用户报告的现象)。哨兵由我们的 bootstrap 在 hook 装好后发出、
        // 用 nonce 门控,主机自带集成无法伪造,故是唯一可信的「我方集成已生效」信号。
        if let Some(off) = ready_offset {
            *muted = false;
            // 哨兵之前的 visible 是集成生效前的输出——被 PTY 回显的 bootstrap 引导行(base64
            // 分块 + eval)以及可能的 MOTD。当这些回显与哨兵攒进同一批发回时,按哨兵边界精确
            // 切割:丢弃哨兵之前的噪声,只保留其后的干净 prompt,不依赖服务端分批时序。
            visible.drain(..off);
        } else if started.elapsed() > std::time::Duration::from_millis(MUTE_FALLBACK_MS) {
            // 无我方集成的 shell(如 ESXi ash,eval 得空串、不发哨兵)靠 3s 兜底解除 mute。
            *muted = false;
        }
    }
    // Does this batch contain a prompt-end / input-start marker? If so we want to
    // tag it onto the visible frame (when there is one) so the frontend writes the
    // prompt bytes BEFORE capturing the input-start cursor position.
    let has_input_start = events.iter().any(|e| matches!(e, osc::OscEvent::InputStart));
    let mut input_start_emitted = false;
    // 剥掉「定时器解除 mute 时补发的回车」回显出来的前导换行(ash 对空回车回 `\r\n`+提示符),
    // 否则提示符前会多出一个空行。仅在补回车后的首批可见输出生效,见到真实内容即停止。
    if *strip_lead_nl && !visible.is_empty() {
        let skip = visible
            .iter()
            .take_while(|&&b| b == b'\r' || b == b'\n')
            .count();
        if skip > 0 {
            visible.drain(..skip);
        }
        if !visible.is_empty() {
            *strip_lead_nl = false;
        }
    }
    if !*muted && !visible.is_empty() {
        // 攒进 pending;本批含 inputStart 时连同已攒批数据一起立即 flush 并挂标志(提示符字节
        // 写完前端才 beginInputCapture,保证 startCol 记在输入起点)。无标志则等定时器合帧。
        pending.extend_from_slice(&visible);
        if has_input_start {
            flush_pending(sink, evt, pending, true);
            input_start_emitted = true;
        }
    }
    // Always process events for the audit state machine regardless of mute.
    for ev in events {
        match ev {
            osc::OscEvent::CommandLine(c) => {
                *cur_cmd = Some(c);
                *cur_start = std::time::Instant::now();
            }
            osc::OscEvent::Cwd(d) => {
                *cur_cwd = d;
            }
            osc::OscEvent::InputStart => {
                // 没有可见帧可搭载时:先 flush 已攒批数据(带 inputStart 标志),把标志挂在最后
                // 一段可见字节上;pending 为空则单发 { inputStart: true }。(一批内多个 InputStart
                // 折叠成一次——标志对 UI 幂等。)
                if !input_start_emitted {
                    flush_pending(sink, evt, pending, true);
                    input_start_emitted = true;
                }
            }
            osc::OscEvent::ExecStart => {
                // 命令已提交:先 flush 残留可见字节保证顺序,再发 execStart(前端据此清输入捕获)。
                flush_pending(sink, evt, pending, false);
                sink.emit(evt, serde_json::json!({ "execStart": true }));
            }
            osc::OscEvent::ExecEnd(code) => {
                if let Some(cmd) = cur_cmd.take() {
                    // Definitive dedup: skip emitting if this is the same command we
                    // just emitted within the dedup window (the shell emitted extra
                    // markers for one user command). Still clears cur_cmd above.
                    if is_duplicate_emit(last_emit, &cmd) {
                        continue;
                    }
                    let dur = cur_start.elapsed().as_millis() as u64;
                    sink.emit(
                        history_evt,
                        serde_json::json!({
                            "id": HIST_IDS.next(),
                            "command": cmd,
                            "exitCode": code,
                            "cwd": *cur_cwd,
                            "durationMs": dur,
                            "host": host,
                        }),
                    );
                    *last_emit = Some((cmd, std::time::Instant::now()));
                }
            }
            // Ready is consumed by the mute logic above (via ready_offset); it is
            // not a command-audit event and carries no history/UI side effect here.
            osc::OscEvent::Ready => {}
        }
    }
}

/// 向终端写入字节（base64 编码的击键/粘贴数据）。
#[tauri::command]
pub async fn term_write(
    session_id: String,
    chan_id: String,
    data_base64: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    term_write_core(&mgr, &session_id, &chan_id, &data_base64).await
}

/// Transport-agnostic terminal write — shared by the Tauri command and the web WS handler.
pub async fn term_write_core(
    mgr: &SessionManager,
    session_id: &str,
    chan_id: &str,
    data_base64: &str,
) -> Result<(), SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    let bytes = B64
        .decode(data_base64.as_bytes())
        .map_err(|e| SshError::Io(e.to_string()))?;
    let tx = sess
        .lock()
        .await
        .get_term(chan_id)
        .ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Write(bytes))
        .map_err(|_| SshError::ChannelClosed)
}

/// 调整终端窗口大小。
#[tauri::command]
pub async fn term_resize(
    session_id: String,
    chan_id: String,
    cols: u32,
    rows: u32,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    term_resize_core(&mgr, &session_id, &chan_id, cols, rows).await
}

/// Transport-agnostic terminal resize — shared by the Tauri command and the web WS handler.
pub async fn term_resize_core(
    mgr: &SessionManager,
    session_id: &str,
    chan_id: &str,
    cols: u32,
    rows: u32,
) -> Result<(), SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    let tx = sess
        .lock()
        .await
        .get_term(chan_id)
        .ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Resize(cols, rows))
        .map_err(|_| SshError::ChannelClosed)
}

/// 关闭终端 channel：从会话表移除并通知 owner 任务发 EOF 后退出。
#[tauri::command]
pub async fn term_close(
    session_id: String,
    chan_id: String,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<(), SshError> {
    term_close_core(&mgr, &session_id, &chan_id).await
}

/// Transport-agnostic terminal close — shared by the Tauri command and the web WS handler.
pub async fn term_close_core(
    mgr: &SessionManager,
    session_id: &str,
    chan_id: &str,
) -> Result<(), SshError> {
    let sess = mgr
        .get(session_id)
        .await
        .ok_or_else(|| SshError::NotFound(session_id.to_string()))?;
    if let Some(tx) = sess.lock().await.remove_term(chan_id) {
        let _ = tx.send(TermCmd::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn dedup_skips_identical_command_in_window() {
        let last = Some(("ls -la".to_string(), Instant::now()));
        // Same command, just emitted → duplicate.
        assert!(is_duplicate_emit(&last, "ls -la"));
        // Different command → not a duplicate.
        assert!(!is_duplicate_emit(&last, "pwd"));
        // Nothing emitted yet → not a duplicate.
        assert!(!is_duplicate_emit(&None, "ls -la"));
    }

    #[test]
    fn dedup_allows_identical_command_after_window() {
        // An emission older than the dedup window must NOT be treated as a dup.
        let stale = Instant::now() - Duration::from_millis(DEDUP_WINDOW_MS + 50);
        let last = Some(("ls -la".to_string(), stale));
        assert!(!is_duplicate_emit(&last, "ls -la"));
    }

    /// 捕获型 sink:把 emit 的 (topic, payload) 存起来供断言。
    #[derive(Default)]
    struct CapturingSink(std::sync::Mutex<Vec<(String, serde_json::Value)>>);
    impl crate::events::EventSink for CapturingSink {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((topic.to_string(), payload));
        }
    }

    /// 用一批数据驱动 emit_scanned,返回该批发往 `term://` 事件的 visible 字节(拼接)。
    fn run_batch(sink: &CapturingSink, evt: &str, scanner: &mut osc::Scanner, muted: &mut bool, started: &std::time::Instant, data: &[u8]) -> Vec<u8> {
        let mut cur_cmd = None;
        let mut cur_cwd = String::new();
        let mut cur_start = std::time::Instant::now();
        let mut last_emit = None;
        let mut strip_lead_nl = false;
        let mut pending: Vec<u8> = Vec::new();
        let before = sink.0.lock().unwrap().len();
        emit_scanned(
            sink, evt, "history://s", "host", scanner, data,
            &mut cur_cmd, &mut cur_cwd, &mut cur_start,
            muted, started, &mut last_emit, &mut strip_lead_nl,
            &mut pending,
        );
        // 合帧后可见字节可能仍在 pending(无 inputStart/execStart 触发即时 flush 时),
        // 补一次 flush 复刻 owner task 的定时器行为,让断言读得到本批可见字节。
        flush_pending(sink, evt, &mut pending, false);
        let frames = sink.0.lock().unwrap();
        let mut out = Vec::new();
        for (topic, payload) in frames[before..].iter() {
            if topic == evt {
                if let Some(b64) = payload.get("bytesBase64").and_then(|v| v.as_str()) {
                    out.extend(B64.decode(b64).unwrap());
                }
            }
        }
        out
    }

    #[test]
    fn same_batch_echo_and_ready_hides_bootstrap_noise() {
        // 根因回归:当 PTY 回显的 bootstrap 引导行(base64 分块)、主机自带集成的 633 标记、
        // 与我方就绪哨兵落在同一批(首次连接常见),解除 mute 时必须只显示哨兵之后的干净 prompt,
        // 丢弃哨兵之前的一切噪声。此前「见任意 633 就解除 mute」会让主机自带标记提前解除 →
        // 整段 base64 回显泄漏(用户报告的现象)。
        let sink = CapturingSink::default();
        let mut scanner = osc::Scanner::new("N");
        let mut muted = true;
        let started = std::time::Instant::now();
        // 主机自带集成先发 633;A(不应解除 mute),接着是回显噪声,最后我方哨兵 + 干净 prompt。
        let batch = b"\x1b]633;A\x07 __c=\"$__c\"'QUJD'\r\n eval \"...\"\r\n\x1b]633;P;CatioReady=N\x07admin@spark:~$ ";
        let visible = run_batch(&sink, "term://c1", &mut scanner, &mut muted, &started, batch);
        assert!(!muted, "收到我方就绪哨兵后必须解除 mute");
        assert_eq!(
            String::from_utf8_lossy(&visible),
            "admin@spark:~$ ",
            "只应显示哨兵之后的干净 prompt,回显噪声与主机自带标记之后的内容必须被丢弃"
        );
    }

    #[test]
    fn host_own_marker_does_not_unmute() {
        // 主机自带 shell-integration 的 633 标记(无我方 nonce 的哨兵)绝不能解除 mute,
        // 否则其登录首个 prompt 的标记会在我方 bootstrap 回显到达前解除 mute → 噪声泄漏。
        let sink = CapturingSink::default();
        let mut scanner = osc::Scanner::new("N");
        let mut muted = true;
        let started = std::time::Instant::now();
        // 一批含主机自带的 prompt-start/exec 标记 + 回显,但无我方哨兵。
        let batch = b"\x1b]633;A\x07host$ \x1b]633;C\x07 __c=\"$__c\"'QUJD'\r\n";
        let visible = run_batch(&sink, "term://c1", &mut scanner, &mut muted, &started, batch);
        assert!(muted, "无我方哨兵时必须保持 mute");
        assert!(visible.is_empty(), "mute 阶段不应显示任何回显噪声");
    }

    #[test]
    fn muted_batch_before_ready_shows_nothing() {
        // 哨兵到达之前的纯噪声批:整批处于 mute,不应显示任何字节。
        let sink = CapturingSink::default();
        let mut scanner = osc::Scanner::new("N");
        let mut muted = true;
        let started = std::time::Instant::now();
        let visible = run_batch(&sink, "term://c1", &mut scanner, &mut muted, &started, b" __c=\"$__c\"'QUJD'\r\n");
        assert!(muted, "无哨兵时仍处于 mute");
        assert!(visible.is_empty(), "mute 阶段不应显示任何回显噪声");
    }
}
