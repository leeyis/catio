// adapted from dbx crates/dbx-core/src/db/elasticsearch_driver.rs, Apache-2.0
use async_trait::async_trait;
use serde::Deserialize;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{ColumnInfo, QueryResult};
use crate::db::drivers::http::{HttpClient, check_response_connect, check_response_query};

/// Elasticsearch driver — pseudo-tabular mapping.
/// Indices → tables, documents → rows.
/// sql_console = false, er = false.
pub struct ElasticsearchDriver {
    http: HttpClient,
}

impl ElasticsearchDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let base_url = format!("http://{}:{}", args.host, args.port);
        let user = if args.user.is_empty() { None } else { Some(args.user.as_str()) };
        let pass = args.secret.as_deref();
        let http = HttpClient::new(&base_url, user, pass);
        let driver = Self { http };
        driver.test().await?;
        Ok(driver)
    }
}

#[derive(Deserialize)]
struct CatIndex {
    index: String,
    #[serde(rename = "docs.count")]
    docs_count: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: SearchHits,
}

#[derive(Deserialize)]
struct SearchHits {
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "_id")]
    id: String,
    #[serde(rename = "_source")]
    source: Option<serde_json::Value>,
}

#[async_trait]
impl Driver for ElasticsearchDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Elasticsearch }

    async fn test(&self) -> Result<String, DbError> {
        let resp = self.http
            .get("/")
            .send()
            .await
            .map_err(|e| DbError::ConnectFailed(format!("Elasticsearch request failed: {e}")))?;
        let resp = check_response_connect(resp).await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| DbError::ConnectFailed(format!("Elasticsearch parse error: {e}")))?;
        let version = body
            .pointer("/version/number")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        Ok(format!("Elasticsearch {version}"))
    }

    /// query() treats `sql` as an INDEX NAME (DataGrid uses this to fetch rows).
    /// GET /<index>/_search?size=<max_rows> → hits.hits._source fields as columns/rows.
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let index = sql.trim();
        if index.is_empty() {
            return Err(DbError::QueryFailed("Elasticsearch query: provide an index name as the query".into()));
        }

        let path = format!("/{}/_search", index);
        let body = serde_json::json!({
            "from": 0,
            "size": max_rows,
            "sort": ["_doc"],
        });
        let resp = self.http
            .post(&path)
            .json(&body)
            .send()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch request failed: {e}")))?;
        let resp = check_response_query(resp).await?;

        let result: SearchResponse = resp
            .json()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;

        // Build column union from all _source docs + always include _id first
        let mut all_keys: Vec<String> = vec!["_id".to_string()];
        let docs: Vec<serde_json::Map<String, serde_json::Value>> = result.hits.hits
            .into_iter()
            .map(|hit| {
                let mut doc = serde_json::Map::new();
                doc.insert("_id".to_string(), serde_json::Value::String(hit.id));
                if let Some(serde_json::Value::Object(source)) = hit.source {
                    for (k, v) in source {
                        if !all_keys.contains(&k) {
                            all_keys.push(k.clone());
                        }
                        doc.insert(k, v);
                    }
                }
                doc
            })
            .collect();

        let columns: Vec<ColumnInfo> = all_keys.iter().map(|k| ColumnInfo {
            name: k.clone(),
            type_name: String::new(),
            pk: k == "_id",
        }).collect();

        let rows: Vec<Vec<serde_json::Value>> = docs.iter().map(|doc| {
            all_keys.iter().map(|k| {
                doc.get(k).cloned().unwrap_or(serde_json::Value::Null)
            }).collect()
        }).collect();

        let truncated = rows.len() >= max_rows as usize;

        Ok(QueryResult { columns, rows, rows_affected: None, truncated })
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec!["default".to_string()])
    }

    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let resp = self.http
            .get("/_cat/indices?format=json&h=index,docs.count")
            .send()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch request failed: {e}")))?;
        let resp = check_response_query(resp).await?;

        let indices: Vec<CatIndex> = resp
            .json()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;

        let tables: Vec<TableInfo> = indices
            .into_iter()
            .filter(|i| !i.index.starts_with('.'))
            .map(|i| {
                let rows_estimate = i.docs_count
                    .as_deref()
                    .and_then(|s| s.parse::<i64>().ok());
                TableInfo { name: i.index, kind: "table".into(), rows_estimate }
            })
            .collect();
        Ok(tables)
    }

    async fn table_structure(&self, _schema: &str, table: &str) -> Result<TableStructure, DbError> {
        let path = format!("/{}/_mapping", table);
        let resp = self.http
            .get(&path)
            .send()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch request failed: {e}")))?;
        let resp = check_response_query(resp).await?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;

        // Mapping shape: { "<index>": { "mappings": { "properties": { "<field>": { "type": "..." } } } } }
        let properties = body
            .as_object()
            .and_then(|m| m.values().next())  // first (and only) index
            .and_then(|idx| idx.pointer("/mappings/properties"))
            .and_then(|p| p.as_object());

        let mut columns: Vec<ColumnDef> = vec![
            // _id is always present but not in mapping properties
            ColumnDef {
                name: "_id".into(),
                type_name: "keyword".into(),
                nullable: false,
                default: None,
                key: "PK".into(),
            }
        ];

        if let Some(props) = properties {
            for (field_name, field_def) in props {
                let type_name = field_def
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("object")
                    .to_string();
                columns.push(ColumnDef {
                    name: field_name.clone(),
                    type_name,
                    nullable: true,
                    default: None,
                    key: String::new(),
                });
            }
        }

        Ok(TableStructure {
            columns,
            indexes: Vec::<IndexDef>::new(),
            fks: Vec::<ForeignKeyDef>::new(),
        })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // ES has no FK concept; er=false per capabilities
        Ok(vec![])
    }
}
