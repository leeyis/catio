//! EXPLAIN 执行计划语句拼装(纯函数,易 TDD)。
//! 参考 dbx crates/dbx-core/src/query_execution_sql.rs:
//!   - PG  → `EXPLAIN (FORMAT JSON) <select>`
//!   - MySQL → `EXPLAIN FORMAT=JSON <select>`
//! SQLite/rqlite 使用 QUERY PLAN，DuckDB 使用 FORMAT JSON。来源必须是一条
//! 保守判定的读查询，拒绝脚本、写入 CTE、SELECT INTO 和 ANALYZE。
//! 这是语法门禁，不是数据库授权边界；规划阶段的函数行为仍受数据库权限约束。

use crate::db::DatabaseType;

/// EXPLAIN 语句拼装结果。`ok=false` 时 `reason` 取
/// "unsupported" | "empty" | "unsafe"。
#[derive(Debug, Clone, PartialEq)]
pub struct ExplainSqlResult {
    pub ok: bool,
    pub sql: Option<String>,
    pub reason: Option<String>,
}

/// 该引擎是否已实现非执行式计划格式（JSON 或 QUERY PLAN）。
pub fn supports_explain_plan(db: DatabaseType) -> bool {
    matches!(db, DatabaseType::Postgres | DatabaseType::Mysql | DatabaseType::Sqlite | DatabaseType::Duckdb | DatabaseType::Rqlite)
}

/// 为给定 SQL 拼出按方言的 EXPLAIN 语句。
pub fn build_explain_sql(db: DatabaseType, sql: &str) -> ExplainSqlResult {
    if !supports_explain_plan(db) {
        return err("unsupported");
    }
    let source = strip_trailing_semicolons(sql.trim());
    if source.is_empty() {
        return err("empty");
    }
    let Ok(source) = crate::db::pagination::read_query(db, &source) else { return err("unsafe"); };
    // A session may have NO_BACKSLASH_ESCAPES enabled. Require the same source
    // to be a single read under both escape interpretations rather than guessing.
    if db == DatabaseType::Mysql && crate::db::pagination::read_query(DatabaseType::Sqlite, &source).is_err() { return err("unsafe"); }
    let built = match db {
        DatabaseType::Postgres | DatabaseType::Duckdb => format!("EXPLAIN (FORMAT JSON) {source}"),
        DatabaseType::Sqlite | DatabaseType::Rqlite => format!("EXPLAIN QUERY PLAN {source}"),
        DatabaseType::Mysql => format!("EXPLAIN FORMAT=JSON {source}"),
        _ => return err("unsupported"),
    };
    ExplainSqlResult { ok: true, sql: Some(built), reason: None }
}

