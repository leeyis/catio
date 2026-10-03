use catio_lib::db::{driver::{connect,ConnectArgs},DatabaseType};
fn args(db_type:DatabaseType)->ConnectArgs{ConnectArgs{db_type,host:":memory:".into(),port:0,user:String::new(),database:None,
    driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,ca_cert_path:None,ssl_reject_unauthorized:None}}
fn external(db:DatabaseType,key:&str)->Option<ConnectArgs>{
    let Ok(raw)=std::env::var(key) else{eprintln!("SKIP {key}");return None;};let p:Vec<_>=raw.splitn(5,':').collect();
    Some(ConnectArgs{host:p[0].into(),port:p[1].parse().unwrap(),user:p[2].into(),secret:Some(p[3].into()),database:Some(p[4].into()),..args(db)})
}
#[tokio::test]
async fn postgres_type_modifiers_survive_introspection() {
    let Some(a)=external(DatabaseType::Postgres,"CATIO_TEST_PG_URL") else{return;};let d=connect(&a).await.unwrap();
    let table=format!("catio_type_mod_{}",std::process::id());
    d.query(&format!("CREATE TABLE public.{table}(label VARCHAR(17), amount NUMERIC(28,9), at TIMESTAMP(4), tags INT[])"),0).await.unwrap();
    let result=d.table_structure("public",&table).await;
    let columns=catio_lib::db::metadata::columns(d.as_ref(),"public").await.unwrap();
    assert_eq!(columns.tables.iter().find(|(name,_)|name==&table).unwrap().1,vec!["label","amount","at","tags"]);
    assert!(columns.errors.is_empty());assert!(!columns.truncated);
    d.query(&format!("DROP TABLE public.{table}"),0).await.unwrap();let st=result.unwrap();
    let ty=|name:&str|st.columns.iter().find(|c|c.name==name).unwrap().type_name.to_lowercase();
    assert!(ty("label").contains("17"));assert!(ty("amount").contains("28,9"));assert!(ty("at").contains("4"));assert!(ty("tags").ends_with("[]"));
}
#[tokio::test]
async fn sqlserver_type_modifiers_survive_introspection() {
    let Some(a)=external(DatabaseType::Sqlserver,"CATIO_TEST_MSSQL_URL") else{return;};let d=connect(&a).await.unwrap();
    let table=format!("catio_type_mod_{}",std::process::id());
    d.query(&format!("CREATE TABLE dbo.{table}(label NVARCHAR(17), amount DECIMAL(28,9), payload VARBINARY(MAX), at DATETIME2(4))"),0).await.unwrap();
    let result=d.table_structure("dbo",&table).await;
    let columns=catio_lib::db::metadata::columns(d.as_ref(),"dbo").await.unwrap();
    assert_eq!(columns.tables.iter().find(|(name,_)|name==&table).unwrap().1,vec!["label","amount","payload","at"]);
    d.query(&format!("DROP TABLE dbo.{table}"),0).await.unwrap();let st=result.unwrap();
    let ty=|name:&str|st.columns.iter().find(|c|c.name==name).unwrap().type_name.to_lowercase();
    assert_eq!(ty("label"),"nvarchar(17)");assert_eq!(ty("amount"),"decimal(28,9)");assert_eq!(ty("payload"),"varbinary(max)");assert_eq!(ty("at"),"datetime2(4)");
}
#[tokio::test]
async fn mysql_and_rqlite_lightweight_column_catalogs() {
    for (kind,key) in [(DatabaseType::Mysql,"CATIO_TEST_MYSQL_URL"),(DatabaseType::Rqlite,"CATIO_TEST_RQLITE_URL")] {
        let Some(a)=external(kind,key) else{continue;};let d=connect(&a).await.unwrap();
        let schema=d.default_namespace().await.unwrap().unwrap();
        let table=format!("catio_metacol_{}",std::process::id());
        d.query(&format!("CREATE TABLE {table}(id INT, label TEXT)"),0).await.unwrap();
        let result=catio_lib::db::metadata::columns(d.as_ref(),&schema).await;
        d.query(&format!("DROP TABLE {table}"),0).await.unwrap();
        let catalog=result.unwrap();
        assert_eq!(catalog.tables.iter().find(|(name,_)|name==&table).unwrap().1,vec!["id","label"],"{kind:?}");
        assert!(catalog.errors.is_empty());assert!(!catalog.truncated);
    }
}
#[tokio::test]
async fn embedded_engines_report_actual_default_namespace() {
    for kind in [DatabaseType::Sqlite,DatabaseType::Duckdb] {
        let driver=connect(&args(kind)).await.unwrap();
        assert_eq!(driver.default_namespace().await.unwrap().as_deref(),Some("main"),"{kind:?}");
        driver.query("CREATE TABLE \"cols\"(id INTEGER, n INTEGER GENERATED ALWAYS AS (id*2))",0).await.unwrap();
        let catalog=catio_lib::db::metadata::columns(driver.as_ref(),"main").await.unwrap();
        assert_eq!(catalog.tables,vec![("cols".into(),vec!["id".into(),"n".into()])]);
        assert!(catalog.errors.is_empty());assert!(!catalog.truncated);
    }
}
#[tokio::test]
async fn h2_default_namespace_is_public_not_information_schema() {
    if std::env::var("CATIO_TEST_JDBC").ok().as_deref()!=Some("1"){eprintln!("SKIP CATIO_TEST_JDBC");return;}
    let driver=connect(&ConnectArgs{host:String::new(),user:"sa".into(),secret:Some(String::new()),driver_profile:Some("h2".into()),
        database:Some("mem:metadata_default;DB_CLOSE_DELAY=-1".into()),..args(DatabaseType::Jdbc)}).await.unwrap();
    assert!(driver.list_schemas().await.unwrap().contains(&"INFORMATION_SCHEMA".into()));
    assert_eq!(driver.default_namespace().await.unwrap().as_deref(),Some("PUBLIC"));
    driver.query("CREATE TABLE COLS(label VARCHAR(17), amount DECIMAL(28,9), at TIMESTAMP(4))",0).await.unwrap();
    let columns=catio_lib::db::metadata::columns(driver.as_ref(),"PUBLIC").await.unwrap();
    assert_eq!(columns.tables,vec![("COLS".into(),vec!["LABEL".into(),"AMOUNT".into(),"AT".into()])]);
    let structure=driver.table_structure("PUBLIC","COLS").await.unwrap();
    assert_eq!(structure.columns.iter().map(|column|column.type_name.as_str()).collect::<Vec<_>>(),vec!["CHARACTER VARYING(17)","DECIMAL(28,9)","TIMESTAMP(4)"]);
}
