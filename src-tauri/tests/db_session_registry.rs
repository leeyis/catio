use std::sync::Arc;
use catio_lib::db::{driver::{connect,ConnectArgs},DatabaseType,manager::ConnManager,query_session::{TransactionAction,TransactionState}};
use serde_json::json;
async fn parent(manager:&ConnManager,id:&str){
    let a=ConnectArgs{db_type:DatabaseType::Sqlite,host:":memory:".into(),port:0,user:String::new(),database:None,
        driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None};
    manager.insert(id.into(),connect(&a).await.unwrap()).await;
}
#[tokio::test]
async fn session_ids_are_bound_to_their_parent_connection() {
    let m=ConnManager::default();parent(&m,"a").await;parent(&m,"b").await;
    let session=m.open_query_session("a").await.unwrap();
    assert_eq!(session.transaction_state,TransactionState::Idle);
    assert!(m.query_in_session("b","CREATE TABLE wrong(id INT)",0,None,None,None,Some(&session.id)).await.is_err());
    assert!(m.close_query_session("b",&session.id).await.is_err());
    assert!(m.touch_query_session("b",&session.id).await.is_err());
    assert_eq!(m.query_in_session("a","SELECT 7",1,None,None,None,Some(&session.id)).await.unwrap().rows[0][0],json!(7));
    assert!(m.remove("a").await);assert_eq!(m.sessions.count(),0);
    assert!(m.query_in_session("a","SELECT 1",1,None,None,None,Some(&session.id)).await.is_err());
}
#[tokio::test]
async fn transaction_actions_and_pagination_keep_the_same_session() {
    let m=ConnManager::default();parent(&m,"a").await;
    let session=m.open_query_session("a").await.unwrap();
    m.query_in_session("a","CREATE TEMPORARY TABLE local_only(id INTEGER)",0,None,None,None,Some(&session.id)).await.unwrap();
    let state=m.query_session_transaction("a",&session.id,TransactionAction::Begin).await.unwrap();
    assert_eq!(state.transaction_state,TransactionState::Active);
    assert!(m.query_session_transaction("a",&session.id,TransactionAction::Begin).await.is_err());
    m.query_in_session("a","INSERT INTO local_only VALUES(1),(2),(3)",0,None,None,None,Some(&session.id)).await.unwrap();
    let page=m.query_page_in_session("a",&session.id,"SELECT id FROM local_only ORDER BY id",1,1,None).await.unwrap();
    assert_eq!(page.rows,vec![vec![json!(2)]]);assert!(page.truncated);
    m.query_session_transaction("a",&session.id,TransactionAction::Rollback).await.unwrap();
    assert_eq!(m.query_in_session("a","SELECT COUNT(*) FROM local_only",1,None,None,None,Some(&session.id)).await.unwrap().rows[0][0],json!(0));
    m.close_query_session("a",&session.id).await.unwrap();assert_eq!(m.sessions.count(),0);
}
#[tokio::test]
async fn closing_a_running_session_cancels_its_execution_and_cleans_registration() {
    let m=Arc::new(ConnManager::default());parent(&m,"a").await;
    let session=m.open_query_session("a").await.unwrap();let job_manager=m.clone();let id=session.id.clone();
    let job=tokio::spawn(async move{job_manager.query_in_session("a",
        "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) FROM n",
        1,None,Some("long-query"),None,Some(&id)).await});
    tokio::time::timeout(std::time::Duration::from_secs(2),async{while m.running.active_count()==0 {tokio::task::yield_now().await;}}).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3),m.close_query_session("a",&session.id)).await.unwrap().unwrap();
    assert!(job.await.unwrap().is_err());assert_eq!(m.running.active_count(),0);assert_eq!(m.sessions.count(),0);
    assert_eq!(m.query("a","SELECT 1",1,None,None,None).await.unwrap().rows[0][0],json!(1));
}
#[tokio::test]
async fn session_quota_is_bounded_and_parent_disconnect_releases_all_slots() {
    let m=ConnManager::default();parent(&m,"a").await;
    for _ in 0..16 {m.open_query_session("a").await.unwrap();}
    assert!(m.open_query_session("a").await.is_err());assert_eq!(m.sessions.count(),16);
    m.remove("a").await;assert_eq!(m.sessions.count(),0);
}
