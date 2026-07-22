use async_trait::async_trait;
use futures_util::{stream, StreamExt};
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
    /// 是否启用 SSL/TLS。默认 false（保留无 TLS 路径）。照搬 dbx connection.rs `ssl`。
    #[serde(default)]
    pub ssl: bool,
    /// SSL 模式细化（如 "require"/"prefer"/"verify-ca"/"verify-full"/"disable"）。
    /// 缺省时 ssl=true 视为 "require"。各驱动按其协议语义映射。
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// 自定义 CA 证书的 PEM 文件路径（用于校验自签名/私有 CA 颁发的服务器证书）。
    /// 非敏感，可入连接档案。照搬 dbx connection.rs `ca_cert_path`。
    #[serde(default)]
    pub ca_cert_path: Option<String>,
    /// 是否校验服务器证书。None/Some(true)=校验（默认）；Some(false)=接受无效证书
    /// （自签/过期/主机名不符），用于内网/测试环境。
    #[serde(default)]
    pub ssl_reject_unauthorized: Option<bool>,
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
            .field("ssl", &self.ssl)
            .field("ssl_mode", &self.ssl_mode)
            .field("ca_cert_path", &self.ca_cert_path)
            .field("ssl_reject_unauthorized", &self.ssl_reject_unauthorized)
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

/// KV 引擎(Redis)的 key 元信息:替代"表结构"展示。`types` 为采样得到的
/// 键类型分布(string/hash/list/set/zset/stream…),`total_keys` 为 DBSIZE。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyspaceInfo {
    pub total_keys: u64,
    /// 实际采样统计的键数(可能小于 total_keys —— 大库只采样前若干个)。
    pub sampled: u64,
    pub types: Vec<KeyspaceType>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyspaceType {
    pub name: String,
    pub count: u64,
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
    pub comment: String,
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
    /// 约束名（DROP FOREIGN KEY / DROP CONSTRAINT 所需）。SQLite/rqlite 等无命名约束的
    /// 引擎留 None；前端据此决定是否提供「删除外键」入口。
    pub constraint_name: Option<String>,
}

