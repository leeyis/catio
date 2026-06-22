use serde::Serialize;
use crate::db::DatabaseType;

/// 引擎能力位。前端按此灰显不适用的 tab/按钮（像素不变，仅 disabled）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub writable: bool,
    pub transactions: bool,
    pub schemas: bool,       // 有 schema 命名空间概念（PG 有，MySQL 无）
    pub sql_console: bool,   // 支持任意 SQL 控制台（Redis 无）
    pub er: bool,            // 支持 FK/ER 图
    pub structure_edit: bool,
    pub views: bool,         // 有"视图"概念（KV/文档/检索引擎无：Redis/Mongo/ES）
    pub functions: bool,     // 有"存储函数/过程"概念（SQLite/Rqlite/Mongo/ES/Redis 无）
}

/// 照搬 dbx database_capabilities.rs 的判定语义。
pub fn capabilities_for(db: DatabaseType) -> Capabilities {
    use DatabaseType::*;
    match db {
        Postgres | Sqlserver => Capabilities {
            writable: true, transactions: true, schemas: true,
            sql_console: true, er: true, structure_edit: true,
            views: true, functions: true,
        },
        // SQLite/Rqlite 有视图但无存储函数/过程概念 → functions = false（仅对 Sqlite）。
        Mysql | Sqlite | Duckdb => Capabilities {
            writable: true, transactions: true, schemas: db == Duckdb,
            sql_console: true, er: true, structure_edit: true,
            views: true, functions: db != Sqlite,
        },
        Clickhouse | Rqlite => Capabilities {
            writable: true, transactions: false, schemas: false,
            sql_console: true, er: false, structure_edit: false,
            // ClickHouse 有视图+UDF；Rqlite 基于 SQLite，有视图但无存储函数。
            views: true, functions: db == Clickhouse,
        },
        // Mongo 用 mongo shell 语法、ES 用 REST/SELECT(见各 driver 的 query()),
        // 控制台可用 → sql_console = true。文档库/检索引擎无 SQL 视图与存储函数概念,
        // 且 Mongo driver 的 list_tables 不区分视图 → views/functions 均关闭。
        Elasticsearch | Mongodb => Capabilities {
            writable: true, transactions: false, schemas: db == Mongodb,
            sql_console: true, er: false, structure_edit: false,
            views: false, functions: false,
        },
        // KV 存储:无表/视图/函数概念,树里只保留 keys。查询控制台可用——
        // 但语义不是 SQL,而是把输入当 key 的 glob 模式做 SCAN(见 redis driver
        // 的 query()),前端 SqlConsole 对 Redis 走 plain 模式(不挂 SQL 补全)。
        Redis => Capabilities {
            writable: true, transactions: false, schemas: true,
            sql_console: true, er: false, structure_edit: false,
            views: false, functions: false,
        },
        // JDBC sidecar: SQL console + writes work; the simple plugin protocol
        // exposes columns but no FK/index introspection, so ER and structure
        // editing are off. Schemas on (most JDBC engines are schema-aware).
        // 多数 JDBC 引擎为关系型,有视图与存储函数(list_functions 已实现) → 开启。
        Jdbc => Capabilities {
            writable: true, transactions: false, schemas: true,
            sql_console: true, er: false, structure_edit: false,
            views: true, functions: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn postgres_is_full_featured() {
        let c = capabilities_for(DatabaseType::Postgres);
        assert!(c.schemas && c.er && c.sql_console && c.writable);
    }
    #[test]
    fn redis_has_query_console_but_no_er() {
        // Redis 的查询页用 key glob 模式 SCAN(非 SQL),控制台可用但无 ER。
        let c = capabilities_for(DatabaseType::Redis);
        assert!(c.sql_console && !c.er);
    }
    #[test]
    fn non_relational_stores_have_no_views_or_functions() {
        for db in [DatabaseType::Redis, DatabaseType::Mongodb, DatabaseType::Elasticsearch] {
            let c = capabilities_for(db);
            assert!(!c.views && !c.functions, "{db:?} 不应显示视图/函数节点");
        }
    }
    #[test]
    fn sqlite_has_views_but_no_functions() {
        let c = capabilities_for(DatabaseType::Sqlite);
        assert!(c.views && !c.functions);
    }
    #[test]
    fn postgres_has_views_and_functions() {
        let c = capabilities_for(DatabaseType::Postgres);
        assert!(c.views && c.functions);
    }
    #[test]
    fn mysql_has_no_schema_namespace() {
        assert!(!capabilities_for(DatabaseType::Mysql).schemas);
    }
    #[test]
    fn mongodb_and_es_have_sql_console() {
        assert!(capabilities_for(DatabaseType::Mongodb).sql_console);
        assert!(capabilities_for(DatabaseType::Elasticsearch).sql_console);
    }
}
