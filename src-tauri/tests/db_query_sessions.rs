//! Independent physical sessions must share a database, not transaction state or temporary tables.
use catio_lib::db::{driver::{connect,ConnectArgs},DatabaseType,query_session::TransactionState};
use serde_json::json;
fn args(db_type:DatabaseType)->ConnectArgs {ConnectArgs{db_type,host:":memory:".into(),port:0,user:String::new(),database:None,
    driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None}}
fn external(db:DatabaseType,key:&str)->Option<ConnectArgs>{
    let Ok(raw)=std::env::var(key) else {eprintln!("SKIP {key}");return None;};let p:Vec<_>=raw.splitn(5,':').collect();assert_eq!(p.len(),5);
    Some(ConnectArgs{host:p[0].into(),port:p[1].parse().unwrap(),user:p[2].into(),secret:Some(p[3].into()),database:Some(p[4].into()),..args(db)})
}
async fn contract(config:ConnectArgs) {
    let db=config.db_type;let parent=connect(&config).await.unwrap();
    let table=format!("catio_sessions_{}",std::process::id());
    parent.query(&format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY)"),0).await.unwrap();
    let a=parent.fork_query_session().await.unwrap();let b=parent.fork_query_session().await.unwrap();
    let temporary=if db==DatabaseType::Sqlserver {"#catio_local"} else {"catio_local"};
    a.query(&format!("CREATE {}TABLE {temporary}(id INTEGER)",if db==DatabaseType::Sqlserver{""}else{"TEMPORARY "}),0).await.unwrap();
    assert!(b.query(&format!("SELECT * FROM {temporary}"),1).await.is_err(),"temporary table leaked to another session");
    assert_eq!(a.transaction_state().await.unwrap(),TransactionState::Idle);
    let begin=if db==DatabaseType::Sqlserver {"BEGIN TRANSACTION"} else {"BEGIN"};
    a.query(begin,0).await.unwrap();
    a.query(&format!("INSERT INTO {table} VALUES(1)"),0).await.unwrap();
    assert_eq!(a.transaction_state().await.unwrap(),TransactionState::Active);
    assert_eq!(b.transaction_state().await.unwrap(),TransactionState::Idle);
    // Some engines block the reader instead of returning its earlier snapshot.
    let reader=b.clone();let sql=format!("SELECT COUNT(*) FROM {table}");
    let read=tokio::spawn(async move{reader.query(&sql,1).await});
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    a.close_query_session().await.unwrap();
    let result=tokio::time::timeout(std::time::Duration::from_secs(5),read).await.unwrap().unwrap();
    match result {
        Ok(result)=>assert_eq!(result.rows[0][0],json!(0),"uncommitted row leaked"),
        Err(error) if db==DatabaseType::Sqlite=>assert!(error.to_string().contains("locked"),"{error}"),
        Err(error)=>panic!("{db:?}: {error}"),
    }
    assert!(a.query("SELECT 1",1).await.is_err(),"closed session still accepts work");
    assert_eq!(parent.query(&format!("SELECT COUNT(*) FROM {table}"),1).await.unwrap().rows[0][0],json!(0));
    b.query(begin,0).await.unwrap();b.query(&format!("INSERT INTO {table} VALUES(2)"),0).await.unwrap();b.query("COMMIT",0).await.unwrap();
    assert_eq!(b.transaction_state().await.unwrap(),TransactionState::Idle);
    b.close_query_session().await.unwrap();
    assert_eq!(parent.query(&format!("SELECT id FROM {table}"),1).await.unwrap().rows[0][0],json!(2));
    parent.query(&format!("DROP TABLE {table}"),0).await.unwrap();
}
#[tokio::test]
async fn duckdb_rollback_remains_available_with_a_default_namespace_after_failure() {
    let parent=connect(&args(DatabaseType::Duckdb)).await.unwrap();
    parent.query("CREATE TABLE tx_error(id INTEGER PRIMARY KEY)",0).await.unwrap();
    let child=parent.fork_query_session().await.unwrap();child.query("BEGIN",0).await.unwrap();
    child.query("INSERT INTO tx_error VALUES(1)",0).await.unwrap();
    assert!(child.query("INSERT INTO tx_error VALUES(1)",0).await.is_err());
    assert_eq!(child.transaction_state().await.unwrap(),TransactionState::Failed);
    child.query_with_default_namespace("ROLLBACK",0,Some("main")).await.unwrap();
    assert_eq!(child.transaction_state().await.unwrap(),TransactionState::Idle);
    assert_eq!(parent.query("SELECT COUNT(*) FROM tx_error",1).await.unwrap().rows[0][0],json!(0));
    child.close_query_session().await.unwrap();
}
#[tokio::test] async fn sqlite_query_sessions_are_independent(){contract(args(DatabaseType::Sqlite)).await;}
#[tokio::test] async fn duckdb_query_sessions_are_independent(){contract(args(DatabaseType::Duckdb)).await;}
#[tokio::test] async fn postgres_query_sessions_are_independent(){if let Some(a)=external(DatabaseType::Postgres,"CATIO_TEST_PG_URL"){contract(a).await;}}
#[tokio::test] async fn mysql_query_sessions_are_independent(){if let Some(a)=external(DatabaseType::Mysql,"CATIO_TEST_MYSQL_URL"){contract(a).await;}}
#[tokio::test] async fn sqlserver_query_sessions_are_independent(){if let Some(a)=external(DatabaseType::Sqlserver,"CATIO_TEST_MSSQL_URL"){contract(a).await;}}
#[tokio::test]
async fn postgres_failed_transaction_is_observed_without_querying_the_aborted_session() {
    let Some(a)=external(DatabaseType::Postgres,"CATIO_TEST_PG_URL") else{return;};
    let parent=connect(&a).await.unwrap();let child=parent.fork_query_session().await.unwrap();
    child.query("BEGIN",0).await.unwrap();assert!(child.query("SELECT * FROM missing_catio_session_relation",1).await.is_err());
    assert_eq!(child.transaction_state().await.unwrap(),TransactionState::Failed);
    child.query("ROLLBACK",0).await.unwrap();assert_eq!(child.transaction_state().await.unwrap(),TransactionState::Idle);
    child.close_query_session().await.unwrap();
}
