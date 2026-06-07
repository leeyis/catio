// adapted from dbx crates/dbx-core/src/db/rqlite_driver.rs, Apache-2.0
use async_trait::async_trait;
use serde::Deserialize;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{ColumnInfo, QueryResult};
use crate::db::drivers::http::{HttpClient, check_response_query};

/// rqlite driver — SQLite-over-HTTP.
/// sql_console = true.
pub struct RqliteDriver {
    http: HttpClient,
}

impl RqliteDriver {
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

#[derive(Debug, Deserialize)]
struct RqliteResponse {
    results: Vec<RqliteResult>,
}

#[derive(Debug, Deserialize)]
struct RqliteResult {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    values: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows_affected: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

fn is_read(sql: &str) -> bool {
    let upper = sql.trim_start().to_uppercase();
    upper.starts_with("SELECT")
        || upper.starts_with("PRAGMA")
        || upper.starts_with("EXPLAIN")
        || upper.starts_with("WITH")
}

async fn rqlite_query(http: &HttpClient, sql: &str) -> Result<RqliteResult, DbError> {
    let body = serde_json::json!([sql]);
    let resp = http
        .post("/db/query")
        .json(&body)
        .send()
        .await
        .map_err(|e| DbError::QueryFailed(format!("rqlite request failed: {e}")))?;
    let resp = check_response_query(resp).await?;
    let text = resp.text().await
        .map_err(|e| DbError::QueryFailed(format!("rqlite read failed: {e}")))?;
    let response: RqliteResponse = serde_json::from_str(&text)
        .map_err(|e| DbError::QueryFailed(format!("rqlite parse error: {e}; body: {text}")))?;
    extract_first_result(response)
}

async fn rqlite_execute(http: &HttpClient, sql: &str) -> Result<RqliteResult, DbError> {
    let body = serde_json::json!([sql]);
    let resp = http
        .post("/db/execute")
        .json(&body)
        .send()
        .await
        .map_err(|e| DbError::QueryFailed(format!("rqlite request failed: {e}")))?;
    let resp = check_response_query(resp).await?;
    let text = resp.text().await
        .map_err(|e| DbError::QueryFailed(format!("rqlite read failed: {e}")))?;
    let response: RqliteResponse = serde_json::from_str(&text)
        .map_err(|e| DbError::QueryFailed(format!("rqlite parse error: {e}; body: {text}")))?;
    extract_first_result(response)
}

fn extract_first_result(response: RqliteResponse) -> Result<RqliteResult, DbError> {
    let result = response.results.into_iter().next()
        .ok_or_else(|| DbError::QueryFailed("rqlite returned no result".into()))?;
    if let Some(ref err) = result.error {
        if !err.is_empty() {
            return Err(DbError::QueryFailed(format!("rqlite error: {err}")));
        }
    }
    Ok(result)
}

fn value_by_column(columns: &[String], row: &[serde_json::Value], name: &str) -> Option<String> {
    columns.iter().position(|c| c.eq_ignore_ascii_case(name))
        .and_then(|i| row.get(i))
        .and_then(|v| match v {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::Bool(b) => Some(b.to_string()),
            other => Some(other.to_string()),
        })
}

fn sqlite_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[async_trait]
impl Driver for RqliteDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Rqlite }

