use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::db::{DbError, DatabaseType, result::QueryResult, capabilities::Capabilities};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    /// 协议族内变体（如 "cockroachdb"/"tidb"/"oceanbase-oracle"），照搬 dbx driver_profile。
    pub driver_profile: Option<String>,
    /// 密码；仅内存，不落盘、不回前端。
    pub secret: Option<String>,
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
    /// schema 浏览：库下的 schema 名（无 schema 概念的引擎返回单元素如 ["default"]）。
    async fn list_schemas(&self) -> Result<Vec<String>, DbError>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError>;
    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError>;
    /// ER：该 schema 下所有 FK 关系。不支持的引擎返回 Unsupported。
    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError>;
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
        other => Err(DbError::Unsupported(format!("{:?} (later phase)", other))),
    }
}
