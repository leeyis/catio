//! 对象(视图/函数/存储过程)源码的「可执行保存语句」生成（纯函数，易 TDD）。
//!
//! 参考 dbx crates/dbx-core/src/object_source_sql.rs，按 Catio 的较小引擎集
//! （Postgres/Mysql/Sqlite/Duckdb/Sqlserver/Clickhouse/Rqlite/Mongodb/
//! Elasticsearch/Redis/Jdbc）裁剪 + 适配，对象类型限定为 View/Function/Procedure。
//!
//! 设计要点（与 dbx 一致）：
//! - SQLServer：把开头的 CREATE/ALTER 归一为 `CREATE OR ALTER`，单条幂等。
//! - Postgres 系 + View：源码体若不是 CREATE/ALTER 开头，包成 `CREATE OR REPLACE
//!   VIEW <qualified> AS <body>`；已是完整 DDL 则原样补分号。
//! - 其余（含 Function/Procedure、MySQL/SQLite/DuckDB/… 的 View）：把用户源码当作
//!   完整 CREATE 语句，补分号执行（多数引擎 routine 源码本身即完整 CREATE）。
//!
//! 不引入 regex 依赖，前缀判定用大小写无关的纯字符串比较（与现有 driver 一致风格）。
//! 标识符引用复用 dialect::quote_ident，schema 限定按引擎能力。

use serde::{Deserialize, Serialize};

use crate::db::DatabaseType;
use crate::db::dialect::quote_ident;

/// 可保存源码的对象类型（视图/函数/存储过程）。serde 与前端 objKind 字符串对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectSourceKind {
    View,
    Function,
    Procedure,
}

impl ObjectSourceKind {
    /// 从前端的 kind 字符串解析（与 db_object_source 的取值一致）。
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "view" => Some(ObjectSourceKind::View),
            "function" => Some(ObjectSourceKind::Function),
            "procedure" => Some(ObjectSourceKind::Procedure),
            _ => None,
        }
    }
}

/// 保存对象源码的入参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableObjectSourceSqlInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    pub source: String,
}

fn object_type_keyword(object_type: ObjectSourceKind) -> &'static str {
    match object_type {
        ObjectSourceKind::View => "VIEW",
        ObjectSourceKind::Function => "FUNCTION",
        ObjectSourceKind::Procedure => "PROCEDURE",
    }
}

/// 文档/KV/检索引擎没有 SQL DDL 概念，无法保存对象源码。
fn is_sql_engine(db: DatabaseType) -> bool {
    !matches!(
        db,
        DatabaseType::Mongodb | DatabaseType::Redis | DatabaseType::Elasticsearch
    )
}

fn is_postgres_like(db: DatabaseType) -> bool {
    matches!(db, DatabaseType::Postgres)
}

/// 没有 stored procedure / SQL function 概念的引擎：SQLite/DuckDB/Rqlite。
/// 对这些引擎保存 function/procedure 直接拒绝，避免发送注定失败的 CREATE。
fn lacks_routines(db: DatabaseType) -> bool {
    matches!(db, DatabaseType::Sqlite | DatabaseType::Duckdb | DatabaseType::Rqlite)
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

/// schema 限定的对象名（schema 非空时加前缀），用于包裹 CREATE OR REPLACE VIEW。
fn qualified_name(db: DatabaseType, schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(db, s), quote_ident(db, name)),
        _ => quote_ident(db, name),
    }
}

/// 大小写无关地判断 source 去除前导空白后是否以某个关键字（后跟空白）开头。
fn starts_with_keyword(source: &str, keyword: &str) -> bool {
    let s = source.trim_start();
    let kw_len = keyword.len();
    if s.len() < kw_len {
        return false;
    }
    if !s[..kw_len].eq_ignore_ascii_case(keyword) {
        return false;
    }
    // 关键字后须紧跟空白（或字符串结束），避免误匹配 CREATETBL 之类。
    s[kw_len..].chars().next().map_or(true, |c| c.is_whitespace())
}

/// 把 SQLServer 源码开头的 CREATE / CREATE OR ALTER / ALTER 归一为 `CREATE OR ALTER `，
/// 使保存幂等（已存在则改写，不存在则新建）。仅替换开头的引导关键字，正文保持不变。
fn replace_sqlserver_create_with_create_or_alter(source: &str) -> String {
    let s = source.trim_start();
    // 已是 CREATE OR ALTER：原样返回（仍按整体 trim）。
    if starts_with_keyword(s, "CREATE") {
        let after_create = s["CREATE".len()..].trim_start();
        if starts_with_keyword(after_create, "OR") {
            let after_or = after_create["OR".len()..].trim_start();
            if starts_with_keyword(after_or, "ALTER") {
                return s.trim().to_string();
            }
        }
        // CREATE ...（非 OR ALTER）→ 替换 CREATE 为 CREATE OR ALTER。
        return format!("CREATE OR ALTER {}", after_create.trim());
    }
    if starts_with_keyword(s, "ALTER") {
        let after_alter = s["ALTER".len()..].trim_start();
        return format!("CREATE OR ALTER {}", after_alter.trim());
    }
    s.trim().to_string()
}

