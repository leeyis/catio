// adapted from dbx crates/dbx-core/src/db/postgres.rs, Apache-2.0
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, PoolError, RecyclingMethod};
use tokio_postgres::NoTls; // 起步用 NoTls；TLS 变体见 Step 4 备注
use tokio_postgres::error::SqlState;
use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::result::QueryResult;

pub struct PostgresDriver {
    pool: Pool,
    profile: Option<String>,
}

impl PostgresDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let dbname = args.database.clone()
            .or_else(|| default_database(args.driver_profile.as_deref()))
            .unwrap_or_else(|| "postgres".into());
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&args.host).port(args.port).user(&args.user).dbname(&dbname);
        if let Some(pw) = &args.secret { cfg.password(pw); }
        let mgr = Manager::from_config(cfg, NoTls, ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });
        let pool = Pool::builder(mgr).max_size(4).build()
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // 立即取一个连接验证可达 + 认证
        let _client = pool.get().await.map_err(|e| map_pool_error(e))?;
        Ok(Self { pool, profile: args.driver_profile.clone() })
    }
}

/// Map a deadpool PoolError to DbError.
/// tokio_postgres::Error::Display returns "db error" (no details); match on PoolError::Backend
/// to extract SqlState for auth failures (28P01 = invalid_password, 28000 = invalid_auth).
fn map_pool_error(e: PoolError) -> DbError {
    if let PoolError::Backend(ref pg_err) = e {
        if let Some(code) = pg_err.code() {
            if code == &SqlState::INVALID_PASSWORD
                || code == &SqlState::INVALID_AUTHORIZATION_SPECIFICATION
            {
                return DbError::AuthFailed;
            }
        }
    }
    DbError::ConnectFailed(e.to_string())
}

/// 协议族默认库名（照搬 dbx models/connection.rs default_database）。
fn default_database(profile: Option<&str>) -> Option<String> {
    match profile {
        Some("cockroachdb") | Some("kwdb") => Some("defaultdb".into()),
        Some("redshift") => Some("dev".into()),
        _ => Some("postgres".into()),
    }
}

/// Map a single PG column value to serde_json::Value.
/// Type branches adapted from dbx crates/dbx-core/src/db/postgres.rs execute_query, Apache-2.0.
fn pg_value_to_json(
    row: &tokio_postgres::Row,
    idx: usize,
    ty: &tokio_postgres::types::Type,
    safe_i64: &dyn Fn(i64) -> serde_json::Value,
    bin_to_json: &dyn Fn(&[u8]) -> serde_json::Value,
) -> serde_json::Value {
    use serde_json::Value;
    use tokio_postgres::types::Type;

    match ty {
        &Type::BOOL => match row.try_get::<_, Option<bool>>(idx) {
            Ok(Some(v)) => Value::Bool(v),
            _ => Value::Null,
        },
        &Type::INT2 => match row.try_get::<_, Option<i16>>(idx) {
            Ok(Some(v)) => Value::Number((v as i32).into()),
            _ => Value::Null,
        },
        &Type::INT4 => match row.try_get::<_, Option<i32>>(idx) {
            Ok(Some(v)) => Value::Number(v.into()),
            _ => Value::Null,
        },
        &Type::INT8 => match row.try_get::<_, Option<i64>>(idx) {
            Ok(Some(v)) => safe_i64(v),
            _ => Value::Null,
        },
        &Type::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => Value::Number(v.into()),
            _ => Value::Null,
        },
        &Type::FLOAT4 => match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::FLOAT8 => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(v)) => bin_to_json(&v),
            _ => Value::Null,
        },
        // String-like types: TEXT, VARCHAR, BPCHAR, NAME, UUID
        &Type::TEXT | &Type::VARCHAR | &Type::BPCHAR | &Type::NAME | &Type::UUID => {
            match row.try_get::<_, Option<String>>(idx) {
                Ok(Some(v)) => Value::String(v),
                _ => Value::Null,
            }
        },
        // JSON / JSONB: try serde_json::Value directly
        &Type::JSON | &Type::JSONB => {
            match row.try_get::<_, Option<serde_json::Value>>(idx) {
                Ok(Some(v)) => v,
                _ => Value::Null,
            }
        },
        // Fallback (includes temporal types TIMESTAMP/DATE/TIME/INTERVAL etc.): try String, then Null
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => Value::String(v),
            _ => Value::Null,
        },
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Postgres }

    async fn test(&self) -> Result<String, DbError> {
        let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let row = client.query_one("SELECT version()", &[]).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(row.get::<_, String>(0))
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use crate::db::result::{ColumnInfo, safe_i64_to_json, binary_to_json};
        use serde_json::Value;
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let stmt = client.prepare(sql).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        // Write statements (UPDATE/INSERT/DELETE/DDL) have no result columns.
        // Use execute() to get rows_affected count instead of fetching rows.
        if stmt.columns().is_empty() {
            let affected = client.execute(&stmt, &[]).await
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(affected),
                truncated: false,
            });
        }

        let cols: Vec<ColumnInfo> = stmt.columns().iter().map(|c| ColumnInfo {
            name: c.name().to_string(),
            type_name: c.type_().name().to_string(),
            pk: false,
        }).collect();

        let pg_rows = client.query(&stmt, &[]).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut truncated = false;
        for (i, row) in pg_rows.iter().enumerate() {
            if i as u32 >= max_rows {
                truncated = true;
                break;
            }
            let mut out = Vec::with_capacity(cols.len());
            for (idx, col) in stmt.columns().iter().enumerate() {
                let v = pg_value_to_json(row, idx, col.type_(), &safe_i64_to_json, &binary_to_json);
                out.push(v);
            }
            rows.push(out);
        }
        Ok(QueryResult { columns: cols, rows, rows_affected: None, truncated })
    }
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Err(DbError::Unsupported("schema (A7)".into()))
    }
    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
        Err(DbError::Unsupported("schema (A7)".into()))
    }
    async fn table_structure(&self, _schema: &str, _table: &str) -> Result<TableStructure, DbError> {
        Err(DbError::Unsupported("structure (A7)".into()))
    }
    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        Err(DbError::Unsupported("er (A7)".into()))
    }
}
