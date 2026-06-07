use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::dml::{build_update, CellEdit};
use catio_lib::db::DatabaseType;

fn mem_args() -> ConnectArgs {
    ConnectArgs {
        db_type: DatabaseType::Sqlite,
        host: ":memory:".into(),
        port: 0,
        user: String::new(),
        database: None,
        driver_profile: None,
        secret: None,
    }
}

#[tokio::test]
async fn sqlite_roundtrip_and_introspect() {
    let drv = connect(&mem_args()).await.expect("connect");
    drv.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE)", 1).await.unwrap();
    drv.query("INSERT INTO t (name, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com')", 1).await.unwrap();
    let r = drv.query("SELECT id, name FROM t ORDER BY id", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][1], serde_json::json!("alice"));
    let st = drv.table_structure("main", "t").await.unwrap();
    assert!(st.columns.iter().any(|c| c.name == "id" && c.key == "PK"));
    // UNIQUE constraint on a non-PK column must be annotated as "UNI"
    assert!(st.columns.iter().any(|c| c.name == "email" && c.key == "UNI"),
        "expected email column to have key=UNI, got: {:?}",
        st.columns.iter().find(|c| c.name == "email"));
}

#[tokio::test]
async fn sqlite_edit_roundtrip() {
    let drv = connect(&mem_args()).await.unwrap();
    drv.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 1).await.unwrap();
    drv.query("INSERT INTO t (id, name) VALUES (1, 'old')", 1).await.unwrap();
    // build_update uses double-quote ident for SQLite: "main"."t"
    let sql = build_update(
        DatabaseType::Sqlite,
        Some("main"),
        "t",
        &[("id".into(), serde_json::json!(1))],
        &[CellEdit { column: "name".into(), new_value: serde_json::json!("new") }],
    );
    drv.query(&sql, 0).await.unwrap();
    let r = drv.query("SELECT name FROM t WHERE id = 1", 1).await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!("new"));
}
