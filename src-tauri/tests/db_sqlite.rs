use catio_lib::db::driver::{connect, ConnectArgs};
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
    drv.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 1).await.unwrap();
    drv.query("INSERT INTO t (name) VALUES ('alice'), ('bob')", 1).await.unwrap();
    let r = drv.query("SELECT id, name FROM t ORDER BY id", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][1], serde_json::json!("alice"));
    let st = drv.table_structure("main", "t").await.unwrap();
    assert!(st.columns.iter().any(|c| c.name == "id" && c.key == "PK"));
}
