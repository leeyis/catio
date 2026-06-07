//! Manager-level robustness tests for session/monitor teardown.
//!
//! `ssh_disconnect` is a `#[tauri::command]` (needs `tauri::State` + a live
//! russh handle), so we can't drive it directly here. Instead we exercise the
//! exact registry method it relies on for the E1 robustness fix:
//! `SessionManager::remove_monitor` must abort the registered background task so
//! a disconnected session's monitor no longer execs on a dead handle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use catio_lib::ssh::manager::SessionManager;

/// Register a never-ending "monitor" task, then `remove_monitor` it and assert
/// the task is actually aborted (it stops flipping a shared flag) and that the
/// removal is a safe no-op when called a second time on a missing session — the
/// ordering `ssh_disconnect` uses (abort monitor first, even if none exists).
#[tokio::test]
async fn remove_monitor_aborts_running_task() {
    let mgr = SessionManager::default();

    let ran = Arc::new(AtomicBool::new(false));
    let ran_task = ran.clone();
    let task = tokio::spawn(async move {
        loop {
            ran_task.store(true, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    mgr.insert_monitor("sess-1".into(), task.abort_handle()).await;

    // Let the task tick at least once.
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(ran.load(Ordering::SeqCst), "monitor task should have run");

    // Teardown: abort + remove.
    mgr.remove_monitor("sess-1").await;

    // After abort, the task must stop touching the flag.
    tokio::time::sleep(Duration::from_millis(20)).await;
    ran.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        !ran.load(Ordering::SeqCst),
        "aborted monitor task must not keep running"
    );

    // Removing a monitor that no longer exists is a safe no-op (the order
    // `ssh_disconnect` uses when the session/monitor is already gone).
    mgr.remove_monitor("sess-1").await;
    mgr.remove_monitor("never-existed").await;
}
