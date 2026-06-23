// adapted from dbx crates/dbx-core/src/db/sqlserver.rs, Apache-2.0
use async_trait::async_trait;
use futures_util::TryStreamExt;
use rust_decimal::Decimal;
use std::sync::Arc;
use tiberius::{AuthMethod, Client, ColumnData, Config, FromSql, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::db::{DatabaseType, DbError};
use crate::db::driver::{
    ColumnDef, ConnectArgs, Driver, ErRelation, ForeignKeyDef, IndexDef, TableInfo, TableStructure, TriggerDef,
};
use crate::db::result::{binary_to_json, safe_i64_to_json, ColumnInfo, QueryResult};

/// Column introspection SQL for SQL Server. `s`/`t` are already single-quote-escaped.
/// Column 5 (0-based) is the column comment from sys.extended_properties (MS_Description, class=1).
fn sqlserver_columns_sql(s: &str, t: &str) -> String {
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
         CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         CAST(( \
           SELECT ep.value FROM sys.extended_properties ep \
           WHERE ep.class = 1 \
             AND ep.major_id = OBJECT_ID('{s}.{t}') \
             AND ep.minor_id = COLUMNPROPERTY(OBJECT_ID('{s}.{t}'), c.COLUMN_NAME, 'ColumnId') \
             AND ep.name = 'MS_Description' \
         ) AS NVARCHAR(MAX)) AS COL_COMMENT \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
           ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
           AND c.TABLE_NAME = kcu.TABLE_NAME \
           AND c.COLUMN_NAME = kcu.COLUMN_NAME \
           AND kcu.CONSTRAINT_NAME IN ( \
             SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS \
             WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' \
               AND TABLE_SCHEMA = '{s}' AND TABLE_NAME = '{t}' \
           ) \
         WHERE c.TABLE_SCHEMA = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.ORDINAL_POSITION"
    )
}

/// Table-comment SQL for SQL Server (sys.extended_properties, class=1, minor_id=0, MS_Description).
fn sqlserver_table_comment_sql(s: &str, t: &str) -> String {
    format!(
        "SELECT CAST(ep.value AS NVARCHAR(MAX)) AS TBL_COMMENT \
         FROM sys.extended_properties ep \
         WHERE ep.class = 1 AND ep.minor_id = 0 \
           AND ep.major_id = OBJECT_ID('{s}.{t}') \
           AND ep.name = 'MS_Description'"
    )
}

/// Tiberius client wrapped in a mutex because `Client` needs `&mut self` for queries.
pub struct SqlServerDriver {
    client: Arc<Mutex<Client<Compat<TcpStream>>>>,
}

impl SqlServerDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let port = args.port;
        let host = args.host.clone();
        let user = args.user.clone();
        let pass = args.secret.clone().unwrap_or_default();
        let database = args.database.clone();

        let mut config = Config::new();
        config.host(&host);
        config.port(port);
        config.authentication(AuthMethod::sql_server(&user, &pass));
        if let Some(db) = &database {
            config.database(db);
        }
        // 证书信任策略:默认(ssl 未开)信任自签,便于内网/测试;ssl 开启后
        // 按 ca_cert_path / ssl_reject_unauthorized 决定校验方式。
        match sqlserver_trust_mode(args) {
            SqlServerTrust::TrustAll => config.trust_cert(),
            SqlServerTrust::TrustCa(path) => config.trust_cert_ca(path),
            SqlServerTrust::Verify => {}
        }

        let tcp = TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let client = Client::connect(config, tcp.compat_write())
            .await
            .map_err(|e| map_tiberius_error(e))?;

        Ok(Self {
            client: Arc::new(Mutex::new(client)),
        })
    }
}

/// SQL Server 的证书信任决策(纯函数,便于单测)。tiberius 默认对 TDS 流加密,
/// 这里决定是否校验服务器证书:
/// - `TrustAll`: 跳过校验(自签/测试,或显式 ssl_reject_unauthorized=false);
/// - `TrustCa(path)`: 用自定义 CA PEM 校验;
/// - `Verify`: 走系统信任根正常校验。
#[derive(Debug, PartialEq, Eq)]
enum SqlServerTrust {
    TrustAll,
    TrustCa(String),
    Verify,
}

