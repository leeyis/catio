//! End-to-end JDBC sidecar test: catio JdbcDriver → Java plugin → embedded H2.
//! Proves the whole bridge (connect, query, DML edit round-trip, introspection)
//! with NO external server — H2 is bundled in the plugin jar.
//!
//! Gated by CATIO_TEST_JDBC=1 (needs a JVM). The harness also honours
//! CATIO_JAVA_BIN / CATIO_JDBC_PLUGIN_JAR for locating the runtime + jar.

use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::dml::{self, CellEdit};
use catio_lib::db::DatabaseType;
use serde_json::json;

fn h2_args() -> Option<ConnectArgs> {
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref() != Some("1") {
        eprintln!("SKIP db_jdbc_h2: set CATIO_TEST_JDBC=1 (and a JVM) to run");
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Jdbc,
        driver_profile: Some("h2".into()),
        host: String::new(),
        port: 0,
        user: "sa".into(),
        secret: Some(String::new()),
        // shared in-memory DB kept alive for the connection's lifetime
        database: Some("mem:catio_it;DB_CLOSE_DELAY=-1".into()),
    })
}

#[tokio::test]
async fn jdbc_h2_full_roundtrip() {
    let Some(args) = h2_args() else { return; };
    let drv = connect(&args).await.expect("connect via JDBC sidecar");

    // test() surfaces the product version
    let version = drv.test().await.expect("test()");
    assert!(version.to_uppercase().contains("H2"), "expected H2 version, got: {version}");

    // Quote identifiers in DDL so H2 stores them exactly as the DML builder
    // (which quotes) will reference them — H2 folds *unquoted* names to upper
    // case. In the real app the grid uses names from introspection, which are
    // already consistent; this just makes the hand-written fixture round-trip.
    drv.query(r#"DROP TABLE IF EXISTS "items""#, 1).await.ok();
    drv.query(r#"CREATE TABLE "items" ("id" INT PRIMARY KEY, "name" VARCHAR(40), "qty" INT)"#, 1)
        .await.expect("create");

    // INSERT via the DML builder (the "table data editing" path)
    let db = DatabaseType::Jdbc;
    let insert = dml::build_insert(db, None, "items", &[
        CellEdit { column: "id".into(),   new_value: json!(1) },
        CellEdit { column: "name".into(), new_value: json!("widget") },
        CellEdit { column: "qty".into(),  new_value: json!(7) },
    ]);
    assert_eq!(drv.query(&insert, 0).await.expect("insert").rows_affected, Some(1));

    // UPDATE via the DML builder
    let update = dml::build_update(db, None, "items",
        &[("id".into(), json!(1))],
        &[CellEdit { column: "qty".into(), new_value: json!(99) }]);
    assert_eq!(drv.query(&update, 0).await.expect("update").rows_affected, Some(1));

    // SELECT and verify the edited value
    let r = drv.query(r#"SELECT "id", "name", "qty" FROM "items""#, 100).await.expect("select");
    assert_eq!(r.columns.len(), 3);
    assert_eq!(r.rows.len(), 1);
    assert_eq!(r.rows[0][2], json!(99), "qty should be updated to 99");

    // Introspection: H2 exposes the table + its PK column
    let tables = drv.list_tables("PUBLIC").await.expect("list_tables");
    assert!(tables.iter().any(|t| t.name.eq_ignore_ascii_case("items")), "items missing: {tables:?}");
    let st = drv.table_structure("PUBLIC", "items").await.expect("table_structure");
    assert!(st.columns.iter().any(|c| c.name.eq_ignore_ascii_case("id") && c.key == "PK"),
        "expected id PK, got: {:?}", st.columns);

    // DELETE via the DML builder
    let delete = dml::build_delete(db, None, "items", &[("id".into(), json!(1))]);
    assert_eq!(drv.query(&delete, 0).await.expect("delete").rows_affected, Some(1));
    let r = drv.query(r#"SELECT COUNT(*) FROM "items""#, 10).await.expect("count");
    assert_eq!(r.rows[0][0], json!(0));

    drv.query(r#"DROP TABLE "items""#, 1).await.ok();
}

#[tokio::test]
async fn jdbc_unknown_engine_is_unsupported() {
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref() != Some("1") { return; }
    let args = ConnectArgs {
        db_type: DatabaseType::Jdbc,
        driver_profile: Some("not-a-real-engine".into()),
        host: "h".into(), port: 1, user: "u".into(), secret: None,
        database: None,
    };
    let err = connect(&args).await.err().expect("should fail for unknown engine");
    assert!(matches!(err, catio_lib::db::DbError::Unsupported(_)), "got: {err:?}");
}
