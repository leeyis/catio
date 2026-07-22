//! 非 SSH 终端：本地 shell（portable-pty）、串口（serialport）、Telnet（raw TCP）。
//!
//! 复用 SSH 终端与前端之间的同一套协议：服务端字节经 `term://<chan_id>` 事件流向前端
//! （payload `{ "bytesBase64": "<base64>" }`，关闭时 `{ "closed": true }`），用户输入/缩放/
//! 关闭经 [`TermCmd`] 指令。区别仅在数据源不依赖 SSH 会话——按 chan_id 挂在独立的
//! [`LocalTermManager`] 上。
//!
//! 每个终端：一个**阻塞读线程**（数据源 → emit）+ 一个 **tokio 命令任务**（写/缩放/关闭）。
//! 任一端结束都会驱动另一端退出并从注册表自清理，杜绝僵尸终端与句柄滞留。

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::ssh::ids::IdGen;
use crate::ssh::term::TermCmd;
use crate::ssh::SshError;

static CHAN_IDS: IdGen = IdGen::new("lterm");
/// 本地终端历史事件的进程内单调 id(供前端去重),与 SSH 的 HIST_IDS 独立。
static LOCAL_HIST_IDS: IdGen = IdGen::new("lhist");

/// 一个终端在注册表里的句柄：指令发送端 + 「前端就绪」标志（读线程在它置位前不开读，
/// 避免首屏输出落在前端注册监听之前被丢弃）。
struct TermHandle {
    tx: UnboundedSender<TermCmd>,
    ready: Arc<AtomicBool>,
}

/// 非 SSH 终端注册表：chan_id → 句柄。以 Tauri State 形式挂在 app 上。
#[derive(Default)]
pub struct LocalTermManager {
    terms: Mutex<HashMap<String, TermHandle>>,
}

impl LocalTermManager {
    fn insert(&self, id: String, tx: UnboundedSender<TermCmd>, ready: Arc<AtomicBool>) {
        self.terms.lock().unwrap().insert(id, TermHandle { tx, ready });
    }
    fn get_tx(&self, id: &str) -> Option<UnboundedSender<TermCmd>> {
        self.terms.lock().unwrap().get(id).map(|h| h.tx.clone())
    }
    fn set_ready(&self, id: &str) {
        if let Some(h) = self.terms.lock().unwrap().get(id) {
            h.ready.store(true, Ordering::Relaxed);
        }
    }
    fn remove(&self, id: &str) -> Option<UnboundedSender<TermCmd>> {
        self.terms.lock().unwrap().remove(id).map(|h| h.tx)
    }
}

type ResizeFn = Box<dyn FnMut(u32, u32) + Send>;
type CloseFn = Box<dyn FnOnce() + Send>;

fn emit_local_scanned(
    sink: &dyn crate::events::EventSink,
    evt: &str,
    history_evt: &str,
    scanner: &mut crate::ssh::osc::Scanner,
    data: &[u8],
    cur_cmd: &mut Option<String>,
    cur_start: &mut Instant,
) {
    use crate::ssh::osc::OscEvent;

    let (visible, events, _) = scanner.feed(data);
    let mut visible_pos = 0;
    for positioned in events {
        let event_pos = positioned.visible_offset.min(visible.len());
        let before = &visible[visible_pos..event_pos];
        let input_start = matches!(&positioned.event, OscEvent::InputStart);
        if !before.is_empty() {
            let mut frame = serde_json::json!({ "bytesBase64": B64.encode(before) });
            if input_start { frame["inputStart"] = serde_json::Value::Bool(true); }
            sink.emit(evt, frame);
        } else if input_start {
            sink.emit(evt, serde_json::json!({ "inputStart": true }));
        }
        visible_pos = event_pos;

        match positioned.event {
            OscEvent::CommandLine(c) => { *cur_cmd = Some(c); *cur_start = Instant::now(); }
            OscEvent::ExecStart => sink.emit(evt, serde_json::json!({ "execStart": true })),
            OscEvent::ExecEnd(code) => {
                if let Some(cmd) = cur_cmd.take() {
                    sink.emit(evt, serde_json::json!({
                        "execEnd": true,
                        "command": &cmd,
                        "exitCode": code,
                    }));
                    sink.emit(history_evt, serde_json::json!({
                        "id": LOCAL_HIST_IDS.next(),
                        "command": cmd,
                        "exitCode": code,
                        "cwd": "",
                        "durationMs": cur_start.elapsed().as_millis() as u64,
                        "host": "local",
                    }));
                }
            }
            OscEvent::InputStart | OscEvent::Cwd(_) | OscEvent::Ready => {}
        }
    }
    if visible_pos < visible.len() {
        sink.emit(evt, serde_json::json!({ "bytesBase64": B64.encode(&visible[visible_pos..]) }));
    }
}

