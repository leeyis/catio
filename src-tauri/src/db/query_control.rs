//! Per-execution cancellation, scoped to a connection. Cancel is a request, not a
//! claim that a write was rolled back. The query future is the terminal receipt.
use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use crate::db::DbError;

type Key = (String, String);
#[derive(Default)]
struct Registry {
    active: HashMap<Key, CancellationToken>,
    early: HashMap<Key, Instant>,
}
#[derive(Clone, Default)]
pub struct RunningQueries { inner: Arc<Mutex<Registry>> }

pub struct QueryGuard {
    key: Key,
    registry: RunningQueries,
    pub token: CancellationToken,
}
impl Drop for QueryGuard {
    fn drop(&mut self) {
        self.token.cancel();
        self.registry.inner.lock().active.remove(&self.key);
    }
}

pub fn validate_execution_id(id: &str) -> Result<(), DbError> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err(DbError::QueryFailed("Invalid query execution ID".into()));
    }
    Ok(())
}

impl RunningQueries {
    pub fn register(&self, connection: &str, execution: &str) -> Result<QueryGuard, DbError> {
        validate_execution_id(execution)?;
        let key = (connection.to_string(), execution.to_string());
        let mut registry = self.inner.lock();
        registry.early.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if registry.active.contains_key(&key) {
            return Err(DbError::QueryFailed("This query execution ID is already running".into()));
        }
        if registry.active.keys().filter(|k| k.0 == connection).count() >= 32 {
            return Err(DbError::QueryFailed("Too many active queries on this connection".into()));
        }
        let token = CancellationToken::new();
        if registry.early.remove(&key).is_some() { token.cancel(); }
        registry.active.insert(key.clone(), token.clone());
        Ok(QueryGuard { key, registry: self.clone(), token })
    }

    pub fn cancel(&self, connection: &str, execution: &str) -> Result<(), DbError> {
        validate_execution_id(execution)?;
        let key = (connection.to_string(), execution.to_string());
        let mut registry = self.inner.lock();
        if let Some(token) = registry.active.get(&key) { token.cancel(); }
        else {
            registry.early.retain(|_, at| at.elapsed() < Duration::from_secs(60));
            if registry.early.len() >= 256 {
                return Err(DbError::QueryFailed("Too many pending cancellation requests".into()));
            }
            // The cancel HTTP request may beat the run request. Bound its lifetime
            // and count, then consume it exactly once when that execution arrives.
            registry.early.insert(key, Instant::now());
        }
        Ok(())
    }

    pub fn cancel_connection(&self, connection: &str) {
        let mut registry = self.inner.lock();
        for (key, token) in &registry.active { if key.0 == connection { token.cancel(); } }
        registry.early.retain(|key, _| key.0 != connection);
    }

    pub fn active_count(&self) -> usize { self.inner.lock().active.len() }
    pub fn has_active(&self, connection: &str) -> bool {
        self.inner.lock().active.keys().any(|key|key.0==connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_cancel_is_consumed_and_completion_cleans_registry() {
        let jobs = RunningQueries::default();
        jobs.cancel("a", "q-1").unwrap();
        let a = jobs.register("a", "q-1").unwrap();
        assert!(a.token.is_cancelled());
        assert!(jobs.register("a", "q-1").is_err());
        drop(a);
        assert_eq!(jobs.active_count(), 0);
        assert!(!jobs.register("a", "q-1").unwrap().token.is_cancelled());
    }
    #[test]
    fn identical_execution_ids_on_different_connections_are_isolated() {
        let jobs = RunningQueries::default();
        let a = jobs.register("a", "q-1").unwrap();
        let b = jobs.register("b", "q-1").unwrap();
        jobs.cancel("a", "q-1").unwrap();
        assert!(a.token.is_cancelled()); assert!(!b.token.is_cancelled());
        jobs.cancel_connection("b"); assert!(b.token.is_cancelled());
    }
}
