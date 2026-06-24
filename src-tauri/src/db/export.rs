//! SQL 导出纯函数（结果集/表 → INSERT 语句；整库 → DDL + 数据 + 对象脚本）。
//!
//! 对齐 dbx crates/dbx-core/src/database_export.rs 的 `build_export_insert_statements`
//! / `build_database_sql_export` 语义,但复用 Catio 既有方言助手 `dialect::{quote_ident,
//! value_to_sql/qualified_table}`,与 `dml.rs` 的 `build_insert` 保持一致的标识符引用 +
//! 字面量转义。真实串流到文件由 commands.rs 接线（参考 export_file）。

use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, qualified_table};
use crate::db::dml::value_to_sql;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 整库导出时单表默认每批 INSERT 的行数（dbx 默认 1000）。
pub const DEFAULT_INSERT_BATCH_SIZE: usize = 1000;

/// 一张表的导出快照：DDL（可选）+ 列名 + 行数据。供整库脚本拼装使用。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTable {
    pub display_name: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub ddl: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub truncated: bool,
}

/// 生成批量 INSERT 语句（按 batch_size 分批，每批一条多值 VALUES）。
///
/// 复用 dml::value_to_sql + dialect::quote_ident，保证与单行编辑插入的转义/引用一致。
/// 空列或空行返回空 Vec（无可插入内容，不报错）。batch_size 至少为 1。
pub fn build_insert_statements(
    db: DatabaseType,
    has_schemas: bool,
    schema: Option<&str>,
    table: &str,
    columns: &[String],
    rows: &[Vec<Value>],
    batch_size: usize,
) -> Vec<String> {
    if columns.is_empty() || rows.is_empty() {
        return Vec::new();
    }
    let tbl = qualified_table(db, has_schemas, schema, table);
    let cols = columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
    let batch = batch_size.max(1);

    rows.chunks(batch)
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|row| {
                    let cells = row.iter().map(value_to_sql).collect::<Vec<_>>().join(", ");
                    format!("({cells})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {tbl} ({cols}) VALUES {values};")
        })
        .collect()
}

