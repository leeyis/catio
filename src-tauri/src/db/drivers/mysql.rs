// adapted from dbx crates/dbx-core/src/db/mysql.rs (+ ob_oracle.rs for oceanbase-oracle), Apache-2.0
use async_trait::async_trait;
use futures_util::StreamExt;
use mysql_async::{Opts, OptsBuilder, Pool, prelude::*};
use mysql_async::consts::ColumnType;
use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::result::QueryResult;

pub struct MySqlDriver {
    pool: Pool,
    profile: Option<String>,
    /// The database name we connected to (used as the single "schema").
    database: String,
}

impl MySqlDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let db = args.database.clone().unwrap_or_default();
        let opts = build_mysql_opts(args)?;
        let pool = Pool::new(opts);
        // Validate by acquiring a connection
        let _conn = pool.get_conn().await.map_err(|e| {
            let s = e.to_string();
            if s.contains("Access denied") {
                DbError::AuthFailed
            } else {
                DbError::ConnectFailed(s)
            }
        })?;
        Ok(Self { pool, profile: args.driver_profile.clone(), database: db })
    }
}

/// 构建 mysql_async 连接 URL 的查询串(含前导 `?`,空则返回空串)。
/// 把用户的 options 与 SSL/TLS 开关合并:ssl=true 注入 `require_ssl=true`;
/// insecure 时再加 `verify_ca=false&verify_identity=false` 跳过证书/主机名校验。
fn build_mysql_query(options: Option<&str>, ssl: bool, insecure: bool) -> String {
    let mut parts: Vec<String> = options
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|o| {
            o.trim_start_matches(['?', '&'])
                .split('&')
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    fn has_key(parts: &[String], key: &str) -> bool {
        parts.iter().any(|p| {
            p.split_once('=').map(|(k, _)| k.trim()).unwrap_or(p.trim()).eq_ignore_ascii_case(key)
        })
    }

    if ssl {
        if !has_key(&parts, "require_ssl") && !has_key(&parts, "ssl-mode") && !has_key(&parts, "sslmode") {
            parts.push("require_ssl=true".to_string());
        }
        if insecure {
            if !has_key(&parts, "verify_ca") {
                parts.push("verify_ca=false".to_string());
            }
            if !has_key(&parts, "verify_identity") {
                parts.push("verify_identity=false".to_string());
            }
        }
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// 构建 mysql_async 的 `Opts`:先用 URL 携带 require_ssl/verify_ca 等开关解析出
/// 基础 Opts;若开启 SSL 且提供了自定义 CA 证书路径,则在解析出的 `SslOpts` 上注入
/// 该根证书(URL 查询串无法表达自定义 CA,只能经 `SslOpts::with_root_certs`)。
/// 对齐 dbx 的 ssl + ca_cert_path 能力;无 CA / 无 TLS 时行为与原 URL 路径一致。
fn build_mysql_opts(args: &ConnectArgs) -> Result<Opts, DbError> {
    let db = args.database.clone().unwrap_or_default();
    let insecure = args.ssl_reject_unauthorized == Some(false);
    let query = build_mysql_query(args.options.as_deref(), args.ssl, insecure);
    let url = format!(
        "mysql://{}:{}@{}:{}/{}{}",
        args.user,
        args.secret.clone().unwrap_or_default(),
        args.host,
        args.port,
        db,
        query,
    );
    let opts = Opts::from_url(&url).map_err(|e| DbError::ConnectFailed(e.to_string()))?;

    // 自定义 CA 仅在 TLS 开启时有意义。require_ssl=true 时 from_url 已产出 SslOpts,
    // 在其基础上追加根证书路径(保留 verify_ca/verify_identity 等已解析的开关)。
    let ca = args.ca_cert_path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if args.ssl {
        if let Some(path) = ca {
            let base_ssl = opts.ssl_opts().cloned().unwrap_or_default();
            let ssl = base_ssl.with_root_certs(vec![std::path::PathBuf::from(path).into()]);
            return Ok(OptsBuilder::from_opts(opts).ssl_opts(ssl).into());
        }
    }
    Ok(opts)
}

// ── value extraction helpers (adapted from dbx db/mysql.rs) ──────────────────

fn row_get<T, I>(row: &mysql_async::Row, index: I) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
    I: mysql_async::prelude::ColumnIndex,
{
    row.get_opt::<T, I>(index).and_then(|r| r.ok())
}

/// Extract a String from a row column by position, falling back via Vec<u8>.
fn get_str(row: &mysql_async::Row, idx: usize) -> String {
    row_get::<String, _>(row, idx)
        .or_else(|| {
            row_get::<Vec<u8>, _>(row, idx)
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .unwrap_or_default()
}

/// Extract an optional String from a row column by name.
fn get_opt_str_by_name(row: &mysql_async::Row, name: &str) -> Option<String> {
    row_get::<String, _>(row, name)
        .or_else(|| {
            row_get::<Vec<u8>, _>(row, name)
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
}

/// Extract a String from a row column by name.
fn get_str_by_name(row: &mysql_async::Row, name: &str) -> String {
    get_opt_str_by_name(row, name).unwrap_or_default()
}

/// Quote a string value for use in SQL (single-quoted).
fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Map a single MySQL row column value to serde_json::Value.
/// Adapted from dbx crates/dbx-core/src/db/mysql.rs mysql_value_to_json.
fn mysql_value_to_json(row: &mysql_async::Row, idx: usize) -> serde_json::Value {
    use crate::db::result::{safe_i64_to_json, binary_to_json};
    use serde_json::Value;

    let Some(column) = row.columns_ref().get(idx) else {
        return Value::Null;
    };

    // Check for NULL
    let Some(raw_val) = row.as_ref(idx) else {
        return Value::Null;
    };
    if matches!(raw_val, mysql_async::Value::NULL) {
        return Value::Null;
    }

    match column.column_type() {
        ColumnType::MYSQL_TYPE_TINY
        | ColumnType::MYSQL_TYPE_SHORT
        | ColumnType::MYSQL_TYPE_LONG
        | ColumnType::MYSQL_TYPE_INT24
        | ColumnType::MYSQL_TYPE_YEAR => {
            if let Some(v) = row_get::<i64, _>(row, idx) {
                return safe_i64_to_json(v);
            }
            if let Some(v) = row_get::<u64, _>(row, idx) {
                return if v <= i64::MAX as u64 {
                    safe_i64_to_json(v as i64)
                } else {
                    Value::String(v.to_string())
                };
            }
        }
        ColumnType::MYSQL_TYPE_LONGLONG => {
            // BIGINT — may exceed JS safe integer, stringify if needed
            if let Some(v) = row_get::<i64, _>(row, idx) {
                return safe_i64_to_json(v);
            }
            if let Some(v) = row_get::<u64, _>(row, idx) {
                return Value::String(v.to_string());
            }
        }
        ColumnType::MYSQL_TYPE_FLOAT => {
            if let Some(v) = row_get::<f32, _>(row, idx) {
                return serde_json::Number::from_f64(v as f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null);
            }
        }
        ColumnType::MYSQL_TYPE_DOUBLE => {
            if let Some(v) = row_get::<f64, _>(row, idx) {
                return serde_json::Number::from_f64(v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null);
            }
        }
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => {
            // Return as string to preserve precision
            if let Some(v) = row_get::<rust_decimal::Decimal, _>(row, idx) {
                return Value::String(v.to_string());
            }
            if let Some(v) = row_get::<String, _>(row, idx) {
                return Value::String(v);
            }
        }
        ColumnType::MYSQL_TYPE_BIT => {
            if let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) {
                let val = bytes.iter().fold(0u64, |acc, &b| (acc << 8) | b as u64);
                return Value::String(val.to_string());
            }
        }
        ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_TINY_BLOB => {
            // binary charset (63) → hex; otherwise TEXT → string
            if column.character_set() == 63 {
                if let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) {
                    return binary_to_json(&bytes);
                }
            }
            // TEXT column stored as BLOB type with non-binary charset
            if let Some(v) = row_get::<String, _>(row, idx) {
                return Value::String(v);
            }
            if let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) {
                return Value::String(String::from_utf8_lossy(&bytes).to_string());
            }
        }
        ColumnType::MYSQL_TYPE_GEOMETRY => {
            if let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) {
                return binary_to_json(&bytes);
            }
        }
        ColumnType::MYSQL_TYPE_TIMESTAMP
        | ColumnType::MYSQL_TYPE_TIMESTAMP2
        | ColumnType::MYSQL_TYPE_DATETIME
        | ColumnType::MYSQL_TYPE_DATETIME2
        | ColumnType::MYSQL_TYPE_DATE
        | ColumnType::MYSQL_TYPE_NEWDATE => {
            if let Some(v) = row_get::<chrono::NaiveDateTime, _>(row, idx) {
                return Value::String(v.to_string());
            }
            if let Some(v) = row_get::<chrono::NaiveDate, _>(row, idx) {
                return Value::String(v.to_string());
            }
        }
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2 => {
            if let Some(v) = row_get::<chrono::NaiveTime, _>(row, idx) {
                return Value::String(v.to_string());
            }
        }
        ColumnType::MYSQL_TYPE_JSON => {
            if let Some(v) = row_get::<String, _>(row, idx) {
                return Value::String(v);
            }
        }
        _ => {}
    }

    // Generic fallback: try String, then i64, then bytes
    if let Some(v) = row_get::<String, _>(row, idx) {
        return Value::String(v);
    }
    if let Some(v) = row_get::<i64, _>(row, idx) {
        return safe_i64_to_json(v);
    }
    if let Some(v) = row_get::<f64, _>(row, idx) {
        return serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Some(bytes) = row_get::<Vec<u8>, _>(row, idx) {
        return Value::String(String::from_utf8_lossy(&bytes).to_string());
    }
    Value::Null
}

async fn mysql_query_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    max_rows: u32,
) -> Result<QueryResult, DbError> {
    use crate::db::result::ColumnInfo;
    use serde_json::Value;

    // Use query_iter for both SELECT and DML
    let mut result = conn.query_iter(sql).await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;

    // Build column list from the result set metadata
    let col_names: Vec<String> = result
        .columns()
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| c.name_str().to_string())
        .collect();

    let col_types: Vec<String> = result
        .columns()
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| format!("{:?}", c.column_type()))
        .collect();

    // No columns means this is a write statement
    if col_names.is_empty() {
        let affected = result.affected_rows();
        result.drop_result().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(affected),
            truncated: false,
        });
    }

    let columns: Vec<ColumnInfo> = col_names.iter().zip(col_types.iter()).map(|(name, type_name)| {
        ColumnInfo {
            name: name.clone(),
            type_name: type_name.clone(),
            pk: false,
        }
    }).collect();

    // Stream rows
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    let stream = result
        .stream::<mysql_async::Row>()
        .await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;

    // stream() returns None if no result set (DML); treat as 0 rows
    if let Some(mut stream) = stream {
        while let Some(row_result) = stream.next().await {
            let row = row_result.map_err(|e| DbError::QueryFailed(e.to_string()))?;
            if rows.len() as u32 >= max_rows {
                truncated = true;
                break;
            }
            let values: Vec<Value> = (0..row.len()).map(|i| mysql_value_to_json(&row, i)).collect();
            rows.push(values);
        }
    }

    Ok(QueryResult { columns, rows, rows_affected: None, truncated })
}

