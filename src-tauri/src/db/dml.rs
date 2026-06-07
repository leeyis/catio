use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, quote_literal};
use serde_json::Value;

/// 一处单元格改动。
pub struct CellEdit {
    pub column: String,
    pub new_value: Value,
}

/// 值 → SQL 字面量（NULL/数字/布尔/字符串）。
pub fn value_to_sql(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_literal(s),
        other => quote_literal(&other.to_string()),
    }
}

/// 生成 UPDATE：按主键列定位行。
pub fn build_update(
    db: DatabaseType, schema: Option<&str>, table: &str,
    pk: &[(String, Value)], edits: &[CellEdit],
) -> String {
    let tbl = qualified(db, schema, table);
    let set = edits.iter()
        .map(|e| format!("{} = {}", quote_ident(db, &e.column), value_to_sql(&e.new_value)))
        .collect::<Vec<_>>().join(", ");
    let whr = pk.iter()
        .map(|(c, v)| format!("{} = {}", quote_ident(db, c), value_to_sql(v)))
        .collect::<Vec<_>>().join(" AND ");
    format!("UPDATE {tbl} SET {set} WHERE {whr}")
}

pub fn build_delete(db: DatabaseType, schema: Option<&str>, table: &str, pk: &[(String, Value)]) -> String {
    let tbl = qualified(db, schema, table);
    let whr = pk.iter()
        .map(|(c, v)| format!("{} = {}", quote_ident(db, c), value_to_sql(v)))
        .collect::<Vec<_>>().join(" AND ");
    format!("DELETE FROM {tbl} WHERE {whr}")
}

pub fn build_insert(db: DatabaseType, schema: Option<&str>, table: &str, cells: &[CellEdit]) -> String {
    let tbl = qualified(db, schema, table);
    let cols = cells.iter().map(|c| quote_ident(db, &c.column)).collect::<Vec<_>>().join(", ");
    let vals = cells.iter().map(|c| value_to_sql(&c.new_value)).collect::<Vec<_>>().join(", ");
    format!("INSERT INTO {tbl} ({cols}) VALUES ({vals})")
}

fn qualified(db: DatabaseType, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(db, s), quote_ident(db, table)),
        _ => quote_ident(db, table),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn update_pg() {
        let sql = build_update(DatabaseType::Postgres, Some("public"), "orders",
            &[("id".into(), json!(7))],
            &[CellEdit { column: "status".into(), new_value: json!("shipped") }]);
        assert_eq!(sql, r#"UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 7"#);
    }
    #[test]
    fn delete_mysql_no_schema() {
        let sql = build_delete(DatabaseType::Mysql, None, "t", &[("id".into(), json!(1))]);
        assert_eq!(sql, "DELETE FROM `t` WHERE `id` = 1");
    }
    #[test]
    fn insert_escapes_quotes() {
        let sql = build_insert(DatabaseType::Postgres, None, "t",
            &[CellEdit { column: "name".into(), new_value: json!("O'Brien") }]);
        assert_eq!(sql, r#"INSERT INTO "t" ("name") VALUES ('O''Brien')"#);
    }
    #[test]
    fn null_value() {
        assert_eq!(value_to_sql(&json!(null)), "NULL");
    }
}
