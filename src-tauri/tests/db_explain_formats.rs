use catio_lib::db::{driver::{connect, ConnectArgs}, DatabaseType, query_explain_sql::build_explain_sql, query_session::TransactionState};
use serde_json::json;
fn args(db_type: DatabaseType) -> ConnectArgs { ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
    driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None, ca_cert_path: None, ssl_reject_unauthorized: None } }
fn external(kind: DatabaseType, key: &str) -> Option<ConnectArgs> {
    let Ok(raw) = std::env::var(key) else { eprintln!("SKIP {key}"); return None; }; let p: Vec<_> = raw.splitn(5, ':').collect();
    Some(ConnectArgs { host:p[0].into(),port:p[1].parse().unwrap(),user:p[2].into(),secret:Some(p[3].into()),database:Some(p[4].into()),..args(kind) })
}
async fn session_plan(config: ConnectArgs) {
    let engine = config.db_type; let parent = connect(&config).await.unwrap(); let session = parent.fork_query_session().await.unwrap();
    session.query("CREATE TEMPORARY TABLE catio_plan_local(id INTEGER PRIMARY KEY, amount INTEGER)",0).await.unwrap();
    session.query("BEGIN",0).await.unwrap(); session.query("INSERT INTO catio_plan_local VALUES(1,17)",0).await.unwrap();
    let sql = build_explain_sql(engine,"SELECT amount FROM catio_plan_local WHERE id=1").sql.unwrap();
    assert!(!sql.to_uppercase().contains("ANALYZE"));
    let result = session.query(&sql,1000).await.unwrap(); assert!(!result.rows.is_empty());
    let expected = if engine == DatabaseType::Sqlite { "detail" } else if engine == DatabaseType::Duckdb { "explain_value" } else if engine == DatabaseType::Mysql { "EXPLAIN" } else { "QUERY PLAN" };
    assert!(result.columns.iter().any(|c|c.name.eq_ignore_ascii_case(expected)),"{engine:?}: {:?}",result.columns);
    assert_eq!(session.transaction_state().await.unwrap(),TransactionState::Active);
    assert_eq!(session.query("SELECT amount FROM catio_plan_local",1).await.unwrap().rows[0][0],json!(17));
    session.query("ROLLBACK",0).await.unwrap(); assert_eq!(session.query("SELECT COUNT(*) FROM catio_plan_local",1).await.unwrap().rows[0][0],json!(0));
    session.close_query_session().await.unwrap();
}
#[tokio::test] async fn sqlite_plan_stays_in_the_active_physical_session(){session_plan(args(DatabaseType::Sqlite)).await;}
#[tokio::test] async fn duckdb_json_plan_stays_in_the_active_physical_session(){session_plan(args(DatabaseType::Duckdb)).await;}
#[tokio::test] async fn postgres_plan_stays_in_the_active_physical_session(){if let Some(a)=external(DatabaseType::Postgres,"CATIO_TEST_PG_URL"){session_plan(a).await;}}
#[tokio::test] async fn mysql_plan_stays_in_the_active_physical_session(){if let Some(a)=external(DatabaseType::Mysql,"CATIO_TEST_MYSQL_URL"){session_plan(a).await;}}
#[tokio::test]
async fn rqlite_plan_does_not_execute_a_write() {
    let Some(a)=external(DatabaseType::Rqlite,"CATIO_TEST_RQLITE_URL") else{return;};let d=connect(&a).await.unwrap();
    let table=format!("catio_plan_{}",std::process::id());d.query(&format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY)"),0).await.unwrap();
    let sql=build_explain_sql(DatabaseType::Rqlite,&format!("SELECT id FROM {table}")).sql.unwrap();
    let result=d.query(&sql,1000).await;let count=d.query(&format!("SELECT COUNT(*) FROM {table}"),1).await.unwrap();
    d.query(&format!("DROP TABLE {table}"),0).await.unwrap();
    assert!(result.unwrap().columns.iter().any(|c|c.name=="detail"));assert_eq!(count.rows[0][0],json!(0));
}
