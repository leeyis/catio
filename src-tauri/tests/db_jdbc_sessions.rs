//! Same-JVM JDBC sessions, concurrent request routing and statement cancellation (real bundled H2).
use std::{sync::Arc,time::Duration};
use catio_lib::db::{driver::{connect,ConnectArgs},DatabaseType,manager::ConnManager,query_session::TransactionAction};
use serde_json::json;
async fn manager()->Option<Arc<ConnManager>> {
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref()!=Some("1"){eprintln!("SKIP CATIO_TEST_JDBC");return None;}
    let args=ConnectArgs{db_type:DatabaseType::Jdbc,host:String::new(),port:0,user:"sa".into(),database:Some("mem:session_test;DB_CLOSE_DELAY=-1".into()),
        driver_profile:Some("h2".into()),options:None,secret:Some(String::new()),ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None};
    let manager=Arc::new(ConnManager::default());manager.insert("jdbc".into(),connect(&args).await.unwrap()).await;Some(manager)
}
#[tokio::test]
async fn jdbc_child_sessions_share_database_and_close_without_killing_siblings() {
    let Some(m)=manager().await else{return;};
    m.query("jdbc","CREATE TABLE DATA(ID INT)",0,None,None,None).await.unwrap();
    let a=m.open_query_session("jdbc").await.unwrap();let b=m.open_query_session("jdbc").await.unwrap();
    let state=m.query_session_transaction("jdbc",&a.id,TransactionAction::Begin).await.unwrap();
    assert!(matches!(serde_json::to_value(state).unwrap()["transactionState"].as_str(),Some("manual"|"active")));
    m.query_in_session("jdbc","INSERT INTO DATA VALUES(1)",0,None,None,None,Some(&a.id)).await.unwrap();
    assert_eq!(m.query_in_session("jdbc","SELECT COUNT(*) FROM DATA",1,None,None,None,Some(&b.id)).await.unwrap().rows[0][0],json!(0));
    m.close_query_session("jdbc",&a.id).await.unwrap();
    assert_eq!(m.query_in_session("jdbc","SELECT COUNT(*) FROM DATA",1,None,None,None,Some(&b.id)).await.unwrap().rows[0][0],json!(0));
    m.query_session_transaction("jdbc",&b.id,TransactionAction::Begin).await.unwrap();
    m.query_in_session("jdbc","INSERT INTO DATA VALUES(2)",0,None,None,None,Some(&b.id)).await.unwrap();
    m.query_session_transaction("jdbc",&b.id,TransactionAction::Commit).await.unwrap();
    assert_eq!(m.query("jdbc","SELECT ID FROM DATA",1,None,None,None).await.unwrap().rows[0][0],json!(2));
    m.remove("jdbc").await;
}
#[tokio::test]
async fn jdbc_long_query_does_not_block_other_sessions_and_cancel_is_request_scoped() {
    let Some(m)=manager().await else{return;};let a=m.open_query_session("jdbc").await.unwrap();let b=m.open_query_session("jdbc").await.unwrap();
    let worker=m.clone();let id=a.id.clone();
    let job=tokio::spawn(async move{worker.query_in_session("jdbc","SELECT SUM(X) FROM SYSTEM_RANGE(1,1000000000)",1,None,Some("slow-h2"),None,Some(&id)).await});
    tokio::time::timeout(Duration::from_secs(3),async{while !m.running.has_active(&a.id){tokio::task::yield_now().await;}}).await.unwrap();
    let fast=tokio::time::timeout(Duration::from_secs(3),m.query_in_session("jdbc","SELECT 7",1,None,None,None,Some(&b.id))).await.expect("one slow session blocked a different physical session").unwrap();
    assert_eq!(fast.rows[0][0],json!(7));assert!(!job.is_finished());
    m.cancel_query_in_session("jdbc","slow-h2",Some(&a.id)).await.unwrap();
    let result=tokio::time::timeout(Duration::from_secs(6),job).await.unwrap().unwrap();assert!(matches!(result,Err(catio_lib::db::DbError::Cancelled)),"{result:?}");
    assert_eq!(m.query_in_session("jdbc","SELECT 9",1,None,None,None,Some(&b.id)).await.unwrap().rows[0][0],json!(9));
    assert_eq!(m.query_in_session("jdbc","SELECT 4",1,None,None,None,Some(&a.id)).await.unwrap().rows[0][0],json!(4));
    m.remove("jdbc").await;
}
#[tokio::test]
async fn dropping_a_child_outside_tokio_still_releases_its_transaction() {
    let Some(m)=manager().await else{return;};let parent=m.get("jdbc").await.unwrap();
    parent.query("CREATE TABLE DROP_SCOPE(ID INT PRIMARY KEY)",0).await.unwrap();
    let child=parent.fork_query_session().await.unwrap();
    child.transaction_command(TransactionAction::Begin,tokio_util::sync::CancellationToken::new()).await.unwrap();
    child.query("INSERT INTO DROP_SCOPE VALUES(1)",0).await.unwrap();
    std::thread::spawn(move||drop(child)).join().unwrap();
    tokio::time::timeout(Duration::from_secs(3),parent.query("INSERT INTO DROP_SCOPE VALUES(1)",0)).await
        .expect("dropped child retained a database lock").unwrap();
    m.remove("jdbc").await;
}
#[tokio::test]
async fn jdbc_session_paging_and_early_cancel_preserve_context() {
    let Some(m)=manager().await else{return;};let a=m.open_query_session("jdbc").await.unwrap();
    m.query_in_session("jdbc","CREATE LOCAL TEMPORARY TABLE PAGED(ID INT)",0,None,None,None,Some(&a.id)).await.unwrap();
    m.query_in_session("jdbc","INSERT INTO PAGED SELECT X FROM SYSTEM_RANGE(1,205)",0,None,None,None,Some(&a.id)).await.unwrap();
    let page=m.query_page_in_session("jdbc",&a.id,"SELECT ID FROM PAGED ORDER BY ID",100,200,None).await.unwrap();
    assert_eq!(page.rows.len(),5);assert_eq!(page.rows[0][0],json!(201));assert!(!page.truncated);
    m.cancel_query_in_session("jdbc","early",Some(&a.id)).await.unwrap();
    assert!(m.query_in_session("jdbc","DELETE FROM PAGED",0,None,Some("early"),None,Some(&a.id)).await.is_err());
    assert_eq!(m.query_in_session("jdbc","SELECT COUNT(*) FROM PAGED",1,None,None,None,Some(&a.id)).await.unwrap().rows[0][0],json!(205));
    m.remove("jdbc").await;
}
