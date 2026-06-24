use crate::db::DatabaseType;

/// 标识符引用。照搬 dbx sql_dialect.rs：PG/SQLite 用 "x"，MySQL 用 `x`，SQLServer 用 [x]。
pub fn quote_ident(db: DatabaseType, ident: &str) -> String {
    use DatabaseType::*;
    match db {
        Mysql => format!("`{}`", ident.replace('`', "``")),
        Sqlserver => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

/// SQL 字符串字面量转义（单引号加倍）。
pub fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 给 SELECT 包一层分页。多数引擎用 LIMIT/OFFSET；SQLServer 用 OFFSET/FETCH。
pub fn paginate(db: DatabaseType, sql: &str, limit: u32, offset: u32) -> String {
    match db {
        DatabaseType::Sqlserver => {
            format!("{sql} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
        }
        _ => format!("{sql} LIMIT {limit} OFFSET {offset}"),
    }
}

/// Dialect-correct, identifier-quoted qualified table name. Qualifies with the
/// schema only when the engine has schema namespaces AND a non-empty schema was
/// given; otherwise returns the bare quoted table.
pub fn qualified_table(db: DatabaseType, has_schemas: bool, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if has_schemas && !s.is_empty() =>
            format!("{}.{}", quote_ident(db, s), quote_ident(db, table)),
        _ => quote_ident(db, table),
    }
}

/// 服务端表查询的拼接(对齐 dbx 网格的 whereFilterInput/orderByInput)。
///
/// 生成 `SELECT [ctid AS __ctid, ]* FROM <qualified> [WHERE <where>] [ORDER BY <order>]`
/// 后用方言 `paginate` 包裹分页(SQLServer 用 OFFSET/FETCH,其余 LIMIT/OFFSET)。
/// `where_clause`/`order_by` 为用户输入的 SQL 片段(与 SQL 控制台同信任级别):空白片段
/// 不拼对应子句。`with_ctid=true` 时(Postgres 无主键行定位)前置 `ctid AS __ctid`,与
/// 默认 `table_data` 一致。
pub fn build_table_query_sql(
    db: DatabaseType,
    has_schemas: bool,
    schema: Option<&str>,
    table: &str,
    where_clause: Option<&str>,
    order_by: Option<&str>,
    limit: u32,
    offset: u32,
    with_ctid: bool,
) -> String {
    let qualified = qualified_table(db, has_schemas, schema, table);
    let projection = if with_ctid { "ctid AS __ctid, *" } else { "*" };
    let mut sql = format!("SELECT {projection} FROM {qualified}");
    if let Some(w) = where_clause {
        let w = w.trim();
        if !w.is_empty() {
            sql.push_str(&format!(" WHERE {w}"));
        }
    }
    if let Some(o) = order_by {
        let o = o.trim();
        if !o.is_empty() {
            sql.push_str(&format!(" ORDER BY {o}"));
        }
    }
    paginate(db, &sql, limit, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_per_dialect() {
        assert_eq!(quote_ident(DatabaseType::Postgres, "tbl"), "\"tbl\"");
        assert_eq!(quote_ident(DatabaseType::Mysql, "tbl"), "`tbl`");
        assert_eq!(quote_ident(DatabaseType::Sqlserver, "tbl"), "[tbl]");
    }
    #[test]
    fn escapes_injection_in_ident() {
        assert_eq!(quote_ident(DatabaseType::Postgres, "a\"b"), "\"a\"\"b\"");
    }
    #[test]
    fn literal_escapes_quote() {
        assert_eq!(quote_literal("O'Brien"), "'O''Brien'");
    }
    #[test]
    fn sqlserver_pagination_differs() {
        assert!(paginate(DatabaseType::Sqlserver, "SELECT 1", 10, 5).contains("FETCH NEXT 10"));
        assert!(paginate(DatabaseType::Postgres, "SELECT 1", 10, 5).contains("LIMIT 10 OFFSET 5"));
    }
    #[test]
    fn pg_with_schema_is_quoted_and_qualified() {
        assert_eq!(qualified_table(DatabaseType::Postgres, true, Some("public"), "orders"), r#""public"."orders""#);
    }
    #[test]
    fn mysql_no_schema_is_bare_backtick() {
        assert_eq!(qualified_table(DatabaseType::Mysql, false, Some("ignored"), "orders"), "`orders`");
    }
    #[test]
    fn sqlserver_with_schema_uses_brackets() {
        assert_eq!(qualified_table(DatabaseType::Sqlserver, true, Some("dbo"), "orders"), "[dbo].[orders]");
    }
    #[test]
    fn pg_empty_schema_falls_back_to_bare() {
        assert_eq!(qualified_table(DatabaseType::Postgres, true, Some(""), "orders"), r#""orders""#);
    }

    // ── build_table_query_sql:服务端 WHERE / ORDER BY ────────────────────────────
    #[test]
    fn table_query_no_clauses_is_plain_select() {
        let sql = build_table_query_sql(
            DatabaseType::Postgres, true, Some("public"), "orders", None, None, 100, 0, false);
        assert_eq!(sql, r#"SELECT * FROM "public"."orders" LIMIT 100 OFFSET 0"#);
    }
    #[test]
    fn table_query_blank_clauses_omit_keywords() {
        // 空白(含纯空格)片段不应拼出 WHERE / ORDER BY。
        let sql = build_table_query_sql(
            DatabaseType::Mysql, false, None, "orders", Some("   "), Some(""), 50, 10, false);
        assert_eq!(sql, "SELECT * FROM `orders` LIMIT 50 OFFSET 10");
        assert!(!sql.contains("WHERE"));
        assert!(!sql.contains("ORDER BY"));
    }
    #[test]
    fn table_query_where_and_order_by_compose() {
        let sql = build_table_query_sql(
            DatabaseType::Mysql, false, None, "orders",
            Some("status = 'paid'"), Some("created_at DESC"), 100, 0, false);
        assert_eq!(
            sql,
            "SELECT * FROM `orders` WHERE status = 'paid' ORDER BY created_at DESC LIMIT 100 OFFSET 0",
        );
    }
    #[test]
    fn table_query_trims_clause_whitespace() {
        let sql = build_table_query_sql(
            DatabaseType::Postgres, true, Some("public"), "t",
            Some("  id > 5  "), Some("  id ASC  "), 10, 0, false);
        assert_eq!(sql, r#"SELECT * FROM "public"."t" WHERE id > 5 ORDER BY id ASC LIMIT 10 OFFSET 0"#);
    }
    #[test]
    fn table_query_sqlserver_uses_offset_fetch_with_clauses() {
        // SQLServer 分页用 OFFSET/FETCH,WHERE/ORDER BY 仍在分页之前。
        let sql = build_table_query_sql(
            DatabaseType::Sqlserver, true, Some("dbo"), "orders",
            Some("amount > 0"), Some("id"), 25, 50, false);
        assert_eq!(
            sql,
            "SELECT * FROM [dbo].[orders] WHERE amount > 0 ORDER BY id OFFSET 50 ROWS FETCH NEXT 25 ROWS ONLY",
        );
    }
    #[test]
    fn table_query_with_ctid_prepends_hidden_column() {
        // Postgres 无主键行定位:projection 前置 ctid AS __ctid,与默认 table_data 一致。
        let sql = build_table_query_sql(
            DatabaseType::Postgres, true, Some("public"), "orders",
            Some("id = 1"), None, 100, 0, true);
        assert_eq!(
            sql,
            r#"SELECT ctid AS __ctid, * FROM "public"."orders" WHERE id = 1 LIMIT 100 OFFSET 0"#,
        );
    }
}
