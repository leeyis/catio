use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// 用 CATIO_TEST_PG_URL 形如 "host:port:user:password:dbname" 配置；缺失则 skip。
fn pg_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_PG_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 { return None; }
    Some(ConnectArgs {
        db_type: DatabaseType::Postgres,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: None,
    })
}

#[tokio::test]
async fn pg_connect_and_test() {
    let Some(args) = pg_args() else {
        eprintln!("SKIP pg_connect_and_test: set CATIO_TEST_PG_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect");
    let version = driver.test().await.expect("test() ok");
    assert!(version.to_lowercase().contains("postgresql"), "got: {version}");
}

#[tokio::test]
async fn pg_wrong_password_is_auth_failed() {
    let Some(mut args) = pg_args() else { return; };
    args.secret = Some("definitely-wrong".into());
    let err = connect(&args).await.err().expect("should fail");
    assert!(matches!(err, catio_lib::db::DbError::AuthFailed));
}

#[tokio::test]
async fn pg_query_returns_generic_rows() {
    let Some(args) = pg_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT 1 AS n, 'hi' AS s, true AS b", 100).await.unwrap();
    assert_eq!(r.columns.len(), 3);
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.rows.len(), 1);
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("hi"));
    assert_eq!(r.rows[0][2], serde_json::json!(true));
}

#[tokio::test]
async fn pg_query_truncates_at_max_rows() {
    let Some(args) = pg_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT * FROM generate_series(1, 50)", 10).await.unwrap();
    assert_eq!(r.rows.len(), 10);
    assert!(r.truncated);
}
