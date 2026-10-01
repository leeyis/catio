use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, quote_literal};
use serde_json::Value;

pub struct CellEdit {
    pub column: String,
    pub new_value: Value,
}

/// Backward-compatible ANSI/PostgreSQL literal helper. Engine-aware callers must
/// use value_to_sql_for so SQL Server booleans/Unicode and MySQL escapes round-trip.
pub fn value_to_sql(v: &Value) -> String { value_to_sql_for(DatabaseType::Postgres, v) }

pub fn value_to_sql_for(db: DatabaseType, value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) if db == DatabaseType::Sqlserver => if *b { "1" } else { "0" }.into(),
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => string_literal(db, s),
        other => string_literal(db, &other.to_string()),
    }
}

fn string_literal(db: DatabaseType, s: &str) -> String {
    match db {
        DatabaseType::Mysql if s.contains(['\\', '\0']) => {
            // Hex text is independent of NO_BACKSLASH_ESCAPES and cannot terminate the
            // literal. Preserve readable SQL for ordinary strings without backslashes.
            let hex: String = s.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
            format!("CONVERT(X'{hex}' USING utf8mb4)")
        }
        DatabaseType::Postgres if s.contains('\\') => format!("E{}", quote_literal(&s.replace('\\', "\\\\"))),
        DatabaseType::Clickhouse if s.contains(['\\', '\0']) => {
            let hex: String = s.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
            format!("unhex('{hex}')")
        }
        DatabaseType::Sqlserver => format!("N{}", quote_literal(s)),
        _ => quote_literal(s),
    }
}

fn predicate(db: DatabaseType, key: &[(String, Value)]) -> String {
    key.iter().map(|(column, value)| {
        let col = quote_ident(db, column);
        if value.is_null() { format!("{col} IS NULL") }
        else { format!("{col} = {}", value_to_sql_for(db, value)) }
    }).collect::<Vec<_>>().join(" AND ")
}

pub fn build_update(db: DatabaseType, schema: Option<&str>, table: &str,
    pk: &[(String, Value)], edits: &[CellEdit]) -> String {
    let table = crate::db::dialect::qualified_table(db, true, schema, table);
    let set = edits.iter().map(|e| format!("{} = {}", quote_ident(db, &e.column), value_to_sql_for(db, &e.new_value)))
        .collect::<Vec<_>>().join(", ");
    format!("UPDATE {table} SET {set} WHERE {}", predicate(db, pk))
}

pub fn build_delete(db: DatabaseType, schema: Option<&str>, table: &str, pk: &[(String, Value)]) -> String {
    let table = crate::db::dialect::qualified_table(db, true, schema, table);
    format!("DELETE FROM {table} WHERE {}", predicate(db, pk))
}

pub fn build_insert(db: DatabaseType, schema: Option<&str>, table: &str, cells: &[CellEdit]) -> String {
    let table = crate::db::dialect::qualified_table(db, true, schema, table);
    let cols = cells.iter().map(|c| quote_ident(db, &c.column)).collect::<Vec<_>>().join(", ");
    let values = cells.iter().map(|c| value_to_sql_for(db, &c.new_value)).collect::<Vec<_>>().join(", ");
    format!("INSERT INTO {table} ({cols}) VALUES ({values})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn update_pg() {
        let sql = build_update(DatabaseType::Postgres, Some("public"), "orders", &[("id".into(), json!(7))],
            &[CellEdit { column: "status".into(), new_value: json!("shipped") }]);
        assert_eq!(sql, r#"UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 7"#);
    }
    #[test]
    fn delete_mysql_no_schema() {
        assert_eq!(build_delete(DatabaseType::Mysql, None, "t", &[("id".into(), json!(1))]), "DELETE FROM `t` WHERE `id` = 1");
    }
    #[test]
    fn insert_escapes_quotes() {
        let sql = build_insert(DatabaseType::Postgres, None, "t", &[CellEdit { column: "name".into(), new_value: json!("O'Brien") }]);
        assert_eq!(sql, r#"INSERT INTO "t" ("name") VALUES ('O''Brien')"#);
    }
    #[test]
    fn null_value_and_null_predicate_are_distinct() {
        assert_eq!(value_to_sql(&Value::Null), "NULL");
        assert_eq!(build_delete(DatabaseType::Sqlite, None, "t", &[("k".into(), Value::Null)]), "DELETE FROM \"t\" WHERE \"k\" IS NULL");
    }
    #[test]
    fn sqlserver_unicode_and_boolean_literals() {
        assert_eq!(value_to_sql_for(DatabaseType::Sqlserver, &json!("中文'")), "N'中文'''" );
        assert_eq!(value_to_sql_for(DatabaseType::Sqlserver, &json!(true)), "1");
    }
    #[test]
    fn mysql_backslash_is_mode_independent() {
        assert_eq!(value_to_sql_for(DatabaseType::Mysql, &json!("a\\'")), "CONVERT(X'615c27' USING utf8mb4)");
        assert_eq!(value_to_sql_for(DatabaseType::Postgres, &json!("a\\b")), "E'a\\\\b'");
    }
}
