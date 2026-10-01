use catio_lib::db::{driver::{connect, ConnectArgs}, manager::ConnManager, DatabaseType};
use serde_json::json;
fn args(db_type: DatabaseType) -> ConnectArgs {
    ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
        driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None,
        ca_cert_path: None, ssl_reject_unauthorized: None }
}
fn external(db: DatabaseType, env: &str) -> Option<ConnectArgs> {
    let Ok(raw) = std::env::var(env) else { eprintln!("SKIP: {env} is not configured"); return None; };
    let p: Vec<_> = raw.splitn(5, ':').collect(); assert_eq!(p.len(), 5);
    Some(ConnectArgs { host: p[0].into(), port: p[1].parse().unwrap(), user: p[2].into(),
        secret: Some(p[3].into()), database: Some(p[4].into()), ..args(db) })
}

#[tokio::test]
async fn duckdb_decimals_dates_and_nested_values_are_lossless() {
    let d = connect(&args(DatabaseType::Duckdb)).await.unwrap();
    let r = d.query("SELECT DATE '2026-01-02' AS d, TIMESTAMP '2026-01-02 03:04:05.123456' AS ts, CAST(12345678901234567890.123456789012 AS DECIMAL(38,12)) AS n, [1, NULL, 9007199254740993::BIGINT] AS a, {'name': 'Ada', 'scores': [1,2]} AS obj, [CAST(0.00000000000000000000000000001 AS DECIMAL(38,29))] AS tiny", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!("2026-01-02"));
    assert!(r.rows[0][1].as_str().unwrap().contains("03:04:05.123456"));
    assert_eq!(r.rows[0][2], json!("12345678901234567890.123456789012"));
    assert_eq!(r.rows[0][3], json!([1,null,"9007199254740993"]));
    assert_eq!(r.rows[0][4], json!({"name":"Ada","scores":[1,2]}));
    assert_eq!(r.rows[0][5], json!(["0.00000000000000000000000000001"]));
    assert!(!r.columns[0].type_name.is_empty());
    d.query("CREATE TABLE affected(i INT)", 0).await.unwrap();
    assert_eq!(d.query("/* comment */ INSERT INTO affected VALUES(1),(2)", 0).await.unwrap().rows_affected, Some(2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duckdb_timeout_interrupts_and_does_not_poison_the_next_query() {
    let mgr = ConnManager::default();
    mgr.insert("duck".into(), connect(&args(DatabaseType::Duckdb)).await.unwrap()).await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(4), mgr.query("duck",
        "SELECT SUM(i) FROM range(10000000000) AS t(i)", 1, None, Some("duck-timeout"), Some(30))).await.unwrap();
    assert!(matches!(result, Err(catio_lib::db::DbError::TimedOut)), "{result:?}");
    assert_eq!(mgr.query("duck", "SELECT 42", 1, None, None, None).await.unwrap().rows[0][0], json!(42));
    assert_eq!(mgr.running.active_count(), 0);
}

#[tokio::test]
async fn sqlite_foreign_keys_and_atomic_batch_validation_are_enforced() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE parent(id INTEGER PRIMARY KEY)", 0).await.unwrap();
    d.query("CREATE TABLE child(id INTEGER REFERENCES parent(id))", 0).await.unwrap();
    assert!(d.query("INSERT INTO child VALUES(9)", 0).await.is_err());
    assert!(d.exec_batch(&["INSERT INTO parent VALUES(1)".into(), "COMMIT".into()]).await.is_err());
    assert_eq!(d.query("SELECT COUNT(*) FROM parent", 1).await.unwrap().rows[0][0], json!(0));
}

async fn console_session(a: ConnectArgs) {
    let mysql = a.db_type == DatabaseType::Mysql;
    let namespace = if mysql { a.database.clone().unwrap() } else { "public".into() };
    let d = connect(&a).await.unwrap(); let mgr = ConnManager::default(); mgr.insert("session".into(), d).await;
    let create = if mysql { "CREATE TEMPORARY TABLE catio_console_session(id INT PRIMARY KEY)" }
        else { "CREATE TEMP TABLE catio_console_session(id INT PRIMARY KEY)" };
    for sql in [create, "INSERT INTO catio_console_session VALUES(1)", "BEGIN", "INSERT INTO catio_console_session VALUES(2)"] {
        mgr.query("session", sql, 10, Some(&namespace), None, None).await.unwrap();
    }
    // An error in a manual PG transaction must still allow ROLLBACK even when the
    // console supplies a schema. Do not run a failing SET search_path before it.
    assert!(mgr.query("session", "INSERT INTO catio_console_session VALUES(2)", 10, Some(&namespace), None, None).await.is_err());
    mgr.query("session", "ROLLBACK", 10, Some(&namespace), None, None).await.unwrap();
    let rows = mgr.query("session", "SELECT id FROM catio_console_session ORDER BY id", 10, Some(&namespace), None, None).await.unwrap().rows;
    assert_eq!(rows, vec![vec![json!(1)]]);
    assert!(mgr.remove("session").await);
}
#[tokio::test] async fn postgres_console_keeps_temp_tables_and_transaction_state() {
    if let Some(a) = external(DatabaseType::Postgres, "CATIO_TEST_PG_URL") { console_session(a).await; }
}
#[tokio::test] async fn mysql_console_keeps_temp_tables_and_transaction_state() {
    if let Some(a) = external(DatabaseType::Mysql, "CATIO_TEST_MYSQL_URL") { console_session(a).await; }
}

