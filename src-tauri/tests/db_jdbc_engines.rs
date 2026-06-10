//! Real-engine JDBC sidecar tests (Oracle, DB2) through the Java plugin with
//! user-supplied driver JARs. Proves the full bridge against genuine commercial
//! engines — connect, version, query, table-data editing (DML round-trip), and
//! introspection.
//!
//! Each engine is gated by its own env var (URL form host:port:user:pw:db) so the
//! suite skips cleanly without Docker. The driver JAR dir is CATIO_JDBC_DRIVERS_DIR
//! and the JVM/plugin jar are located via CATIO_JAVA_BIN / CATIO_JDBC_PLUGIN_JAR.

use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::dml::{self, CellEdit};
use catio_lib::db::DatabaseType;
use serde_json::json;

fn jdbc_args(env_var: &str, profile: &str) -> Option<ConnectArgs> {
    let raw = std::env::var(env_var).ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        eprintln!("SKIP {env_var}: expected host:port:user:pw:db");
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Jdbc,
        driver_profile: Some(profile.into()),
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
    })
}

/// Shared round-trip: connect → version → DDL → INSERT/UPDATE/DELETE via the DML
/// builder → SELECT verify → introspection. Identifiers are quoted in DDL so they
/// round-trip with the DML builder (which quotes) on engines that fold unquoted
/// names (Oracle uppercases) — in-app the grid uses introspected names.
async fn run_roundtrip(args: ConnectArgs, schema: &str, version_needle: &str) {
    let drv = connect(&args).await.expect("connect via JDBC sidecar");
    let version = drv.test().await.expect("test()");
    assert!(version.to_uppercase().contains(&version_needle.to_uppercase()),
        "expected {version_needle} in version, got: {version}");

    let db = DatabaseType::Jdbc;
    let table = "catio_it";

    drv.query(r#"DROP TABLE "catio_it""#, 1).await.ok();
    drv.query(r#"CREATE TABLE "catio_it" ("id" INT PRIMARY KEY, "name" VARCHAR(40), "qty" INT)"#, 1)
        .await.expect("create");

    let insert = dml::build_insert(db, None, table, &[
        CellEdit { column: "id".into(),   new_value: json!(1) },
        CellEdit { column: "name".into(), new_value: json!("alpha") },
        CellEdit { column: "qty".into(),  new_value: json!(10) },
    ]);
    assert_eq!(drv.query(&insert, 0).await.expect("insert").rows_affected, Some(1));

    let update = dml::build_update(db, None, table,
        &[("id".into(), json!(1))],
        &[CellEdit { column: "qty".into(), new_value: json!(55) }]);
    assert_eq!(drv.query(&update, 0).await.expect("update").rows_affected, Some(1));

    let r = drv.query(r#"SELECT "qty" FROM "catio_it" WHERE "id" = 1"#, 10).await.expect("select");
    assert_eq!(r.rows[0][0], json!(55), "qty should be 55 after update");

    // introspection: the table + PK column show up
    let tables = drv.list_tables(schema).await.expect("list_tables");
    assert!(tables.iter().any(|t| t.name.eq_ignore_ascii_case("catio_it")),
        "catio_it missing from {schema}: {tables:?}");
    let st = drv.table_structure(schema, "catio_it").await.expect("table_structure");
    assert!(st.columns.iter().any(|c| c.name.eq_ignore_ascii_case("id") && c.key == "PK"),
        "expected id PK, got: {:?}", st.columns);

    let delete = dml::build_delete(db, None, table, &[("id".into(), json!(1))]);
    assert_eq!(drv.query(&delete, 0).await.expect("delete").rows_affected, Some(1));

    drv.query(r#"DROP TABLE "catio_it""#, 1).await.ok();
}

#[tokio::test]
async fn jdbc_oracle_roundtrip() {
    // CATIO_TEST_JDBC_ORACLE=127.0.0.1:11521:system:catio:XEPDB1
    let Some(args) = jdbc_args("CATIO_TEST_JDBC_ORACLE", "oracle") else { return; };
    // Oracle schema = the connecting user, upper-cased (SYSTEM).
    run_roundtrip(args, "SYSTEM", "oracle").await;
}

#[tokio::test]
async fn jdbc_db2_roundtrip() {
    // CATIO_TEST_JDBC_DB2=127.0.0.1:50000:db2inst1:catio:catio
    let Some(args) = jdbc_args("CATIO_TEST_JDBC_DB2", "db2") else { return; };
    // DB2 default schema = the connecting user, upper-cased (DB2INST1).
    run_roundtrip(args, "DB2INST1", "db2").await;
}
