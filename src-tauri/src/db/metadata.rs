//! Scoped metadata operations shared by desktop/Web. Empty, unloaded and failed are distinct states.
use std::{sync::Arc,time::Duration};
use serde::Serialize;
use futures_util::{stream,StreamExt};
use tokio_util::sync::CancellationToken;
use crate::db::{DbError,driver::{Driver,TableInfo}};

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct NamespaceCatalog {
    pub namespaces:Vec<String>,
    pub default_namespace:Option<String>,
    pub default_namespace_error:Option<String>,
}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct NamespaceObjects {
    pub name:String,
    pub tables:Vec<TableInfo>,
    pub functions:Vec<String>,
    pub functions_error:Option<String>,
}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct MetadataObject {pub schema:String,pub name:String,pub kind:String}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct NamespaceFailure {pub schema:String,pub message:String}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ObjectSearch {
    pub objects:Vec<MetadataObject>,pub errors:Vec<NamespaceFailure>,pub truncated:bool,pub cancelled:bool,
}

pub async fn catalog(driver:&dyn Driver)->Result<NamespaceCatalog,DbError> {
    // No table/function/column enumeration here: opening a connection is cheap even
    // when the user can see hundreds of namespaces.
    let mut namespaces=driver.list_schemas().await?;
    let (default_namespace,default_namespace_error)=match driver.default_namespace().await {
        Ok(value)=>(value,None),Err(error)=>(None,Some(error.to_string())),
    };
    if let Some(name)=default_namespace.as_ref().filter(|name|!name.trim().is_empty()) {
        if !namespaces.contains(name){namespaces.insert(0,name.clone());}
    }
    let mut seen=std::collections::HashSet::new();namespaces.retain(|name|seen.insert(name.clone()));
    Ok(NamespaceCatalog{namespaces,default_namespace,default_namespace_error})
}
pub async fn namespace(driver:&dyn Driver,name:&str)->Result<NamespaceObjects,DbError> {
    let tables=driver.list_tables(name).await?; // never disguise a denied namespace as an empty one
    let (functions,functions_error)=if driver.capabilities().functions {
        match driver.list_functions(name).await {Ok(values)=>(values,None),Err(error)=>(vec![],Some(error.to_string()))}
    }else{(vec![],None)};
    Ok(NamespaceObjects{name:name.into(),tables,functions,functions_error})
}
pub async fn search(driver:Arc<dyn Driver>,pattern:&str,limit:usize,cancel:CancellationToken)->Result<ObjectSearch,DbError> {
    if pattern.trim().is_empty(){return Ok(ObjectSearch{objects:vec![],errors:vec![],truncated:false,cancelled:false});}
    if pattern.len()>512{return Err(DbError::QueryFailed("Metadata search text is too long".into()));}
    let limit=limit.clamp(1,1000);let pattern=pattern.to_lowercase();
    if cancel.is_cancelled(){return Ok(ObjectSearch{objects:vec![],errors:vec![],truncated:false,cancelled:true});}
    let deadline=tokio::time::sleep(Duration::from_secs(15));tokio::pin!(deadline);
    let schemas=tokio::select!{_=cancel.cancelled()=>return Ok(ObjectSearch{objects:vec![],errors:vec![],truncated:false,cancelled:true}),
        _=&mut deadline=>return Ok(ObjectSearch{objects:vec![],errors:vec![],truncated:true,cancelled:false}),
        result=driver.list_schemas()=>result?};
    let mut pending=stream::iter(schemas).map(|name|{let driver=driver.clone();async move{
        let result=namespace(driver.as_ref(),&name).await;(name,result)
    }}).buffer_unordered(4);
    let mut out=ObjectSearch{objects:vec![],errors:vec![],truncated:false,cancelled:false};
    loop {
        let next=tokio::select!{
            _=cancel.cancelled()=>{out.cancelled=true;break;},
            _=&mut deadline=>{out.truncated=true;break;},
            result=pending.next()=>result,
        };
        let Some((name,result))=next else{break;};
        match result {
            Err(error)=>out.errors.push(NamespaceFailure{schema:name,message:error.to_string()}),
            Ok(namespace)=>{
                if let Some(error)=namespace.functions_error {out.errors.push(NamespaceFailure{schema:name.clone(),message:error});}
                let objects=namespace.tables.into_iter().map(|table|(table.name,table.kind))
                    .chain(namespace.functions.into_iter().map(|name|(name,"function".to_string())));
                for (object,kind) in objects {
                    if !object.to_lowercase().contains(&pattern){continue;}
                    if out.objects.len()>=limit{out.truncated=true;break;}
                    out.objects.push(MetadataObject{schema:name.clone(),name:object,kind});
                }
                if out.truncated{break;}
            }
        }
    }
    out.objects.sort_by(|a,b|(&a.schema,&a.kind,&a.name).cmp(&(&b.schema,&b.kind,&b.name)));
    Ok(out)
}

