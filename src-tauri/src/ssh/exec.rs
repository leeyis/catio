//! SSH exec channel 的统一入口：**锁内只开 channel，exec/收流在锁外**。
//!
//! 根因背景：此前 `multiexec::run_on` 在整条命令期间持有会话锁
//! （`let s = sess.lock().await; run_cmd(&s.handle, cmd).await`），于是一条
//! `sleep 420` 会把同一会话的 term/sftp/tunnel/其它 exec 全部堵在锁上——
//! MCP `execute_command` 跑长命令后，后续 `echo test` 只能排队到超时。
//!
//! 本模块把开 channel 与跑命令拆开：`channel_open_session()` 必须在锁内
//! （`Handle` 不是 `Clone`，只能借），拿到 `Channel` 后立刻放锁，`exec` 与收流
//! 在锁外进行——`sftp::open_exec_channel` / `sftp_transfer::open_sftp` 已是此模式。
//!
//! 超时语义：超时后**显式 `close()`** 并有界 drain。仅 drop future 不会发
//! CHANNEL_CLOSE，远端进程继续跑、channel 残留在 russh 内部 map 与 sshd 的
//! MaxSessions 配额里（term.rs 已就同一机制留有注释）。
//!
//! [`ExecChannel`] / [`ChannelOpener`] 两个 trait 只为把上述时序做成可单测的：
//! 生产实现是 russh 的 `Channel<Msg>` / [`Session`]，测试注入假实现。

use std::time::Duration;

use async_trait::async_trait;
use russh::client::{Handle, Msg};
use russh::{Channel, ChannelMsg};
use tokio::sync::Mutex;

use crate::ssh::conn::ClientHandler;
use crate::ssh::manager::Session;
use crate::ssh::SshError;

/// 超时 close 之后继续 drain 的上限，防个别服务器不回 CHANNEL_CLOSE 时任务泄漏。
const CLOSE_DRAIN: Duration = Duration::from_secs(2);

// ─── 可注入抽象（只为把「锁内开 channel / 锁外收流」的时序做成可单测）──────────

/// 一条已打开的 exec channel。生产实现是 russh `Channel<Msg>`。
#[async_trait]
pub trait ExecChannel: Send {
    /// 发 `exec` 请求（`want_reply = true`）。
    async fn exec_cmd(&mut self, cmd: &str) -> Result<(), SshError>;
    /// 取下一条 channel 消息；`None` = 流结束。
    async fn next_msg(&mut self) -> Option<ChannelMsg>;
    /// 发 CHANNEL_CLOSE。
    async fn close_channel(&mut self) -> Result<(), SshError>;
}

/// 能开出 exec channel 的东西。**实现体在会话锁内被调用**，故必须只做开 channel
/// 这一件事——任何耗时操作放在返回的 channel 上、由调用方在锁外做。
///
/// 取 `&mut self`：`Session` 内的 `russh` `Handle` 含 `UnboundedReceiver`，非 `Sync`，
/// `&Self: Send` 不成立；而调用方本就持有 `MutexGuard`，可变借用不增加任何约束。
#[async_trait]
pub trait ChannelOpener: Send {
    type Chan: ExecChannel;
    async fn open_exec(&mut self) -> Result<Self::Chan, SshError>;
}

#[async_trait]
impl ExecChannel for Channel<Msg> {
    async fn exec_cmd(&mut self, cmd: &str) -> Result<(), SshError> {
        self.exec(true, cmd).await.map_err(|e| SshError::Io(e.to_string()))
    }
    async fn next_msg(&mut self) -> Option<ChannelMsg> {
        self.wait().await
    }
    async fn close_channel(&mut self) -> Result<(), SshError> {
        self.close().await.map_err(|e| SshError::Io(e.to_string()))
    }
}

#[async_trait]
impl ChannelOpener for Session {
    type Chan = Channel<Msg>;
    async fn open_exec(&mut self) -> Result<Self::Chan, SshError> {
        self.handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Io(e.to_string()))
    }
}

