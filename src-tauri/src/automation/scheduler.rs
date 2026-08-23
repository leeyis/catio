//! Runtime scheduler: fires enabled tasks on cron / interval / once triggers,
//! skipping an overlapping run of the same task (a task whose dispatch is still
//! in flight is not re-fired on a later tick).
//!
//! The scheduler is app-lifetime: it only runs while the process is up. The
//! firing semantics are pure functions (`cron_matches` / `should_fire`) so the
//! whole contract is testable without a real clock; `Scheduler` is a thin tokio
//! tick loop on top.

use super::repo::AutomationStore;
use super::types::{AutomationError, ScheduledTask, TaskTrigger};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, Timelike, Utc};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Executes a single fired task. Implementations resolve the owner/target and
/// run the shell script or Agent prompt. Injected so tests can script it.
#[async_trait]
pub trait TaskDispatcher: Send + Sync {
    async fn dispatch(&self, task: &ScheduledTask) -> Result<(), AutomationError>;
}

/// Pure: does `field` (one cron segment) accept `value` in `min..=max`?
/// Supports `*`, `*/n`, `a-b`, `a,b,c` and a bare number. All segments are ANDed
/// (a deliberate simplification: standard cron ORs day-of-month with
/// day-of-week; we never do — a task fires only when every segment matches).
fn field_matches(field: &str, min: u32, max: u32, value: u32) -> bool {
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part == "*" {
            return true;
        }
        if let Some(rest) = part.strip_prefix("*/") {
            let n: u32 = rest.parse().unwrap_or(1);
            if n > 0 && value % n == 0 {
                return true;
            }
        } else if let Some((a, b)) = part.split_once('-') {
            let a: u32 = a.trim().parse().unwrap_or(min);
            let b: u32 = b.trim().parse().unwrap_or(max);
            if value >= a && value <= b {
                return true;
            }
        } else if let Ok(n) = part.parse::<u32>() {
            if n == value {
                return true;
            }
        }
    }
    false
}

/// Pure: does a 5-field cron expression match this instant? Non-5-field
/// expressions never match.
pub fn cron_matches(expr: &str, dt: DateTime<Utc>) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    field_matches(fields[0], 0, 59, dt.minute())
        && field_matches(fields[1], 0, 23, dt.hour())
        && field_matches(fields[2], 1, 31, dt.day())
        && field_matches(fields[3], 1, 12, dt.month())
        && field_matches(fields[4], 0, 6, dt.weekday().num_days_from_sunday())
}

/// Pure: should `task` fire now, given its last fire time?
///
/// - disabled → never
/// - interval: first scan fires; afterwards every `seconds` elapsed
/// - cron: fires when the expression matches the current minute and the last
///   fire is outside that minute
/// - once: fires at/after `at`, only once
pub fn should_fire(
    task: &ScheduledTask,
    last_fired: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if !task.enabled {
        return false;
    }
    match &task.trigger {
        TaskTrigger::Interval { seconds } => match last_fired {
            None => true,
            Some(last) => now >= last + chrono::Duration::seconds(*seconds as i64),
        },
        TaskTrigger::Cron { expr } => {
            if !cron_matches(expr, now) {
                return false;
            }
            match last_fired {
                None => true,
                // Coarse anti-re-fire: once this minute has fired, wait for a
                // later minute even if `now` is still within it.
                Some(last) => last < now - chrono::Duration::seconds(59),
            }
        }
        TaskTrigger::Once { at } => {
            let at = match DateTime::parse_from_rfc3339(at) {
                Ok(a) => a.with_timezone(&Utc),
                Err(_) => return false,
            };
            match last_fired {
                None => now >= at,
                Some(_) => false,
            }
        }
    }
}

struct SchedulerInner {
    repo: Arc<AutomationStore>,
    dispatch: Arc<dyn TaskDispatcher>,
    running: RwLock<HashMap<String, ()>>,
    last_fired: RwLock<HashMap<String, DateTime<Utc>>>,
}

/// App-lifetime scheduler. `start` spawns the tick loop; `stop` aborts it.
pub struct Scheduler {
    inner: Arc<SchedulerInner>,
    handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Scheduler {
    pub fn new(repo: Arc<AutomationStore>, dispatch: Arc<dyn TaskDispatcher>) -> Self {
        Self {
            inner: Arc::new(SchedulerInner {
                repo,
                dispatch,
                running: RwLock::new(HashMap::new()),
                last_fired: RwLock::new(HashMap::new()),
            }),
            handle: std::sync::Mutex::new(None),
        }
    }

    /// Start the tick loop. Re-spawning replaces the previous loop.
    pub fn start(&self, tick: Duration) {
        let inner = self.inner.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                tick_once(inner.clone(), Utc::now());
            }
        });
        *self.handle.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        if let Some(handle) = self.handle.lock().unwrap().take() {
            handle.abort();
        }
    }
}

fn tick_once(inner: Arc<SchedulerInner>, now: DateTime<Utc>) {
    for task in inner.repo.all_enabled_tasks() {
        if inner.running.read().contains_key(&task.id) {
            continue; // overlap → skip
        }
        let last = inner.last_fired.read().get(&task.id).copied();
        if !should_fire(&task, last, now) {
            continue;
        }
        inner.running.write().insert(task.id.clone(), ());
        inner.last_fired.write().insert(task.id.clone(), now);
        let dispatch = inner.dispatch.clone();
        let inner_task = inner.clone();
        let id = task.id.clone();
        tokio::spawn(async move {
            let _ = dispatch.dispatch(&task).await;
            inner_task.running.write().remove(&id);
        });
    }
}
