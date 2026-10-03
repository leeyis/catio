//! End-to-end browser data operations through the authenticated HTTP transport.
use catio_lib::server::{build_router, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;

struct Rig { base: String, task: tokio::task::JoinHandle<()>, _dir: tempfile::TempDir }
impl Drop for Rig { fn drop(&mut self) { self.task.abort(); } }
impl Rig {
    async fn start() -> (Self, reqwest::Client) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into(), dir.path().join("data")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, build_router(state)).await.unwrap(); });
        let rig = Self { base, task, _dir: dir };
        let client = Self::client();
        assert_eq!(rig.call(&client, "auth_bootstrap", json!({"username":"admin","password":"fixture-only-123"})).await.0, 200);
        (rig, client)
    }
    fn client() -> reqwest::Client { reqwest::Client::builder().cookie_store(true).timeout(Duration::from_secs(8)).build().unwrap() }
    async fn call(&self, client: &reqwest::Client, cmd: &str, args: Value) -> (u16, Value) {
        let r = client.post(format!("{}/api/invoke", self.base)).json(&json!({"cmd":cmd,"args":args})).send().await.unwrap();
        (r.status().as_u16(), r.json().await.unwrap())
    }
    async fn connection(&self, client: &reqwest::Client) -> String {
        let (status, value) = self.call(client, "db_connect", json!({"args":{"dbType":"sqlite","host":":memory:","port":0,"user":""}})).await;
        assert_eq!(status, 200, "{value}"); value["connId"].as_str().unwrap().into()
    }
    async fn sql(&self, client: &reqwest::Client, conn: &str, sql: &str) -> Value {
        let (status, value) = self.call(client, "db_query", json!({"connId":conn,"sql":sql})).await;
        assert_eq!(status, 200, "{value}"); value
    }
}

#[tokio::test]
async fn browser_import_has_confirmation_and_whole_file_rollback() {
    let (rig, client) = Rig::start().await;
    let conn = rig.connection(&client).await;
    rig.sql(&client, &conn, "CREATE TABLE target(id INTEGER PRIMARY KEY, name TEXT)").await;
    rig.sql(&client, &conn, "INSERT INTO target VALUES(9,'original')").await;
    let mut request = json!({"connId":conn,"table":"target","fileName":"rows.csv",
        "dataBase64":STANDARD.encode("id,name\n1,first\n1,duplicate"), "mode":"truncate", "batchSize":1,
        "mappings":[{"sourceColumn":"id","targetColumn":"id"},{"sourceColumn":"name","targetColumn":"name"}]});
    assert_eq!(rig.call(&client, "db_import_table_bytes", request.clone()).await.0, 400);
    request["allowDestructive"] = json!(true);
    assert_eq!(rig.call(&client, "db_import_table_bytes", request.clone()).await.0, 400);
    assert_eq!(rig.sql(&client, &conn, "SELECT id,name FROM target").await["rows"], json!([[9,"original"]]));
    request["dataBase64"] = json!(STANDARD.encode("id,name\n1,Ada\n2,Linus"));
    let (status, result) = rig.call(&client, "db_import_table_bytes", request).await;
    assert_eq!(status, 200, "{result}"); assert_eq!(result["rowsImported"], 2);
    assert_eq!(rig.sql(&client, &conn, "SELECT id,name FROM target ORDER BY id").await["rows"], json!([[1,"Ada"],[2,"Linus"]]));
}

#[tokio::test]
async fn ambiguous_hex_keys_never_modify_another_sqlite_row() {
    let (rig, client) = Rig::start().await;
    let conn = rig.connection(&client).await;
    rig.sql(&client, &conn, "CREATE TABLE binary_keys(id BLOB PRIMARY KEY, v TEXT)").await;
    rig.sql(&client, &conn, "INSERT INTO binary_keys VALUES(X'DEAD','binary'),('0xdead','text')").await;
    let request = json!({"table":"binary_keys","kind":"update","pk":[["id","0xdead"]],"cells":[["v","wrong-row"]]});
    let (status, _) = rig.call(&client, "db_apply_edits", json!({"connId":conn,"reqs":[request]})).await;
    assert_eq!(status, 400, "a hex display value must not be used as an untyped row key");
    assert_eq!(rig.sql(&client, &conn, "SELECT COUNT(*) FROM binary_keys WHERE v='wrong-row'").await["rows"][0][0], 0);
}