/// 启动一个终端 owner。
/// - 阻塞读线程：先等 `ready`（最多 2s 兜底）再读，把字节 emit 给前端；读到 EOF/错误时发
///   `{closed:true}` 并通过 `eof_tx` 通知 owner 退出。串口读带超时，TimedOut/WouldBlock 续轮询。
/// - tokio 命令任务：消费 [`TermCmd`] 写入/缩放/关闭；退出时置 `stop`、调用 `closer` 拆除底层
///   资源（杀子进程 / shutdown socket），并从注册表移除自己 —— 故源端先死也能完整回收。
#[allow(clippy::too_many_arguments)]
fn spawn_terminal(
    app: tauri::AppHandle,
    chan_id: String,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    mut resize: ResizeFn,
    closer: CloseFn,
    eof_tx: UnboundedSender<TermCmd>,
    ready: Arc<AtomicBool>,
    mut rx: UnboundedReceiver<TermCmd>,
    // 本地 shell 命令审计:Some(nonce) 时读线程过 OSC 扫描器抽命令、emit history://<chanId>。
    // 关键:集成脚本由 shell 经 ZDOTDIR/rcfile 自己 source(不碰 stdin)→ 无引导回显 →
    // **不 mute**,可见字节始终原样 emit,故绝不会像上次那样黑屏。None 时走纯字节直传。
    audit_nonce: Option<String>,
) {
    let evt = format!("term://{chan_id}");
    let stop = Arc::new(AtomicBool::new(false));

    // 阻塞读线程。
    {
        let evt = evt.clone();
        let app = app.clone();
        let stop = stop.clone();
        let chan_id = chan_id.clone();
        std::thread::spawn(move || {
            // 等前端注册好 `term://` 监听（term_local_ready 置位）；2s 兜底防止前端异常时永久阻塞。
            let start = Instant::now();
            while !ready.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(5));
            }
            let mut buf = [0u8; 8192];
            // 命令审计状态(仅 audit_nonce 为 Some 时使用)。
            let mut scanner = audit_nonce.as_ref().map(|n| crate::ssh::osc::Scanner::new(n.clone()));
            let history_evt = format!("history://{chan_id}");
            let mut cur_cmd: Option<String> = None;
            let mut cur_start = Instant::now();
            let sink = crate::events::TauriSink(app.clone());
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(sc) = scanner.as_mut() {
                            emit_local_scanned(
                                &sink, &evt, &history_evt, sc,
                                &buf[..n], &mut cur_cmd, &mut cur_start,
                            );
                        } else {
                            // 纯字节直传(串口/Telnet/Mosh/非 zsh|bash 本地 shell)。
                            let _ = app.emit(&evt, serde_json::json!({ "bytesBase64": B64.encode(&buf[..n]) }));
                        }
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => continue,
                    Err(_) => break,
                }
            }
            let _ = app.emit(&evt, serde_json::json!({ "closed": true }));
            // 通知 owner 退出并自清理（owner 若已先退出，send 失败无副作用）。
            let _ = eof_tx.send(TermCmd::Close);
        });
    }

    // 命令任务。
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                TermCmd::Write(bytes) => {
                    let _ = writer.write_all(&bytes);
                    let _ = writer.flush();
                }
                TermCmd::Resize(c, r) => resize(c, r),
                TermCmd::Close => break,
            }
        }
        stop.store(true, Ordering::Relaxed);
        closer();
        // 从注册表移除自己（幂等：前端 close 已先移除时返回 None）。
        app.state::<LocalTermManager>().remove(&chan_id);
    });
}

