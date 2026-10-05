use std::time::Duration;
use base64::{engine::general_purpose::STANDARD, Engine};
use catio_lib::server::{build_router, AppState};
use serde_json::{json,Value};
struct Rig { base:String, state:AppState, task:tokio::task::JoinHandle<()>, _dir:tempfile::TempDir }
impl Drop for Rig {fn drop(&mut self){self.task.abort();}}
impl Rig {
    fn client()->reqwest::Client {reqwest::Client::builder().cookie_store(true).timeout(Duration::from_secs(15)).build().unwrap()}
    async fn start()->(Self,reqwest::Client) {
        let dir=tempfile::tempdir().unwrap();let state=AppState::new(dir.path().into(),dir.path().join("data")).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        let cloned=state.clone();let task=tokio::spawn(async move{axum::serve(listener,build_router(cloned)).await.unwrap()});
        let rig=Self{base,state,task,_dir:dir};let client=Self::client();
        assert_eq!(rig.call(&client,"auth_bootstrap",json!({"username":"admin","password":format!("qa-{:032x}",rand::random::<u128>())})).await.0,200);(rig,client)
    }
    async fn call(&self,client:&reqwest::Client,cmd:&str,args:Value)->(u16,Value) {
        let response=client.post(format!("{}/api/invoke",self.base)).json(&json!({"cmd":cmd,"args":args})).send().await.unwrap();
        (response.status().as_u16(),response.json().await.unwrap())
    }
    async fn connection(&self,client:&reqwest::Client)->String {
        let (status,data)=self.call(client,"db_connect",json!({"args":{"dbType":"sqlite","host":":memory:","port":0,"user":""}})).await;
        assert_eq!(status,200);data["connId"].as_str().unwrap().into()
    }
    async fn upload(&self,client:&reqwest::Client,conn:&str,sql:&[u8])->Value {
        let mut args=json!({"connId":conn,"fileName":"../../local.sql","dataBase64":STANDARD.encode(sql)});
        let (status,preview)=self.call(client,"db_sql_file_preview_bytes",args.clone()).await;
        assert_eq!(status,200,"{preview}");assert_eq!(preview["fileName"],"local.sql");
        args["expectedFingerprint"]=preview["fingerprint"].clone();args["executionId"]=json!(format!("file-{:x}",rand::random::<u64>()));args
    }
}
#[tokio::test]
async fn browser_file_runs_with_owner_scoped_progress_and_a_terminal_rpc_receipt() {
    let (rig,admin)=Rig::start().await;let conn=rig.connection(&admin).await;
    let (tx,mut own)=tokio::sync::mpsc::channel(32);let id=rig.state.ws.register(tx,Some("1".into()));rig.state.ws.subscribe(id,"db://sql-file-progress");
    let (tx,mut foreign)=tokio::sync::mpsc::channel(32);let id2=rig.state.ws.register(tx,Some("another-owner".into()));rig.state.ws.subscribe(id2,"db://sql-file-progress");
    let args=rig.upload(&admin,&conn,"CREATE TABLE file_rows(v TEXT); INSERT INTO file_rows VALUES('中文😀');".as_bytes()).await;
    let (status,receipt)=rig.call(&admin,"db_run_sql_file_bytes",args).await;
    assert_eq!(status,200,"{receipt}");assert_eq!(receipt["status"],"done");assert_eq!(receipt["successCount"],2);
    assert!(own.try_recv().is_ok());assert!(foreign.try_recv().is_err());assert_eq!(rig.state.sql_files.active_count(),0);
    let (_,result)=rig.call(&admin,"db_query",json!({"connId":conn,"sql":"SELECT v FROM file_rows"})).await;assert_eq!(result["rows"],json!([["中文😀"]]));
}
#[tokio::test]
async fn uploads_reject_foreign_connections_paths_invalid_encoding_and_changed_previews() {
    let (rig,admin)=Rig::start().await;let conn=rig.connection(&admin).await;
    let args=rig.upload(&admin,&conn,b"CREATE TABLE forbidden(v INT);").await;
    assert_eq!(rig.call(&Rig::client(),"db_sql_file_preview_bytes",args.clone()).await.0,401);
    let bob=Rig::client();assert_eq!(rig.call(&bob,"auth_register",json!({"username":"bob","password":format!("qa-{:032x}",rand::random::<u128>())})).await.0,200);
    for cmd in ["db_sql_file_preview_bytes","db_run_sql_file_bytes","db_cancel_sql_file"] {assert_eq!(rig.call(&bob,cmd,args.clone()).await.0,400,"{cmd}");}
    let mut attack=args.clone();attack["filePath"]=json!("server-secret.sql");assert_eq!(rig.call(&admin,"db_run_sql_file_bytes",attack).await.0,400);
    let mut bad=args.clone();bad["dataBase64"]=json!(STANDARD.encode(b"CREATE TABLE forbidden(v INT);\xff"));assert_eq!(rig.call(&admin,"db_sql_file_preview_bytes",bad).await.0,400);
    let mut changed=args;changed["dataBase64"]=json!(STANDARD.encode(b"CREATE TABLE forbidden(v INT); INSERT INTO forbidden VALUES(1);"));
    let (status,receipt)=rig.call(&admin,"db_run_sql_file_bytes",changed).await;
    assert_eq!(status,200);assert_eq!(receipt["status"],"error");assert_eq!(receipt["successCount"],0);
    let (_,rows)=rig.call(&admin,"db_query",json!({"connId":conn,"sql":"SELECT COUNT(*) FROM sqlite_master WHERE name='forbidden'"})).await;
    assert_eq!(rows["rows"],json!([[0]]));assert_eq!(rig.state.sql_files.active_count(),0);
}
#[tokio::test]
async fn early_cancel_and_live_driver_cancel_work_over_http() {
    let (rig,admin)=Rig::start().await;let conn=rig.connection(&admin).await;
    let args=rig.upload(&admin,&conn,b"CREATE TABLE cancelled(v INT);").await;
    assert_eq!(rig.call(&admin,"db_cancel_sql_file",json!({"connId":conn,"executionId":args["executionId"]})).await.0,200);
    let (_,receipt)=rig.call(&admin,"db_run_sql_file_bytes",args).await;assert_eq!(receipt["status"],"cancelled");assert_eq!(receipt["successCount"],0);
    let args=rig.upload(&admin,&conn,b"CREATE TABLE kept(v INT); INSERT INTO kept VALUES(7); WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000000) INSERT INTO kept SELECT sum(n) FROM seq; INSERT INTO kept VALUES(99);").await;
    let (tx,mut events)=tokio::sync::mpsc::channel(64);let id=rig.state.ws.register(tx,Some("1".into()));rig.state.ws.subscribe(id,"db://sql-file-progress");
    let run=rig.call(&admin,"db_run_sql_file_bytes",args.clone());
    let cancel=async {
        loop {let ev=tokio::time::timeout(Duration::from_secs(5),events.recv()).await.unwrap().unwrap();if ev["payload"]["statementIndex"]==3 && ev["payload"]["status"]=="running"{break;}}
        assert_eq!(rig.call(&admin,"db_cancel_sql_file",json!({"connId":conn,"executionId":args["executionId"]})).await.0,200);
    };
    let ((status,receipt),())=tokio::join!(run,cancel);assert_eq!(status,200);assert_eq!(receipt["status"],"cancelled");assert_eq!(receipt["successCount"],2);
    let (_,rows)=rig.call(&admin,"db_query",json!({"connId":conn,"sql":"SELECT v FROM kept"})).await;assert_eq!(rows["rows"],json!([[7]]));
}