/// 表上的一个触发器（结构内省）。`timing`/`event` 仅用于展示，可空（部分引擎/查询取不到）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDef {
    pub name: String,
    pub timing: Option<String>, // BEFORE | AFTER | INSTEAD OF
    pub event: Option<String>,  // INSERT | UPDATE | DELETE（可为组合串）
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub comment: String,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    pub fks: Vec<ForeignKeyDef>,
    /// 该表的触发器列表。不支持触发器的引擎留空。
    pub triggers: Vec<TriggerDef>,
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
    /// Execute SQL with an optional default namespace selected by the UI.
    ///
    /// Engines that can reliably scope a single query/session override this
    /// (e.g. Postgres search_path, MySQL/ClickHouse/MongoDB database, JDBC
    /// setCatalog/setSchema). Others keep the plain query path rather than
    /// rewriting user SQL.
    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, _default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        self.query(sql, max_rows).await
    }
    /// Execute multiple statements as ONE transaction; rolls back on the first error and
    /// returns total rows affected. Default: unsupported — overridden by transaction-capable
    /// SQL engines. Used by Data Compare's "execute sync SQL".
    async fn exec_batch(&self, _statements: &[String]) -> Result<u64, DbError> {
        Err(DbError::Unsupported("transactional batch execution is not supported for this engine".into()))
    }
    /// 分页查询：用方言 paginate 包裹 SQL 后调 query。
    async fn paginated_query(&self, sql: &str, limit: u32, offset: u32) -> Result<QueryResult, DbError> {
        let paged = crate::db::dialect::paginate(self.db_type(), sql, limit, offset);
        self.query(&paged, limit).await
    }
    /// 分页查询，同时沿用查询控制台选择的默认命名空间。
    async fn paginated_query_with_default_namespace(
        &self,
        sql: &str,
        limit: u32,
        offset: u32,
        default_namespace: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let paged = crate::db::dialect::paginate(self.db_type(), sql, limit, offset);
        self.query_with_default_namespace(&paged, limit, default_namespace).await
    }

    /// 表格数据预览：取一张表（或集合 / index / key 空间）的分页行。
    ///
    /// 默认走关系型 SQL 路径：`SELECT * FROM <qualified>` + 方言分页。非 SQL 引擎
    /// （MongoDB/Redis/Elasticsearch）覆盖此方法，用各自原生协议取数（find/scan/
    /// _search），因为它们不能执行 SQL。这样数据网格无需关心引擎差异。
    async fn table_data(&self, schema: Option<&str>, table: &str, limit: u32, offset: u32)
        -> Result<QueryResult, DbError> {
        let db = self.db_type();
        let has_schemas = self.capabilities().schemas;
        let qualified = crate::db::dialect::qualified_table(db, has_schemas, schema, table);
        // On Postgres, prepend ctid (aliased __ctid) so the grid can edit/delete
        // rows in tables with no primary key.
        let select = if db == DatabaseType::Postgres {
            format!("SELECT ctid AS __ctid, * FROM {}", qualified)
        } else {
            format!("SELECT * FROM {}", qualified)
        };
        self.paginated_query(&select, limit, offset).await
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
    /// `table_structure` with bounded concurrency, so all drivers get it for free.
    /// Relational drivers MAY override later with a single information_schema query.
    /// Per-table failures (e.g. Redis `table_structure` → Unsupported) degrade to
    /// an empty column list rather than failing the whole call. Capped at the
    /// first 200 tables to avoid pathological stalls on huge schemas (this is a
    /// completion aid, so a silent cap is acceptable).
    async fn schema_columns(&self, schema: &str) -> Result<Vec<(String, Vec<String>)>, DbError> {
        const MAX_TABLES: usize = 200;
        const CONCURRENCY: usize = 8;
        let tables = self.list_tables(schema).await?;
        Ok(stream::iter(tables.into_iter().take(MAX_TABLES))
            .map(|table| async move {
                let name = table.name;
                let columns = self.table_structure(schema, &name).await
                    .map(|st| st.columns.into_iter().map(|column| column.name).collect())
                    .unwrap_or_default();
                (name, columns)
            })
            .buffered(CONCURRENCY)
            .collect()
            .await)
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

    /// KV 引擎(Redis)的 key 元信息,用于结构面板的 keyspace 概览。默认 Unsupported:
    /// 关系型/文档型引擎有真正的表结构,不走这条路径。
    async fn keyspace_info(&self, _schema: &str) -> Result<KeyspaceInfo, DbError> {
        Err(DbError::Unsupported("engine has no keyspace info".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::{ColumnDef, ConnectArgs, Driver, ErRelation, TableInfo, TableStructure};
    use crate::db::{DatabaseType, DbError, result::QueryResult};
    use std::{sync::atomic::{AtomicUsize, Ordering}, time::Duration};

    struct SchemaColumnsDriver {
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl Driver for SchemaColumnsDriver {
        fn db_type(&self) -> DatabaseType { DatabaseType::Sqlite }
        async fn test(&self) -> Result<String, DbError> { unimplemented!() }
        async fn query(&self, _sql: &str, _max_rows: u32) -> Result<QueryResult, DbError> { unimplemented!() }
        async fn list_schemas(&self) -> Result<Vec<String>, DbError> { unimplemented!() }
        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
            Ok((0..20).map(|i| TableInfo { name: format!("table_{i}"), kind: "table".into(), rows_estimate: None }).collect())
        }
        async fn table_structure(&self, _schema: &str, table: &str) -> Result<TableStructure, DbError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(TableStructure {
                comment: String::new(),
                columns: vec![ColumnDef { name: format!("{table}_id"), type_name: "int".into(), nullable: false, default: None, key: String::new(), comment: String::new() }],
                indexes: vec![],
                fks: vec![],
                triggers: vec![],
            })
        }
        async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> { unimplemented!() }
    }

    #[tokio::test]
    async fn schema_columns_is_bounded_and_keeps_table_order() {
        let driver = SchemaColumnsDriver { active: AtomicUsize::new(0), max_active: AtomicUsize::new(0) };
        let columns = driver.schema_columns("main").await.unwrap();

        assert_eq!(columns.len(), 20);
        assert_eq!(columns[0], ("table_0".into(), vec!["table_0_id".into()]));
        assert_eq!(columns[19], ("table_19".into(), vec!["table_19_id".into()]));
        assert!((2..=8).contains(&driver.max_active.load(Ordering::SeqCst)));
    }

    /// 不带任何 ssl 字段的旧 payload 必须仍可反序列化，且 ssl 全部回落默认（关闭、不指定 mode/ca）。
    #[test]
    fn ssl_fields_default_when_absent() {
        let args: ConnectArgs = serde_json::from_value(serde_json::json!({
            "dbType": "postgres",
            "host": "127.0.0.1",
            "port": 5432,
            "user": "postgres",
        }))
        .expect("legacy payload without ssl must still deserialize");
        assert!(!args.ssl, "ssl 默认应为 false");
        assert_eq!(args.ssl_mode, None);
        assert_eq!(args.ca_cert_path, None);
        assert_eq!(args.ssl_reject_unauthorized, None);
    }

    /// camelCase 的 ssl 字段必须按前端约定正确反序列化。
    #[test]
    fn ssl_fields_deserialize_camel_case() {
        let args: ConnectArgs = serde_json::from_value(serde_json::json!({
            "dbType": "postgres",
            "host": "127.0.0.1",
            "port": 5432,
            "user": "postgres",
            "ssl": true,
            "sslMode": "verify-full",
            "caCertPath": "/etc/ssl/ca.pem",
            "sslRejectUnauthorized": false,
        }))
        .expect("ssl payload must deserialize");
        assert!(args.ssl);
        assert_eq!(args.ssl_mode.as_deref(), Some("verify-full"));
        assert_eq!(args.ca_cert_path.as_deref(), Some("/etc/ssl/ca.pem"));
        assert_eq!(args.ssl_reject_unauthorized, Some(false));
    }

    /// Debug 实现仍然隐藏 secret，但可以打印 ssl 相关字段（非敏感）。
    #[test]
    fn debug_redacts_secret_but_shows_ssl() {
        let args = ConnectArgs {
            db_type: crate::db::DatabaseType::Postgres,
            host: "h".into(),
            port: 5432,
            user: "u".into(),
            database: None,
            driver_profile: None,
            options: None,
            secret: Some("topsecret".into()),
            ssl: true,
            ssl_mode: Some("require".into()),
            ca_cert_path: None,
            ssl_reject_unauthorized: None,
        };
        let dbg = format!("{:?}", args);
        assert!(!dbg.contains("topsecret"), "secret 不得泄漏到 Debug");
        assert!(dbg.contains("ssl"), "ssl 字段应出现在 Debug");
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