fn quote_mysql_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

async fn current_mysql_database(conn: &mut mysql_async::Conn) -> Result<Option<String>, DbError> {
    let row: Option<mysql_async::Row> = conn
        .query_first("SELECT DATABASE()")
        .await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
    Ok(row.and_then(|r| get_opt_str_by_name(&r, "DATABASE()").or_else(|| row_get::<String, _>(&r, 0))))
}

#[async_trait]
impl Driver for MySqlDriver {
    fn db_type(&self) -> DatabaseType {
        DatabaseType::Mysql
    }

    async fn test(&self) -> Result<String, DbError> {
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let row: Option<mysql_async::Row> = conn
            .query_first("SELECT version()")
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let version = row
            .map(|r| get_str(&r, 0))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(version)
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        mysql_query_on_conn(&mut conn, sql, max_rows).await
    }

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        let Some(database) = default_namespace.map(str::trim).filter(|s| !s.is_empty()) else {
            return self.query(sql, max_rows).await;
        };
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let original_database = current_mysql_database(&mut conn).await?;
        if original_database.as_deref() != Some(database) {
            conn.query_drop(format!("USE {}", quote_mysql_ident(database))).await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        }
        let result = mysql_query_on_conn(&mut conn, sql, max_rows).await;
        if original_database.as_deref() != Some(database) {
            let reset = match original_database.as_deref().filter(|s| !s.is_empty()) {
                Some(db) => conn.query_drop(format!("USE {}", quote_mysql_ident(db))).await,
                None => {
                    // MySQL has no "USE none"; dropping the connection is safer
                    // than returning a database-scoped session to the pool.
                    return match conn.disconnect().await {
                        Ok(()) => result,
                        Err(e) => Err(DbError::QueryFailed(e.to_string())),
                    };
                }
            };
            if let Err(e) = reset {
                let _ = conn.disconnect().await;
                return Err(DbError::QueryFailed(e.to_string()));
            }
        }
        result
    }

    // ── Introspection ──────────────────────────────────────────────────────────
    // MySQL has no schema namespace: list_schemas returns the connected DB name.
    // list_tables / table_structure / er_relations operate within that database.
    // OceanBase-Oracle mode uses Oracle system views (ALL_TABLES/ALL_USERS/etc.)
    // via the same mysql_async connection — branch by driver_profile.
    // SQL adapted from dbx crates/dbx-core/src/db/mysql.rs + ob_oracle.rs, Apache-2.0.

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        if self.profile.as_deref() == Some("oceanbase-oracle") {
            // OceanBase-Oracle: schemas = users/owners
            let mut conn = self.pool.get_conn().await
                .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
            let sql = "SELECT USERNAME FROM ALL_USERS \
                       WHERE USERNAME NOT IN ('SYS','LBACSYS','ORAAUDITOR','__public') \
                       ORDER BY USERNAME";
            let result = conn.query_iter(sql).await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let rows: Vec<mysql_async::Row> = result
                .collect_and_drop()
                .await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            return Ok(rows.iter().map(|r| get_str(r, 0)).collect());
        }
        // Standard MySQL: expose databases as namespaces so the query console can
        // choose a default database, matching DBX's catalog-scoped execution model.
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let result = conn.query_iter(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') \
             ORDER BY CASE WHEN SCHEMA_NAME = DATABASE() THEN 0 ELSE 1 END, SCHEMA_NAME"
        ).await.map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let mut schemas: Vec<String> = rows.iter().map(|r| get_str(r, 0)).filter(|s| !s.is_empty()).collect();
        if schemas.is_empty() && !self.database.is_empty() {
            schemas.push(self.database.clone());
        }
        Ok(schemas)
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        if self.profile.as_deref() == Some("oceanbase-oracle") {
            return self.ob_list_tables(schema).await;
        }
        // Standard MySQL — adapted from dbx list_tables / information_schema.TABLES
        let sql = format!(
            "SELECT TABLE_NAME, TABLE_TYPE \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {} \
             ORDER BY TABLE_NAME",
            quote_value(schema),
        );
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let result = conn.query_iter(&sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| {
            let table_type = get_str_by_name(r, "TABLE_TYPE");
            let kind = if table_type.eq_ignore_ascii_case("VIEW") { "view" } else { "table" };
            TableInfo {
                name: get_str_by_name(r, "TABLE_NAME"),
                kind: kind.into(),
                rows_estimate: None,
            }
        }).collect())
    }

    async fn table_data(&self, schema: Option<&str>, table: &str, limit: u32, offset: u32)
        -> Result<QueryResult, DbError> {
        let qualified = match schema.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => format!("{}.{}", quote_mysql_ident(s), quote_mysql_ident(table)),
            None => quote_mysql_ident(table),
        };
        self.paginated_query(&format!("SELECT * FROM {}", qualified), limit, offset).await
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        if self.profile.as_deref() == Some("oceanbase-oracle") {
            return self.ob_table_structure(schema, table).await;
        }
        self.mysql_table_structure(schema, table).await
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        if self.profile.as_deref() == Some("oceanbase-oracle") {
            return self.ob_er_relations(schema).await;
        }
        self.mysql_er_relations(schema).await
    }

    async fn list_functions(&self, schema: &str) -> Result<Vec<String>, DbError> {
        // information_schema.routines includes both FUNCTION and PROCEDURE routines.
        let sql = format!(
            "SELECT routine_name FROM information_schema.routines \
             WHERE routine_schema = {} ORDER BY routine_name",
            quote_value(schema),
        );
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let result = conn.query_iter(&sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| get_str(r, 0)).collect())
    }

    async fn object_source(&self, schema: &str, name: &str, kind: &str) -> Result<String, DbError> {
        // SHOW CREATE {VIEW|FUNCTION|PROCEDURE} `schema`.`name` — the create text is
        // in the 2nd column of the returned row. Best-effort: any error → "".
        let stmt = match kind {
            "view" => "VIEW",
            "function" => "FUNCTION",
            "procedure" => "PROCEDURE",
            _ => return Ok(String::new()),
        };
        // For SHOW CREATE VIEW the create text is column index 1; for FUNCTION /
        // PROCEDURE the routine name is col 0 and the create text is col 2.
        let text_idx = if kind == "view" { 1 } else { 2 };
        let sql = format!(
            "SHOW CREATE {} `{}`.`{}`",
            stmt,
            schema.replace('`', "``"),
            name.replace('`', "``"),
        );
        let mut conn = match self.pool.get_conn().await {
            Ok(c) => c,
            Err(_) => return Ok(String::new()),
        };
        let row: Option<mysql_async::Row> = match conn.query_first(&sql).await {
            Ok(r) => r,
            Err(_) => return Ok(String::new()),
        };
        Ok(row.map(|r| get_str(&r, text_idx)).unwrap_or_default())
    }
}