fn sqlserver_trust_mode(args: &crate::db::driver::ConnectArgs) -> SqlServerTrust {
    // ssl 未显式开启:保持历史行为(信任自签证书,兼容内网/测试实例)。
    if !args.ssl {
        return SqlServerTrust::TrustAll;
    }
    if let Some(path) = args.ca_cert_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        return SqlServerTrust::TrustCa(path.to_string());
    }
    if args.ssl_reject_unauthorized == Some(false) {
        return SqlServerTrust::TrustAll;
    }
    SqlServerTrust::Verify
}

#[cfg(test)]
mod trust_tests {
    use super::{sqlserver_trust_mode, SqlServerTrust};
    use crate::db::driver::ConnectArgs;
    use crate::db::DatabaseType;

    fn args() -> ConnectArgs {
        ConnectArgs {
            db_type: DatabaseType::Sqlserver,
            host: "h".into(),
            port: 1433,
            user: "sa".into(),
            database: None,
            driver_profile: None,
            options: None,
            secret: None,
            ssl: false,
            ssl_mode: None,
            ca_cert_path: None,
            ssl_reject_unauthorized: None,
        }
    }

    #[test]
    fn ssl_off_trusts_all_for_backward_compat() {
        assert_eq!(sqlserver_trust_mode(&args()), SqlServerTrust::TrustAll);
    }

    #[test]
    fn ssl_on_verifies_by_default() {
        let mut a = args();
        a.ssl = true;
        assert_eq!(sqlserver_trust_mode(&a), SqlServerTrust::Verify);
    }

    #[test]
    fn ssl_on_with_ca_uses_ca() {
        let mut a = args();
        a.ssl = true;
        a.ca_cert_path = Some("/etc/ssl/ca.pem".into());
        assert_eq!(sqlserver_trust_mode(&a), SqlServerTrust::TrustCa("/etc/ssl/ca.pem".into()));
    }

    #[test]
    fn ssl_on_insecure_trusts_all() {
        let mut a = args();
        a.ssl = true;
        a.ssl_reject_unauthorized = Some(false);
        assert_eq!(sqlserver_trust_mode(&a), SqlServerTrust::TrustAll);
    }
}

fn map_tiberius_error(e: tiberius::error::Error) -> DbError {
    let msg = e.to_string();
    // Tiberius wraps auth failure messages with "Login failed" or "18456"
    if msg.contains("18456")
        || msg.contains("Login failed")
        || msg.contains("login failed")
        || msg.contains("password")
    {
        DbError::AuthFailed
    } else {
        DbError::ConnectFailed(msg)
    }
}

/// Map a tiberius ColumnData cell to serde_json::Value.
/// Type order mirrors dbx sqlserver.rs sqlserver_cell_to_json.
fn cell_to_json(cell: &ColumnData<'static>) -> serde_json::Value {
    // String types first (varchar, nvarchar, char, text, xml)
    if let Ok(Some(v)) = <&str as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    // Datetime types
    if let Ok(Some(v)) = <chrono::NaiveDateTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveDate as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::DateTime<chrono::FixedOffset> as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_rfc3339());
    }
    // Decimal / numeric → string to preserve precision
    if let Ok(Some(v)) = <Decimal as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    // Numeric integers (tinyint=u8, smallint=i16, int=i32, bigint=i64)
    if let Ok(Some(v)) = <u8 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i16 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i32 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i64 as FromSql>::from_sql(cell) {
        return safe_i64_to_json(v);
    }
    // Float
    if let Ok(Some(v)) = <f32 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(Some(v)) = <f64 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null);
    }
    // Bool (bit)
    if let Ok(Some(v)) = <bool as FromSql>::from_sql(cell) {
        return serde_json::Value::Bool(v);
    }
    // Binary (varbinary)
    if let Ok(Some(v)) = <Vec<u8> as tiberius::FromSqlOwned>::from_sql_owned(cell.clone()) {
        return binary_to_json(&v);
    }
    serde_json::Value::Null
}