/// 生成把「编辑后的对象源码」落库的可执行语句（按方言；返回单条 SQL）。
///
/// 失败场景：传入非 SQL 引擎（Mongo/Redis/ES）→ Err；源码为空 → Err。
pub fn build_executable_object_source_sql(input: EditableObjectSourceSqlInput) -> Result<String, String> {
    if !is_sql_engine(input.database_type) {
        return Err(format!(
            "Saving object source is not supported for {:?}.",
            input.database_type
        ));
    }

    let source = input.source.trim();
    if source.is_empty() {
        return Err("Object source is empty.".into());
    }

    // SQLServer：CREATE OR ALTER 归一化，单条幂等。
    if input.database_type == DatabaseType::Sqlserver {
        return Ok(ensure_semicolon(&replace_sqlserver_create_with_create_or_alter(source)));
    }

    // Postgres 系的 View：若源码体不是 CREATE/ALTER 开头，包成 CREATE OR REPLACE VIEW。
    if is_postgres_like(input.database_type) && input.object_type == ObjectSourceKind::View {
        if starts_with_keyword(source, "CREATE") || starts_with_keyword(source, "ALTER") {
            return Ok(ensure_semicolon(source));
        }
        return Ok(format!(
            "CREATE OR REPLACE VIEW {} AS\n{}",
            qualified_name(input.database_type, input.schema.as_deref(), &input.name),
            ensure_semicolon(source)
        ));
    }

    // Postgres 系的 function/procedure：源码来自 pg_get_functiondef，本身就是
    // CREATE OR REPLACE，原生幂等，原样补分号执行。
    if is_postgres_like(input.database_type) {
        return Ok(ensure_semicolon(source));
    }

    // SQLite/DuckDB/Rqlite 没有 stored procedure / SQL function：保存这类对象直接拒绝，
    // 不发送注定以「不支持」失败的 CREATE 语句。
    if lacks_routines(input.database_type)
        && matches!(
            input.object_type,
            ObjectSourceKind::Function | ObjectSourceKind::Procedure
        )
    {
        return Err(format!(
            "{:?} does not support stored {}s.",
            input.database_type,
            object_type_keyword(input.object_type).to_ascii_lowercase()
        ));
    }

    // 其余引擎（MySQL/ClickHouse/DuckDB/SQLite/Rqlite/Jdbc 的 view，
    // 以及 MySQL/ClickHouse 的 function/procedure）：源码来自 SHOW CREATE，
    // 是「裸 CREATE」语句，重复提交会因对象已存在而失败。为保证幂等，
    // 先 DROP <kind> IF EXISTS <qualified> 再执行用户的 CREATE。
    //
    // Jdbc 的具体引擎未知（Oracle/DB2/…），DROP IF EXISTS 语义不一定通用，
    // 故保持原样的「裸 CREATE」回退，由真机/方言决定行为。
    if input.database_type == DatabaseType::Jdbc {
        return Ok(ensure_semicolon(source));
    }

    let drop_stmt = format!(
        "DROP {} IF EXISTS {};",
        object_type_keyword(input.object_type),
        qualified_name(input.database_type, input.schema.as_deref(), &input.name)
    );
    Ok(format!("{}\n{}", drop_stmt, ensure_semicolon(source)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        database_type: DatabaseType,
        object_type: ObjectSourceKind,
        source: &str,
    ) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type,
            object_type,
            schema: Some("public".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        }
    }

    #[test]
    fn parses_kind_strings() {
        assert_eq!(ObjectSourceKind::parse("view"), Some(ObjectSourceKind::View));
        assert_eq!(ObjectSourceKind::parse("function"), Some(ObjectSourceKind::Function));
        assert_eq!(ObjectSourceKind::parse("procedure"), Some(ObjectSourceKind::Procedure));
        assert_eq!(ObjectSourceKind::parse("table"), None);
    }

    #[test]
    fn sqlserver_create_source_saves_as_create_or_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Sqlserver,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_alter_source_saves_as_create_or_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Sqlserver,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_already_create_or_alter_kept() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Sqlserver,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "v".to_string(),
            source: "CREATE OR ALTER VIEW dbo.v AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "CREATE OR ALTER VIEW dbo.v AS SELECT 1;");
    }

    #[test]
    fn postgres_view_body_wraps_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
        );
    }

    #[test]
    fn postgres_view_existing_create_kept_as_is() {
        let sql = build_executable_object_source_sql(input(
            DatabaseType::Postgres,
            ObjectSourceKind::View,
            "CREATE OR REPLACE VIEW v AS SELECT 1",
        ))
        .unwrap();
        assert_eq!(sql, "CREATE OR REPLACE VIEW v AS SELECT 1;");
    }

    #[test]
    fn postgres_function_source_executed_as_create() {
        let sql = build_executable_object_source_sql(input(
            DatabaseType::Postgres,
            ObjectSourceKind::Function,
            "CREATE OR REPLACE FUNCTION refresh_cache() RETURNS void LANGUAGE SQL AS $$ SELECT 1 $$",
        ))
        .unwrap();
        assert_eq!(
            sql,
            "CREATE OR REPLACE FUNCTION refresh_cache() RETURNS void LANGUAGE SQL AS $$ SELECT 1 $$;"
        );
    }

    #[test]
    fn mysql_view_source_executed_as_create_when_full_ddl() {
        // MySQL view 保存须幂等：先 DROP VIEW IF EXISTS 再 CREATE，避免「已存在」报错。
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("reporting".to_string()),
            name: "active_users".to_string(),
            source: "CREATE VIEW `active_users` AS SELECT `id` FROM `users`".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "DROP VIEW IF EXISTS `reporting`.`active_users`;\n\
             CREATE VIEW `active_users` AS SELECT `id` FROM `users`;"
        );
    }

    #[test]
    fn mysql_view_save_drops_then_creates_for_idempotency() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("reporting".to_string()),
            name: "active_users".to_string(),
            source: "CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "DROP VIEW IF EXISTS `reporting`.`active_users`;\n\
             CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`;"
        );
    }

    #[test]
    fn mysql_procedure_save_drops_then_creates_for_idempotency() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE `usp_demo`() BEGIN SELECT 1; END".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "DROP PROCEDURE IF EXISTS `app`.`usp_demo`;\n\
             CREATE PROCEDURE `usp_demo`() BEGIN SELECT 1; END;"
        );
    }

    #[test]
    fn mysql_function_save_drops_then_creates_for_idempotency() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Function,
            schema: None,
            name: "fn_add".to_string(),
            source: "CREATE FUNCTION `fn_add`(a INT) RETURNS INT DETERMINISTIC RETURN a + 1".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "DROP FUNCTION IF EXISTS `fn_add`;\n\
             CREATE FUNCTION `fn_add`(a INT) RETURNS INT DETERMINISTIC RETURN a + 1;"
        );
    }

    #[test]
    fn clickhouse_view_save_drops_then_creates() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Clickhouse,
            object_type: ObjectSourceKind::View,
            schema: Some("analytics".to_string()),
            name: "daily".to_string(),
            source: "CREATE VIEW daily AS SELECT 1".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "DROP VIEW IF EXISTS \"analytics\".\"daily\";\nCREATE VIEW daily AS SELECT 1;"
        );
    }

    #[test]
    fn duckdb_view_save_drops_then_creates() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Duckdb,
            object_type: ObjectSourceKind::View,
            schema: None,
            name: "v".to_string(),
            source: "CREATE VIEW v AS SELECT 1".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "DROP VIEW IF EXISTS \"v\";\nCREATE VIEW v AS SELECT 1;");
    }

    #[test]
    fn sqlite_view_save_drops_then_creates() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Sqlite,
            object_type: ObjectSourceKind::View,
            schema: None,
            name: "v".to_string(),
            source: "CREATE VIEW v AS SELECT 1".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "DROP VIEW IF EXISTS \"v\";\nCREATE VIEW v AS SELECT 1;");
    }

    #[test]
    fn sqlite_procedure_save_is_rejected() {
        let err = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Sqlite,
            object_type: ObjectSourceKind::Procedure,
            schema: None,
            name: "p".to_string(),
            source: "CREATE PROCEDURE p() BEGIN SELECT 1; END".to_string(),
        })
        .unwrap_err();
        assert!(err.contains("does not support"), "got: {err}");
    }

    #[test]
    fn duckdb_function_save_is_rejected() {
        let err = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Duckdb,
            object_type: ObjectSourceKind::Function,
            schema: None,
            name: "f".to_string(),
            source: "CREATE FUNCTION f() RETURNS INT".to_string(),
        })
        .unwrap_err();
        assert!(err.contains("does not support"), "got: {err}");
    }

    #[test]
    fn redis_source_save_is_rejected() {
        let err = build_executable_object_source_sql(input(
            DatabaseType::Redis,
            ObjectSourceKind::View,
            "SELECT 1",
        ))
        .unwrap_err();
        assert!(err.contains("not supported"));
    }

    #[test]
    fn empty_source_is_rejected() {
        let err = build_executable_object_source_sql(input(
            DatabaseType::Postgres,
            ObjectSourceKind::View,
            "   ",
        ))
        .unwrap_err();
        assert!(err.contains("empty"));
    }
}
