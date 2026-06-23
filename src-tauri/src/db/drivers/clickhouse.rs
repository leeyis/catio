// adapted from dbx crates/dbx-core/src/db/clickhouse_driver.rs, Apache-2.0
use async_trait::async_trait;
use serde::Deserialize;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{ColumnInfo, QueryResult};
use crate::db::drivers::http::{HttpClient, check_response_connect, check_response_query};

/// ClickHouse driver — HTTP API with JSONCompact format.
/// sql_console = true, er = false (no FK concept).
pub struct ClickhouseDriver {
    http: HttpClient,
}

impl ClickhouseDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let base_url = format!("http://{}:{}", args.host, args.port);
        let user = if args.user.is_empty() { None } else { Some(args.user.as_str()) };
        let pass = args.secret.as_deref();
        let http = HttpClient::new(&base_url, user, pass);
        let driver = Self { http };
        // validate connection
        driver.test().await?;
        Ok(driver)
    }
}

/// JSONCompact response from ClickHouse.
#[derive(Deserialize)]
struct ChJsonCompact {
    meta: Vec<ChMeta>,
    data: Vec<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct ChMeta {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
}

/// POST SQL to ClickHouse `/?default_format=JSONCompact`.
async fn ch_query_in(http: &HttpClient, sql: &str, database: Option<&str>) -> Result<ChJsonCompact, DbError> {
    let url = "/?default_format=JSONCompact";
    let mut req = http.post(url);
    if let Some(db) = database.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.query(&[("database", db)]);
    }
    let resp = req.body(sql.to_string()).send().await
        .map_err(|e| DbError::QueryFailed(format!("ClickHouse request failed: {e}")))?;
    let resp = check_response_query(resp).await?;
    let result: ChJsonCompact = resp
        .json()
        .await
        .map_err(|e| DbError::QueryFailed(format!("ClickHouse parse error: {e}")))?;
    Ok(result)
}

async fn ch_query(http: &HttpClient, sql: &str) -> Result<ChJsonCompact, DbError> {
    ch_query_in(http, sql, None).await
}

fn is_nullable(type_name: &str) -> bool {
    type_name.starts_with("Nullable(")
}

/// Column introspection SQL. Selects `comment` (6th column) so the「备注」
/// column can be populated from `system.columns.comment`.
fn clickhouse_columns_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key, comment \
         FROM system.columns \
         WHERE database = '{}' AND table = '{}' \
         ORDER BY position",
        schema.replace('\'', "\\'"),
        table.replace('\'', "\\'")
    )
}

/// Table-level comment SQL (`system.tables.comment`).
fn clickhouse_table_comment_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT comment FROM system.tables WHERE database = '{}' AND name = '{}'",
        schema.replace('\'', "\\'"),
        table.replace('\'', "\\'")
    )
}

