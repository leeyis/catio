//! EXPLAIN 执行计划语句拼装(纯函数,易 TDD)。
//! 参考 dbx crates/dbx-core/src/query_execution_sql.rs:
//!   - PG  → `EXPLAIN (FORMAT JSON) <select>`
//!   - MySQL → `EXPLAIN FORMAT=JSON <select>`
//! 仅对只读语句(SELECT/WITH/TABLE/VALUES)放行,拒绝 DML/DDL,避免 EXPLAIN ANALYZE
//! 之外的副作用(本实现用普通 EXPLAIN,本就不执行计划,但仍做来源安全校验)。

use crate::db::DatabaseType;

/// EXPLAIN 语句拼装结果。`ok=false` 时 `reason` 取
/// "unsupported" | "empty" | "unsafe"。
#[derive(Debug, Clone, PartialEq)]
pub struct ExplainSqlResult {
    pub ok: bool,
    pub sql: Option<String>,
    pub reason: Option<String>,
}

/// 该引擎是否支持 JSON 执行计划(目前 PG / MySQL)。
pub fn supports_explain_plan(db: DatabaseType) -> bool {
    matches!(db, DatabaseType::Postgres | DatabaseType::Mysql)
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
    if !is_safe_explain_source(&source) {
        return err("unsafe");
    }
    let built = if db == DatabaseType::Postgres {
        format!("EXPLAIN (FORMAT JSON) {source}")
    } else {
        format!("EXPLAIN FORMAT=JSON {source}")
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

/// 只允许只读语句进入 EXPLAIN(去注释后看首关键字)。
fn is_safe_explain_source(sql: &str) -> bool {
    let source = strip_sql_comments(sql).trim_start().to_lowercase();
    ["select", "with", "table", "values"].iter().any(|kw| {
        source == *kw
            || source.starts_with(&format!("{kw} "))
            || source.starts_with(&format!("{kw}\n"))
            || source.starts_with(&format!("{kw}\t"))
    })
}

/// 去掉 SQL 行/块注释(-- … / # … / /* … */),用空格替换以保留分词边界。
fn strip_sql_comments(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line = false;
    let mut in_block = false;
    while let Some(ch) = chars.next() {
        if in_line {
            if ch == '\n' {
                in_line = false;
                output.push(' ');
            }
            continue;
        }
        if in_block {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
                output.push(' ');
            }
            continue;
        }
        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            in_line = true;
            continue;
        }
        if ch == '#' {
            in_line = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block = true;
            continue;
        }
        output.push(ch);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

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
            build_explain_sql(DatabaseType::Sqlite, "SELECT 1"),
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