    async fn test(&self) -> Result<String, DbError> {
        // Validate with SELECT 1 via /db/query
        let result = rqlite_query(&self.http, "SELECT 1 AS n").await
            .map_err(|e| DbError::ConnectFailed(format!("rqlite connect failed: {e}")))?;
        let val = result.values.first()
            .and_then(|row| row.first())
            .map(|v| v.to_string())
            .unwrap_or_else(|| "1".to_string());
        Ok(format!("rqlite ok (SELECT 1 = {val})"))
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        if is_read(sql) {
            let result = rqlite_query(&self.http, sql).await?;
            let columns: Vec<ColumnInfo> = result.columns.iter().map(|c| ColumnInfo {
                name: c.clone(),
                type_name: String::new(),
                pk: false,
            }).collect();
            let mut rows = result.values;
            let truncated = rows.len() > max_rows as usize;
            if truncated {
                rows.truncate(max_rows as usize);
            }
            Ok(QueryResult { columns, rows, rows_affected: None, truncated })
        } else {
            let result = rqlite_execute(&self.http, sql).await?;
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: result.rows_affected,
                truncated: false,
            })
        }
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec!["main".to_string()])
    }

    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let result = rqlite_query(
            &self.http,
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        ).await?;

        let tables: Vec<TableInfo> = result.values.iter().map(|row| {
            let name = row.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            let kind_raw = row.get(1).and_then(|v| v.as_str()).unwrap_or("table");
            let kind = if kind_raw.eq_ignore_ascii_case("view") { "view" } else { "table" };
            TableInfo { name, kind: kind.into(), rows_estimate: None }
        }).collect();
        Ok(tables)
    }

    async fn table_structure(&self, _schema: &str, table: &str) -> Result<TableStructure, DbError> {
        // columns via PRAGMA table_info
        let col_result = rqlite_query(
            &self.http,
            &format!("PRAGMA table_info({})", sqlite_ident(table)),
        ).await?;

        let columns: Vec<ColumnDef> = col_result.values.iter().map(|row| {
            let name = value_by_column(&col_result.columns, row, "name").unwrap_or_default();
            let type_name = value_by_column(&col_result.columns, row, "type").unwrap_or_default();
            let notnull: i64 = value_by_column(&col_result.columns, row, "notnull")
                .and_then(|s| s.parse().ok()).unwrap_or(0);
            let nullable = notnull == 0;
            let default = value_by_column(&col_result.columns, row, "dflt_value");
            let pk: i64 = value_by_column(&col_result.columns, row, "pk")
                .and_then(|s| s.parse().ok()).unwrap_or(0);
            let key = if pk > 0 { "PK" } else { "" };
            ColumnDef { name, type_name, nullable, default, key: key.into() }
        }).collect();

        // indexes via PRAGMA index_list
        let idx_list = rqlite_query(
            &self.http,
            &format!("PRAGMA index_list({})", sqlite_ident(table)),
        ).await.unwrap_or_else(|_| RqliteResult {
            columns: vec![], values: vec![], rows_affected: None, error: None
        });

        let mut indexes: Vec<IndexDef> = Vec::new();
        for row in &idx_list.values {
            let idx_name = match value_by_column(&idx_list.columns, row, "name") {
                Some(n) if !n.is_empty() => n,
                _ => continue,
            };
            let unique: i64 = value_by_column(&idx_list.columns, row, "unique")
                .and_then(|s| s.parse().ok()).unwrap_or(0);

            // Get columns for this index
            let idx_info = rqlite_query(
                &self.http,
                &format!("PRAGMA index_info({})", sqlite_ident(&idx_name)),
            ).await.unwrap_or_else(|_| RqliteResult {
                columns: vec![], values: vec![], rows_affected: None, error: None
            });
            let idx_cols: Vec<String> = idx_info.values.iter()
                .filter_map(|r| value_by_column(&idx_info.columns, r, "name"))
                .collect();

            indexes.push(IndexDef {
                name: idx_name,
                columns: idx_cols.join(", "),
                unique: unique != 0,
                method: "btree".into(),
            });
        }

        // foreign keys via PRAGMA foreign_key_list
        let fk_list = rqlite_query(
            &self.http,
            &format!("PRAGMA foreign_key_list({})", sqlite_ident(table)),
        ).await.unwrap_or_else(|_| RqliteResult {
            columns: vec![], values: vec![], rows_affected: None, error: None
        });

        let fks: Vec<ForeignKeyDef> = fk_list.values.iter().map(|row| {
            let _id = value_by_column(&fk_list.columns, row, "id").unwrap_or_else(|| "0".to_string());
            let from_col = value_by_column(&fk_list.columns, row, "from").unwrap_or_default();
            let ref_table = value_by_column(&fk_list.columns, row, "table").unwrap_or_default();
            let ref_col = value_by_column(&fk_list.columns, row, "to").unwrap_or_default();
            ForeignKeyDef {
                column: from_col,
                references: format!("main.{}.{}", ref_table, ref_col),
                on_delete: value_by_column(&fk_list.columns, row, "on_delete")
                    .unwrap_or_else(|| "NO ACTION".into()),
                on_update: value_by_column(&fk_list.columns, row, "on_update")
                    .unwrap_or_else(|| "NO ACTION".into()),
            }
        }).collect();

        Ok(TableStructure { columns, indexes, fks })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // Enumerate all tables and collect FK relations
        let tables = self.list_tables("main").await?;
        let mut relations: Vec<ErRelation> = Vec::new();

        for tbl in &tables {
            if tbl.kind != "table" { continue; }
            let fk_list = rqlite_query(
                &self.http,
                &format!("PRAGMA foreign_key_list({})", sqlite_ident(&tbl.name)),
            ).await.unwrap_or_else(|_| RqliteResult {
                columns: vec![], values: vec![], rows_affected: None, error: None
            });

            for row in &fk_list.values {
                let from_col = value_by_column(&fk_list.columns, row, "from").unwrap_or_default();
                let to_table = value_by_column(&fk_list.columns, row, "table").unwrap_or_default();
                let to_col = value_by_column(&fk_list.columns, row, "to").unwrap_or_default();
                if !from_col.is_empty() && !to_table.is_empty() {
                    relations.push(ErRelation {
                        from: tbl.name.clone(),
                        from_col,
                        to: to_table,
                        to_col,
                    });
                }
            }
        }
        Ok(relations)
    }
}