#[tokio::test]
async fn sqlserver_guid_high_scale_decimal_and_comment_prefixed_query() {
    let Some(a) = external(DatabaseType::Sqlserver, "CATIO_TEST_MSSQL_URL") else { return; };
    let d = connect(&a).await.unwrap();
    let r = d.query("/* metadata must not disappear */ SELECT CAST('123e4567-e89b-12d3-a456-426614174000' AS UNIQUEIDENTIFIER) AS id, CAST(0.00000000000000000000000000001 AS DECIMAL(38,29)) AS tiny, CAST(12345678901234567890.1234567890 AS DECIMAL(38,10)) AS amount", 10).await.unwrap();
    assert_eq!(r.rows[0][0].as_str().unwrap().to_lowercase(), "123e4567-e89b-12d3-a456-426614174000");
    assert_eq!(r.rows[0][1], json!("0.00000000000000000000000000001"));
    assert_eq!(r.rows[0][2], json!("12345678901234567890.1234567890"));
    assert!(!r.columns[0].type_name.is_empty());
    let r = d.paginated_query("SELECT v FROM (VALUES(1),(2),(3)) t(v)", 2, 0).await.unwrap();
    assert_eq!(r.rows.len(), 2); assert!(r.truncated);
}

#[tokio::test]
async fn mysql_passwords_are_not_url_interpreted() {
    let Some(a) = external(DatabaseType::Mysql, "CATIO_TEST_MYSQL_URL") else { return; };
    let admin = connect(&a).await.unwrap();
    let user = format!("catio_url_{}@x", std::process::id());
    // Deliberately synthetic fixture credentials; includes reserved URL characters.
    let password = "Fixture9@:/?#%+Unicode";
    admin.query(&format!("CREATE USER '{user}'@'%' IDENTIFIED BY '{password}'"), 0).await.unwrap();
    let mut login = a.clone(); login.user = user.clone(); login.secret = Some(password.into()); login.database = None;
    let result = match connect(&login).await { Ok(d) => d.test().await, Err(e) => Err(e) };
    admin.query(&format!("DROP USER '{user}'@'%'"), 0).await.unwrap();
    assert!(result.is_ok(), "typed credentials must connect: {result:?}");
}

#[tokio::test]
async fn mysql_nontransactional_targets_are_rejected_before_replacement() {
    use catio_lib::db::{write_ops, table_import::ImportColumnMapping};
    let Some(a) = external(DatabaseType::Mysql, "CATIO_TEST_MYSQL_URL") else { return; };
    let d = connect(&a).await.unwrap(); let table = format!("catio_myisam_{}", std::process::id());
    d.query(&format!("CREATE TABLE {table}(id INT PRIMARY KEY) ENGINE=MyISAM"), 0).await.unwrap();
    d.query(&format!("INSERT INTO {table} VALUES(9)"), 0).await.unwrap();
    let result = write_ops::import_bytes(d.as_ref(), a.database.as_deref(), &table, "x.csv", b"id\n1",
        &[ImportColumnMapping { source_column: "id".into(), target_column: "id".into() }], "truncate", 1, true).await;
    let rows = d.query(&format!("SELECT id FROM {table}"), 10).await.unwrap().rows;
    d.query(&format!("DROP TABLE {table}"), 0).await.unwrap();
    assert!(result.is_err()); assert_eq!(rows, vec![vec![json!(9)]]);
}
