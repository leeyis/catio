//! Conservative, lossless query paging. Inspired by DBX query_result_sql's separation
//! of SQL construction and execution plans; never paginate a write or a script.
//! This is a syntax gate, not a database authorization boundary (SELECT functions may
//! have side effects). Database privileges remain the security boundary.
use crate::db::{DatabaseType, DbError};

pub const MAX_PAGE_SIZE: u32 = 10_000;
pub const MAX_CLIENT_WINDOW: u32 = 1_000_000;

#[derive(Debug)]
pub struct PagePlan {
    pub sql: String,
    pub fetch_rows: u32,
    pub skip_rows: usize,
}

#[derive(Debug)]
struct Word { text: String, depth: usize }

/// Scan without interpreting literals as keywords. Handles doubled quotes, SQL Server
/// brackets, MySQL escapes, PostgreSQL dollar strings and nested block comments.
fn shape(db: DatabaseType, sql: &str) -> Result<(String, Vec<Word>), DbError> {
    let b = sql.as_bytes();
    let (mut i, mut depth, mut last, mut ended) = (0, 0usize, 0, false);
    let mut words = Vec::new();
    let invalid = || DbError::QueryFailed("Pagination requires one complete read query".into());
    while i < b.len() {
        if b[i].is_ascii_whitespace() { i += 1; continue; }
        if b[i..].starts_with(b"--") || (db == DatabaseType::Mysql && b[i] == b'#') {
            while i < b.len() && b[i] != b'\n' { i += 1; }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            if db == DatabaseType::Mysql && (b[i..].starts_with(b"/*!") || b[i..].starts_with(b"/*M!")) {
                return Err(DbError::Unsupported("Executable SQL comments cannot be paginated or used in an atomic batch".into()));
            }
            i += 2;
            let mut nesting = 1;
            while i < b.len() && nesting > 0 {
                if b[i..].starts_with(b"/*") { nesting += 1; i += 2; }
                else if b[i..].starts_with(b"*/") { nesting -= 1; i += 2; }
                else { i += 1; }
            }
            if nesting != 0 { return Err(invalid()); }
            continue;
        }
        if b[i] == b';' {
            if depth != 0 { return Err(invalid()); }
            ended = true; i += 1; continue;
        }
        if ended { return Err(invalid()); }
        if matches!(b[i], b'\'' | b'"' | b'`' | b'[') {
            let start = i;
            let quote = b[i];
            let close = if quote == b'[' { b']' } else { quote };
            // PG E'...' uses backslash escapes regardless of standard_conforming_strings.
            let escapes = db == DatabaseType::Mysql
                || (quote == b'\'' && start > 0 && matches!(b[start-1], b'e' | b'E'));
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if escapes && b[i] == b'\\' { i = (i + 2).min(b.len()); continue; }
                if b[i] == close {
                    i += 1;
                    if i < b.len() && b[i] == close { i += 1; continue; }
                    closed = true; break;
                }
                i += 1;
            }
            if !closed { return Err(invalid()); }
            last = i; continue;
        }
        if b[i] == b'$' {
            let start = i;
            let mut end = i + 1;
            while end < b.len() && (b[end].is_ascii_alphanumeric() || b[end] == b'_') { end += 1; }
            if end < b.len() && b[end] == b'$' {
                let tag = &sql[start..=end];
                let rest = &sql[end+1..];
                let close = rest.find(tag).ok_or_else(invalid)?;
                i = end + 1 + close + tag.len();
                last = i; continue;
            }
        }
        if b[i] == b'(' { depth += 1; }
        else if b[i] == b')' { depth = depth.checked_sub(1).ok_or_else(invalid)?; }
        else if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') { i += 1; }
            words.push(Word { text: sql[start..i].to_ascii_uppercase(), depth });
            last = i; continue;
        }
        i += 1;
        last = i;
    }
    if depth != 0 || words.is_empty() { return Err(invalid()); }
    // `last` is the byte after a significant token, excluding trailing comments/semicolons.
    Ok((sql[..last].trim().to_string(), words))
}

