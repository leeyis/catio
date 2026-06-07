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

#[async_trait]
impl Driver for PostgresDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Postgres }

    async fn test(&self) -> Result<String, DbError> {
        let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let row = client.query_one("SELECT version()", &[]).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(row.get::<_, String>(0))
    }

    // 以下方法 Task A6/A7 实现；先用 Unsupported 占位让其编译
    async fn query(&self, _sql: &str, _max_rows: u32) -> Result<QueryResult, DbError> {
        Err(DbError::Unsupported("query (A6)".into()))
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