// ── Standard MySQL introspection helpers ────────────────────────────────────

/// Build the column introspection SQL for standard MySQL.
/// Includes c.COLUMN_COMMENT so the「备注」column can be populated.
fn mysql_columns_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, \
         c.COLUMN_KEY, c.COLUMN_COMMENT, \
         CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk, \
         CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_fk \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE pk \
           ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA \
           AND pk.TABLE_NAME = c.TABLE_NAME \
           AND pk.COLUMN_NAME = c.COLUMN_NAME \
           AND pk.CONSTRAINT_NAME = 'PRIMARY' \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE fk \
           ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA \
           AND fk.TABLE_NAME = c.TABLE_NAME \
           AND fk.COLUMN_NAME = c.COLUMN_NAME \
           AND fk.REFERENCED_TABLE_NAME IS NOT NULL \
         WHERE c.TABLE_SCHEMA = {s} AND c.TABLE_NAME = {t} \
         ORDER BY c.ORDINAL_POSITION",
        s = quote_value(schema),
        t = quote_value(table),
    )
}

/// Build the table-comment SQL for standard MySQL (information_schema.TABLES.TABLE_COMMENT).
fn mysql_table_comment_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT TABLE_COMMENT FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {t}",
        s = quote_value(schema),
        t = quote_value(table),
    )
}

