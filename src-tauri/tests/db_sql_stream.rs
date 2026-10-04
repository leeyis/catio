use catio_lib::db::{driver::{connect, ConnectArgs}, sql_file::{SqlStatementSplitter, SqlParsingOptions}, DatabaseType};
use serde_json::json;
fn args(db_type: DatabaseType) -> ConnectArgs { ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
    driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None, ca_cert_path: None, ssl_reject_unauthorized: None } }
fn fragmented(source: &str, engine: DatabaseType) -> Vec<String> {
    let mut splitter = SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(engine)); let mut statements = Vec::new();
    for ch in source.chars() { statements.extend(splitter.push_chunk(&ch.to_string())); }
    statements.extend(splitter.finish()); statements
}
#[tokio::test]
async fn sqlite_fragmented_comments_cannot_turn_into_extra_inserts() {
    for comment in ["-- note; INSERT INTO t VALUES(99,'must not execute');\n", "/* note; INSERT INTO t VALUES(99,'must not execute'); */"] {
        let driver = connect(&args(DatabaseType::Sqlite)).await.unwrap();
        let source = format!("CREATE TABLE t(id INT,label TEXT);{comment}INSERT INTO t VALUES(1,'中文');SELECT id,label FROM t;");
        let statements = fragmented(&source, DatabaseType::Sqlite); assert_eq!(statements.len(), 3);
        let mut last = None; for statement in statements { last = Some(driver.query(&statement, 10).await.unwrap()); }
        assert_eq!(last.unwrap().rows, vec![vec![json!(1),json!("中文")]]);
    }
}
#[tokio::test]
async fn postgres_fragmented_dollar_body_keeps_its_internal_statements() {
    let Ok(raw) = std::env::var("CATIO_TEST_PG_URL") else { eprintln!("SKIP CATIO_TEST_PG_URL"); return; };
    let p: Vec<_> = raw.splitn(5, ':').collect();
    let config = ConnectArgs {host:p[0].into(),port:p[1].parse().unwrap(),user:p[2].into(),secret:Some(p[3].into()),database:Some(p[4].into()),..args(DatabaseType::Postgres)};
    let driver = connect(&config).await.unwrap(); let table = format!("catio_stream_{}",std::process::id());
    let source = format!("CREATE TABLE {table}(id INT);DO $body$ BEGIN INSERT INTO {table} VALUES(1); INSERT INTO {table} VALUES(2); END $body$;SELECT COUNT(*) FROM {table};");
    let statements = fragmented(&source, DatabaseType::Postgres); assert_eq!(statements.len(), 3);
    let mut last = None; for statement in statements { last = Some(driver.query(&statement, 10).await.unwrap()); }
    driver.query(&format!("DROP TABLE {table}"),0).await.unwrap();
    assert_eq!(last.unwrap().rows[0][0],json!(2));
}
