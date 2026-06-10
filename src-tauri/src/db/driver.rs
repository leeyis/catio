use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::db::{DbError, DatabaseType, result::QueryResult, capabilities::Capabilities};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    /// 协议族内变体（如 "cockroachdb"/"tidb"/"oceanbase-oracle"），照搬 dbx driver_profile。
    pub driver_profile: Option<String>,
    /// 高级连接参数：URL 查询串形式的 key=value（如
    /// "authSource=admin&directConnection=true"），由各驱动按其连接 URL 语义拼接。
    /// 非敏感，可入连接档案。
    #[serde(default)]
    pub options: Option<String>,
    /// 密码；仅内存，不落盘、不回前端。
    pub secret: Option<String>,
}

// Hand-written Debug that redacts the secret (mirrors ssh/conn.rs ConnectArgs),
// so a password can never leak via {:?} / trace / panic payloads.
impl std::fmt::Debug for ConnectArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectArgs")
            .field("db_type", &self.db_type)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("database", &self.database)
            .field("driver_profile", &self.driver_profile)
            .field("options", &self.options)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// schema 浏览：一张表的轻量信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: String, // "table" | "view"
    pub rows_estimate: Option<i64>,
}

/// 表结构：一列。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub key: String, // "PK" | "FK" | "UNI" | ""
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub columns: String,
    pub unique: bool,
    pub method: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    pub column: String,
    pub references: String, // "schema.table.col"
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    pub fks: Vec<ForeignKeyDef>,
}

/// ER 关系（表布局坐标由前端算，后端只给关系）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErRelation {
    pub from: String,
    pub from_col: String,
    pub to: String,
    pub to_col: String,
}

/// 前端传来的单行编辑请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    pub schema: Option<String>,
    pub table: String,
    pub kind: String, // "update" | "insert" | "delete"
    pub pk: Vec<(String, serde_json::Value)>,
    pub cells: Vec<(String, serde_json::Value)>,
}

/// 所有引擎统一抽象。把 dbx 各模块自由函数的函数体搬进这些方法。
#[async_trait]
pub trait Driver: Send + Sync {
    fn db_type(&self) -> DatabaseType;
    fn capabilities(&self) -> Capabilities {
        crate::db::capabilities::capabilities_for(self.db_type())
    }
    /// 测连：成功返回服务器版本串。
    async fn test(&self) -> Result<String, DbError>;
    /// 执行任意 SQL（读+写）。max_rows 触达即 truncated。
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError>;
    /// 分页查询：用方言 paginate 包裹 SQL 后调 query。
    async fn paginated_query(&self, sql: &str, limit: u32, offset: u32) -> Result<QueryResult, DbError> {
        let paged = crate::db::dialect::paginate(self.db_type(), sql, limit, offset);
        self.query(&paged, limit).await
    }
    /// schema 浏览：库下的 schema 名（无 schema 概念的引擎返回单元素如 ["default"]）。
    async fn list_schemas(&self) -> Result<Vec<String>, DbError>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError>;
    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError>;
    /// ER：该 schema 下所有 FK 关系。不支持的引擎返回 Unsupported。
    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError>;

    /// 批量列名：为 schema 下每张表收集列名，供编辑器补全用。
    ///
    /// Default is engine-agnostic and best-effort: it reuses `list_tables` +
    /// `table_structure`, so all drivers get it for free. Relational drivers MAY
    /// override later with a single information_schema query for efficiency.
    /// Per-table failures (e.g. Redis `table_structure` → Unsupported) degrade to
    /// an empty column list rather than failing the whole call. Capped at the
    /// first 200 tables to avoid pathological stalls on huge schemas (this is a
    /// completion aid, so a silent cap is acceptable).
    async fn schema_columns(&self, schema: &str) -> Result<Vec<(String, Vec<String>)>, DbError> {
        const MAX_TABLES: usize = 200;
        let tables = self.list_tables(schema).await?;
        let mut out = Vec::new();
        for t in tables.into_iter().take(MAX_TABLES) {
            match self.table_structure(schema, &t.name).await {
                Ok(st) => out.push((t.name, st.columns.into_iter().map(|c| c.name).collect())),
                Err(_) => out.push((t.name, Vec::new())), // best-effort: skip columns on per-table failure
            }
        }
        Ok(out)
    }

    /// List stored functions/procedures in a schema. Default is empty so engines
    /// without routine support (or that haven't overridden) still compile.
    async fn list_functions(&self, _schema: &str) -> Result<Vec<String>, DbError> {
        Ok(vec![])
    }

    /// Source/DDL of a view, function, or procedure. `kind` is one of
    /// "view" | "function" | "procedure". Default returns an empty string so
    /// engines without DDL introspection (or that haven't overridden) still
    /// compile and degrade to a "no definition" state in the UI.
    async fn object_source(&self, _schema: &str, _name: &str, _kind: &str) -> Result<String, DbError> {
        Ok(String::new())
    }
}

/// 按 db_type 建立驱动。后续每加一个引擎在此加一臂。
pub async fn connect(args: &ConnectArgs) -> Result<Arc<dyn Driver>, DbError> {
    match args.db_type {
        DatabaseType::Postgres =>
            Ok(Arc::new(crate::db::drivers::postgres::PostgresDriver::connect(args).await?)),
        DatabaseType::Mysql =>
            Ok(Arc::new(crate::db::drivers::mysql::MySqlDriver::connect(args).await?)),
        DatabaseType::Sqlite =>
            Ok(Arc::new(crate::db::drivers::sqlite::SqliteDriver::connect(args).await?)),
        DatabaseType::Duckdb =>
            Ok(Arc::new(crate::db::drivers::duckdb::DuckDbDriver::connect(args).await?)),
        DatabaseType::Sqlserver =>
            Ok(Arc::new(crate::db::drivers::sqlserver::SqlServerDriver::connect(args).await?)),
        DatabaseType::Clickhouse =>
            Ok(Arc::new(crate::db::drivers::clickhouse::ClickhouseDriver::connect(args).await?)),
        DatabaseType::Rqlite =>
            Ok(Arc::new(crate::db::drivers::rqlite::RqliteDriver::connect(args).await?)),
        DatabaseType::Elasticsearch =>
            Ok(Arc::new(crate::db::drivers::elasticsearch::ElasticsearchDriver::connect(args).await?)),
        DatabaseType::Mongodb =>
            Ok(Arc::new(crate::db::drivers::mongo::MongoDriver::connect(args).await?)),
        DatabaseType::Redis =>
            Ok(Arc::new(crate::db::drivers::redis::RedisDriver::connect(args).await?)),
        DatabaseType::Jdbc =>
            Ok(Arc::new(crate::db::drivers::jdbc::JdbcDriver::connect(args).await?)),
    }
}
