//! Real embedded-driver coverage of the production SQL-file I/O and execution core.
use std::{io::Write, sync::Arc, time::Duration};
use catio_lib::db::{DatabaseType, SqlFileState,
    driver::{connect, ConnectArgs, Driver},
    sql_file::{SqlFileRequest, SqlFileStatus},
    sql_file_io::{prepare_sql_file, execute_sql_file}};
use serde_json::json;
use tokio_util::sync::CancellationToken;

async fn database() -> Arc<dyn Driver> { database_for(DatabaseType::Sqlite).await }
async fn database_for(db_type: DatabaseType) -> Arc<dyn Driver> {
    connect(&ConnectArgs {db_type,host:":memory:".into(),port:0,user:String::new(),database:None,
        driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None}).await.unwrap()
}
fn input(bytes: &[u8]) -> tempfile::NamedTempFile {let mut file=tempfile::NamedTempFile::new().unwrap();file.write_all(bytes).unwrap();file.flush().unwrap();file}
fn request(file: &tempfile::NamedTempFile) -> SqlFileRequest {SqlFileRequest{execution_id:"qa-file".into(),conn_id:"qa-connection".into(),file_path:file.path().to_string_lossy().into(),continue_on_error:false,expected_fingerprint:None}}

#[tokio::test]
async fn invalid_tail_and_changed_preview_execute_nothing() {
    let db=database().await;
    let invalid=input(b"CREATE TABLE forbidden(id INT);\xff");
    let status=execute_sql_file(db.clone(),&request(&invalid),CancellationToken::new(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Error);assert_eq!(status.success_count,0);
    let mut changed=input(b"CREATE TABLE forbidden(id INT);");
    let preview=prepare_sql_file(changed.path(),DatabaseType::Sqlite,&CancellationToken::new(), |_|{}).await.unwrap().preview;
    changed.write_all(b"INSERT INTO forbidden VALUES(1);").unwrap();changed.flush().unwrap();
    let mut req=request(&changed);req.expected_fingerprint=Some(preview.fingerprint);
    let status=execute_sql_file(db.clone(),&req,CancellationToken::new(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Error);assert!(status.error.unwrap().contains("changed after preview"));
    assert_eq!(db.query("SELECT COUNT(*) FROM sqlite_master WHERE name='forbidden'",1).await.unwrap().rows[0][0],json!(0));
}

#[tokio::test]
async fn utf16_bom_temp_tables_and_explicit_commit_share_one_physical_session() {
    let db=database().await;
    let sql="CREATE TEMP TABLE stage(v TEXT); BEGIN; CREATE TABLE restored(v TEXT); INSERT INTO stage VALUES('中文😀'); INSERT INTO restored SELECT v FROM stage; COMMIT;";
    for be in [false,true] {
        let mut bytes=if be {vec![0xfe,0xff]} else {vec![0xff,0xfe]};for unit in sql.encode_utf16(){bytes.extend(if be{unit.to_be_bytes()}else{unit.to_le_bytes()});}
        let file=input(&bytes);
        let preview=prepare_sql_file(file.path(),DatabaseType::Sqlite,&CancellationToken::new(), |_|{}).await.unwrap().preview;
        let mut req=request(&file);req.expected_fingerprint=Some(preview.fingerprint);
        let status=execute_sql_file(db.clone(),&req,CancellationToken::new(), |_|{}).await;
        assert_eq!(status.status,SqlFileStatus::Done,"{:?}",status.error);assert_eq!(status.success_count,6);
        assert_eq!(db.query("SELECT v FROM restored",1).await.unwrap().rows[0][0],json!("中文😀"));
        db.query("DROP TABLE restored",0).await.unwrap();
    }
}

#[tokio::test]
async fn file_cancellation_interrupts_current_sqlite_statement_but_keeps_prior_commit() {
    let db=database().await;
    let file=input(b"CREATE TABLE kept(v INT); INSERT INTO kept VALUES(7); WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000000) INSERT INTO kept SELECT sum(n) FROM seq; INSERT INTO kept VALUES(99);");
    let cancel=CancellationToken::new();let trigger=cancel.clone();
    let status=tokio::time::timeout(Duration::from_secs(5),execute_sql_file(db.clone(),&request(&file),cancel,move |p|{
        if p.status==SqlFileStatus::Running && p.statement_index==3 {let token=trigger.clone();tokio::spawn(async move{tokio::time::sleep(Duration::from_millis(30)).await;token.cancel();});}
    })).await.expect("driver cancellation must interrupt the active statement");
    assert_eq!(status.status,SqlFileStatus::Cancelled);assert_eq!(status.success_count,2);
    assert_eq!(db.query("SELECT v FROM kept",10).await.unwrap().rows,vec![vec![json!(7)]]);
}

#[tokio::test]
async fn incomplete_transaction_is_not_reported_as_success_and_is_cleaned() {
    let db=database().await;
    db.query("CREATE TABLE kept(v INT)",0).await.unwrap();
    let file=input(b"INSERT INTO kept VALUES(7); BEGIN; INSERT INTO kept VALUES(9);");
    let status=execute_sql_file(db.clone(),&request(&file),CancellationToken::new(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Error);assert!(status.error.unwrap().contains("idle transaction"));
    assert_eq!(db.query("SELECT v FROM kept",10).await.unwrap().rows,vec![vec![json!(7)]]);
}

#[tokio::test]
async fn continue_policy_preserves_per_statement_failures_and_later_receipts() {
    let db=database().await;let file=input(b"CREATE TABLE kept(v INT); INVALID SQL; INSERT INTO kept VALUES(9);");
    let mut req=request(&file);req.continue_on_error=true;
    let status=execute_sql_file(db.clone(),&req,CancellationToken::new(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Done);assert_eq!(status.failure_count,1);assert_eq!(status.success_count,2);
    assert_eq!(db.query("SELECT v FROM kept",10).await.unwrap().rows,vec![vec![json!(9)]]);
}

#[tokio::test]
async fn duckdb_file_uses_one_physical_session_and_cleans_temporary_state() {
    let db=database_for(DatabaseType::Duckdb).await;
    let file=input("CREATE TEMP TABLE stage(v VARCHAR); BEGIN; CREATE TABLE kept(v VARCHAR); INSERT INTO stage VALUES('中文😀'); INSERT INTO kept SELECT v FROM stage; COMMIT;".as_bytes());
    let status=execute_sql_file(db.clone(),&request(&file),CancellationToken::new(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Done,"{:?}",status.error);assert_eq!(status.success_count,6);
    assert_eq!(db.query("SELECT v FROM kept",1).await.unwrap().rows,vec![vec![json!("中文😀")]]);
    assert!(db.query("SELECT * FROM stage",1).await.is_err());
}

#[tokio::test]
async fn early_cancel_and_guard_cleanup_apply_to_sql_files() {
    let jobs=SqlFileState::default();jobs.cancel("qa-connection","qa-file").unwrap();
    let guard=jobs.register("qa-connection","qa-file").unwrap();
    assert!(jobs.register("qa-connection","qa-file").is_err());
    let file=input(b"CREATE TABLE forbidden(v INT);");let db=database().await;
    let status=execute_sql_file(db.clone(),&request(&file),guard.token.clone(), |_|{}).await;
    assert_eq!(status.status,SqlFileStatus::Cancelled);assert_eq!(status.success_count,0);
    drop(guard);assert_eq!(jobs.active_count(),0);
    assert_eq!(db.query("SELECT COUNT(*) FROM sqlite_master",1).await.unwrap().rows[0][0],json!(0));
}