/// Build the trigger-list SQL for standard MySQL (information_schema.TRIGGERS).
/// 列:TRIGGER_NAME / ACTION_TIMING(BEFORE|AFTER) / EVENT_MANIPULATION(INSERT|UPDATE|DELETE)。
fn mysql_triggers_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION \
         FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = {s} AND EVENT_OBJECT_TABLE = {t} \
         ORDER BY TRIGGER_NAME",
        s = quote_value(schema),
        t = quote_value(table),
    )
}

impl MySqlDriver {
    /// table_structure for standard MySQL.
    /// Adapted from dbx list_columns/list_indexes/list_foreign_keys, Apache-2.0.
    async fn mysql_table_structure(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, DbError> {
        use crate::db::driver::{ColumnDef, IndexDef, ForeignKeyDef, TriggerDef};

        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;

        // ---- columns ----
        // adapted from dbx columns_sql (information_schema.COLUMNS + KEY_COLUMN_USAGE for PK)
        let col_sql = mysql_columns_sql(schema, table);
        let result = conn.query_iter(&col_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let col_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let columns: Vec<ColumnDef> = col_rows.iter().map(|r| {
            let column_key = get_str_by_name(r, "COLUMN_KEY");
            let is_pk = row_get::<i32, _>(r, "is_pk").unwrap_or(0) == 1
                || column_key.eq_ignore_ascii_case("PRI");
            let is_fk = row_get::<i32, _>(r, "is_fk").unwrap_or(0) == 1;
            let is_uni = column_key.eq_ignore_ascii_case("UNI");
            let key = if is_pk { "PK" } else if is_fk { "FK" } else if is_uni { "UNI" } else { "" };
            let nullable = get_str_by_name(r, "IS_NULLABLE").eq_ignore_ascii_case("YES");
            ColumnDef {
                name: get_str_by_name(r, "COLUMN_NAME"),
                type_name: get_str_by_name(r, "COLUMN_TYPE"),
                nullable,
                default: get_opt_str_by_name(r, "COLUMN_DEFAULT"),
                key: key.into(),
                comment: get_str_by_name(r, "COLUMN_COMMENT"),
            }
        }).collect();

        // ---- indexes ----
        // adapted from dbx list_indexes: GROUP_CONCAT columns by SEQ_IN_INDEX
        let idx_sql = format!(
            "SELECT INDEX_NAME, \
             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS columns, \
             MIN(NON_UNIQUE) = 0 AS is_unique, \
             INDEX_TYPE \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {t} \
             GROUP BY INDEX_NAME, INDEX_TYPE \
             ORDER BY INDEX_NAME",
            s = quote_value(schema),
            t = quote_value(table),
        );
        let result = conn.query_iter(&idx_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let idx_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let indexes: Vec<IndexDef> = idx_rows.iter().map(|r| {
            let unique: bool = row_get::<i32, _>(r, "is_unique").unwrap_or(0) == 1
                || row_get::<u8, _>(r, "is_unique").unwrap_or(0) == 1;
            IndexDef {
                name: get_str_by_name(r, "INDEX_NAME"),
                columns: get_str_by_name(r, "columns"),
                unique,
                method: get_str_by_name(r, "INDEX_TYPE"),
            }
        }).collect();

        // ---- foreign keys ----
        // adapted from dbx list_foreign_keys (KEY_COLUMN_USAGE)
        let fk_sql = format!(
            "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, \
             kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, \
             rc.DELETE_RULE, rc.UPDATE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
               AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA \
             WHERE kcu.TABLE_SCHEMA = {s} AND kcu.TABLE_NAME = {t} \
             AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            s = quote_value(schema),
            t = quote_value(table),
        );
        let result = conn.query_iter(&fk_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fk_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let fks: Vec<ForeignKeyDef> = fk_rows.iter().map(|r| {
            let ref_schema = get_str_by_name(r, "REFERENCED_TABLE_SCHEMA");
            let ref_table = get_str_by_name(r, "REFERENCED_TABLE_NAME");
            let ref_col = get_str_by_name(r, "REFERENCED_COLUMN_NAME");
            ForeignKeyDef {
                column: get_str_by_name(r, "COLUMN_NAME"),
                references: format!("{}.{}.{}", ref_schema, ref_table, ref_col),
                on_delete: get_opt_str_by_name(r, "DELETE_RULE")
                    .unwrap_or_else(|| "NO ACTION".into()),
                on_update: get_opt_str_by_name(r, "UPDATE_RULE")
                    .unwrap_or_else(|| "NO ACTION".into()),
                constraint_name: get_opt_str_by_name(r, "CONSTRAINT_NAME"),
            }
        }).collect();

        // ---- triggers ----
        // information_schema.TRIGGERS：按表过滤,带触发时机/事件用于展示。
        let trg_sql = mysql_triggers_sql(schema, table);
        let trg_rows: Vec<mysql_async::Row> = conn.query_iter(&trg_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect_and_drop().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let triggers: Vec<TriggerDef> = trg_rows.iter().map(|r| TriggerDef {
            name: get_str_by_name(r, "TRIGGER_NAME"),
            timing: get_opt_str_by_name(r, "ACTION_TIMING"),
            event: get_opt_str_by_name(r, "EVENT_MANIPULATION"),
        }).collect();

        // ---- table comment ----
        let comment_sql = mysql_table_comment_sql(schema, table);
        let comment = conn.query_first::<mysql_async::Row, _>(&comment_sql).await
            .ok()
            .flatten()
            .map(|r| get_str(&r, 0))
            .unwrap_or_default();

        Ok(TableStructure { comment, columns, indexes, fks, triggers })
    }

    /// er_relations for standard MySQL.
    async fn mysql_er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // adapted from dbx list_foreign_keys (schema-level, no table filter)
        let sql = format!(
            "SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, \
             kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             WHERE kcu.TABLE_SCHEMA = {s} \
             AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            s = quote_value(schema),
        );
        let result = conn.query_iter(&sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| ErRelation {
            from: get_str(r, 0),
            from_col: get_str(r, 1),
            to: get_str(r, 2),
            to_col: get_str(r, 3),
        }).collect())
    }
}

/// Build the column introspection SQL for the OceanBase-Oracle path.
/// Joins ALL_COL_COMMENTS so column comments populate the「备注」column.
fn ob_columns_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, \
         c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.COLUMN_ID, \
         CASE WHEN cc.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         cm.COMMENTS AS COL_COMMENT \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ( \
           SELECT cols.OWNER, cols.TABLE_NAME, cols.COLUMN_NAME \
           FROM ALL_CONS_COLUMNS cols \
           JOIN ALL_CONSTRAINTS con \
             ON con.CONSTRAINT_NAME = cols.CONSTRAINT_NAME AND con.OWNER = cols.OWNER \
           WHERE con.CONSTRAINT_TYPE = 'P' \
         ) cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME \
         LEFT JOIN ALL_COL_COMMENTS cm \
           ON cm.OWNER = c.OWNER AND cm.TABLE_NAME = c.TABLE_NAME AND cm.COLUMN_NAME = c.COLUMN_NAME \
         WHERE c.OWNER = {s} AND c.TABLE_NAME = {t} \
         ORDER BY c.COLUMN_ID",
        s = quote_value(schema),
        t = quote_value(table),
    )
}

/// Build the table-comment SQL for the OceanBase-Oracle path (ALL_TAB_COMMENTS).
fn ob_table_comment_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT COMMENTS FROM ALL_TAB_COMMENTS \
         WHERE OWNER = {s} AND TABLE_NAME = {t}",
        s = quote_value(schema),
        t = quote_value(table),
    )
}