#[async_trait]
impl Driver for ClickhouseDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Clickhouse }

    async fn test(&self) -> Result<String, DbError> {
        let url = "/?query=SELECT+version()";
        let resp = self.http
            .get(url)
            .send()
            .await
            .map_err(|e| DbError::ConnectFailed(format!("ClickHouse request failed: {e}")))?;
        let resp = check_response_connect(resp).await?;
        let version = resp
            .text()
            .await
            .map_err(|e| DbError::ConnectFailed(format!("ClickHouse read failed: {e}")))?;
        Ok(version.trim().to_string())
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        self.query_with_default_namespace(sql, max_rows, None).await
    }

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        let sql_upper = sql.trim_start().to_uppercase();

        // For read statements use JSONCompact and parse result set
        if sql_upper.starts_with("SELECT")
            || sql_upper.starts_with("SHOW")
            || sql_upper.starts_with("DESCRIBE")
            || sql_upper.starts_with("EXPLAIN")
            || sql_upper.starts_with("WITH")
        {
            let result = ch_query_in(&self.http, sql, default_namespace).await?;
            let columns: Vec<ColumnInfo> = result.meta.iter().map(|m| ColumnInfo {
                name: m.name.clone(),
                type_name: m.type_name.clone(),
                pk: false,
            }).collect();

            let mut rows = result.data;
            let truncated = rows.len() > max_rows as usize;
            if truncated {
                rows.truncate(max_rows as usize);
            }
            Ok(QueryResult { columns, rows, rows_affected: None, truncated })
        } else {
            // DDL/DML — POST plain text, ClickHouse returns empty body on success
            let url = "/?default_format=JSONCompact";
            let mut req = self.http.post(url);
            if let Some(db) = default_namespace.map(str::trim).filter(|s| !s.is_empty()) {
                req = req.query(&[("database", db)]);
            }
            let resp = req.body(sql.to_string()).send().await
                .map_err(|e| DbError::QueryFailed(format!("ClickHouse request failed: {e}")))?;
            let _ = check_response_query(resp).await?;
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: None, // ClickHouse HTTP doesn't return affected-row count
                truncated: false,
            })
        }
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let result = ch_query(
            &self.http,
            "SELECT name FROM system.databases \
             WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
             ORDER BY name",
        ).await?;
        let schemas: Vec<String> = result.data.iter()
            .filter_map(|row| row.first().and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        Ok(schemas)
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let sql = format!(
            "SELECT name, engine FROM system.tables WHERE database = '{}' ORDER BY name",
            schema.replace('\'', "\\'")
        );
        let result = ch_query(&self.http, &sql).await?;
        let tables: Vec<TableInfo> = result.data.iter().map(|row| {
            let name = row.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            let engine = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let kind = if engine.contains("View") { "view" } else { "table" };
            TableInfo { name, kind: kind.into(), rows_estimate: None }
        }).collect();
        Ok(tables)
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        let result = ch_query(&self.http, &clickhouse_columns_sql(schema, table)).await?;

        let columns: Vec<ColumnDef> = result.data.iter().map(|row| {
            let name = row.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            let type_name = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let nullable = is_nullable(&type_name);
            let default_kind = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let default_expr = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
            let default = if default_kind.is_empty() { None } else { Some(default_expr.to_string()) };
            let is_pk = row.get(4)
                .map(|v| match v {
                    serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) == 1,
                    serde_json::Value::Bool(b) => *b,
                    serde_json::Value::String(s) => s == "1" || s.eq_ignore_ascii_case("true"),
                    _ => false,
                })
                .unwrap_or(false);
            let key = if is_pk { "PK" } else { "" };
            // system.columns.comment is the 6th selected column.
            let comment = row.get(5).and_then(|v| v.as_str()).unwrap_or("").to_string();
            ColumnDef { name, type_name, nullable, default, key: key.into(), comment }
        }).collect();

        // ---- table comment (system.tables.comment) ----
        let comment = ch_query(&self.http, &clickhouse_table_comment_sql(schema, table)).await
            .ok()
            .and_then(|r| r.data.into_iter().next())
            .and_then(|row| row.into_iter().next())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();

        // ClickHouse has no foreign keys or triggers
        Ok(TableStructure {
            comment,
            columns,
            indexes: Vec::<IndexDef>::new(),
            fks: Vec::<ForeignKeyDef>::new(),
            triggers: Vec::new(),
        })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // ClickHouse has no FK concept; er=false per capabilities
        Ok(vec![])
    }
}

#[cfg(test)]
mod comment_sql_tests {
    use super::{clickhouse_columns_sql, clickhouse_table_comment_sql};

    #[test]
    fn columns_sql_selects_comment_from_system_columns() {
        let sql = clickhouse_columns_sql("mydb", "users");
        assert!(sql.contains("system.columns"), "列 SQL 必须查 system.columns");
        assert!(sql.contains("comment"), "列 SQL 必须 SELECT comment 以填备注");
    }

    #[test]
    fn table_comment_sql_selects_comment_from_system_tables() {
        let sql = clickhouse_table_comment_sql("mydb", "users");
        assert!(sql.contains("system.tables"), "表注释 SQL 必须查 system.tables");
        assert!(sql.contains("comment"), "表注释 SQL 必须 SELECT comment");
    }
}