/// Shared lexical view for choosing a session-preserving transport; not a SQL authorization gate.
pub(crate) fn statement_words(db: DatabaseType, sql: &str) -> Result<Vec<String>,DbError> {
    shape(db,sql).map(|(_,words)|words.into_iter().map(|word|word.text).collect())
}

pub fn read_query(db: DatabaseType, sql: &str) -> Result<String, DbError> {
    let (source, words) = shape(db, sql)?;
    if !matches!(words.first().map(|w| w.text.as_str()), Some("SELECT" | "WITH" | "TABLE" | "VALUES")) {
        return Err(DbError::Unsupported("Pagination is only available for read queries".into()));
    }
    // Inspect CTE bodies too, not just the first word. Quoted identifiers and literals
    // were deliberately excluded above. Reject SELECT INTO / locking reads as well.
    if words.iter().any(|w| matches!(w.text.as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "CREATE" | "ALTER"
        | "DROP" | "TRUNCATE" | "CALL" | "EXEC" | "EXECUTE" | "INTO" | "LOCK" | "COPY")) {
        return Err(DbError::Unsupported("A mutating or locking statement cannot be paginated".into()));
    }
    Ok(source)
}

/// Result classification for drivers whose query/execute APIs differ. Literals and
/// comments are excluded; DML RETURNING/OUTPUT are genuine result sets.
pub fn transaction_control(db: DatabaseType, sql: &str) -> bool {
    shape(db, sql).ok().and_then(|(_, words)| words.first().map(|w| w.text.clone()))
        .is_some_and(|word| matches!(word.as_str(), "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "SAVEPOINT" | "RELEASE"))
}

pub fn returns_rows(db: DatabaseType, sql: &str) -> bool {
    let Ok((_, words)) = shape(db, sql) else { return false; };
    if words.iter().any(|w| w.depth == 0 && matches!(w.text.as_str(), "RETURNING" | "OUTPUT")) { return true; }
    let first = words.first().map(|w| w.text.as_str()).unwrap_or("");
    if first == "WITH" {
        return words.iter().find(|w| w.depth == 0 && matches!(w.text.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"))
            .is_some_and(|w| w.text == "SELECT");
    }
    matches!(first, "SELECT" | "FROM" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES" | "TABLE" | "SUMMARIZE" | "EXEC" | "EXECUTE")
}

/// Atomic DML batches must not contain implicit-commit DDL or transaction control.
/// Validate the entire batch before acquiring its transaction.
pub fn batch_statement(db: DatabaseType, sql: &str) -> Result<String, DbError> {
    let (source, words) = shape(db, sql)?;
    if !matches!(words.first().map(|w| w.text.as_str()), Some("INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE")) {
        return Err(DbError::Unsupported("Atomic batches accept only INSERT/UPDATE/DELETE/MERGE/REPLACE, not DDL or transaction control".into()));
    }
    Ok(format!("{source};"))
}

pub fn validate_limit(limit: u32) -> Result<(), DbError> {
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(DbError::QueryFailed(format!("Page size must be between 1 and {MAX_PAGE_SIZE}")));
    }
    Ok(())
}

pub fn build_page_plan(db: DatabaseType, sql: &str, limit: u32, offset: u32) -> Result<PagePlan, DbError> {
    validate_limit(limit)?;
    if matches!(db, DatabaseType::Mongodb | DatabaseType::Redis | DatabaseType::Elasticsearch) {
        return Err(DbError::Unsupported("Use the engine's native document/key pagination".into()));
    }
    let source = read_query(db, sql)?;
    let (_, words) = shape(db, &source)?;
    let top: Vec<&str> = words.iter().filter(|w| w.depth == 0).map(|w| w.text.as_str()).collect();
    let existing_limit = top.iter().any(|w| matches!(*w, "LIMIT" | "OFFSET" | "FETCH" | "TOP"));
    let ordered = top.windows(2).any(|w| w == ["ORDER", "BY"]);

    // JDBC is not a dialect. Its per-driver result-set cursor can page without adding
    // invalid LIMIT to Oracle/DB2/SQL Server. Complex SQL Server queries use the same
    // bounded fallback, preserving TOP, CTEs, duplicate/unnamed columns and ORDER BY.
    if db == DatabaseType::Jdbc || (db == DatabaseType::Sqlserver && (existing_limit || top.first() == Some(&"WITH"))) {
        let window = offset.checked_add(limit).and_then(|v| v.checked_add(1))
            .filter(|v| *v <= MAX_CLIENT_WINDOW)
            .ok_or_else(|| DbError::Unsupported("This query needs cursor pagination; narrow the query before paging beyond one million rows".into()))?;
        return Ok(PagePlan { sql: source, fetch_rows: window, skip_rows: offset as usize });
    }
    let fetch = limit + 1; // sentinel row: exactly-full final pages must NOT claim more rows
    let paged = if db == DatabaseType::Sqlserver {
        let order = if ordered { "" } else { " ORDER BY (SELECT NULL)" };
        format!("{source}\n{order} OFFSET {offset} ROWS FETCH NEXT {fetch} ROWS ONLY")
    } else if existing_limit {
        // Keep the user's LIMIT as an inner boundary, never silently widen it.
        format!("SELECT * FROM (\n{source}\n) AS __catio_page LIMIT {fetch} OFFSET {offset}")
    } else {
        format!("{source}\nLIMIT {fetch} OFFSET {offset}")
    };
    Ok(PagePlan { sql: paged, fetch_rows: fetch, skip_rows: 0 })
}

pub fn finish_page(mut result: crate::db::result::QueryResult, plan: &PagePlan, limit: u32) -> crate::db::result::QueryResult {
    let skipped = plan.skip_rows.min(result.rows.len());
    if skipped > 0 { result.rows.drain(..skipped); }
    result.truncated = result.truncated || result.rows.len() > limit as usize;
    result.rows.truncate(limit as usize);
    result.binary_cells = result.binary_cells.into_iter().filter_map(|[r,c]|
        (r >= skipped && r - skipped < result.rows.len()).then(|| [r - skipped,c])).collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comments_and_literals_cannot_smuggle_a_second_statement() {
        for sql in ["SELECT ';DELETE' AS x; -- harmless", "/* outer /* nested */ comment */ SELECT $$;DELETE$$", "SELECT [semi;colon] FROM [t]"] {
            assert!(read_query(DatabaseType::Postgres, sql).is_ok(), "{sql}");
        }
        for sql in ["SELECT 1; DELETE FROM t", "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "SELECT * INTO new_table FROM t", "SELECT 1 /* unfinished", "SELECT 'unfinished"] {
            assert!(read_query(DatabaseType::Postgres, sql).is_err(), "{sql}");
        }
    }
    #[test]
    fn sqlserver_requires_real_outer_order_not_keyword_inside_literal() {
        let p = build_page_plan(DatabaseType::Sqlserver, "SELECT 'ORDER BY' AS [x]", 100, 0).unwrap();
        assert!(p.sql.contains("ORDER BY (SELECT NULL)"));
        assert!(p.sql.contains("FETCH NEXT 101"));
        let p = build_page_plan(DatabaseType::Sqlserver, "SELECT * FROM t ORDER BY id", 100, 0).unwrap();
        assert_eq!(p.sql.matches("ORDER BY").count(), 1);
    }
    #[test]
    fn jdbc_never_assumes_limit_syntax() {
        let p = build_page_plan(DatabaseType::Jdbc, "SELECT * FROM t", 100, 100).unwrap();
        assert_eq!(p.sql, "SELECT * FROM t");
        assert_eq!(p.fetch_rows, 201);
        assert_eq!(p.skip_rows, 100);
    }
    #[test]
    fn limits_and_offsets_are_bounded() {
        assert!(build_page_plan(DatabaseType::Postgres, "SELECT 1", 0, 0).is_err());
        assert!(build_page_plan(DatabaseType::Postgres, "SELECT 1", MAX_PAGE_SIZE+1, 0).is_err());
        assert!(build_page_plan(DatabaseType::Jdbc, "SELECT 1", 100, u32::MAX).is_err());
    }
}
