//! D3：多会话广播 exec（Multi-Exec）。
//!
//! 在多条 SSH 会话上并发执行同一条命令，通过 `multiexec://{runId}` 事件把每个
//! 目标的状态（running / done / error）流式推送给前端。
//!
//! 事件载荷结构（camelCase，匹配 src/services/types.ts `MultiExecEvent`）：
//! ```json
//! { "sessionId": "sess-1", "state": "running" }
//! { "sessionId": "sess-1", "state": "done",  "chunk": "<stdout>" }
//! { "sessionId": "sess-1", "state": "error", "chunk": "<error>" }
//! ```

use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::ssh::ids::IdGen;
use crate::ssh::manager::{Session, SessionManager};
use crate::ssh::monitor::run_cmd;
use crate::ssh::SshError;

/// 进程级唯一 run-id 生成器。"run-1", "run-2", ...
static RUN_IDS: IdGen = IdGen::new("run");

// ─── 事件载荷 ─────────────────────────────────────────────────────────────────

/// 单个目标的状态事件（前端 `MultiExecEvent`）。
/// `chunk` 在 running 时为 None；done/error 时为 Some。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiExecEvent {
    session_id: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk: Option<String>,
}

// ─── 可测试核心 ───────────────────────────────────────────────────────────────

/// 在单条会话上执行一次命令，返回 stdout。
///
/// 持有会话锁仅贯穿 `run_cmd` 的 exec 调用（单条 SSH exec channel），
/// 与 `monitor::run_cmd_locked` 保持相同的细粒度锁策略。
/// 复用 `monitor::run_cmd` 以保持 exec channel 行为完全一致（不因非零退出码报错）。
pub async fn run_on(session: Arc<Mutex<Session>>, cmd: &str) -> Result<String, SshError> {
    let s = session.lock().await;
    run_cmd(&s.handle, cmd).await
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 在多条会话上并发执行 `cmd`，通过 `multiexec://{run_id}` 事件流式上报结果。
/// 立即返回 `run_id`（不等待所有目标完成）。
///
/// 每个目标独立 tokio 任务：
/// 1. 发 `{ sessionId, state: "running" }` ；
/// 2. 调 `run_on`；
/// 3. 成功 → 发 `{ sessionId, state: "done",  chunk: <stdout> }`；
///    失败 → 发 `{ sessionId, state: "error", chunk: <error> }`。
///
/// 找不到 session_id 时直接发 `{ state: "error", chunk: "session not found" }`。
#[tauri::command]
pub async fn multiexec_run(
    session_ids: Vec<String>,
    cmd: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, SessionManager>,
) -> Result<String, SshError> {
    let run_id = RUN_IDS.next();
    let evt = format!("multiexec://{run_id}");

    for sid in session_ids {
        let maybe_sess = mgr.get(&sid).await;
        let app2 = app.clone();
        let evt2 = evt.clone();
        let cmd2 = cmd.clone();
        let sid2 = sid.clone();

        tokio::spawn(async move {
            // 1. running
            let _ = app2.emit(
                &evt2,
                &MultiExecEvent {
                    session_id: sid2.clone(),
                    state: "running",
                    chunk: None,
                },
            );

            match maybe_sess {
                None => {
                    // session not found
                    let _ = app2.emit(
                        &evt2,
                        &MultiExecEvent {
                            session_id: sid2,
                            state: "error",
                            chunk: Some("session not found".into()),
                        },
                    );
                }
                Some(sess) => {
                    match run_on(sess, &cmd2).await {
                        Ok(output) => {
                            let _ = app2.emit(
                                &evt2,
                                &MultiExecEvent {
                                    session_id: sid2,
                                    state: "done",
                                    chunk: Some(output),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = app2.emit(
                                &evt2,
                                &MultiExecEvent {
                                    session_id: sid2,
                                    state: "error",
                                    chunk: Some(e.to_string()),
                                },
                            );
                        }
                    }
                }
            }
        });
    }

    Ok(run_id)
}
