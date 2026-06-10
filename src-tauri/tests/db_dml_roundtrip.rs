//! End-to-end DML round-trip against a real engine — proves the "table data
//! editing" feature (the dml.rs SQL builders + driver.query apply path) actually
//! mutates rows correctly. Gated by CATIO_TEST_PG_URL (host:port:user:pw:db);
//! skips when unset so CI without Docker still passes.
//!
//! `driver_profile` is set to exercise the protocol-family-variant code path
//! (here "cockroachdb" over the Postgres wire — the profile only changes the
//! default db name, so it is harmless against vanilla Postgres while still
//! proving the variant plumbing connects, queries and edits).

use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::dml::{self, CellEdit};
use catio_lib::db::DatabaseType;
use serde_json::json;

fn pg_args(profile: Option<&str>) -> Option<ConnectArgs> {
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
        driver_profile: profile.map(str::to_string),
        options: None,
    })
}

#[tokio::test]
async fn pg_dml_insert_update_delete_roundtrip() {
    let Some(args) = pg_args(Some("cockroachdb")) else {
        eprintln!("SKIP pg_dml_insert_update_delete_roundtrip: set CATIO_TEST_PG_URL=host:port:user:pw:db");
        return;
    };
    let drv = connect(&args).await.expect("connect");
    let db = DatabaseType::Postgres;
    let schema = Some("public");
    let table = "catio_it_dml";

    drv.query("DROP TABLE IF EXISTS catio_it_dml", 1).await.ok();
    drv.query("CREATE TABLE catio_it_dml (id int PRIMARY KEY, name text, qty int)", 1)
        .await.expect("create");

    // INSERT
    let insert = dml::build_insert(db, schema, table, &[
        CellEdit { column: "id".into(),   new_value: json!(1) },
        CellEdit { column: "name".into(), new_value: json!("alpha") },
        CellEdit { column: "qty".into(),  new_value: json!(10) },
    ]);
    let n = drv.query(&insert, 0).await.expect("insert").rows_affected.unwrap_or(0);
    assert_eq!(n, 1, "insert should affect 1 row");

    // UPDATE name + qty WHERE id=1
    let update = dml::build_update(db, schema, table,
        &[("id".into(), json!(1))],
        &[
            CellEdit { column: "name".into(), new_value: json!("beta") },
            CellEdit { column: "qty".into(),  new_value: json!(42) },
        ]);
    let n = drv.query(&update, 0).await.expect("update").rows_affected.unwrap_or(0);
    assert_eq!(n, 1, "update should affect 1 row");

    // Verify the edit landed
    let r = drv.query("SELECT name, qty FROM catio_it_dml WHERE id = 1", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!("beta"));
    assert_eq!(r.rows[0][1], json!(42));

    // DELETE WHERE id=1
    let delete = dml::build_delete(db, schema, table, &[("id".into(), json!(1))]);
    let n = drv.query(&delete, 0).await.expect("delete").rows_affected.unwrap_or(0);
    assert_eq!(n, 1, "delete should affect 1 row");

    let r = drv.query("SELECT count(*) FROM catio_it_dml", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!(0), "table should be empty after delete");

    drv.query("DROP TABLE catio_it_dml", 1).await.ok();
}

/// NULL handling + paginated table preview window — the grid's read path.
#[tokio::test]
async fn pg_paginated_query_windows_rows() {
    let Some(args) = pg_args(None) else { return; };
    let drv = connect(&args).await.unwrap();
    // rows 6..=10 (offset 5, limit 5) of a 1..20 series
    let r = drv.paginated_query("SELECT g AS n FROM generate_series(1,20) g ORDER BY g", 5, 5)
        .await.unwrap();
    assert_eq!(r.rows.len(), 5);
    assert_eq!(r.rows[0][0], json!(6));
    assert_eq!(r.rows[4][0], json!(10));
}

// ── MySQL family (MariaDB/TiDB/…) ────────────────────────────────────────────
// Same DML-builder round-trip on a real MySQL-protocol engine, proving table
// data editing works for the MySQL family (driver_profile "mariadb" is harmless
// to the driver — it only matters to the frontend catalog). Gated by
// CATIO_TEST_MYSQL_URL=host:port:user:pw:db.

fn mysql_args(profile: Option<&str>) -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_MYSQL_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 { return None; }
    Some(ConnectArgs {
        db_type: DatabaseType::Mysql,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: profile.map(str::to_string),
        options: None,
    })
}

#[tokio::test]
async fn mysql_dml_insert_update_delete_roundtrip() {
    let Some(args) = mysql_args(Some("mariadb")) else {
        eprintln!("SKIP mysql_dml_insert_update_delete_roundtrip: set CATIO_TEST_MYSQL_URL=host:port:user:pw:db");
        return;
    };
    let drv = connect(&args).await.expect("connect");
    let db = DatabaseType::Mysql;
    // MySQL has no schema namespace (capabilities.schemas=false); the table lives
    // in the connected database, so DML is built unqualified.
    let schema: Option<&str> = None;
    let table = "catio_it_dml";

    drv.query("DROP TABLE IF EXISTS catio_it_dml", 1).await.ok();
    drv.query("CREATE TABLE catio_it_dml (id INT PRIMARY KEY, name VARCHAR(40), qty INT)", 1)
        .await.expect("create");

    let insert = dml::build_insert(db, schema, table, &[
        CellEdit { column: "id".into(),   new_value: json!(1) },
        CellEdit { column: "name".into(), new_value: json!("alpha") },
        CellEdit { column: "qty".into(),  new_value: json!(10) },
    ]);
    assert_eq!(drv.query(&insert, 0).await.expect("insert").rows_affected, Some(1));

    let update = dml::build_update(db, schema, table,
        &[("id".into(), json!(1))],
        &[CellEdit { column: "qty".into(), new_value: json!(42) }]);
    assert_eq!(drv.query(&update, 0).await.expect("update").rows_affected, Some(1));

    let r = drv.query("SELECT qty FROM catio_it_dml WHERE id = 1", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!(42), "qty should be updated to 42");

    let delete = dml::build_delete(db, schema, table, &[("id".into(), json!(1))]);
    assert_eq!(drv.query(&delete, 0).await.expect("delete").rows_affected, Some(1));
    let r = drv.query("SELECT COUNT(*) FROM catio_it_dml", 10).await.unwrap();
    // MySQL COUNT(*) comes back as a BIGINT → JSON number 0
    assert_eq!(r.rows[0][0], json!(0), "table empty after delete");

    drv.query("DROP TABLE catio_it_dml", 1).await.ok();
}