#[tokio::test]
async fn byte_preview_never_reads_a_server_path_and_requires_auth() {
    let (rig, client) = Rig::start().await;
    let payload = json!({"fileName":"../../never-read-this.csv","dataBase64":STANDARD.encode("id,name\n1,fixture")});
    let (status, value) = rig.call(&client, "db_import_preview_bytes", payload.clone()).await;
    assert_eq!(status, 200, "{value}"); assert_eq!(value["fileName"], "never-read-this.csv");
    assert_eq!(value["rows"], json!([["1","fixture"]]));
    assert_eq!(rig.call(&Rig::client(), "db_import_preview_bytes", payload).await.0, 401);
    assert_eq!(rig.call(&client, "db_import_preview_bytes", json!({"fileName":"x.csv","dataBase64":"invalid!"})).await.0, 400);
}

#[tokio::test]
async fn web_transfer_works_and_both_connection_owners_are_checked() {
    let (rig, admin) = Rig::start().await;
    let source = rig.connection(&admin).await;
    let target = rig.connection(&admin).await;
    rig.sql(&admin, &source, "CREATE TABLE s(id INTEGER PRIMARY KEY, name TEXT)").await;
    rig.sql(&admin, &source, "INSERT INTO s VALUES(1,'Ada'),(2,'Linus')").await;
    rig.sql(&admin, &target, "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)").await;
    let request = json!({"sourceConnId":source,"sourceTable":"s","targetConnId":target,"targetTable":"t","mode":"append","batchSize":1,
        "mappings":[{"sourceColumn":"id","targetColumn":"id"},{"sourceColumn":"name","targetColumn":"name"}]});
    let (status, value) = rig.call(&admin, "db_transfer_table", request.clone()).await;
    assert_eq!(status, 200, "{value}"); assert_eq!(value["rowsTransferred"], 2);
    assert_eq!(rig.sql(&admin, &target, "SELECT COUNT(*) FROM t").await["rows"][0][0], 2);
    let bob = Rig::client();
    assert_eq!(rig.call(&bob, "auth_register", json!({"username":"bob","password":"fixture-only-123"})).await.0, 200);
    let bob_conn = rig.connection(&bob).await;
    for foreign_source in [true, false] {
        let mut attack = request.clone();
        attack[if foreign_source { "targetConnId" } else { "sourceConnId" }] = json!(bob_conn);
        let (status, value) = rig.call(&bob, "db_transfer_table", attack).await;
        assert_eq!(status, 400); assert_eq!(value["error"], "connection not found");
    }
    let (status, _) = rig.call(&bob, "db_cancel_query", json!({"connId":source,"executionId":"cannot-cancel-other-user"})).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn metadata_catalog_scoped_load_search_and_owner_gate() {
    let (rig,admin)=Rig::start().await;let conn=rig.connection(&admin).await;
    rig.sql(&admin,&conn,"CREATE TABLE metadata_needle(id INT)").await;
    let (status,catalog)=rig.call(&admin,"db_schema_catalog",json!({"connId":conn})).await;
    assert_eq!(status,200,"{catalog}");assert_eq!(catalog["defaultNamespace"],"main");assert!(catalog.get("tables").is_none());
    let (status,objects)=rig.call(&admin,"db_schema_namespace",json!({"connId":conn,"schema":"main"})).await;
    assert_eq!(status,200,"{objects}");assert_eq!(objects["tables"][0]["name"],"metadata_needle");
    let (status,columns)=rig.call(&admin,"db_column_catalog",json!({"connId":conn,"schema":"main"})).await;
    assert_eq!(status,200,"{columns}");assert_eq!(columns["tables"][0],json!(["metadata_needle",["id"]]));
    let search=json!({"connId":conn,"pattern":"needle","executionId":"metadata-one","limit":20});
    let (status,result)=rig.call(&admin,"db_search_objects",search.clone()).await;
    assert_eq!(status,200,"{result}");assert_eq!(result["objects"][0]["schema"],"main");
    rig.call(&admin,"db_cancel_metadata",json!({"connId":conn,"executionId":"metadata-early"})).await;
    let (_,cancelled)=rig.call(&admin,"db_search_objects",json!({"connId":conn,"pattern":"needle","executionId":"metadata-early"})).await;
    assert_eq!(cancelled["cancelled"],true);
    let bob=Rig::client();rig.call(&bob,"auth_register",json!({"username":"meta-bob","password":"fixture-only-123"})).await;
    for command in ["db_schema_catalog","db_schema_namespace","db_search_objects","db_cancel_metadata","db_column_catalog"] {
        let mut args=search.clone();args["schema"]=json!("main");assert_eq!(rig.call(&bob,command,args).await.0,400,"{command}");
    }
}

#[tokio::test]
async fn http_query_session_transaction_paging_and_close_rollback() {
    let (rig,client)=Rig::start().await;let conn=rig.connection(&client).await;
    rig.sql(&client,&conn,"CREATE TABLE scoped_rows(id INTEGER)").await;
    let (status,session)=rig.call(&client,"db_open_query_session",json!({"connId":conn})).await;
    assert_eq!(status,200,"{session}");let id=session["id"].as_str().unwrap();
    let args=json!({"connId":conn,"querySessionId":id});
    let mut begin=args.clone();begin["action"]=json!("begin");
    let (_,state)=rig.call(&client,"db_query_session_transaction",begin).await;
    assert_eq!(state["transactionState"],"active");
    let mut sql=args.clone();sql["sql"]=json!("INSERT INTO scoped_rows VALUES(1),(2),(3)");
    assert_eq!(rig.call(&client,"db_query",sql).await.0,200);
    let mut page=args.clone();page["sql"]=json!("SELECT id FROM scoped_rows ORDER BY id");page["limit"]=json!(1);page["offset"]=json!(1);
    let (status,rows)=rig.call(&client,"db_query_page",page).await;assert_eq!(status,200,"{rows}");assert_eq!(rows["rows"],json!([[2]]));
    assert_eq!(rig.call(&client,"db_close_query_session",args.clone()).await.0,200);
    assert_eq!(rig.call(&client,"db_close_query_session",args).await.0,200);
    assert_eq!(rig.sql(&client,&conn,"SELECT COUNT(*) FROM scoped_rows").await["rows"],json!([[0]]));
}

#[tokio::test]
async fn http_sql_session_requires_both_connection_owner_and_matching_parent() {
    let (rig,admin)=Rig::start().await;let alice_conn=rig.connection(&admin).await;
    let (_,session)=rig.call(&admin,"db_open_query_session",json!({"connId":alice_conn})).await;
    let id=session["id"].as_str().unwrap();
    let bob=Rig::client();assert_eq!(rig.call(&bob,"auth_register",json!({"username":"bob","password":"fixture-only-123"})).await.0,200);
    let bob_conn=rig.connection(&bob).await;
    for conn in [&alice_conn,&bob_conn] {
        let args=json!({"connId":conn,"querySessionId":id,"sql":"SELECT 1","action":"commit","executionId":"foreign-session"});
        for command in ["db_query","db_query_session_status","db_query_session_ping","db_query_session_transaction","db_close_query_session","db_cancel_query"] {
            assert_eq!(rig.call(&bob,command,args.clone()).await.0,400,"{command}");
        }
    }
    let (_,state)=rig.call(&admin,"db_query_session_status",json!({"connId":alice_conn,"querySessionId":id})).await;
    assert_eq!(state["transactionState"],"idle");
}
