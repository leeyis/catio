use catio_lib::db::{driver::{connect, ConnectArgs, Driver}, DatabaseType};
use serde_json::{json, Value};
fn args(db_type: DatabaseType) -> ConnectArgs { ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
    driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None, ca_cert_path: None, ssl_reject_unauthorized: None } }
fn external(kind: DatabaseType, key: &str) -> Option<ConnectArgs> {
    let Ok(raw) = std::env::var(key) else { eprintln!("SKIP {key}"); return None; };
    let p: Vec<_> = raw.splitn(5, ':').collect();
    Some(ConnectArgs { host: p[0].into(), port: p[1].parse().unwrap(), user: p[2].into(), secret: Some(p[3].into()), database: Some(p[4].into()), ..args(kind) })
}
fn verify(rows: &Value, from_schema: &str, to_schema: &str, child: &str, parent: &str) {
    let keys: Vec<_> = rows.as_array().unwrap().iter().filter(|r| r["from"] == child).collect();
    assert_eq!(keys.len(), 2, "a composite FK must contain exactly two pairs");
    assert_eq!(keys.iter().map(|r| r["ordinal"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2)]);
    for key in &keys {
        assert_eq!(key["fromSchema"], from_schema); assert_eq!(key["toSchema"], to_schema); assert_eq!(key["to"], parent);
        assert_eq!(key["columnCount"], 2); assert!(key["constraintId"].as_str().is_some_and(|s| !s.is_empty()));
    }
    assert_eq!(keys[0]["constraintId"], keys[1]["constraintId"]);
    assert_eq!(keys[0]["fromCol"], "x"); assert_eq!(keys[0]["toCol"], "b");
    assert_eq!(keys[1]["fromCol"], "y"); assert_eq!(keys[1]["toCol"], "a");
}
async fn read(d: &dyn Driver, schema: &str) -> Value { serde_json::to_value(d.er_relations(schema).await.unwrap()).unwrap() }
#[tokio::test]
async fn sqlite_fk_identity_including_implicit_primary_key() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE \"p.with.dot\"(b INT, a INT, PRIMARY KEY(b,a))", 0).await.unwrap();
    d.query("CREATE TABLE child(x INT, y INT, FOREIGN KEY(x,y) REFERENCES \"p.with.dot\")", 0).await.unwrap();
    verify(&read(d.as_ref(), "main").await, "main", "main", "child", "p.with.dot");
    d.query("ATTACH DATABASE ':memory:' AS \"other.ns\"", 0).await.unwrap();
    d.query("CREATE TABLE \"other.ns\".p(b INT, a INT, PRIMARY KEY(b,a))", 0).await.unwrap();
    d.query("CREATE TABLE \"other.ns\".child(x INT, y INT, FOREIGN KEY(x,y) REFERENCES p(b,a))", 0).await.unwrap();
    verify(&read(d.as_ref(), "other.ns").await, "other.ns", "other.ns", "child", "p");
}
#[tokio::test]
async fn duckdb_composite_pairs_do_not_cross_product() {
    let d = connect(&args(DatabaseType::Duckdb)).await.unwrap();
    d.query("CREATE TABLE parent(b INT, a INT, PRIMARY KEY(b,a))", 0).await.unwrap();
    d.query("CREATE TABLE child(x INT, y INT, FOREIGN KEY(x,y) REFERENCES parent(b,a))", 0).await.unwrap();
    verify(&read(d.as_ref(), "main").await, "main", "main", "child", "parent");
}
#[tokio::test]
async fn h2_cross_schema_composite_foreign_key_identity() {
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref() != Some("1") { eprintln!("SKIP CATIO_TEST_JDBC"); return; }
    let d = connect(&ConnectArgs { host: String::new(), user: "sa".into(), secret: Some(String::new()), driver_profile: Some("h2".into()),
        database: Some(format!("mem:fk_identity_{};DB_CLOSE_DELAY=-1", std::process::id())), ..args(DatabaseType::Jdbc) }).await.unwrap();
    d.query("CREATE SCHEMA APP", 0).await.unwrap(); d.query("CREATE SCHEMA OTHER", 0).await.unwrap();
    d.query("CREATE TABLE OTHER.\"parent\"(\"b\" INT, \"a\" INT, PRIMARY KEY(\"b\",\"a\"))", 0).await.unwrap();
    d.query("CREATE TABLE APP.\"child\"(\"x\" INT, \"y\" INT, CONSTRAINT FK_PAIR FOREIGN KEY(\"x\",\"y\") REFERENCES OTHER.\"parent\"(\"b\",\"a\"))", 0).await.unwrap();
    verify(&read(d.as_ref(), "APP").await, "APP", "OTHER", "child", "parent");
}
#[tokio::test]
async fn rqlite_implicit_composite_foreign_key_identity() {
    let Some(a) = external(DatabaseType::Rqlite, "CATIO_TEST_RQLITE_URL") else { return; };
    let d = connect(&a).await.unwrap(); let parent = format!("catio_fk_parent_{}", std::process::id()); let child = format!("catio_fk_child_{}", std::process::id());
    d.query(&format!("CREATE TABLE {parent}(b INT, a INT, PRIMARY KEY(b,a))"), 0).await.unwrap();
    d.query(&format!("CREATE TABLE {child}(x INT, y INT, FOREIGN KEY(x,y) REFERENCES {parent})"), 0).await.unwrap();
    let result = d.er_relations("main").await;
    d.query(&format!("DROP TABLE {child}"), 0).await.unwrap(); d.query(&format!("DROP TABLE {parent}"), 0).await.unwrap();
    verify(&serde_json::to_value(result.unwrap()).unwrap(), "main", "main", &child, &parent);
}
#[tokio::test]
async fn external_cross_namespace_foreign_keys() {
    for (kind, env) in [(DatabaseType::Postgres, "CATIO_TEST_PG_URL"), (DatabaseType::Mysql, "CATIO_TEST_MYSQL_URL"), (DatabaseType::Sqlserver, "CATIO_TEST_MSSQL_URL")] {
        let Some(a) = external(kind, env) else { continue; }; let d = connect(&a).await.unwrap();
        let source = format!("catio_fk_src_{}", std::process::id()); let target = format!("catio_fk_dst_{}", std::process::id());
        let ns_kind = if kind == DatabaseType::Mysql { "DATABASE" } else { "SCHEMA" };
        d.query(&format!("CREATE {ns_kind} {source}"), 0).await.unwrap(); d.query(&format!("CREATE {ns_kind} {target}"), 0).await.unwrap();
        d.query(&format!("CREATE TABLE {target}.parent(b INT NOT NULL, a INT NOT NULL, PRIMARY KEY(b,a))"), 0).await.unwrap();
        d.query(&format!("CREATE TABLE {source}.child(x INT, y INT, CONSTRAINT fk_pair FOREIGN KEY(x,y) REFERENCES {target}.parent(b,a))"), 0).await.unwrap();
        let result = d.er_relations(&source).await;
        d.query(&format!("DROP TABLE {source}.child"), 0).await.unwrap(); d.query(&format!("DROP TABLE {target}.parent"), 0).await.unwrap();
        d.query(&format!("DROP {ns_kind} {source}"), 0).await.unwrap(); d.query(&format!("DROP {ns_kind} {target}"), 0).await.unwrap();
        verify(&serde_json::to_value(result.unwrap()).unwrap(), &source, &target, "child", "parent");
    }
}
