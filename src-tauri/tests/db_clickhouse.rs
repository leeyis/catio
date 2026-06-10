use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_CLICKHOUSE_URL (format: "host:port:user:password:dbname").
/// Password and dbname may be empty: "127.0.0.1:58123:default::default"
fn ch_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_CLICKHOUSE_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Clickhouse,
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
async fn ch_connect_and_test() {
    let Some(args) = ch_args() else {
        eprintln!("SKIP ch_connect_and_test: set CATIO_TEST_CLICKHOUSE_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect to ClickHouse");
    let version = driver.test().await.expect("test() should return version");
    assert!(!version.is_empty(), "version should be non-empty, got: {version:?}");
    eprintln!("ClickHouse version: {version}");
}

#[tokio::test]
async fn ch_query_returns_generic_rows() {
    let Some(args) = ch_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT 1 AS n, 'hi' AS s", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2, "expected 2 columns");
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.columns[1].name, "s");
    assert_eq!(r.rows.len(), 1, "expected 1 row");
    // ClickHouse returns number 1 as a JSON number
    assert!(
        r.rows[0][0] == serde_json::json!(1) || r.rows[0][0] == serde_json::json!("1"),
        "expected 1, got: {:?}", r.rows[0][0]
    );
    assert_eq!(r.rows[0][1], serde_json::json!("hi"));
}

#[tokio::test]
async fn ch_list_schemas() {
    let Some(args) = ch_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let schemas = driver.list_schemas().await.unwrap();
    // "default" schema should be present
    assert!(
        schemas.iter().any(|s| s == "default"),
        "expected 'default' schema, got: {:?}", schemas
    );
}

#[tokio::test]
async fn ch_list_tables_and_introspect() {
    let Some(args) = ch_args() else { return; };
    let driver = connect(&args).await.unwrap();

    // Create a test table in the default database
    driver.query(
        "CREATE TABLE IF NOT EXISTS catio_it_test (id UInt32, name String) ENGINE = Memory",
        1,
    ).await.unwrap();

    // list_tables should include it
    let tables = driver.list_tables("default").await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == "catio_it_test"),
        "catio_it_test not found in tables: {:?}", tables
    );

    // table_structure should return columns
    let st = driver.table_structure("default", "catio_it_test").await.unwrap();
    assert!(
        st.columns.iter().any(|c| c.name == "id"),
        "expected 'id' column, got: {:?}", st.columns
    );
    assert!(
        st.columns.iter().any(|c| c.name == "name"),
        "expected 'name' column, got: {:?}", st.columns
    );

    // Cleanup
    driver.query("DROP TABLE IF EXISTS catio_it_test", 1).await.ok();
}

#[tokio::test]
async fn ch_er_relations_returns_empty() {
    let Some(args) = ch_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let rels = driver.er_relations("default").await.unwrap();
    assert!(rels.is_empty(), "ClickHouse has no FK relations, expected empty, got: {:?}", rels);
}
