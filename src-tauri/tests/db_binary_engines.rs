//! Genuine binary roundtrip contracts across native engines and the JDBC sidecar.
use catio_lib::db::{driver::{connect,ConnectArgs,EditRequest},DatabaseType,write_ops,
    dialect::quote_ident,transfer::{TransferColumnMapping,TransferMode},export::build_insert_statements_typed};
use serde_json::json;
fn args(db_type:DatabaseType)->ConnectArgs { ConnectArgs{db_type,host:":memory:".into(),port:0,user:String::new(),
    database:None,driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None} }
fn external(db:DatabaseType,key:&str)->Option<ConnectArgs>{
    let Ok(raw)=std::env::var(key) else {eprintln!("SKIP: {key} not configured");return None;};
    let p:Vec<_>=raw.splitn(5,':').collect();assert_eq!(p.len(),5);
    Some(ConnectArgs{host:p[0].into(),port:p[1].parse().unwrap(),user:p[2].into(),secret:Some(p[3].into()),database:Some(p[4].into()),..args(db)})
}
async fn roundtrip(a:ConnectArgs) {
    let db=a.db_type; let d=connect(&a).await.unwrap();
    let table=format!("catio_binary_{}",std::process::id());
    let copied=format!("{table}_copy");let restored=format!("{table}_restore");
    let q=|s:&str|quote_ident(db,s);
    let (key_type,value_type,text_type)=match db {
        DatabaseType::Postgres=>("BYTEA","BYTEA","TEXT"),
        DatabaseType::Mysql=>("VARBINARY(64)","LONGBLOB","TEXT"),
        DatabaseType::Sqlserver=>("VARBINARY(64)","VARBINARY(MAX)","NVARCHAR(100)"),
        DatabaseType::Jdbc=>("VARBINARY(64)","BLOB","VARCHAR(100)"),
        _=>("BLOB","BLOB","VARCHAR"),
    };
    for name in [&table,&copied,&restored] {
        d.query(&format!("CREATE TABLE {} ({} {key_type} PRIMARY KEY, {} {value_type}, {} {text_type})",q(name),q("id"),q("payload"),q("hex_text")),0).await.unwrap();
    }
    let inserts:Vec<EditRequest>=[("0x00ff",Some("0x00ff")),("0x0000",Some("0x")),("0x1234",None)].into_iter().map(|(id,payload)|
        serde_json::from_value(json!({"table":table,"kind":"insert","pk":[],
            "cells":[["id",id],["payload",payload],["hex_text","0x00ff"]],"binaryColumns":["id","payload"]})).unwrap()).collect();
    assert_eq!(write_ops::apply_edits(d.as_ref(),&inserts).await.unwrap(),3,"{db:?}");
    let select=|name:&str|format!("SELECT {},{},{} FROM {} ORDER BY {}",q("id"),q("payload"),q("hex_text"),q(name),q("id"));
    let r=d.query(&select(&table),10).await.unwrap();
    assert_eq!(r.rows[0],vec![json!("0x0000"),json!("0x"),json!("0x00ff")],"{db:?}");
    assert_eq!(r.binary_cells,vec![[0,0],[0,1],[1,0],[1,1],[2,0]],"{db:?}");
    let update:EditRequest=serde_json::from_value(json!({"table":table,"kind":"update","pk":[["id","0x00ff"]],
        "cells":[["payload","0xdeadbeef"]],"binaryColumns":["payload"],"binaryPkColumns":["id"]})).unwrap();
    assert_eq!(write_ops::apply_edits(d.as_ref(),&[update]).await.unwrap(),1);
    let mappings:Vec<_>=["id","payload","hex_text"].into_iter().map(|c|TransferColumnMapping{source_column:c.into(),target_column:c.into()}).collect();
    write_ops::transfer_table(d.as_ref(),None,&table,d.as_ref(),None,&copied,&mappings,TransferMode::Append,&[],1,false,&|_,_|{}).await.unwrap();
    let expected=d.query(&select(&table),10).await.unwrap();
    let copy=d.query(&select(&copied),10).await.unwrap();
    assert_eq!(copy.rows,expected.rows,"{db:?}");assert_eq!(copy.binary_cells,expected.binary_cells);
    let columns=expected.columns.iter().map(|c|c.name.clone()).collect::<Vec<_>>();
    let sql=build_insert_statements_typed(db,true,None,&restored,&columns,&expected.rows,1,&expected.binary_cells).unwrap();
    for statement in sql { d.query(&statement,0).await.unwrap(); }
    let restore=d.query(&select(&restored),10).await.unwrap();
    assert_eq!(restore.rows,expected.rows);assert_eq!(restore.binary_cells,expected.binary_cells);
    for name in [&restored,&copied,&table] {d.query(&format!("DROP TABLE {}",q(name)),0).await.unwrap();}
}
#[tokio::test]
async fn sqlserver_transaction_and_temporary_table_scope() {
    let Some(a)=external(DatabaseType::Sqlserver,"CATIO_TEST_MSSQL_URL") else {return;};
    let d=connect(&a).await.unwrap();
    d.query("CREATE TABLE #catio_scope(id INT PRIMARY KEY)",0).await.unwrap();
    d.query("/* control */ BEGIN TRANSACTION",0).await.unwrap();
    d.query("INSERT INTO #catio_scope VALUES(1)",0).await.unwrap();
    d.query("ROLLBACK TRANSACTION",0).await.unwrap();
    assert_eq!(d.query("SELECT COUNT(*) FROM #catio_scope",1).await.unwrap().rows[0][0],json!(0));
    assert!(d.exec_batch(&["INSERT INTO #catio_scope VALUES(1)".into(),"INSERT INTO #catio_scope VALUES(1)".into()]).await.is_err());
    assert_eq!(d.query("SELECT COUNT(*) FROM #catio_scope",1).await.unwrap().rows[0][0],json!(0));
    assert_eq!(d.query("SELECT @@TRANCOUNT",1).await.unwrap().rows[0][0],json!(0));
    assert_eq!(d.exec_batch(&["INSERT INTO #catio_scope VALUES(2)".into(),"INSERT INTO #catio_scope VALUES(3)".into()]).await.unwrap(),2);
    assert_eq!(d.query("SELECT COUNT(*) FROM #catio_scope",1).await.unwrap().rows[0][0],json!(2));
}
#[tokio::test] async fn sqlite_binary_roundtrip(){roundtrip(args(DatabaseType::Sqlite)).await;}
#[tokio::test] async fn duckdb_binary_roundtrip(){roundtrip(args(DatabaseType::Duckdb)).await;}
#[tokio::test] async fn rqlite_binary_roundtrip(){if let Some(a)=external(DatabaseType::Rqlite,"CATIO_TEST_RQLITE_URL"){roundtrip(a).await;}}
#[tokio::test]
async fn rqlite_transaction_failure_restores_original_data() {
    let Some(a)=external(DatabaseType::Rqlite,"CATIO_TEST_RQLITE_URL") else {return;};
    let d=connect(&a).await.unwrap();
    let t=format!("catio_rqlite_tx_{}",std::process::id());
    d.query(&format!("CREATE TABLE {t}(id INTEGER PRIMARY KEY)"),0).await.unwrap();
    d.query(&format!("INSERT INTO {t} VALUES(9)"),0).await.unwrap();
    assert!(d.capabilities().transactions);
    assert!(d.exec_batch(&[format!("DELETE FROM {t}"),format!("INSERT INTO {t} VALUES(1)"),format!("INSERT INTO {t} VALUES(1)")]).await.is_err());
    assert_eq!(d.query(&format!("SELECT id FROM {t}"),10).await.unwrap().rows,vec![vec![json!(9)]]);
    d.query(&format!("DROP TABLE {t}"),0).await.unwrap();
}
#[tokio::test] async fn postgres_binary_roundtrip(){if let Some(a)=external(DatabaseType::Postgres,"CATIO_TEST_PG_URL"){roundtrip(a).await;}}
#[tokio::test] async fn mysql_binary_roundtrip(){if let Some(a)=external(DatabaseType::Mysql,"CATIO_TEST_MYSQL_URL"){roundtrip(a).await;}}
#[tokio::test] async fn sqlserver_binary_roundtrip(){if let Some(a)=external(DatabaseType::Sqlserver,"CATIO_TEST_MSSQL_URL"){roundtrip(a).await;}}
#[tokio::test] async fn jdbc_h2_binary_roundtrip(){
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref()!=Some("1"){eprintln!("SKIP: CATIO_TEST_JDBC");return;}
    roundtrip(ConnectArgs{host:String::new(),user:"sa".into(),secret:Some(String::new()),driver_profile:Some("h2".into()),
        database:Some("mem:typed_binary;DB_CLOSE_DELAY=-1".into()),..args(DatabaseType::Jdbc)}).await;
}