/// 平台默认 shell。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// 本地 shell 命令审计支持的 shell 类型。仅 zsh / bash 能装 hook；其它(fish/sh/…)
/// 走 `Other` —— 不注入,终端照常工作,只是没有命令历史(降级安全)。
#[cfg(not(windows))]
#[derive(Debug, PartialEq, Clone, Copy)]
enum LocalShellKind {
    Zsh,
    Bash,
    Other,
}

/// 从 shell 可执行路径判定类型(按 basename 匹配,忽略路径与版本后缀)。
#[cfg(not(windows))]
fn classify_shell(shell_path: &str) -> LocalShellKind {
    let base = shell_path.rsplit('/').next().unwrap_or(shell_path);
    if base.contains("zsh") {
        LocalShellKind::Zsh
    } else if base.contains("bash") {
        LocalShellKind::Bash
    } else {
        LocalShellKind::Other
    }
}

/// 生成「本地 shell-integration」rc 脚本内容。与 SSH 的 `bootstrap_line` 不同:这份由
/// shell 通过 ZDOTDIR(zsh) / --rcfile(bash) **自己 source**,绝不写入 stdin,因此:
///   * 无引导回显 → 无需 mute(上次全黑的根因正是 stdin 注入 + mute)。
///   * 先 source 用户真实 rc 再追加 hook,不影响用户环境。
/// hook 发 OSC 633:preexec `E;<cmd>;<nonce>` + `C`,precmd `D;<exit>`;由 `osc::Scanner`
/// (nonce 门控)剥离并抽成命令审计。`nonce` 防止用户自有集成的 633 序列被误当作我方命令。
#[cfg(not(windows))]
fn local_integration_rc(kind: LocalShellKind, nonce: &str, user_rc_source: &str) -> String {
    match kind {
        LocalShellKind::Zsh => format!(
            r#"# --- catio local shell-integration (auto-generated) ---
{user_rc_source}
__catio_n='{nonce}'
__catio_esc() {{ local s=${{1//\\/\\\\}}; s=${{s//;/\\x3b}}; s=${{s//$'\n'/\\x0a}}; print -rn -- "$s"; }}
__catio_pe() {{ print -rn -- $'\e]633;E;'"$(__catio_esc "$1")"';'"$__catio_n"$'\a\e]633;C;'"$__catio_n"$'\a'; }}
__catio_pc() {{ local e=$?; print -rn -- $'\e]633;D;'"$e"';'"$__catio_n"$'\a'; }}
autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook preexec __catio_pe
add-zsh-hook precmd __catio_pc
# 给 PS1 追加 OSC 633;B(输入起点标记),使前端在提示符结束处捕获当前输入、驱动历史候选。
# %{{...%}} 是 zsh 的「零宽」包裹,避免标记占用可见列。幂等:已含则不重复追加。
case "$PS1" in *'633;B'*) ;; *) PS1="$PS1"$'%{{\e]633;B\a%}}';; esac
# hook 已装好:还原 ZDOTDIR 到用户 HOME,使子 shell 走用户正常配置(不重复注入)。
export ZDOTDIR="$HOME"
"#
        ),
        LocalShellKind::Bash => format!(
            r#"# --- catio local shell-integration (auto-generated) ---
{user_rc_source}
__catio_n='{nonce}'
__catio_esc() {{ local s=${{1//\\/\\\\}}; s=${{s//;/\\x3b}}; s=${{s//$'\n'/\\x0a}}; printf '%s' "$s"; }}
__catio_in=0
__catio_pe() {{ case "$BASH_COMMAND" in __catio_*) return;; esac; if [ "$__catio_in" = 0 ]; then __catio_in=1; local c; c=$(builtin history 1 | sed 's/ *[0-9][0-9]* *//'); printf '\e]633;E;%s;%s\a\e]633;C;%s\a' "$(__catio_esc "$c")" "$__catio_n" "$__catio_n"; fi; }}
__catio_pc() {{ local e=$?; __catio_in=0; printf '\e]633;D;%s;%s\a' "$e" "$__catio_n"; }}
trap '__catio_pe' DEBUG
case "${{PROMPT_COMMAND:-}}" in *__catio_pc*) ;; *) PROMPT_COMMAND="__catio_pc${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}";; esac
# 给 PS1 追加 OSC 633;B(输入起点标记)。\[...\] 是 bash 的「零宽」包裹,避免占用可见列。幂等。
case "$PS1" in *'633;B'*) ;; *) PS1="$PS1"'\[\e]633;B\a\]';; esac
"#
        ),
        LocalShellKind::Other => String::new(),
    }
}

/// macOS GUI app 由 launchd 赋予的 PATH 通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`,
/// 不含 Homebrew / Docker / Colima 等 CLI 目录。虽然以 login shell 启动会加载用户
/// profile 补齐 PATH,但用户未在 profile 里配置时仍会缺失。这里把常见目录合并进
/// 现有 PATH(保序、去重、原有目录优先),作为兜底。返回合并后的 PATH 字符串。
///
/// 纯函数便于单测:`current` 为进程当前 PATH,`extra` 为要补充的目录。
#[cfg(not(windows))]
fn merge_path(current: &str, extra: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    // 现有目录优先(用户/系统已有的解析顺序保持不变)。
    for dir in current.split(':').chain(extra.iter().copied()) {
        if dir.is_empty() || !seen.insert(dir) {
            continue;
        }
        out.push(dir);
    }
    out.join(":")
}

/// macOS 上常见但 GUI PATH 里缺失的 CLI 目录(Homebrew arm64/x86_64 + 常见本地 bin)。
#[cfg(target_os = "macos")]
const MACOS_EXTRA_PATH: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
}