// ─── 收流 ────────────────────────────────────────────────────────────────────

/// 收流直到 `Eof`/`Close`/流结束，字节**累加进 `out`**。
///
/// 写入调用方的缓冲（而非返回 String）：超时被 `tokio::time::timeout` 切断时，
/// 这个 future 会被丢弃，若字节存在 future 内部就一并丢失——而超时前已产出的
/// stdout 往往正是用户要看的。由调用方持有缓冲即可在超时后取回 partial output。
///
/// 契约（exit-code 处理）：**不**因非零退出码报错，也**不**在 `ExitStatus` 处结束
/// 循环——多数服务器在末批 stdout（乃至 `Eof`）之前就发 `ExitStatus`，在此 break 会
/// 截断仍在途的 stdout（曾导致 OS 探测偶发拿到空输出、回退到 SSH banner）。
async fn drain<C: ExecChannel + ?Sized>(ch: &mut C, out: &mut Vec<u8>) {
    while let Some(msg) = ch.next_msg().await {
        match msg {
            ChannelMsg::Data { ref data } => out.extend_from_slice(&data[..]),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
}

/// 在**已打开**的 channel 上跑命令并收流；`timeout = None` 表示不限时。
///
/// 超时路径：`close_channel()` + 有界善后 drain（[`CLOSE_DRAIN`]），然后返回
/// [`SshError::TimedOut`]，**其中带上超时前已收到的 stdout**。不依赖 drop future
/// 来收尾——只 drop 不会发 CHANNEL_CLOSE，远端进程会继续跑并占着 sshd 的会话配额。
pub async fn exec_on_channel<C: ExecChannel + ?Sized>(
    ch: &mut C,
    cmd: &str,
    timeout: Option<Duration>,
) -> Result<String, SshError> {
    ch.exec_cmd(cmd).await?;
    let mut out: Vec<u8> = Vec::new();
    match timeout {
        None => {
            drain(ch, &mut out).await;
            Ok(lossy(out))
        }
        Some(d) => {
            if tokio::time::timeout(d, drain(ch, &mut out)).await.is_ok() {
                return Ok(lossy(out));
            }
            let _ = ch.close_channel().await;
            // 善后 drain 仍写入同一缓冲：close 与远端结束之间到达的尾巴也一并带回。
            let _ = tokio::time::timeout(CLOSE_DRAIN, drain(ch, &mut out)).await;
            Err(SshError::TimedOut { partial: lossy(out) })
        }
    }
}

fn lossy(out: Vec<u8>) -> String {
    String::from_utf8_lossy(&out).into_owned()
}

// ─── 对外入口 ────────────────────────────────────────────────────────────────

/// 会话锁内**只**开 channel，随即放锁，`exec` 与收流在锁外。
///
/// 这是修掉「长命令占着会话锁」的关键：同会话的 term/sftp/tunnel/其它 exec 在本
/// 命令运行期间可自由拿锁。
pub async fn run_on_session<O: ChannelOpener>(
    session: &Mutex<O>,
    cmd: &str,
    timeout: Option<Duration>,
) -> Result<String, SshError> {
    let mut ch = {
        let mut guard = session.lock().await;
        guard.open_exec().await?
    }; // ← 锁在此释放，下面全在锁外
    exec_on_channel(&mut ch, cmd, timeout).await
}

/// 已持有 `Handle`（无会话锁）时的入口：扫描期的临时连接、以及 `monitor::sample`。
pub async fn run_cmd(handle: &Handle<ClientHandler>, cmd: &str) -> Result<String, SshError> {
    let mut ch = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Io(e.to_string()))?;
    exec_on_channel(&mut ch, cmd, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    /// 假 channel：按脚本逐条吐消息（`ChannelMsg` 非 `Clone`，故用 `VecDeque` 弹出）。
    /// `hang_at_end` 为 true 时脚本吐完后 `next_msg` 永挂（模拟远端命令仍在跑）。
    struct FakeChan {
        script: std::collections::VecDeque<ChannelMsg>,
        hang_at_end: bool,
        /// true = 服务器无视 CHANNEL_CLOSE（善后 drain 只能靠 CLOSE_DRAIN 兜底）。
        ignore_close: bool,
        closed: Arc<AtomicUsize>,
        /// 第一次 next_msg 时发信号 / 等许可，用于并发探锁。
        started: Option<oneshot::Sender<()>>,
        resume: Option<oneshot::Receiver<()>>,
    }

    impl FakeChan {
        fn new(script: Vec<ChannelMsg>) -> Self {
            Self {
                script: script.into(),
                hang_at_end: false,
                ignore_close: false,
                closed: Arc::new(AtomicUsize::new(0)),
                started: None,
                resume: None,
            }
        }
        /// 远端命令一直在跑；收到 close 后正常结束流（善后 drain 立即返回）。
        fn hanging() -> Self {
            Self { hang_at_end: true, ..Self::new(vec![]) }
        }
        /// 远端命令一直在跑，且不回 CHANNEL_CLOSE：善后 drain 走 CLOSE_DRAIN 兜底。
        fn never_closes() -> Self {
            Self { hang_at_end: true, ignore_close: true, ..Self::new(vec![]) }
        }
        fn data(s: &str) -> ChannelMsg {
            ChannelMsg::Data { data: bytes::Bytes::from(s.as_bytes().to_vec()) }
        }
    }

    #[async_trait]
    impl ExecChannel for FakeChan {
        async fn exec_cmd(&mut self, _cmd: &str) -> Result<(), SshError> {
            Ok(())
        }
        async fn next_msg(&mut self) -> Option<ChannelMsg> {
            if let Some(tx) = self.started.take() {
                let _ = tx.send(());
            }
            if let Some(rx) = self.resume.take() {
                let _ = rx.await;
            }
            if let Some(msg) = self.script.pop_front() {
                return Some(msg);
            }
            if self.hang_at_end {
                std::future::pending::<()>().await;
            }
            None
        }
        async fn close_channel(&mut self) -> Result<(), SshError> {
            self.closed.fetch_add(1, Ordering::SeqCst);
            // 守规矩的服务器收到 close 就结束流；ignore_close 模拟不结束的那种。
            if !self.ignore_close {
                self.hang_at_end = false;
            }
            Ok(())
        }
    }

    struct FakeOpener {
        chan: Option<FakeChan>,
        opens: AtomicUsize,
    }

    impl FakeOpener {
        fn new(chan: FakeChan) -> Self {
            Self { chan: Some(chan), opens: AtomicUsize::new(0) }
        }
    }

    #[async_trait]
    impl ChannelOpener for FakeOpener {
        type Chan = FakeChan;
        async fn open_exec(&mut self) -> Result<Self::Chan, SshError> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            Ok(self.chan.take().expect("open_exec 只应被调用一次"))
        }
    }

    // ── 收流契约 ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn collects_data_until_eof() {
        let mut ch = FakeChan::new(vec![
            FakeChan::data("hello "),
            FakeChan::data("world"),
            ChannelMsg::Eof,
        ]);
        let out = exec_on_channel(&mut ch, "echo", None).await.unwrap();
        assert_eq!(out, "hello world");
    }

    #[tokio::test]
    async fn exit_status_does_not_truncate_trailing_stdout() {
        // 回归护栏：ExitStatus 常早于末批 stdout 到达，在此 break 会截断输出。
        let mut ch = FakeChan::new(vec![
            FakeChan::data("part1 "),
            ChannelMsg::ExitStatus { exit_status: 1 },
            FakeChan::data("part2"),
            ChannelMsg::Eof,
        ]);
        let out = exec_on_channel(&mut ch, "false", None).await.unwrap();
        assert_eq!(out, "part1 part2", "非零退出码不报错、ExitStatus 不终止收流");
    }

    // ── 超时收尾 ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn timeout_closes_channel_and_reports_timeout() {
        // 用短真实时长（而非 start_paused）以免为测试引入 tokio test-util feature。
        let mut ch = FakeChan::hanging();
        let closed = ch.closed.clone();
        let err = exec_on_channel(&mut ch, "sleep 420", Some(Duration::from_millis(20)))
            .await
            .expect_err("必须超时");
        assert!(matches!(err, SshError::TimedOut { .. }), "得到 {err:?}");
        assert_eq!(closed.load(Ordering::SeqCst), 1, "超时必须显式 close，而非仅 drop future");
    }

    #[tokio::test]
    async fn timeout_preserves_stdout_received_before_deadline() {
        // 回归护栏：长命令跑了一段才超时，那段 stdout 不能随 future 一起丢掉。
        let (started_tx, started_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        let mut ch = FakeChan::new(vec![FakeChan::data("line1\nline2\n")]);
        ch.hang_at_end = true; // 吐完这批就挂住，模拟命令仍在跑
        ch.started = Some(started_tx);
        ch.resume = Some(resume_rx);
        // 让首批数据先落地，再放行进入挂起。
        tokio::spawn(async move {
            started_rx.await.unwrap();
            resume_tx.send(()).unwrap();
        });

        let err = exec_on_channel(&mut ch, "tail -f log", Some(Duration::from_millis(50)))
            .await
            .expect_err("必须超时");
        match err {
            SshError::TimedOut { partial } => {
                assert_eq!(partial, "line1\nline2\n", "超时前的 stdout 必须随错误带回");
            }
            other => panic!("期望 TimedOut，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_returns_even_if_server_never_closes() {
        // close 后远端不回 CHANNEL_CLOSE：善后 drain 必须**有上界**（在 CLOSE_DRAIN 处
        // 被切断），而不是永久挂住调用方。故耗时应 ≈ CLOSE_DRAIN，且不超过它太多。
        let mut ch = FakeChan::never_closes();
        let t0 = std::time::Instant::now();
        let r = exec_on_channel(&mut ch, "sleep 420", Some(Duration::from_millis(20))).await;
        let elapsed = t0.elapsed();
        assert!(matches!(r, Err(SshError::TimedOut { .. })));
        assert!(
            elapsed < CLOSE_DRAIN + Duration::from_millis(500),
            "善后 drain 必须在 CLOSE_DRAIN 处被切断，实际耗时 {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn wellbehaved_server_close_returns_promptly() {
        // 守规矩的服务器收到 close 即结束流 → 不应白等满 CLOSE_DRAIN。
        let mut ch = FakeChan::hanging();
        let t0 = std::time::Instant::now();
        let r = exec_on_channel(&mut ch, "sleep 420", Some(Duration::from_millis(20))).await;
        assert!(matches!(r, Err(SshError::TimedOut { .. })));
        assert!(t0.elapsed() < CLOSE_DRAIN, "实际耗时 {:?}", t0.elapsed());
    }

    // ── 根因：锁粒度 ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn session_lock_is_released_while_command_runs() {
        // 本测试是这次修复的核心断言：命令仍在收流时，同会话的其它操作必须能拿到锁。
        let (started_tx, started_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        let mut chan = FakeChan::new(vec![FakeChan::data("done"), ChannelMsg::Eof]);
        chan.started = Some(started_tx);
        chan.resume = Some(resume_rx);

        let sess = Arc::new(Mutex::new(FakeOpener::new(chan)));
        let sess2 = sess.clone();
        let task = tokio::spawn(async move { run_on_session(&sess2, "sleep 420", None).await });

        // 等命令进入收流阶段（channel 已开、exec 已发）。
        started_rx.await.unwrap();
        assert!(
            sess.try_lock().is_ok(),
            "命令收流期间会话锁必须是空闲的——否则同会话 term/sftp/其它 exec 会被堵到超时"
        );

        resume_tx.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), "done");
        assert_eq!(sess.lock().await.opens.load(Ordering::SeqCst), 1);
    }
}
