//! Task 5/6 contract tests: scheduler firing semantics (pure), plus a loopback
//! integration proving interval firing and overlap-skip.

use async_trait::async_trait;
use catio_lib::automation::scheduler::{cron_matches, should_fire, Scheduler, TaskDispatcher};
use catio_lib::automation::{AutomationStore, ScheduledTask, TaskKind, TaskPolicy, TaskTrigger};
use chrono::{DateTime, TimeZone, Utc};
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::Notify;

fn task(trigger: TaskTrigger) -> ScheduledTask {
    ScheduledTask {
        id: "t1".into(),
        name: "任务".into(),
        trigger,
        kind: TaskKind::Shell,
        script: Some("echo hi".into()),
        prompt: None,
        target_ref: Some("web-01".into()),
        skill_ids: vec![],
        mcp_ids: vec![],
        policy: TaskPolicy::Reject,
        whitelist: vec![],
        enabled: true,
        auto_confirmed: false,
        owner_id: "owner-a".into(),
    }
}

fn dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap()
}

// ── cron matching (pure) ────────────────────────────────────────────────────

#[test]
fn cron_star_matches_everything() {
    assert!(cron_matches("* * * * *", utc(2026, 8, 23, 10, 15, 0)));
}

#[test]
fn cron_exact_minute_and_hour() {
    // 0 2 * * * → every day at 02:00.
    assert!(cron_matches("0 2 * * *", utc(2026, 8, 23, 2, 0, 0)));
    assert!(!cron_matches("0 2 * * *", utc(2026, 8, 23, 3, 0, 0)));
    assert!(!cron_matches("0 2 * * *", utc(2026, 8, 23, 2, 5, 0)));
}

#[test]
fn cron_step_minutes() {
    // */15 → :00 :15 :30 :45
    assert!(cron_matches("*/15 * * * *", utc(2026, 8, 23, 9, 30, 0)));
    assert!(!cron_matches("*/15 * * * *", utc(2026, 8, 23, 9, 20, 0)));
}

#[test]
fn cron_range_and_list() {
    // * 9-11 * * * → hours 9..11
    assert!(cron_matches("* 9-11 * * *", utc(2026, 8, 23, 10, 0, 0)));
    assert!(!cron_matches("* 9-11 * * *", utc(2026, 8, 23, 12, 0, 0)));
    // 0,30 * * * *
    assert!(cron_matches("0,30 * * * *", utc(2026, 8, 23, 7, 30, 0)));
}

#[test]
fn cron_matches_weekday() {
    // 0 9 * * 1 → Mondays 09:00 (0 = Sunday). 2026-08-24 is a Monday.
    assert!(cron_matches("0 9 * * 1", dt("2026-08-24T09:00:00Z")));
    assert!(!cron_matches("0 9 * * 1", dt("2026-08-25T09:00:00Z")));
}

#[test]
fn cron_bad_arity_never_matches() {
    assert!(!cron_matches("* * * *", utc(2026, 8, 23, 10, 15, 0)));
    assert!(!cron_matches("* * * * * *", utc(2026, 8, 23, 10, 15, 0)));
}

// ── should_fire (pure) ──────────────────────────────────────────────────────

#[test]
fn interval_fires_on_first_scan_then_after_interval() {
    let t = task(TaskTrigger::Interval { seconds: 60 });
    let now = dt("2026-08-23T10:00:00Z");
    assert!(should_fire(&t, None, now));
    // Fired at 10:00; not due again until 10:01.
    let last = now;
    assert!(!should_fire(&t, Some(last), dt("2026-08-23T10:00:30Z")));
    assert!(should_fire(&t, Some(last), dt("2026-08-23T10:01:00Z")));
}

#[test]
fn cron_fires_when_minute_matches_and_is_fresh() {
    let t = task(TaskTrigger::Cron {
        expr: "*/15 * * * *".into(),
    });
    let now = dt("2026-08-23T10:00:00Z");
    assert!(should_fire(&t, None, now));
    // Same minute, already fired → no re-fire.
    assert!(!should_fire(&t, Some(now), dt("2026-08-23T10:00:10Z")));
    // Non-matching minute → no fire.
    assert!(!should_fire(&t, None, dt("2026-08-23T10:07:00Z")));
    // Next matching minute with a stale last-fire → fire.
    let last = dt("2026-08-23T09:45:00Z");
    assert!(should_fire(&t, Some(last), dt("2026-08-23T10:00:00Z")));
}