/// 拼装整库导出脚本：头注释 → 各表（DDL + 数据 INSERT 批）。
///
/// `include_structure` 写出 DDL（自动补一个结尾分号），`include_data` 写出 INSERT 批。
/// MySQL 在脚本首尾包一对 `SET FOREIGN_KEY_CHECKS`,避免按表顺序导入触发外键冲突
/// （对齐 dbx export_database_sql_core 的行为）。
#[allow(clippy::too_many_arguments)]
pub fn build_database_sql_export(
    db: DatabaseType,
    has_schemas: bool,
    database_name: &str,
    exported_at: &str,
    tables: &[ExportTable],
    include_structure: bool,
    include_data: bool,
    batch_size: usize,
) -> String {
    let mut lines = vec![
        format!("-- Catio database export: {database_name}"),
        format!("-- Exported at: {exported_at}"),
        String::new(),
    ];

    if matches!(db, DatabaseType::Mysql) {
        lines.push("SET FOREIGN_KEY_CHECKS = 0;".to_string());
        lines.push(String::new());
    }

    for table in tables {
        if include_structure {
            if let Some(ddl) = table.ddl.as_ref().map(|d| d.trim()).filter(|d| !d.is_empty()) {
                lines.push(format!("-- Structure for {}", table.display_name));
                lines.push(format!("{};", ddl.trim_end_matches(';')));
                lines.push(String::new());
            }
        }

        if include_data {
            lines.push(format!("-- Data for {}", table.display_name));
            if table.truncated {
                lines.push(format!("-- Exported rows: {} (truncated)", table.rows.len()));
            } else {
                lines.push(format!("-- Exported rows: {}", table.rows.len()));
            }
            let inserts = build_insert_statements(
                db,
                has_schemas,
                table.schema.as_deref(),
                &table.table_name,
                &table.columns,
                &table.rows,
                batch_size,
            );
            if inserts.is_empty() {
                lines.push("-- No rows".to_string());
            } else {
                lines.extend(inserts);
            }
            lines.push(String::new());
        }
    }

    if matches!(db, DatabaseType::Mysql) {
        lines.push("SET FOREIGN_KEY_CHECKS = 1;".to_string());
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn batches_insert_statements_by_size() {
        let stmts = build_insert_statements(
            DatabaseType::Mysql,
            false,
            None,
            "users",
            &["id".into(), "name".into()],
            &[
                vec![json!(1), json!("Ada")],
                vec![json!(2), json!("O'Hara")],
                vec![json!(3), json!("Linus")],
            ],
            2,
        );
        assert_eq!(
            stmts,
            vec![
                "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada'), (2, 'O''Hara');",
                "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Linus');",
            ]
        );
    }

    #[test]
    fn qualifies_table_with_schema_on_postgres() {
        let stmts = build_insert_statements(
            DatabaseType::Postgres,
            true,
            Some("public"),
            "orders",
            &["id".into()],
            &[vec![json!(7)]],
            1000,
        );
        assert_eq!(stmts, vec![r#"INSERT INTO "public"."orders" ("id") VALUES (7);"#]);
    }

    #[test]
    fn empty_columns_or_rows_yield_no_statements() {
        assert!(build_insert_statements(DatabaseType::Mysql, false, None, "t", &[], &[vec![json!(1)]], 100).is_empty());
        assert!(build_insert_statements(DatabaseType::Mysql, false, None, "t", &["id".into()], &[], 100).is_empty());
    }

    #[test]
    fn zero_batch_size_falls_back_to_one_per_statement() {
        let stmts = build_insert_statements(
            DatabaseType::Sqlite,
            false,
            None,
            "t",
            &["id".into()],
            &[vec![json!(1)], vec![json!(2)]],
            0,
        );
        assert_eq!(stmts.len(), 2);
    }

    #[test]
    fn escapes_null_and_quotes_via_dml_helpers() {
        let stmts = build_insert_statements(
            DatabaseType::Postgres,
            false,
            None,
            "t",
            &["a".into(), "b".into()],
            &[vec![Value::Null, json!("O'Brien")]],
            10,
        );
        assert_eq!(stmts, vec![r#"INSERT INTO "t" ("a", "b") VALUES (NULL, 'O''Brien');"#]);
    }

    #[test]
    fn database_export_writes_ddl_before_data() {
        let sql = build_database_sql_export(
            DatabaseType::Postgres,
            true,
            "app",
            "2026-05-02T00:00:00Z",
            &[ExportTable {
                display_name: "users".into(),
                schema: Some("public".into()),
                table_name: "users".into(),
                ddl: Some("CREATE TABLE \"public\".\"users\" (\"id\" int);".into()),
                columns: vec!["id".into()],
                rows: vec![vec![json!(1)]],
                truncated: false,
            }],
            true,
            true,
            DEFAULT_INSERT_BATCH_SIZE,
        );
        assert_eq!(
            sql,
            [
                "-- Catio database export: app",
                "-- Exported at: 2026-05-02T00:00:00Z",
                "",
                "-- Structure for users",
                "CREATE TABLE \"public\".\"users\" (\"id\" int);",
                "",
                "-- Data for users",
                "-- Exported rows: 1",
                "INSERT INTO \"public\".\"users\" (\"id\") VALUES (1);",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn mysql_export_wraps_foreign_key_checks() {
        let sql = build_database_sql_export(
            DatabaseType::Mysql,
            false,
            "app",
            "now",
            &[ExportTable {
                display_name: "t".into(),
                schema: None,
                table_name: "t".into(),
                ddl: None,
                columns: vec!["id".into()],
                rows: vec![vec![json!(1)]],
                truncated: false,
            }],
            true,
            true,
            DEFAULT_INSERT_BATCH_SIZE,
        );
        assert!(sql.contains("SET FOREIGN_KEY_CHECKS = 0;"));
        assert!(sql.trim_end().ends_with("SET FOREIGN_KEY_CHECKS = 1;"));
    }

    #[test]
    fn structure_only_omits_inserts() {
        let sql = build_database_sql_export(
            DatabaseType::Sqlite,
            false,
            "app",
            "now",
            &[ExportTable {
                display_name: "t".into(),
                schema: None,
                table_name: "t".into(),
                ddl: Some("CREATE TABLE t (id int)".into()),
                columns: vec!["id".into()],
                rows: vec![vec![json!(1)]],
                truncated: false,
            }],
            true,
            false,
            DEFAULT_INSERT_BATCH_SIZE,
        );
        assert!(sql.contains("CREATE TABLE t (id int);"));
        assert!(!sql.contains("INSERT INTO"));
        assert!(!sql.contains("-- Data for"));
    }

    #[test]
    fn data_only_omits_ddl() {
        let sql = build_database_sql_export(
            DatabaseType::Sqlite,
            false,
            "app",
            "now",
            &[ExportTable {
                display_name: "t".into(),
                schema: None,
                table_name: "t".into(),
                ddl: Some("CREATE TABLE t (id int)".into()),
                columns: vec!["id".into()],
                rows: vec![vec![json!(1)]],
                truncated: false,
            }],
            false,
            true,
            DEFAULT_INSERT_BATCH_SIZE,
        );
        assert!(!sql.contains("CREATE TABLE"));
        assert!(sql.contains("INSERT INTO \"t\" (\"id\") VALUES (1);"));
    }

    #[test]
    fn empty_table_data_emits_no_rows_comment() {
        let sql = build_database_sql_export(
            DatabaseType::Sqlite,
            false,
            "app",
            "now",
            &[ExportTable {
                display_name: "t".into(),
                schema: None,
                table_name: "t".into(),
                ddl: None,
                columns: vec!["id".into()],
                rows: vec![],
                truncated: false,
            }],
            true,
            true,
            DEFAULT_INSERT_BATCH_SIZE,
        );
        assert!(sql.contains("-- No rows"));
    }
}