/// 在本地 PTY 里跑给定命令，接到终端 owner。供本地 shell / mosh 共用。
fn open_pty_terminal(
    cmd: portable_pty::CommandBuilder,
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: &LocalTermManager,
    // 本地 shell 命令审计 nonce(Some→读线程扫描 emit 历史);其它终端传 None。
    audit_nonce: Option<String>,
    // 临时 ZDOTDIR/rcfile 目录:终端关闭时删除(best-effort);无则 None。
    cleanup_dir: Option<std::path::PathBuf>,
) -> Result<String, SshError> {
    use portable_pty::{native_pty_system, PtySize};

    let size = PtySize { rows: rows as u16, cols: cols as u16, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| SshError::Io(e.to_string()))?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| SshError::Io(e.to_string()))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| SshError::Io(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| SshError::Io(e.to_string()))?;
    let master = pair.master;
    let resize: ResizeFn = Box::new(move |c, r| {
        let _ = master.resize(PtySize { rows: r as u16, cols: c as u16, pixel_width: 0, pixel_height: 0 });
    });
    // kill + wait：避免 Unix 僵尸进程；并确保 slave 关闭后 master 读到 EOF 让读线程退出。
    // 收尾时删除临时 ZDOTDIR 目录(若有)。
    let closer: CloseFn = Box::new(move || {
        let _ = child.kill();
        let _ = child.wait();
        if let Some(dir) = cleanup_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    });

    Ok(launch(app, reader, writer, resize, closer, mgr, audit_nonce))
}

