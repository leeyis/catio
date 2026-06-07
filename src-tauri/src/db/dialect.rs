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
}
