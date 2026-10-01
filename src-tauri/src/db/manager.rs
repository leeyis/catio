use std::collections::HashMap;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tokio::sync::Mutex;
use crate::db::{driver::Driver, query_control::RunningQueries, result::QueryResult, DbError};

static QUERY_IDS: crate::db::ids::IdGen = crate::db::ids::IdGen::new("query");

#[derive(Default)]
pub struct ConnManager {
    pub conns: Mutex<HashMap<String, Arc<dyn Driver>>>,
    pub running: RunningQueries,
}

struct Deadline(Option<tokio::task::JoinHandle<()>>);
impl Drop for Deadline { fn drop(&mut self) { if let Some(task) = self.0.take() { task.abort(); } } }

impl ConnManager {
    pub async fn insert(&self, id: String, driver: Arc<dyn Driver>) {
        self.conns.lock().await.insert(id, driver);
    }
    pub async fn get(&self, id: &str) -> Option<Arc<dyn Driver>> {
        self.conns.lock().await.get(id).cloned()
    }
    pub async fn remove(&self, id: &str) -> bool {
        self.running.cancel_connection(id);
        let driver = self.conns.lock().await.remove(id);
        if let Some(driver) = driver { driver.close(); true } else { false }
    }

    pub async fn cancel_query(&self, connection: &str, execution: &str) -> Result<(), DbError> {
        let driver = self.get(connection).await.ok_or_else(|| DbError::NotFound(connection.into()))?;
        if !driver.supports_query_cancel() {
            return Err(DbError::Unsupported("This engine cannot interrupt a running query; it is still executing".into()));
        }
        self.running.cancel(connection, execution)
    }

    pub async fn query(&self, connection: &str, sql: &str, max_rows: u32, namespace: Option<&str>,
        execution_id: Option<&str>, timeout_ms: Option<u64>) -> Result<QueryResult, DbError> {
        let driver = self.get(connection).await.ok_or_else(|| DbError::NotFound(connection.into()))?;
        let timeout = timeout_ms.unwrap_or(0);
        if timeout > 86_400_000 { return Err(DbError::QueryFailed("Query timeout exceeds 24 hours".into())); }
        if timeout > 0 && !driver.supports_query_cancel() {
            return Err(DbError::Unsupported("Query timeout requires native cancellation support".into()));
        }
        let id = execution_id.map(str::to_string).unwrap_or_else(|| QUERY_IDS.next());
        let guard = self.running.register(connection, &id)?;
        let timed_out = Arc::new(AtomicBool::new(false));
        let _deadline = Deadline(if timeout > 0 {
            let token = guard.token.clone();
            let expired = timed_out.clone();
            Some(tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                expired.store(true, Ordering::SeqCst); token.cancel();
            }))
        } else { None });
        let result = driver.query_cancellable(sql, max_rows.min(100_000), namespace, guard.token.clone()).await;
        match result {
            Err(DbError::Cancelled) if timed_out.load(Ordering::SeqCst) => Err(DbError::TimedOut),
            other => other,
        }
    }
}
