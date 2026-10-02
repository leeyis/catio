//! Binary data must not be confused with identical-looking text, including mixed SQLite columns.
use catio_lib::db::{driver::{connect, ConnectArgs, EditRequest}, DatabaseType, write_ops,
    transfer::{TransferColumnMapping, TransferMode}};
use serde_json::json;

fn args(db_type: DatabaseType) -> ConnectArgs {
    ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
        driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None,
        ca_cert_path: None, ssl_reject_unauthorized: None }
}

#[tokio::test]
async fn sqlite_marks_actual_binary_cells_not_hex_text_or_json_shape() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE mixed(id PRIMARY KEY, v TEXT)", 0).await.unwrap();
    d.query("INSERT INTO mixed VALUES(X'00ff',X''),('0x00ff','0x'),(3,NULL)", 0).await.unwrap();
    let result = serde_json::to_value(d.query("SELECT id,v FROM mixed ORDER BY rowid", 10).await.unwrap()).unwrap();
    assert_eq!(result["binaryCells"], json!([[0,0],[0,1]]));
    assert_eq!(result["rows"][0], result["rows"][1], "display values coincide; metadata must disambiguate");
    let page = serde_json::to_value(d.paginated_query("SELECT id,v FROM mixed ORDER BY rowid", 1, 1).await.unwrap()).unwrap();
    assert_eq!(page["binaryCells"], json!([]));
    assert_eq!(page["rows"], json!([["0x00ff","0x"]]));
}

#[tokio::test]
async fn typed_binary_and_text_keys_update_different_rows() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE keyed(id PRIMARY KEY, payload BLOB)", 0).await.unwrap();
    d.query("INSERT INTO keyed VALUES(X'00ff',X'11'),('0x00ff',X'22')", 0).await.unwrap();
    for (binary_pk, value) in [(vec!["id"], "0xdead"), (vec![], "0xbeef")] {
        let req: EditRequest = serde_json::from_value(json!({"table":"keyed","kind":"update",
            "pk":[["id","0x00ff"]], "cells":[["payload",value]],
            "binaryPkColumns":binary_pk,"binaryColumns":["payload"]})).unwrap();
        assert_eq!(write_ops::apply_edits(d.as_ref(), &[req]).await.unwrap(), 1);
    }
    let result = d.query("SELECT typeof(id),hex(payload) FROM keyed ORDER BY rowid", 10).await.unwrap();
    assert_eq!(result.rows, vec![vec![json!("blob"),json!("DEAD")],vec![json!("text"),json!("BEEF")]]);
    let invalid: EditRequest = serde_json::from_value(json!({"table":"keyed","kind":"insert","pk":[],
        "cells":[["id",3],["payload","0x1'bad"]],"binaryColumns":["payload"]})).unwrap();
    assert!(write_ops::apply_edits(d.as_ref(), &[invalid]).await.is_err());
}

#[tokio::test]
async fn typed_sql_export_restores_blob_empty_null_and_text_separately() {
    use catio_lib::db::export::{ExportTable, build_database_sql_export};
    let snapshot: ExportTable = serde_json::from_value(json!({"displayName":"restore","tableName":"restore",
        "columns":["id","v"],"rows":[[1,"0x00ff"],[2,"0x00ff"],[3,"0x"],[4,null]],
        "binaryCells":[[0,1],[2,1]]})).unwrap();
    let sql = build_database_sql_export(DatabaseType::Sqlite,true,"main","test",&[snapshot],false,true,1).unwrap();
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE restore(id INTEGER PRIMARY KEY,v)",0).await.unwrap();
    for stmt in sql.lines().filter(|line| line.starts_with("INSERT")) { d.query(stmt,0).await.unwrap(); }
    let result = d.query("SELECT typeof(v), CASE WHEN typeof(v)='blob' THEN hex(v) ELSE v END FROM restore ORDER BY id",10).await.unwrap();
    assert_eq!(result.rows,vec![vec![json!("blob"),json!("00FF")],vec![json!("text"),json!("0x00ff")],
        vec![json!("blob"),json!("")],vec![json!("null"),json!(null)]]);
}

#[tokio::test]
async fn typed_json_import_preserves_binary_and_validates_before_replacement() {
    use catio_lib::db::table_import::ImportColumnMapping;
    let d=connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE typed_import(id INTEGER PRIMARY KEY,v TEXT)",0).await.unwrap();
    let data=json!({"format":"catio-table-v1","columns":["id","v"],
        "rows":[[1,"0x00ff"],[2,"0x00ff"],[3,"0x"],[4,null]],"binaryCells":[[0,1],[2,1]]});
    let mapping=vec![ImportColumnMapping{source_column:"id".into(),target_column:"id".into()},
        ImportColumnMapping{source_column:"v".into(),target_column:"v".into()}];
    write_ops::import_bytes(d.as_ref(),None,"typed_import","typed.json",&serde_json::to_vec(&data).unwrap(),&mapping,"append",1,false).await.unwrap();
    let expected=d.query("SELECT id,typeof(v),v FROM typed_import ORDER BY id",10).await.unwrap().rows;
    assert_eq!(expected[0][1],json!("blob"));assert_eq!(expected[1][1],json!("text"));
    assert_eq!(expected[2][1],json!("blob"));assert_eq!(expected[3][1],json!("null"));
    for bad in [json!([[0,9]]),json!([[8,1]]),json!([[0,1],[0,1]])] {
        let mut invalid=data.clone();invalid["binaryCells"]=bad;
        assert!(write_ops::import_bytes(d.as_ref(),None,"typed_import","typed.json",&serde_json::to_vec(&invalid).unwrap(),&mapping,"truncate",1,true).await.is_err());
        assert_eq!(d.query("SELECT id,typeof(v),v FROM typed_import ORDER BY id",10).await.unwrap().rows,expected);
    }
}

#[tokio::test]
async fn mixed_storage_transfer_preserves_binary_identity() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE source(id INTEGER PRIMARY KEY,v TEXT)",0).await.unwrap();
    d.query("CREATE TABLE target(id INTEGER PRIMARY KEY,v TEXT)",0).await.unwrap();
    d.query("INSERT INTO source VALUES(1,X'00ff'),(2,'0x00ff'),(3,X''),(4,NULL)",0).await.unwrap();
    let mapping=vec![TransferColumnMapping{source_column:"id".into(),target_column:"id".into()},
        TransferColumnMapping{source_column:"v".into(),target_column:"v".into()}];
    write_ops::transfer_table(d.as_ref(),None,"source",d.as_ref(),None,"target",&mapping,TransferMode::Append,&[],1,false,&|_,_|{}).await.unwrap();
    assert_eq!(d.query("SELECT typeof(v),v FROM source ORDER BY id",10).await.unwrap().rows,
        d.query("SELECT typeof(v),v FROM target ORDER BY id",10).await.unwrap().rows);
}