// ── OceanBase-Oracle introspection helpers ───────────────────────────────────
// Adapted from dbx crates/dbx-core/src/db/ob_oracle.rs, Apache-2.0.
// Uses Oracle system views (ALL_TABLES, ALL_VIEWS, ALL_INDEXES, ALL_CONSTRAINTS, etc.)
// over the same mysql_async connection. Untested here (no OceanBase instance),
// but faithfully adapted from dbx ob_oracle.rs patterns.

impl MySqlDriver {
    async fn ob_list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let sql = format!(
            "SELECT TABLE_NAME, 'TABLE' AS TABLE_TYPE FROM ALL_TABLES WHERE OWNER = {s} \
             UNION ALL \
             SELECT VIEW_NAME, 'VIEW' AS TABLE_TYPE FROM ALL_VIEWS WHERE OWNER = {s} \
             ORDER BY 1",
            s = quote_value(schema),
        );
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let result = conn.query_iter(&sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| {
            let table_type = get_str(r, 1);
            let kind = if table_type.eq_ignore_ascii_case("VIEW") { "view" } else { "table" };
            TableInfo {
                name: get_str(r, 0),
                kind: kind.into(),
                rows_estimate: None,
            }
        }).collect())
    }

    async fn ob_table_structure(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, DbError> {
        use crate::db::driver::{ColumnDef, IndexDef, ForeignKeyDef, TriggerDef};

        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;

        // ---- columns (ALL_TAB_COLUMNS + PK join) ----
        // (OceanBase-Oracle path)
        let col_sql = ob_columns_sql(schema, table);
        let result = conn.query_iter(&col_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let col_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let columns: Vec<ColumnDef> = col_rows.iter().map(|r| {
            let is_pk = row_get::<i32, _>(r, 8).unwrap_or(0) == 1;
            let is_nullable = get_str(r, 2) == "Y";
            ColumnDef {
                name: get_str(r, 0),
                type_name: get_str(r, 1),
                nullable: is_nullable,
                default: {
                    let d = get_str(r, 3).trim().to_string();
                    if d.is_empty() { None } else { Some(d) }
                },
                key: if is_pk { "PK" } else { "" }.into(),
                comment: get_str(r, 9),
            }
        }).collect();

        // ---- indexes (ALL_INDEXES + ALL_IND_COLUMNS with LISTAGG) ----
        let idx_sql = format!(
            "SELECT ai.INDEX_NAME, \
             LISTAGG(aic.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY aic.COLUMN_POSITION) AS COLUMNS, \
             ai.UNIQUENESS, \
             CASE WHEN ac.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PRIMARY \
             FROM ALL_INDEXES ai \
             JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.TABLE_OWNER = aic.TABLE_OWNER \
             LEFT JOIN ALL_CONSTRAINTS ac \
               ON ac.INDEX_NAME = ai.INDEX_NAME AND ac.OWNER = ai.TABLE_OWNER AND ac.CONSTRAINT_TYPE = 'P' \
             WHERE ai.TABLE_OWNER = {s} AND ai.TABLE_NAME = {t} \
             GROUP BY ai.INDEX_NAME, ai.UNIQUENESS, ac.CONSTRAINT_TYPE \
             ORDER BY ai.INDEX_NAME",
            s = quote_value(schema),
            t = quote_value(table),
        );
        let result = conn.query_iter(&idx_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let idx_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let indexes: Vec<IndexDef> = idx_rows.iter().map(|r| {
            let unique = get_str(r, 2) == "UNIQUE";
            IndexDef {
                name: get_str(r, 0),
                columns: get_str(r, 1),
                unique,
                method: "B-TREE".into(),
            }
        }).collect();

        // ---- foreign keys (ALL_CONSTRAINTS + ALL_CONS_COLUMNS) ----
        let fk_sql = format!(
            "SELECT ac.CONSTRAINT_NAME, acc.COLUMN_NAME, \
             ac2.OWNER AS R_OWNER, ac2.TABLE_NAME AS R_TABLE, acc2.COLUMN_NAME AS R_COLUMN \
             FROM ALL_CONSTRAINTS ac \
             JOIN ALL_CONS_COLUMNS acc \
               ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER \
             JOIN ALL_CONSTRAINTS ac2 \
               ON ac.R_CONSTRAINT_NAME = ac2.CONSTRAINT_NAME AND ac.R_OWNER = ac2.OWNER \
             JOIN ALL_CONS_COLUMNS acc2 \
               ON ac2.CONSTRAINT_NAME = acc2.CONSTRAINT_NAME AND ac2.OWNER = acc2.OWNER \
               AND acc.POSITION = acc2.POSITION \
             WHERE ac.CONSTRAINT_TYPE = 'R' AND ac.OWNER = {s} AND ac.TABLE_NAME = {t} \
             ORDER BY ac.CONSTRAINT_NAME, acc.POSITION",
            s = quote_value(schema),
            t = quote_value(table),
        );
        let result = conn.query_iter(&fk_sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let fk_rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let fks: Vec<ForeignKeyDef> = fk_rows.iter().map(|r| {
            let cn = get_str(r, 0);
            ForeignKeyDef {
                column: get_str(r, 1),
                references: format!("{}.{}.{}", get_str(r, 2), get_str(r, 3), get_str(r, 4)),
                on_delete: "NO ACTION".into(),
                on_update: "NO ACTION".into(),
                constraint_name: if cn.is_empty() { None } else { Some(cn) },
            }
        }).collect();

        // ---- triggers (ALL_TRIGGERS) ----
        let trg_sql = format!(
            "SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE FROM ALL_TRIGGERS \
             WHERE TABLE_OWNER = {s} AND TABLE_NAME = {t} ORDER BY TRIGGER_NAME",
            s = quote_value(schema),
            t = quote_value(table),
        );
        let triggers: Vec<TriggerDef> = match conn.query_iter(&trg_sql).await {
            Ok(res) => res.collect_and_drop::<mysql_async::Row>().await
                .map(|rows| rows.iter().map(|r| TriggerDef {
                    name: get_str(r, 0),
                    timing: { let s = get_str(r, 2); if s.is_empty() { None } else { Some(s) } },
                    event: { let s = get_str(r, 1); if s.is_empty() { None } else { Some(s) } },
                }).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(), // best-effort: ALL_TRIGGERS 不可用时留空
        };

        // ---- table comment ----
        let comment_sql = ob_table_comment_sql(schema, table);
        let comment = conn.query_first::<mysql_async::Row, _>(&comment_sql).await
            .ok()
            .flatten()
            .map(|r| get_str(&r, 0))
            .unwrap_or_default();

        Ok(TableStructure { comment, columns, indexes, fks, triggers })
    }

    async fn ob_er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        let mut conn = self.pool.get_conn().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let sql = format!(
            "SELECT ac.TABLE_NAME, acc.COLUMN_NAME, \
             ac2.TABLE_NAME AS R_TABLE, acc2.COLUMN_NAME AS R_COLUMN \
             FROM ALL_CONSTRAINTS ac \
             JOIN ALL_CONS_COLUMNS acc \
               ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER \
             JOIN ALL_CONSTRAINTS ac2 \
               ON ac.R_CONSTRAINT_NAME = ac2.CONSTRAINT_NAME AND ac.R_OWNER = ac2.OWNER \
             JOIN ALL_CONS_COLUMNS acc2 \
               ON ac2.CONSTRAINT_NAME = acc2.CONSTRAINT_NAME AND ac2.OWNER = acc2.OWNER \
               AND acc.POSITION = acc2.POSITION \
             WHERE ac.CONSTRAINT_TYPE = 'R' AND ac.OWNER = {s} \
             ORDER BY ac.TABLE_NAME, ac.CONSTRAINT_NAME, acc.POSITION",
            s = quote_value(schema),
        );
        let result = conn.query_iter(&sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let rows: Vec<mysql_async::Row> = result
            .collect_and_drop()
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| ErRelation {
            from: get_str(r, 0),
            from_col: get_str(r, 1),
            to: get_str(r, 2),
            to_col: get_str(r, 3),
        }).collect())
    }
}

#[cfg(test)]
mod tls_query_tests {
    use super::build_mysql_query;

    #[test]
    fn no_tls_no_options_is_empty() {
        assert_eq!(build_mysql_query(None, false, false), "");
        assert_eq!(build_mysql_query(Some(""), false, false), "");
    }

    #[test]
    fn options_only_pass_through() {
        assert_eq!(build_mysql_query(Some("pool_max=4"), false, false), "?pool_max=4");
        // 去掉前导 ? / & 后再拼。
        assert_eq!(build_mysql_query(Some("?pool_max=4"), false, false), "?pool_max=4");
    }

    #[test]
    fn tls_injects_require_ssl() {
        assert_eq!(build_mysql_query(None, true, false), "?require_ssl=true");
        assert_eq!(build_mysql_query(Some("pool_max=4"), true, false), "?pool_max=4&require_ssl=true");
    }

    #[test]
    fn tls_insecure_disables_ca_verify() {
        assert_eq!(
            build_mysql_query(None, true, true),
            "?require_ssl=true&verify_ca=false&verify_identity=false"
        );
    }
}

#[cfg(test)]
mod opts_ca_tests {
    use super::build_mysql_opts;
    use crate::db::driver::ConnectArgs;
    use crate::db::DatabaseType;

    fn args() -> ConnectArgs {
        ConnectArgs {
            db_type: DatabaseType::Mysql,
            host: "h".into(),
            port: 3306,
            user: "u".into(),
            database: Some("d".into()),
            driver_profile: None,
            options: None,
            secret: Some("pw".into()),
            ssl: false,
            ssl_mode: None,
            ca_cert_path: None,
            ssl_reject_unauthorized: None,
        }
    }

    #[test]
    fn no_ssl_has_no_ssl_opts() {
        let opts = build_mysql_opts(&args()).expect("opts build");
        assert!(opts.ssl_opts().is_none(), "未开 TLS 不应带 ssl_opts");
    }

    #[test]
    fn ssl_without_ca_has_ssl_opts_but_no_root_certs() {
        let mut a = args();
        a.ssl = true;
        let opts = build_mysql_opts(&a).expect("opts build");
        let ssl = opts.ssl_opts().expect("require_ssl 应产生 ssl_opts");
        assert!(ssl.root_certs().is_empty(), "未提供 CA 时不应注入根证书");
    }

    #[test]
    fn ssl_with_ca_path_injects_root_cert() {
        let mut a = args();
        a.ssl = true;
        a.ca_cert_path = Some("/etc/ssl/myca.pem".into());
        let opts = build_mysql_opts(&a).expect("opts build");
        let ssl = opts.ssl_opts().expect("ssl_opts 应存在");
        let roots = ssl.root_certs();
        assert_eq!(roots.len(), 1, "应注入一个自定义 CA 证书路径");
    }

    #[test]
    fn ca_path_ignored_when_ssl_off() {
        let mut a = args();
        a.ssl = false;
        a.ca_cert_path = Some("/etc/ssl/myca.pem".into());
        let opts = build_mysql_opts(&a).expect("opts build");
        assert!(opts.ssl_opts().is_none(), "TLS 关闭时 CA 路径无效,不应产生 ssl_opts");
    }
}

#[cfg(test)]
mod comment_sql_tests {
    use super::{mysql_columns_sql, mysql_table_comment_sql, ob_columns_sql, ob_table_comment_sql};

    #[test]
    fn standard_columns_sql_selects_column_comment() {
        let sql = mysql_columns_sql("mydb", "users");
        assert!(sql.contains("COLUMN_COMMENT"), "标准列 SQL 必须 SELECT COLUMN_COMMENT");
        assert!(sql.contains("'mydb'") && sql.contains("'users'"));
    }

    #[test]
    fn standard_table_comment_sql_selects_table_comment() {
        let sql = mysql_table_comment_sql("mydb", "users");
        assert!(sql.contains("TABLE_COMMENT"), "表注释 SQL 必须 SELECT TABLE_COMMENT");
        assert!(sql.contains("information_schema.TABLES"));
    }

    #[test]
    fn ob_columns_sql_selects_col_comments() {
        let sql = ob_columns_sql("SCOTT", "EMP");
        assert!(sql.contains("ALL_COL_COMMENTS"), "OB-Oracle 列 SQL 必须 JOIN ALL_COL_COMMENTS");
        assert!(sql.contains("COL_COMMENT"));
    }

    #[test]
    fn ob_table_comment_sql_selects_tab_comments() {
        let sql = ob_table_comment_sql("SCOTT", "EMP");
        assert!(sql.contains("ALL_TAB_COMMENTS"), "OB-Oracle 表注释 SQL 必须查 ALL_TAB_COMMENTS");
    }
}
