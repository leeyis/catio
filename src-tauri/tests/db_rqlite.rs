use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_RQLITE_URL (format: "host:port:user:password:dbname").
/// All fields after host:port are typically empty: "127.0.0.1:54001::::"
fn rqlite_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_RQLITE_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Rqlite,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: None,
        options: None,
    })
}

#[tokio::test]
async fn rqlite_connect_and_test() {
    let Some(args) = rqlite_args() else {
        eprintln!("SKIP rqlite_connect_and_test: set CATIO_TEST_RQLITE_URL=host:port::::");
        return;
    };
    let driver = connect(&args).await.expect("should connect to rqlite");
    let version = driver.test().await.expect("test() should succeed");
    assert!(!version.is_empty(), "version/status should be non-empty, got: {version:?}");
    eprintln!("rqlite test result: {version}");
}

#[tokio::test]
async fn rqlite_select_1() {
    let Some(args) = rqlite_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT 1 AS n", 100).await.unwrap();
    assert_eq!(r.columns.len(), 1);
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.rows.len(), 1);
    assert_eq!(r.rows[0][0], serde_json::json!(1));
}

#[tokio::test]
async fn rqlite_create_insert_select_roundtrip() {
    let Some(args) = rqlite_args() else { return; };
    let driver = connect(&args).await.unwrap();

    // Cleanup first
    driver.query("DROP TABLE IF EXISTS catio_it_rqlite", 1).await.ok();

    // Create
    driver.query(
        "CREATE TABLE catio_it_rqlite (id INTEGER PRIMARY KEY, name TEXT)",
        1,
    ).await.unwrap();

    // Insert two rows
    let ins1 = driver.query(
        "INSERT INTO catio_it_rqlite VALUES (1, 'Alice')",
        1,
    ).await.unwrap();
    assert_eq!(ins1.rows_affected, Some(1), "insert 1 should affect 1 row");

    let ins2 = driver.query(
        "INSERT INTO catio_it_rqlite VALUES (2, 'Bob')",
        1,
    ).await.unwrap();
    assert_eq!(ins2.rows_affected, Some(1), "insert 2 should affect 1 row");

    // Select
    let r = driver.query("SELECT id, name FROM catio_it_rqlite ORDER BY id", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2, "expected 2 columns");
    assert_eq!(r.rows.len(), 2, "expected 2 rows");
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("Alice"));
    assert_eq!(r.rows[1][0], serde_json::json!(2));
    assert_eq!(r.rows[1][1], serde_json::json!("Bob"));

    // Cleanup
    driver.query("DROP TABLE IF EXISTS catio_it_rqlite", 1).await.ok();
}

#[tokio::test]
async fn rqlite_table_structure_shows_pk() {
    let Some(args) = rqlite_args() else { return; };
    let driver = connect(&args).await.unwrap();

    // Setup
    driver.query("DROP TABLE IF EXISTS catio_it_rqlite_pk", 1).await.ok();
    driver.query(
        "CREATE TABLE catio_it_rqlite_pk (id INTEGER PRIMARY KEY, val TEXT)",
        1,
    ).await.unwrap();

    let st = driver.table_structure("main", "catio_it_rqlite_pk").await.unwrap();
    assert!(
        st.columns.iter().any(|c| c.name == "id" && c.key == "PK"),
        "expected id PK, got: {:?}", st.columns
    );

    // Cleanup
    driver.query("DROP TABLE IF EXISTS catio_it_rqlite_pk", 1).await.ok();
}

#[tokio::test]
async fn rqlite_list_schemas_is_main() {
    let Some(args) = rqlite_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let schemas = driver.list_schemas().await.unwrap();
    assert_eq!(schemas, vec!["main"]);
}
