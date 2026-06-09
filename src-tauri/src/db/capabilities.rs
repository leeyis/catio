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
}

/// 照搬 dbx database_capabilities.rs 的判定语义。
pub fn capabilities_for(db: DatabaseType) -> Capabilities {
    use DatabaseType::*;
    match db {
        Postgres | Sqlserver => Capabilities {
            writable: true, transactions: true, schemas: true,
            sql_console: true, er: true, structure_edit: true,
        },
        Mysql | Sqlite | Duckdb => Capabilities {
            writable: true, transactions: true, schemas: db == Duckdb,
            sql_console: true, er: true, structure_edit: true,
        },
        Clickhouse | Rqlite => Capabilities {
            writable: true, transactions: false, schemas: false,
            sql_console: true, er: false, structure_edit: false,
        },
        Elasticsearch | Mongodb => Capabilities {
            writable: true, transactions: false, schemas: db == Mongodb,
            sql_console: false, er: false, structure_edit: false,
        },
        Redis => Capabilities {
            writable: true, transactions: false, schemas: true,
            sql_console: false, er: false, structure_edit: false,
        },
        // JDBC sidecar: SQL console + writes work; the simple plugin protocol
        // exposes columns but no FK/index introspection, so ER and structure
        // editing are off. Schemas on (most JDBC engines are schema-aware).
        Jdbc => Capabilities {
            writable: true, transactions: false, schemas: true,
            sql_console: true, er: false, structure_edit: false,
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
    fn redis_has_no_sql_console_or_er() {
        let c = capabilities_for(DatabaseType::Redis);
        assert!(!c.sql_console && !c.er);
    }
    #[test]
    fn mysql_has_no_schema_namespace() {
        assert!(!capabilities_for(DatabaseType::Mysql).schemas);
    }
}