/// Completion data is bounded, but truncation and per-object failures are never hidden.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCatalog {
    pub tables: Vec<(String, Vec<String>)>,
    pub errors: Vec<NamespaceFailure>,
    pub truncated: bool,
}

pub async fn columns(driver: &dyn Driver, schema: &str) -> Result<ColumnCatalog, DbError> {
    use crate::db::DatabaseType;
    const MAX_COLUMNS: u32 = 100_000;
    let engine = driver.db_type();
    if matches!(engine, DatabaseType::Postgres | DatabaseType::Mysql | DatabaseType::Sqlserver | DatabaseType::Duckdb) {
        // One catalog query, not hundreds of full table/index/FK introspections.
        let namespace = crate::db::dml::value_to_sql_for(engine, &serde_json::Value::String(schema.into()));
        let catalog = if engine == DatabaseType::Duckdb { " AND table_catalog=current_database()" } else { "" };
        let sql = format!("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema={namespace}{catalog} ORDER BY table_name,ordinal_position");
        let result = driver.query(&sql, MAX_COLUMNS).await?;
        let mut tables: Vec<(String, Vec<String>)> = Vec::new();
        for row in result.rows {
            let table = row.first().and_then(serde_json::Value::as_str).ok_or_else(|| DbError::QueryFailed("Column metadata returned an invalid table name".into()))?;
            let column = row.get(1).and_then(serde_json::Value::as_str).ok_or_else(|| DbError::QueryFailed("Column metadata returned an invalid column name".into()))?;
            if tables.last().map(|item| item.0.as_str()) != Some(table) { tables.push((table.into(), Vec::new())); }
            tables.last_mut().unwrap().1.push(column.into());
        }
        return Ok(ColumnCatalog { tables, errors: vec![], truncated: result.truncated });
    }
    const MAX_TABLES: usize = 200;
    let tables = driver.list_tables(schema).await?;
    let truncated = tables.len() > MAX_TABLES;
    let mut pending = stream::iter(tables.into_iter().take(MAX_TABLES)).map(|table| async move {
        let result = if matches!(engine, DatabaseType::Sqlite | DatabaseType::Rqlite) {
            let table_ref = crate::db::dialect::quote_ident(engine, &table.name);
            let schema_ref = crate::db::dialect::quote_ident(engine, schema);
            let result = driver.query(&format!("PRAGMA {schema_ref}.table_xinfo({table_ref})"), MAX_COLUMNS).await;
            result.and_then(|result| {
                if result.truncated { return Err(DbError::QueryFailed("Column metadata exceeded its safety limit".into())); }
                result.rows.into_iter().map(|row| row.get(1).and_then(serde_json::Value::as_str).map(str::to_string)
                    .ok_or_else(|| DbError::QueryFailed("Column metadata returned an invalid name".into()))).collect()
            })
        } else { driver.column_names(schema, &table.name).await };
        (table.name, result)
    }).buffered(8);
    let mut out = ColumnCatalog { tables: vec![], errors: vec![], truncated };
    while let Some((name, result)) = pending.next().await {
        match result {
            Ok(columns) => out.tables.push((name, columns)),
            Err(error) => out.errors.push(NamespaceFailure { schema: format!("{schema}.{name}"), message: error.to_string() }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DatabaseType,driver::{TableStructure,ErRelation},result::QueryResult};
    use std::sync::atomic::{AtomicUsize,Ordering};
    struct Fixture{table_calls:AtomicUsize}
    #[async_trait::async_trait]
    impl Driver for Fixture {
        fn db_type(&self)->DatabaseType{DatabaseType::Postgres}
        async fn test(&self)->Result<String,DbError>{Ok("fixture".into())}
        async fn query(&self,_:&str,_:u32)->Result<QueryResult,DbError>{unreachable!()}
        async fn list_schemas(&self)->Result<Vec<String>,DbError>{Ok(vec!["SYS".into(),"APP".into()])}
        async fn default_namespace(&self)->Result<Option<String>,DbError>{Ok(Some("APP".into()))}
        async fn list_tables(&self,schema:&str)->Result<Vec<TableInfo>,DbError>{
            self.table_calls.fetch_add(1,Ordering::SeqCst);
            if schema=="SYS"{return Err(DbError::QueryFailed("permission denied".into()));}
            Ok(vec![TableInfo{name:"needle_table".into(),kind:"table".into(),rows_estimate:None}])
        }
        async fn list_functions(&self,_:&str)->Result<Vec<String>,DbError>{Err(DbError::QueryFailed("routine metadata unavailable".into()))}
        async fn table_structure(&self,_:&str,_:&str)->Result<TableStructure,DbError>{unreachable!()}
        async fn er_relations(&self,_:&str)->Result<Vec<ErRelation>,DbError>{unreachable!()}
    }
    #[tokio::test]
    async fn catalog_is_lazy_and_preserves_the_real_default() {
        let driver=Fixture{table_calls:AtomicUsize::new(0)};let result=catalog(&driver).await.unwrap();
        assert_eq!(result.default_namespace.as_deref(),Some("APP"));assert_eq!(driver.table_calls.load(Ordering::SeqCst),0);
    }
    #[tokio::test]
    async fn denied_tables_are_errors_and_routine_failure_does_not_erase_tables() {
        let driver=Fixture{table_calls:AtomicUsize::new(0)};
        assert!(namespace(&driver,"SYS").await.is_err());
        let result=namespace(&driver,"APP").await.unwrap();assert_eq!(result.tables.len(),1);assert!(result.functions_error.is_some());
    }
    #[tokio::test]
    async fn global_search_returns_matches_and_reports_unavailable_namespaces() {
        let driver=Arc::new(Fixture{table_calls:AtomicUsize::new(0)});
        let result=search(driver,"needle",20,CancellationToken::new()).await.unwrap();
        assert_eq!(result.objects.len(),1);assert_eq!(result.objects[0].schema,"APP");assert_eq!(result.errors.len(),2);
        assert!(!result.truncated);assert!(!result.cancelled);
    }
    struct ColumnFixture;
    #[async_trait::async_trait]
    impl Driver for ColumnFixture {
        fn db_type(&self) -> DatabaseType { DatabaseType::Jdbc }
        async fn test(&self) -> Result<String, DbError> { unreachable!() }
        async fn query(&self, _: &str, _: u32) -> Result<QueryResult, DbError> { unreachable!() }
        async fn list_schemas(&self) -> Result<Vec<String>, DbError> { unreachable!() }
        async fn list_tables(&self, _: &str) -> Result<Vec<TableInfo>, DbError> {
            Ok((0..205).map(|i| TableInfo { name: format!("t{i}"), kind: "table".into(), rows_estimate: None }).collect())
        }
        async fn column_names(&self, _: &str, table: &str) -> Result<Vec<String>, DbError> {
            if table == "t3" { Err(DbError::QueryFailed("permission denied".into())) } else { Ok(vec!["id".into()]) }
        }
        async fn table_structure(&self, _: &str, _: &str) -> Result<TableStructure, DbError> { panic!("completion must not introspect full structures") }
        async fn er_relations(&self, _: &str) -> Result<Vec<ErRelation>, DbError> { unreachable!() }
    }
    #[tokio::test]
    async fn column_completion_reports_limits_and_failures_without_loading_constraints() {
        let result = columns(&ColumnFixture, "APP").await.unwrap();
        assert!(result.truncated);
        assert_eq!(result.tables.len(), 199);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].schema, "APP.t3");
        assert_eq!(result.tables[0], ("t0".into(), vec!["id".into()]));
    }
    #[tokio::test]
    async fn early_search_cancel_does_not_enumerate_tables() {
        let driver=Arc::new(Fixture{table_calls:AtomicUsize::new(0)});let token=CancellationToken::new();token.cancel();
        let result=search(driver.clone(),"needle",20,token).await.unwrap();
        assert!(result.cancelled);assert_eq!(driver.table_calls.load(Ordering::SeqCst),0);
    }
}