/// 为 zsh/bash 搭建「命令审计」环境,**不碰 stdin**:
///   * zsh:建临时 ZDOTDIR 目录,写 `.zshrc`(先 source 用户 `~/.zshrc` 再追加 hook)与
///     `.zshenv`(还原 ZDOTDIR=用户 HOME + source 用户 `~/.zshenv`,使嵌套 shell/env 正常)。
///   * bash:写临时 rcfile(先 source `~/.bashrc` 再追加 hook),用 `--rcfile` 传入。
/// 成功返回 `(nonce, 临时目录, 是否已通过 --rcfile 设置好 cmd)`;shell 不支持则返回 None
/// (调用方走裸 PTY,无历史)。任何 IO 失败也返回 None(降级,绝不阻断开终端)。
#[cfg(not(windows))]
fn setup_local_audit(
    cmd: &mut portable_pty::CommandBuilder,
    shell_path: &str,
) -> Option<(String, std::path::PathBuf)> {
    let kind = classify_shell(shell_path);
    if kind == LocalShellKind::Other {
        return None;
    }
    let home = home_dir()?;
    let nonce = format!("{:016x}", rand::random::<u64>());
    // 唯一临时目录:catio-term-<nonce>。
    let dir = std::env::temp_dir().join(format!("catio-term-{nonce}"));
    std::fs::create_dir_all(&dir).ok()?;

    match kind {
        LocalShellKind::Zsh => {
            // .zshrc:先 source 用户真实 rc,再装 hook。用户 rc 缺失时 source 静默失败无碍。
            let user_rc = format!("[ -f \"{home}/.zshrc\" ] && source \"{home}/.zshrc\"");
            let rc = local_integration_rc(LocalShellKind::Zsh, &nonce, &user_rc);
            std::fs::write(dir.join(".zshrc"), rc).ok()?;
            // .zshenv:zsh 启动最先读它(在 .zshrc 之前)。关键:这里**绝不能**重置 ZDOTDIR——
            // 否则 .zshrc 会从用户 HOME 读、我们的 hook 脚本(在临时 .zshrc)永不加载。仅 source
            // 用户 .zshenv 补齐环境(因 ZDOTDIR 指向临时目录,zsh 不会自动读用户 ~/.zshenv)。
            // ZDOTDIR 的还原放在 .zshrc 末尾(hook 装好之后)。
            let zshenv = format!("[ -f \"{home}/.zshenv\" ] && source \"{home}/.zshenv\"\n");
            std::fs::write(dir.join(".zshenv"), zshenv).ok()?;
            cmd.env("ZDOTDIR", dir.to_string_lossy().to_string());
            Some((nonce, dir))
        }
        LocalShellKind::Bash => {
            let user_rc = format!("[ -f \"{home}/.bashrc\" ] && source \"{home}/.bashrc\"");
            let rc = local_integration_rc(LocalShellKind::Bash, &nonce, &user_rc);
            let rcfile = dir.join("bashrc");
            std::fs::write(&rcfile, rc).ok()?;
            cmd.arg("--rcfile");
            cmd.arg(rcfile.to_string_lossy().to_string());
            Some((nonce, dir))
        }
        LocalShellKind::Other => None,
    }
}