#[test]
fn once_fires_at_or_after_at_then_only_once() {
    let t = task(TaskTrigger::Once {
        at: "2026-08-23T22:30:00Z".into(),
    });
    assert!(!should_fire(&t, None, dt("2026-08-23T22:29:00Z")));
    assert!(should_fire(&t, None, dt("2026-08-23T22:30:00Z")));
    // Already fired once → never again.
    assert!(!should_fire(
        &t,
        Some(dt("2026-08-23T22:30:00Z")),
        dt("2026-08-24T00:00:00Z")
    ));
}

#[test]
fn disabled_task_never_fires() {
    let mut t = task(TaskTrigger::Interval { seconds: 60 });
    t.enabled = false;
    assert!(!should_fire(&t, None, dt("2026-08-23T10:00:00Z")));
}

// ── integration: scheduler loop fires interval and skips overlaps ───────────

/// Records dispatches; can be blocked to hold a dispatch "running".
#[derive(Clone)]
struct ScriptedDispatcher {
    calls: Arc<Mutex<Vec<String>>>,
    hold: Arc<Notify>,
    releases: Arc<Mutex<Vec<Arc<Notify>>>>,
}

impl ScriptedDispatcher {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            hold: Arc::new(Notify::new()),
            releases: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl TaskDispatcher for ScriptedDispatcher {
    async fn dispatch(
        &self,
        task: &ScheduledTask,
    ) -> Result<(), catio_lib::automation::AutomationError> {
        self.calls.lock().push(task.id.clone());
        let release = Arc::new(Notify::new());
        self.releases.lock().push(release.clone());
        self.hold.notify_one();
        // Block until the test releases this dispatch (simulates a slow task).
        release.notified().await;
        Ok(())
    }
}

#[tokio::test]
async fn scheduler_fires_once_and_skips_overlap() {
    let dir = std::env::temp_dir().join(format!("catio-sched-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = AutomationStore::open(&dir);
    store
        .upsert_task(&task(TaskTrigger::Once {
            at: "2026-01-01T00:00:00Z".into(),
        }))
        .unwrap();

    let dispatcher = ScriptedDispatcher::new();
    let scheduler = Scheduler::new(Arc::new(store), Arc::new(dispatcher.clone()));
    scheduler.start(std::time::Duration::from_millis(20));

    // The once task's `at` is in the past → fires on the first tick.
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        dispatcher.hold.notified(),
    )
    .await
    .expect("first dispatch never fired");
    assert_eq!(dispatcher.calls.lock().len(), 1);

    // While the first dispatch is still held, many ticks pass; no overlap.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        dispatcher.calls.lock().len(),
        1,
        "must not overlap while a dispatch is running"
    );

    // Release the dispatch; a once task never fires again.
    dispatcher.releases.lock().first().unwrap().notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        dispatcher.calls.lock().len(),
        1,
        "once task must not re-fire"
    );

    scheduler.stop();
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn interval_task_fires_on_first_scan_and_not_again_until_interval() {
    let dir = std::env::temp_dir().join(format!("catio-sched-int-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = AutomationStore::open(&dir);
    store
        .upsert_task(&task(TaskTrigger::Interval { seconds: 60 }))
        .unwrap();

    let dispatcher = ScriptedDispatcher::new();
    let scheduler = Scheduler::new(Arc::new(store), Arc::new(dispatcher.clone()));
    scheduler.start(std::time::Duration::from_millis(20));

    // Interval "first scan" semantics: fires immediately when no prior run.
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        dispatcher.hold.notified(),
    )
    .await
    .expect("first dispatch never fired");
    assert_eq!(dispatcher.calls.lock().len(), 1);

    // Release it; a 60s interval must NOT re-fire shortly after.
    dispatcher.releases.lock().first().unwrap().notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        dispatcher.calls.lock().len(),
        1,
        "interval re-fired before the interval elapsed"
    );

    scheduler.stop();
    std::fs::remove_dir_all(&dir).unwrap();
}
