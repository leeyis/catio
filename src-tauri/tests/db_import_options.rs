//! Reviewed imports use identical bytes/options in desktop and browser orchestration.
use catio_lib::db::{DatabaseType, driver::{connect,ConnectArgs}, table_import::ImportColumnMapping, write_ops};
use serde_json::json;

#[tokio::test]
async fn native_preview_reread_and_embedded_import_share_the_review_contract() {
    let file=tempfile::Builder::new().suffix(".csv").tempfile().unwrap();
    let original=b"report\nid;name\nunits;ignored\n1;  Ada  \n2;\"\"";
    std::fs::write(file.path(),original).unwrap();
    let options=serde_json::from_value(json!({"delimiter":";","headerRow":2,"dataStartRow":4,"trimValues":true,"emptyStringAsNull":false})).unwrap();
    let preview=catio_lib::db::commands::db_import_preview(file.path().to_str().unwrap().into(),Some(options)).await.unwrap();
    assert_eq!(preview.rows,vec![vec![json!("1"),json!("Ada")],vec![json!("2"),json!("")]]);
    let options=preview.parse_options.as_ref();
    let mapping=vec![ImportColumnMapping{source_column:"id".into(),target_column:"id".into()},ImportColumnMapping{source_column:"name".into(),target_column:"name".into()}];
    for db_type in [DatabaseType::Sqlite,DatabaseType::Duckdb] {
        let drv=connect(&ConnectArgs{db_type,host:":memory:".into(),port:0,user:String::new(),database:None,driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None}).await.unwrap();
        drv.query("CREATE TABLE target(id INTEGER PRIMARY KEY,name VARCHAR)",0).await.unwrap();
        drv.query("INSERT INTO target VALUES(9,'original')",0).await.unwrap();
        std::fs::write(file.path(),b"report\nid;name\nunits;ignored\n1;modified").unwrap();
        let bytes=std::fs::read(file.path()).unwrap();
        assert!(write_ops::import_bytes_reviewed(drv.as_ref(),None,"target","file.csv",&bytes,&mapping,"truncate",1,true,options,Some(&preview.source_fingerprint)).await.is_err());
        assert_eq!(drv.query("SELECT id,name FROM target",10).await.unwrap().rows,vec![vec![json!(9),json!("original")]]);
        let result=write_ops::import_bytes_reviewed(drv.as_ref(),None,"target","file.csv",original,&mapping,"truncate",1,true,options,Some(&preview.source_fingerprint)).await.unwrap();
        assert_eq!(result.rows_imported,2);
        assert_eq!(drv.query("SELECT id,name FROM target ORDER BY id",10).await.unwrap().rows,vec![vec![json!(1),json!("Ada")],vec![json!(2),json!("")]]);
        // A different confirmed file may fail inside the second batch; replacement must roll back.
        let duplicate=b"report\nid;name\nunits;ignored\n1;first\n1;duplicate";
        let bad_preview=write_ops::import_preview_with_options("file.csv",duplicate,options).unwrap();
        assert!(write_ops::import_bytes_reviewed(drv.as_ref(),None,"target","file.csv",duplicate,&mapping,"truncate",1,true,options,Some(&bad_preview.source_fingerprint)).await.is_err());
        assert_eq!(drv.query("SELECT COUNT(*) FROM target",10).await.unwrap().rows[0][0],json!(2));
        assert_eq!(drv.query("SELECT name FROM target WHERE id=1",10).await.unwrap().rows[0][0],json!("Ada"));
        drv.close();
    }
}