/// 打开一个本地 shell 终端（PTY）。
///
/// PATH 修复(macOS/Linux):从 Dock/Finder 启动的 GUI app 只继承 launchd 的极简 PATH,
/// 不含 Homebrew/Docker/Colima 的 CLI 目录,`docker`/`brew` 会 not found。这里把常见目录
/// 用 [`merge_path`] 并进当前 PATH(现有目录优先)交给 shell,使这些命令可用。
///
/// 命令历史(zsh/bash):经 [`setup_local_audit`] 用 ZDOTDIR/rcfile 让 shell **自己 source**
/// 集成脚本装 OSC hook(不碰 stdin、无 mute),读线程抽命令 emit `history://<chanId>`。
/// 非 zsh/bash 或搭建失败则降级为裸 PTY(无历史),终端照常可用。
#[tauri::command]
pub async fn term_open_local(
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    let shell = default_shell();
    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    // 把常见 CLI 目录合并进当前 PATH(现有目录优先),解决 GUI 启动缺 Homebrew/Docker 目录。
    #[cfg(not(windows))]
    {
        let cur = std::env::var("PATH").unwrap_or_default();
        #[cfg(target_os = "macos")]
        let merged = merge_path(&cur, MACOS_EXTRA_PATH);
        #[cfg(not(target_os = "macos"))]
        let merged = merge_path(&cur, &["/usr/local/bin", "/usr/local/sbin"]);
        cmd.env("PATH", merged);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    // 命令审计(仅非 Windows 的 zsh/bash);失败/其它 shell → None,降级裸 PTY。
    #[cfg(not(windows))]
    let (audit_nonce, cleanup_dir) = match setup_local_audit(&mut cmd, &shell) {
        Some((nonce, dir)) => (Some(nonce), Some(dir)),
        None => (None, None),
    };
    #[cfg(windows)]
    let (audit_nonce, cleanup_dir): (Option<String>, Option<std::path::PathBuf>) = (None, None);
    open_pty_terminal(cmd, cols, rows, app, &mgr, audit_nonce, cleanup_dir)
}

/// 打开一个 Mosh 终端：委托系统 `mosh` 客户端在本地 PTY 里跑 `mosh user@host`
/// （mosh 自行 SSH 起 mosh-server 再走 UDP）。需本机已安装 mosh，否则 spawn 失败回错误。
#[tauri::command]
pub async fn term_open_mosh(
    host: String,
    user: String,
    cols: u32,
    rows: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    if host.trim().is_empty() {
        return Err(SshError::Io("mosh host is empty".into()));
    }
    let target = if user.trim().is_empty() { host } else { format!("{user}@{host}") };
    let mut cmd = portable_pty::CommandBuilder::new("mosh");
    // `--` 终止 mosh 选项扫描,防止 host 以 `-` 开头被当成选项注入(如 --ssh=<cmd> 致 RCE)。
    cmd.arg("--");
    cmd.arg(target);
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    // Mosh 是远端 shell,不做本地审计 → None。
    open_pty_terminal(cmd, cols, rows, app, &mgr, None, None)
}

/// 打开一个串口终端。`baud` 波特率（常见 9600 / 115200）。
#[tauri::command]
pub async fn term_open_serial(
    port: String,
    baud: u32,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    if port.trim().is_empty() {
        return Err(SshError::Io("serial port is empty".into()));
    }
    // 50ms 读超时：无数据时 read 返回 TimedOut，使读线程能在轮询间隙感知 stop。
    let sp = serialport::new(&port, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| SshError::Io(e.to_string()))?;
    let reader = sp.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let resize: ResizeFn = Box::new(|_, _| {});
    let closer: CloseFn = Box::new(|| {}); // 串口靠 stop 标志停轮询，无需额外拆除。

    Ok(launch(app, Box::new(reader), Box::new(sp), resize, closer, &mgr, None))
}

/// 打开一个 Telnet 终端（raw TCP 透传，最小实现）。connect 走 spawn_blocking + 超时，
/// 避免不可达 host 阻塞 tokio 执行器线程。
#[tauri::command]
pub async fn term_open_telnet(
    host: String,
    port: u16,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<String, SshError> {
    use std::net::{TcpStream, ToSocketAddrs};
    if host.trim().is_empty() {
        return Err(SshError::Io("telnet host is empty".into()));
    }
    let stream = tokio::task::spawn_blocking(move || -> std::io::Result<TcpStream> {
        let addr = (host.as_str(), port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::new(ErrorKind::NotFound, "no address resolved"))?;
        TcpStream::connect_timeout(&addr, Duration::from_secs(10))
    })
    .await
    .map_err(|e| SshError::Io(e.to_string()))?
    .map_err(|e| SshError::Io(e.to_string()))?;

    let reader = stream.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let writer = stream.try_clone().map_err(|e| SshError::Io(e.to_string()))?;
    let resize: ResizeFn = Box::new(|_, _| {});
    let closer: CloseFn = Box::new(move || {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    });

    Ok(launch(app, Box::new(reader), Box::new(writer), resize, closer, &mgr, None))
}

/// 公共收尾：建 mpsc + ready 标志，spawn owner，登记注册表，返回 chan_id。
fn launch(
    app: tauri::AppHandle,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    resize: ResizeFn,
    closer: CloseFn,
    mgr: &LocalTermManager,
    audit_nonce: Option<String>,
) -> String {
    let (tx, rx) = mpsc::unbounded_channel::<TermCmd>();
    let ready = Arc::new(AtomicBool::new(false));
    let chan_id = CHAN_IDS.next();
    spawn_terminal(app, chan_id.clone(), reader, writer, resize, closer, tx.clone(), ready.clone(), rx, audit_nonce);
    mgr.insert(chan_id.clone(), tx, ready);
    chan_id
}

/// 列出系统可用串口（新建连接的串口下拉）。
#[tauri::command]
pub fn serial_list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

/// 前端注册好 `term://` 监听后调用，放行读线程开始读（避免丢首屏输出）。
#[tauri::command]
pub fn term_local_ready(chan_id: String, mgr: tauri::State<'_, LocalTermManager>) {
    mgr.set_ready(&chan_id);
}

/// 向非 SSH 终端写入字节（base64）。
#[tauri::command]
pub fn term_local_write(
    chan_id: String,
    data_base64: String,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    let bytes = B64.decode(data_base64.as_bytes()).map_err(|e| SshError::Io(e.to_string()))?;
    let tx = mgr.get_tx(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Write(bytes)).map_err(|_| SshError::ChannelClosed)
}

/// 调整非 SSH 终端窗口大小（仅本地 PTY 生效；串口/Telnet 无操作）。
#[tauri::command]
pub fn term_local_resize(
    chan_id: String,
    cols: u32,
    rows: u32,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    let tx = mgr.get_tx(&chan_id).ok_or(SshError::ChannelClosed)?;
    tx.send(TermCmd::Resize(cols, rows)).map_err(|_| SshError::ChannelClosed)
}

/// 关闭非 SSH 终端：从注册表移除并通知 owner 拆除。
#[tauri::command]
pub fn term_local_close(
    chan_id: String,
    mgr: tauri::State<'_, LocalTermManager>,
) -> Result<(), SshError> {
    if let Some(tx) = mgr.remove(&chan_id) {
        let _ = tx.send(TermCmd::Close);
    }
    Ok(())
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[derive(Default)]
    struct CapturingSink(std::sync::Mutex<Vec<(String, serde_json::Value)>>);
    impl crate::events::EventSink for CapturingSink {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((topic.to_string(), payload));
        }
    }

    #[test]
    fn local_batch_emits_lifecycle_at_the_visible_byte_boundaries() {
        let sink = CapturingSink::default();
        let mut scanner = crate::ssh::osc::Scanner::new("N");
        let mut cur_cmd = None;
        let mut cur_start = Instant::now();
        emit_local_scanned(
            &sink, "term://l1", "history://l1", &mut scanner,
            b"prompt$ \x1b]633;E;uptime;N\x07\x1b]633;C;N\x07up\r\n\x1b]633;D;0;N\x07next$ ",
            &mut cur_cmd, &mut cur_start,
        );

        let frames = sink.0.lock().unwrap();
        let term: Vec<_> = frames.iter().filter(|(topic, _)| topic == "term://l1").map(|(_, payload)| payload).collect();
        assert_eq!(B64.decode(term[0]["bytesBase64"].as_str().unwrap()).unwrap(), b"prompt$ ");
        assert_eq!(term[1]["execStart"], true);
        assert_eq!(B64.decode(term[2]["bytesBase64"].as_str().unwrap()).unwrap(), b"up\r\n");
        assert_eq!(term[3]["execEnd"], true);
        assert_eq!(B64.decode(term[4]["bytesBase64"].as_str().unwrap()).unwrap(), b"next$ ");
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{classify_shell, local_integration_rc, merge_path, LocalShellKind};

    #[test]
    fn classify_shell_matches_basename() {
        assert_eq!(classify_shell("/bin/zsh"), LocalShellKind::Zsh);
        assert_eq!(classify_shell("/opt/homebrew/bin/zsh"), LocalShellKind::Zsh);
        assert_eq!(classify_shell("/bin/bash"), LocalShellKind::Bash);
        assert_eq!(classify_shell("/usr/local/bin/bash"), LocalShellKind::Bash);
        assert_eq!(classify_shell("/usr/bin/fish"), LocalShellKind::Other);
        assert_eq!(classify_shell("/bin/sh"), LocalShellKind::Other);
    }

    #[test]
    fn local_rc_zsh_embeds_nonce_hooks_and_user_source() {
        let rc = local_integration_rc(LocalShellKind::Zsh, "NONCE123", "source ~/.zshrc");
        // 先 source 用户 rc。
        assert!(rc.contains("source ~/.zshrc"), "must source user rc first: {rc}");
        // 装 preexec/precmd hook。
        assert!(rc.contains("add-zsh-hook preexec __catio_pe"), "zsh preexec hook missing");
        assert!(rc.contains("add-zsh-hook precmd __catio_pc"), "zsh precmd hook missing");
        // nonce 门控命令序列。
        assert!(rc.contains("NONCE123"), "nonce not embedded");
        assert!(rc.contains(r#"$'\e]633;E;'"#), "OSC 633;E (command) missing");
        assert!(rc.contains(r#"$'\e]633;D;'"#), "OSC 633;D (exit) missing");
    }

    #[test]
    fn local_rc_bash_embeds_nonce_hooks_and_user_source() {
        let rc = local_integration_rc(LocalShellKind::Bash, "NONCE123", "source ~/.bashrc");
        assert!(rc.contains("source ~/.bashrc"), "must source user rc first: {rc}");
        assert!(rc.contains("trap '__catio_pe' DEBUG"), "bash DEBUG trap missing");
        assert!(rc.contains("__catio_pc"), "bash precmd missing");
        assert!(rc.contains("NONCE123"), "nonce not embedded");
        // 防自身命令进审计(镜像 SSH 端逻辑)。
        assert!(rc.contains(r#"case "$BASH_COMMAND" in __catio_*)"#), "bash self-skip guard missing");
    }

    #[test]
    fn local_rc_other_shell_is_empty() {
        // 非 zsh/bash:不注入,返回空串(终端照常,只是无历史)。
        assert_eq!(local_integration_rc(LocalShellKind::Other, "N", "src"), "");
    }

    #[test]
    fn merge_path_appends_missing_dirs_preserving_order() {
        // 现有目录保序在前,缺失的 extra 追加在后。
        let out = merge_path("/usr/bin:/bin", &["/opt/homebrew/bin", "/usr/local/bin"]);
        assert_eq!(out, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn merge_path_dedups_existing_dirs() {
        // extra 里已存在于当前 PATH 的目录不重复追加。
        let out = merge_path("/opt/homebrew/bin:/usr/bin", &["/opt/homebrew/bin", "/usr/local/bin"]);
        assert_eq!(out, "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
    }

    #[test]
    fn merge_path_skips_empty_segments() {
        // 空段(如末尾冒号/连续冒号)被丢弃,不产生空目录。
        let out = merge_path("/usr/bin::", &["/usr/local/bin"]);
        assert_eq!(out, "/usr/bin:/usr/local/bin");
    }

    #[test]
    fn merge_path_empty_current_uses_only_extra() {
        let out = merge_path("", &["/opt/homebrew/bin"]);
        assert_eq!(out, "/opt/homebrew/bin");
    }
}