fn err(reason: &str) -> ExplainSqlResult {
    ExplainSqlResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn strip_trailing_semicolons(sql: &str) -> String {
    // 循环剥到尾部既无分号也无空白为止,处理 "SELECT 1;;" / "SELECT 1 ; ; " 这类
    // 多分号(夹空格)粘贴,避免 EXPLAIN 语句里残留裸分号。
    sql.trim_end().trim_end_matches(|c| c == ';' || c == ' ' || c == '\t' || c == '\n' || c == '\r').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_duckdb_and_rqlite_use_non_executing_plans() {
        for (engine, expected) in [
            (DatabaseType::Sqlite, "EXPLAIN QUERY PLAN SELECT 1"),
            (DatabaseType::Rqlite, "EXPLAIN QUERY PLAN SELECT 1"),
            (DatabaseType::Duckdb, "EXPLAIN (FORMAT JSON) SELECT 1"),
        ] { assert_eq!(build_explain_sql(engine, "SELECT 1;").sql.as_deref(), Some(expected)); }
    }
    #[test]
    fn refuses_scripts_write_ctes_and_select_into() {
        for sql in ["SELECT 1; DELETE FROM t", "WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x", "WITH x AS (SELECT 1) UPDATE t SET n=1", "SELECT 1 INTO target", "EXPLAIN ANALYZE SELECT 1", "SELECT 1 /*!; DELETE FROM t */", "SELECT $tag$ FROM t; DELETE FROM t; SELECT $tag$ FROM t"] {
            assert!(!build_explain_sql(DatabaseType::Mysql, sql).ok, "{sql}");
        }
    }

    #[test]
    fn postgres_uses_format_json_and_strips_semicolon() {
        assert_eq!(
            build_explain_sql(DatabaseType::Postgres, " select * from users where id = 1; "),
            ExplainSqlResult {
                ok: true,
                sql: Some("EXPLAIN (FORMAT JSON) select * from users where id = 1".into()),
                reason: None,
            }
        );
    }

    #[test]
    fn mysql_uses_format_eq_json() {
        assert_eq!(
            build_explain_sql(DatabaseType::Mysql, "SELECT * FROM users;"),
            ExplainSqlResult {
                ok: true,
                sql: Some("EXPLAIN FORMAT=JSON SELECT * FROM users".into()),
                reason: None,
            }
        );
    }

    #[test]
    fn strips_multiple_trailing_semicolons() {
        // 粘贴多分号 SQL(如 "SELECT 1;;")不应在 EXPLAIN 语句里残留内层分号,
        // 否则语义上不干净(PG/MySQL 虽不报错,但生成的语句拖着裸分号)。
        assert_eq!(
            build_explain_sql(DatabaseType::Postgres, "SELECT 1;;"),
            ExplainSqlResult {
                ok: true,
                sql: Some("EXPLAIN (FORMAT JSON) SELECT 1".into()),
                reason: None,
            }
        );
        // 分号之间夹空格也要剥干净。
        assert_eq!(
            build_explain_sql(DatabaseType::Mysql, "SELECT 1 ; ; ").sql.unwrap(),
            "EXPLAIN FORMAT=JSON SELECT 1"
        );
    }

    #[test]
    fn with_cte_is_allowed() {
        let r = build_explain_sql(DatabaseType::Postgres, "WITH t AS (SELECT 1) SELECT * FROM t");
        assert!(r.ok);
        assert_eq!(r.sql.unwrap(), "EXPLAIN (FORMAT JSON) WITH t AS (SELECT 1) SELECT * FROM t");
    }

    #[test]
    fn unsupported_engine_rejected() {
        assert_eq!(
            build_explain_sql(DatabaseType::Redis, "SELECT 1"),
            ExplainSqlResult { ok: false, sql: None, reason: Some("unsupported".into()) }
        );
    }

    #[test]
    fn empty_sql_rejected() {
        assert_eq!(
            build_explain_sql(DatabaseType::Postgres, "   ;  "),
            ExplainSqlResult { ok: false, sql: None, reason: Some("empty".into()) }
        );
    }

    #[test]
    fn dml_rejected_as_unsafe() {
        assert_eq!(
            build_explain_sql(DatabaseType::Mysql, "delete from users"),
            ExplainSqlResult { ok: false, sql: None, reason: Some("unsafe".into()) }
        );
        assert_eq!(
            build_explain_sql(DatabaseType::Postgres, "update t set a = 1"),
            ExplainSqlResult { ok: false, sql: None, reason: Some("unsafe".into()) }
        );
    }

    #[test]
    fn leading_comment_then_select_is_safe() {
        let r = build_explain_sql(DatabaseType::Postgres, "-- explain me\nSELECT 1");
        assert!(r.ok, "leading line comment should be stripped before the safety check");
    }

    #[test]
    fn supports_only_pg_and_mysql() {
        assert!(supports_explain_plan(DatabaseType::Postgres));
        assert!(supports_explain_plan(DatabaseType::Mysql));
        assert!(!supports_explain_plan(DatabaseType::Mongodb));
        assert!(!supports_explain_plan(DatabaseType::Redis));
    }
}