/// Detect whether SQL begins with a keyword that returns rows.
fn is_row_returning(sql: &str) -> bool {
    let upper = sql.trim_start().to_ascii_uppercase();
    upper.starts_with("SELECT") || upper.starts_with("WITH") || upper.starts_with("EXEC")
}

#[async_trait]
impl Driver for SqlServerDriver {
    fn db_type(&self) -> DatabaseType {
        DatabaseType::Sqlserver
    }

    async fn test(&self) -> Result<String, DbError> {
        let mut client = self.client.lock().await;
        let stream = client
            .query("SELECT @@VERSION", &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let version = rows
            .first()
            .and_then(|row| row.try_get::<&str, _>(0).ok().flatten())
            .unwrap_or("")
            .to_string();
        Ok(version)
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let mut client = self.client.lock().await;

        if is_row_returning(sql) {
            // SELECT / WITH / EXEC — stream rows, honour max_rows
            let mut stream = client
                .query(sql, &[])
                .await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;

            let mut columns: Vec<ColumnInfo> = vec![];
            let mut rows: Vec<Vec<serde_json::Value>> = vec![];
            let mut truncated = false;

            while let Some(item) = stream
                .try_next()
                .await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?
            {
                match item {
                    QueryItem::Metadata(meta) if meta.result_index() == 0 => {
                        columns = meta
                            .columns()
                            .iter()
                            .map(|c| ColumnInfo {
                                name: c.name().to_string(),
                                type_name: String::new(),
                                pk: false,
                            })
                            .collect();
                    }
                    QueryItem::Metadata(_) => {}
                    QueryItem::Row(row) if row.result_index() == 0 => {
                        if rows.len() < max_rows as usize {
                            let vals: Vec<serde_json::Value> =
                                row.cells().map(|(_, cell)| cell_to_json(cell)).collect();
                            rows.push(vals);
                        } else {
                            truncated = true;
                        }
                    }
                    QueryItem::Row(_) => {}
                }
            }

            Ok(QueryResult {
                columns,
                rows,
                rows_affected: None,
                truncated,
            })
        } else {
            // INSERT / UPDATE / DELETE / DDL — use execute for rows_affected
            let result = client
                .execute(sql, &[])
                .await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let affected: u64 = result.rows_affected().iter().sum();
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(affected),
                truncated: false,
            })
        }
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let mut client = self.client.lock().await;
        // Query sys.schemas; exclude system schemas; dbo first.
        // Adapted from dbx sqlserver.rs list_schemas.
        let stream = client
            .query(
                "SELECT s.name \
                 FROM sys.schemas s \
                 WHERE s.name NOT IN ('guest','INFORMATION_SCHEMA','sys') \
                   AND s.name NOT LIKE 'db[_]%' \
                 ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name",
                &[],
            )
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string())
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let mut client = self.client.lock().await;
        let s = schema.replace('\'', "''");
        let sql = format!(
            "SELECT TABLE_NAME, TABLE_TYPE \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = '{s}' \
             ORDER BY TABLE_NAME"
        );
        let stream = client
            .query(&*sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| {
                let table_type = r.try_get::<&str, _>(1).ok().flatten().unwrap_or("BASE TABLE");
                let kind = if table_type == "VIEW" { "view" } else { "table" };
                TableInfo {
                    name: r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string(),
                    kind: kind.into(),
                    rows_estimate: None,
                }
            })
            .collect())
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        let mut client = self.client.lock().await;
        let s = schema.replace('\'', "''");
        let t = table.replace('\'', "''");

        // ---- columns with PK detection via INFORMATION_SCHEMA constraints ----
        // Adapted from dbx sqlserver.rs sqlserver_columns_sql.
        let col_sql = sqlserver_columns_sql(&s, &t);

        // Also query FK columns to mark them
        let fk_col_sql = format!(
            "SELECT kcu.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
             JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
               ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
               AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
               AND tc.TABLE_NAME = kcu.TABLE_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY' \
               AND kcu.TABLE_SCHEMA = '{s}' AND kcu.TABLE_NAME = '{t}'"
        );

        let fk_col_stream = client
            .query(&*fk_col_sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fk_col_rows = fk_col_stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fk_cols: std::collections::HashSet<String> = fk_col_rows
            .iter()
            .filter_map(|r| r.try_get::<&str, _>(0).ok().flatten().map(|s| s.to_string()))
            .collect();

        // Unique columns
        let uni_col_sql = format!(
            "SELECT kcu.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
             JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
               ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
               AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
               AND tc.TABLE_NAME = kcu.TABLE_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'UNIQUE' \
               AND kcu.TABLE_SCHEMA = '{s}' AND kcu.TABLE_NAME = '{t}'"
        );
        let uni_col_stream = client
            .query(&*uni_col_sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let uni_col_rows = uni_col_stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let uni_cols: std::collections::HashSet<String> = uni_col_rows
            .iter()
            .filter_map(|r| r.try_get::<&str, _>(0).ok().flatten().map(|s| s.to_string()))
            .collect();

        let col_stream = client
            .query(&*col_sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let col_rows = col_stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let columns: Vec<ColumnDef> = col_rows
            .iter()
            .map(|r| {
                let name = r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string();
                let type_name = r.try_get::<&str, _>(1).ok().flatten().unwrap_or("").to_string();
                let is_nullable = r.try_get::<&str, _>(2).ok().flatten().unwrap_or("NO") == "YES";
                let default = r.try_get::<&str, _>(3).ok().flatten().map(|s| s.to_string());
                let is_pk = r.try_get::<i32, _>(4).ok().flatten().unwrap_or(0) == 1;
                let is_fk = fk_cols.contains(&name);
                let is_uni = uni_cols.contains(&name);
                let key = if is_pk {
                    "PK"
                } else if is_fk {
                    "FK"
                } else if is_uni {
                    "UNI"
                } else {
                    ""
                };
                let comment = r.try_get::<&str, _>(5).ok().flatten().unwrap_or("").to_string();
                ColumnDef {
                    name,
                    type_name,
                    nullable: is_nullable,
                    default,
                    key: key.into(),
                    comment,
                }
            })
            .collect();

        // ---- indexes via sys.indexes / sys.index_columns ----
        // Adapted from dbx sqlserver.rs sqlserver_indexes_sql (uses FOR XML PATH for SQL Server 2012+ compat).
        let idx_sql = format!(
            "SELECT i.name, \
             STUFF(( \
               SELECT ',' + c2.name \
               FROM sys.index_columns ic2 \
               JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id \
               WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0 \
               ORDER BY ic2.key_ordinal \
               FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '') AS idx_cols, \
             i.is_unique, i.is_primary_key, i.type_desc \
             FROM sys.indexes i \
             WHERE i.object_id = OBJECT_ID('{s}.{t}') AND i.name IS NOT NULL \
             ORDER BY i.name"
        );
        let idx_stream = client
            .query(&*idx_sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let idx_rows = idx_stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let indexes: Vec<IndexDef> = idx_rows
            .iter()
            .map(|r| {
                let cols_str = r.try_get::<&str, _>(1).ok().flatten().unwrap_or("");
                IndexDef {
                    name: r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string(),
                    columns: cols_str.to_string(),
                    unique: r.try_get::<bool, _>(2).ok().flatten().unwrap_or(false),
                    method: r.try_get::<&str, _>(4).ok().flatten().unwrap_or("").to_string(),
                }
            })
            .collect();

        // ---- foreign keys ----
        // Adapted from dbx sqlserver.rs list_foreign_keys.
        let fk_sql = format!(
            "SELECT fk.name, c.name AS col, \
             SCHEMA_NAME(rt.schema_id) AS ref_schema, rt.name AS ref_table, rc.name AS ref_col, \
             fk.delete_referential_action_desc, fk.update_referential_action_desc \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
             JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id \
             JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id \
             JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
             WHERE fk.parent_object_id = OBJECT_ID('{s}.{t}') \
             ORDER BY fk.name, fkc.constraint_column_id"
        );
        let fk_stream = client
            .query(&*fk_sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fk_rows = fk_stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fks: Vec<ForeignKeyDef> = fk_rows
            .iter()
            .map(|r| {
                let ref_schema = r.try_get::<&str, _>(2).ok().flatten().unwrap_or("").to_string();
                let ref_table = r.try_get::<&str, _>(3).ok().flatten().unwrap_or("").to_string();
                let ref_col = r.try_get::<&str, _>(4).ok().flatten().unwrap_or("").to_string();
                ForeignKeyDef {
                    column: r.try_get::<&str, _>(1).ok().flatten().unwrap_or("").to_string(),
                    references: format!("{}.{}.{}", ref_schema, ref_table, ref_col),
                    on_delete: r
                        .try_get::<&str, _>(5)
                        .ok()
                        .flatten()
                        .unwrap_or("NO_ACTION")
                        .to_string(),
                    on_update: r
                        .try_get::<&str, _>(6)
                        .ok()
                        .flatten()
                        .unwrap_or("NO_ACTION")
                        .to_string(),
                    constraint_name: r.try_get::<&str, _>(0).ok().flatten().map(|s| s.to_string()),
                }
            })
            .collect();

        // ---- triggers (sys.triggers attached to this table) ----
        let trg_sql = format!(
            "SELECT tr.name FROM sys.triggers tr \
             WHERE tr.parent_id = OBJECT_ID('{s}.{t}') AND tr.is_ms_shipped = 0 \
             ORDER BY tr.name"
        );
        let triggers: Vec<TriggerDef> = match client.query(&*trg_sql, &[]).await {
            Ok(stream) => stream.into_first_result().await
                .map(|rows| rows.iter().map(|r| TriggerDef {
                    name: r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string(),
                    timing: None,
                    event: None,
                }).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        // ---- table comment (sys.extended_properties, minor_id = 0) ----
        let comment_sql = sqlserver_table_comment_sql(&s, &t);
        let comment = match client.query(&*comment_sql, &[]).await {
            Ok(stream) => stream
                .into_first_result()
                .await
                .ok()
                .and_then(|rows| {
                    rows.first()
                        .and_then(|r| r.try_get::<&str, _>(0).ok().flatten())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default(),
            Err(_) => String::new(),
        };

        Ok(TableStructure {
            comment,
            columns,
            indexes,
            fks,
            triggers,
        })
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        let mut client = self.client.lock().await;
        let s = schema.replace('\'', "''");
        // All FKs in the schema → ErRelation.
        // Adapted from dbx sqlserver.rs list_foreign_keys (schema-level).
        let sql = format!(
            "SELECT \
               OBJECT_NAME(fk.parent_object_id) AS from_table, \
               c.name AS from_col, \
               SCHEMA_NAME(rt.schema_id) AS to_schema, \
               rt.name AS to_table, \
               rc.name AS to_col \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
             JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id \
             JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id \
             JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
             WHERE SCHEMA_NAME(fk.schema_id) = '{s}' \
             ORDER BY from_table, fk.name, fkc.constraint_column_id"
        );
        let stream = client
            .query(&*sql, &[])
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| ErRelation {
                from: r.try_get::<&str, _>(0).ok().flatten().unwrap_or("").to_string(),
                from_col: r.try_get::<&str, _>(1).ok().flatten().unwrap_or("").to_string(),
                to: r.try_get::<&str, _>(3).ok().flatten().unwrap_or("").to_string(),
                to_col: r.try_get::<&str, _>(4).ok().flatten().unwrap_or("").to_string(),
            })
            .collect())
    }
}

#[cfg(test)]
mod comment_sql_tests {
    use super::{sqlserver_columns_sql, sqlserver_table_comment_sql};

    #[test]
    fn columns_sql_selects_ms_description() {
        let sql = sqlserver_columns_sql("dbo", "Users");
        assert!(sql.contains("MS_Description"), "列 SQL 必须取 MS_Description 扩展属性");
        assert!(sql.contains("sys.extended_properties"));
        assert!(sql.contains("ep.class = 1"));
        assert!(sql.contains("COLUMNPROPERTY"));
    }

    #[test]
    fn table_comment_sql_uses_minor_id_zero() {
        let sql = sqlserver_table_comment_sql("dbo", "Users");
        assert!(sql.contains("MS_Description"), "表注释 SQL 必须取 MS_Description");
        assert!(sql.contains("ep.minor_id = 0"), "表注释用 minor_id = 0");
    }
}
