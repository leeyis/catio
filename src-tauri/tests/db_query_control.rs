use std::{sync::Arc, time::Duration};
use catio_lib::db::{driver::{connect, ConnectArgs}, manager::ConnManager, DatabaseType, DbError};
use serde_json::json;

fn args(db_type: DatabaseType) -> ConnectArgs {
    ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
        driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None,
        ca_cert_path: None, ssl_reject_unauthorized: None }
}
const LONG_SQLITE: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n";
async fn sqlite() -> Arc<ConnManager> {
    let mgr = Arc::new(ConnManager::default());
    mgr.insert("fixture".into(), connect(&args(DatabaseType::Sqlite)).await.unwrap()).await;
    mgr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_timeout_really_interrupts_and_releases_the_connection() {
    let mgr = sqlite().await;
    let r = tokio::time::timeout(Duration::from_secs(3),
        mgr.query("fixture", LONG_SQLITE, 10, None, Some("timeout"), Some(30))).await.expect("must terminate");
    assert!(matches!(r, Err(DbError::TimedOut)), "{r:?}");
    assert_eq!(mgr.running.active_count(), 0);
    assert_eq!(mgr.query("fixture", "SELECT 42", 1, None, None, None).await.unwrap().rows[0][0], json!(42));
}

#[tokio::test]
async fn cancel_arriving_before_query_prevents_any_write() {
    let mgr = sqlite().await;
    mgr.cancel_query("fixture", "early").await.unwrap();
    let r = mgr.query("fixture", "CREATE TABLE forbidden(id INT)", 0, None, Some("early"), None).await;
    assert!(matches!(r, Err(DbError::Cancelled)));
    let r = mgr.query("fixture", "SELECT name FROM sqlite_master WHERE name='forbidden'", 1, None, None, None).await.unwrap();
    assert!(r.rows.is_empty());
    assert_eq!(mgr.running.active_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_interrupts_inflight_query_and_cleans_registry() {
    let mgr = sqlite().await;
    let work = mgr.clone();
    let task = tokio::spawn(async move { work.query("fixture", LONG_SQLITE, 1, None, Some("disconnect"), None).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while mgr.running.active_count() == 0 { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert!(mgr.remove("fixture").await);
    let r = tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    assert!(matches!(r, Err(DbError::Cancelled)), "{r:?}");
    assert_eq!(mgr.running.active_count(), 0);
}

fn external(db: DatabaseType, key: &str) -> Option<ConnectArgs> {
    let Ok(raw) = std::env::var(key) else { eprintln!("SKIP: {key} is not configured"); return None; };
    let p: Vec<_> = raw.splitn(5, ':').collect();
    assert_eq!(p.len(), 5, "{key}: invalid fixture format");
    Some(ConnectArgs { host: p[0].into(), port: p[1].parse().unwrap(), user: p[2].into(),
        secret: Some(p[3].into()), database: Some(p[4].into()), ..args(db) })
}

async fn native_cancel(a: ConnectArgs, sql: &'static str, active_sql: &'static str) {
    let mgr = Arc::new(ConnManager::default());
    let driver = connect(&a).await.unwrap();
    mgr.insert("native".into(), driver.clone()).await;
    let work = mgr.clone();
    let task = tokio::spawn(async move { work.query("native", sql, 1, None, Some("native-cancel"), None).await });
    // Prove the expensive statement actually reached the DB before cancellation;
    // merely cancelling a future before it starts is not a native-cancel test.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let r = driver.query(active_sql, 10).await.unwrap();
            if !r.rows.is_empty() { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("native sleep query must become visible");
    mgr.cancel_query("native", "native-cancel").await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), task).await.expect("cancel must interrupt the 10s sleep").unwrap();
    // MySQL's standalone SLEEP reports interruption as the successful scalar 1,
    // not error 1317. Preserve that genuine terminal result instead of lying about
    // an already-completed write. The 3s deadline and live-query check prove cancellation.
    let interrupted_sleep = a.db_type == DatabaseType::Mysql
        && result.as_ref().is_ok_and(|r| r.rows == vec![vec![json!(1)]]);
    assert!(matches!(result, Err(DbError::Cancelled)) || interrupted_sleep, "{result:?}");
    assert!(driver.query(active_sql, 10).await.unwrap().rows.is_empty());
    assert_eq!(mgr.running.active_count(), 0);
    assert_eq!(driver.query("SELECT 42", 1).await.unwrap().rows[0][0], json!(42));
}

#[tokio::test]
async fn postgres_cancel_interrupts_the_actual_server_query() {
    let Some(a) = external(DatabaseType::Postgres, "CATIO_TEST_PG_URL") else { return; };
    native_cancel(a, "SELECT pg_sleep(10) /*catio_cancel_probe*/",
        "SELECT pid FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(10) /*catio_cancel_probe*/' AND state='active'").await;
}

#[tokio::test]
async fn mysql_cancel_interrupts_the_actual_server_query() {
    let Some(a) = external(DatabaseType::Mysql, "CATIO_TEST_MYSQL_URL") else { return; };
    native_cancel(a, "SELECT SLEEP(10) /*catio_cancel_probe*/",
        "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO = 'SELECT SLEEP(10) /*catio_cancel_probe*/'").await;
}
