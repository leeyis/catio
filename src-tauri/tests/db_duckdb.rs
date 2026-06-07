use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

fn mem_args() -> ConnectArgs {
    ConnectArgs {
        db_type: DatabaseType::Duckdb,
        host: ":memory:".into(),
        port: 0,
        user: String::new(),
        database: None,
        driver_profile: None,
        secret: None,
    }
}

#[tokio::test]
async fn duckdb_roundtrip_and_introspect() {
    let drv = connect(&mem_args()).await.expect("connect in-memory DuckDB");

    // DDL
    drv.query(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
        1,
    ).await.unwrap();

    // DML
    drv.query(
        "INSERT INTO t VALUES (1, 'alice'), (2, 'bob')",
        1,
    ).await.unwrap();

    // SELECT: expect 2 columns, 2 rows, known value
    let r = drv.query("SELECT id, name FROM t ORDER BY id", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2, "expected 2 columns, got {:?}", r.columns);
    assert_eq!(r.rows.len(), 2, "expected 2 rows");
    assert_eq!(r.rows[0][1], serde_json::json!("alice"), "first row name should be alice");
    assert_eq!(r.rows[1][1], serde_json::json!("bob"), "second row name should be bob");

    // SELECT 1 AS n — generic roundtrip
    let r1 = drv.query("SELECT 1 AS n", 100).await.unwrap();
    assert_eq!(r1.columns.len(), 1);
    assert_eq!(r1.rows.len(), 1);
    assert_eq!(r1.rows[0][0], serde_json::json!(1));

    // list_schemas: must contain "main"
    let schemas = drv.list_schemas().await.unwrap();
    assert!(
        schemas.iter().any(|s| s == "main"),
        "list_schemas should include 'main', got: {:?}",
        schemas
    );

    // list_tables("main"): must contain "t"
    let tables = drv.list_tables("main").await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == "t"),
        "list_tables('main') should include 't', got: {:?}",
        tables
    );

    // table_structure: id column must be PK
    let st = drv.table_structure("main", "t").await.unwrap();
    assert!(
        st.columns.iter().any(|c| c.name == "id" && c.key == "PK"),
        "expected id column with key=PK, got: {:?}",
        st.columns
    );
    assert!(
        st.columns.iter().any(|c| c.name == "name"),
        "expected name column, got: {:?}",
        st.columns
    );
}
