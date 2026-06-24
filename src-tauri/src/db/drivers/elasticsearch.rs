// adapted from dbx crates/dbx-core/src/db/elasticsearch_driver.rs, Apache-2.0
use async_trait::async_trait;
use serde::Deserialize;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{ColumnInfo, QueryResult};
use crate::db::drivers::http::{HttpClient, check_response_connect, check_response_query};

/// Elasticsearch driver — pseudo-tabular mapping.
/// Indices → tables, documents → rows.
/// sql_console = true(REST / SELECT,见 query()), er = false.
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

    /// 查询控制台多语法入口(照 dbx execute_rest_query 的分流):
    /// 1) REST `GET/POST/PUT/DELETE /path [+ JSON body]`
    /// 2) 简单 `SELECT * FROM idx [LIMIT n]` → 直转 _search
    /// 3) 其他 SELECT → 转发 ES 原生 _sql endpoint
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use crate::db::drivers::es_query::{self, RestRequest};
        let input = sql.trim();
        if input.is_empty() {
            return Err(DbError::QueryFailed(es_query::ES_SYNTAX_HINT.into()));
        }
        let send_err = |e: reqwest::Error| DbError::QueryFailed(format!("Elasticsearch request failed: {e}"));

        if let Some(parsed) = es_query::parse_rest(input) {
            let RestRequest { method, path, body } = parsed.map_err(DbError::QueryFailed)?;
            let req = match method.as_str() {
                "GET" => self.http.get(&path),
                "POST" => self.http.post(&path),
                "PUT" => self.http.put(&path),
                _ => self.http.delete(&path),
            };
            let req = match body { Some(b) => req.json(&b), None => req };
            let resp = req.send().await.map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            // _cat 端点常返回纯文本:先按 JSON 解析,失败则包成字符串走 status|response。
            let text = resp.text().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            let body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or(serde_json::Value::String(text));
            return Ok(es_query::parse_es_response(body, max_rows));
        }

        if let Some((index, limit)) = es_query::parse_select_star(input) {
            // 有效上限 = min(用户 LIMIT, max_rows);多取 1 行用于 truncated 检测,
            // 拍平时按有效上限截断(否则 LIMIT 50 会显示 51 行)。
            let effective = limit.unwrap_or(max_rows).min(max_rows);
            let body = serde_json::json!({ "from": 0, "size": (effective as u64) + 1, "sort": ["_doc"] });
            let resp = self.http.post(&format!("/{}/_search", index)).json(&body).send().await
                .map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            let body: serde_json::Value = resp.json().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            return Ok(es_query::parse_es_response(body, effective));
        }

        if es_query::is_select(input) {
            let body = serde_json::json!({
                "query": input.trim_end_matches(';'),
                "fetch_size": max_rows,
            });
            let resp = self.http.post("/_sql?format=json").json(&body).send().await
                .map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            let body: serde_json::Value = resp.json().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            return Ok(es_query::parse_es_response(body, max_rows));
        }

        Err(DbError::QueryFailed(es_query::ES_SYNTAX_HINT.into()))
    }

    /// Native index-data preview for the data grid: `table` is the index,
    /// paginated via `from`/`size`. The default SQL path can't run against ES.
    async fn table_data(&self, _schema: Option<&str>, table: &str, limit: u32, offset: u32)
        -> Result<QueryResult, DbError> {
        let index = table.trim();
        if index.is_empty() {
            return Err(DbError::QueryFailed("Elasticsearch: empty index name".into()));
        }
        let path = format!("/{}/_search", index);
        let body = serde_json::json!({
            "from": offset,
            "size": (limit as u64) + 1, // +1 to detect truncation
            "sort": ["_doc"],
        });
        let resp = self.http.post(&path).json(&body).send().await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch request failed: {e}")))?;
        let resp = check_response_query(resp).await?;
        let result: SearchResponse = resp.json().await
            .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;

        let mut hits = result.hits.hits;
        let truncated = hits.len() > limit as usize;
        if truncated {
            hits.truncate(limit as usize);
        }
        let mut all_keys: Vec<String> = vec!["_id".to_string()];
        let docs: Vec<serde_json::Map<String, serde_json::Value>> = hits
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
            name: k.clone(), type_name: String::new(), pk: k == "_id",
        }).collect();
        let rows: Vec<Vec<serde_json::Value>> = docs.iter().map(|doc| {
            all_keys.iter().map(|k| doc.get(k).cloned().unwrap_or(serde_json::Value::Null)).collect()
        }).collect();
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
                comment: String::new(),
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
                    comment: String::new(),
                });
            }
        }

        Ok(TableStructure {
            comment: String::new(),
            columns,
            indexes: Vec::<IndexDef>::new(),
            fks: Vec::<ForeignKeyDef>::new(),
            triggers: Vec::new(),
        })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // ES has no FK concept; er=false per capabilities
        Ok(vec![])
    }
}
