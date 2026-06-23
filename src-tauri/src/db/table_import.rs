//! 表数据导入纯函数（文件 → 解析 → 列映射 → 批量 INSERT 语句）。
//!
//! 对齐 dbx crates/dbx-core/src/table_import.rs 的解析 + 列映射 + 语句生成语义,但
//! 复用 Catio 既有方言助手 `dialect::{quote_ident, qualified_table}` 与 `dml::value_to_sql`,
//! 与 export.rs 的 `build_insert_statements` 保持一致的标识符引用 + 字面量转义。
//!
//! 真实文件读取 / 执行由 commands.rs 接线（参考 export_file / db_export_database）。
//! 本阶段做 CSV/TSV/JSON 解析;Xlsx 依赖成本较高,标注后续（见 import_file_kind）。

use std::collections::HashSet;

use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, qualified_table};
use crate::db::dml::value_to_sql;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 预览默认行数上限（与 dbx DEFAULT_PREVIEW_LIMIT 一致）。
pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
/// 导入时单条多值 INSERT 的默认行数（与 dbx DEFAULT_BATCH_SIZE 一致）。
pub const DEFAULT_BATCH_SIZE: usize = 500;
/// 导入文件大小上限（200 MiB）。CSV/TSV 走流式逐行解析，JSON 需整体反序列化为
/// serde_json::Value（无法逐 item 流式），二者都会把整文件读入内存,因此在读盘前
/// 用此上限拦截过大的文件,避免「原始字节 + 展开后的行」同时驻留堆造成 OOM。
pub const MAX_IMPORT_BYTES: usize = 200 * 1024 * 1024;

/// 在读盘前校验文件大小,超过 MAX_IMPORT_BYTES 直接报错（防 OOM）。
pub fn check_import_size(len: usize) -> Result<(), String> {
    if len > MAX_IMPORT_BYTES {
        let cap_mb = MAX_IMPORT_BYTES / (1024 * 1024);
        let got_mb = len / (1024 * 1024);
        Err(format!(
            "导入文件过大（{got_mb} MB），超过上限 {cap_mb} MB；请拆分文件或先分批导入"
        ))
    } else {
        Ok(())
    }
}

/// 该引擎在 truncate 模式下能否用事务保证「清表 + 全部 INSERT」原子化。
/// 复用 capabilities 的 transactions 判定,避免与能力表脱节。
pub fn import_supports_transaction(db: DatabaseType) -> bool {
    crate::db::capabilities::capabilities_for(db).transactions
}

/// 该引擎的事务控制关键字 (BEGIN, COMMIT, ROLLBACK)。SQLServer 用 `BEGIN TRANSACTION`。
/// 仅对 import_supports_transaction == true 的引擎有意义。
pub fn transaction_keywords(db: DatabaseType) -> (&'static str, &'static str, &'static str) {
    match db {
        DatabaseType::Sqlserver => ("BEGIN TRANSACTION", "COMMIT", "ROLLBACK"),
        _ => ("BEGIN", "COMMIT", "ROLLBACK"),
    }
}

/// truncate 模式下,若引擎不支持事务则返回一条「清表后逐批 INSERT 无法回滚」的告警,
/// 供 commands 层在执行前提示用户;支持事务的引擎返回 None（会被事务包裹,无此风险）。
pub fn truncate_no_rollback_warning(db: DatabaseType) -> Option<String> {
    if import_supports_transaction(db) {
        None
    } else {
        Some(format!(
            "{db:?} 不支持事务：truncate 模式会先清空目标表再逐批 INSERT,若中途失败将无法回滚"
        ))
    }
}

/// 解析后的导入文件：列名 + 行（受 preview_limit 截断）+ 文件总行数。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub total_rows: usize,
}

/// 一批 INSERT 语句及其覆盖的行数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

/// 源列 → 目标列的映射（目标为空字符串表示跳过该列，不写入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
}

/// 导入文件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFileKind {
    Csv,
    Tsv,
    Json,
}

impl ImportFileKind {
    pub fn label(self) -> &'static str {
        match self {
            ImportFileKind::Csv => "csv",
            ImportFileKind::Tsv => "tsv",
            ImportFileKind::Json => "json",
        }
    }
}

/// 按扩展名识别文件类型。Xlsx/Xls 依赖成本较高（需 calamine），本阶段不支持,
/// 显式报错让前端提示「先转成 CSV/JSON」（后续可补 calamine 解析）。
pub fn import_file_kind(path: &str) -> Result<ImportFileKind, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        Ok(ImportFileKind::Csv)
    } else if lower.ends_with(".tsv") {
        Ok(ImportFileKind::Tsv)
    } else if lower.ends_with(".json") {
        Ok(ImportFileKind::Json)
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") {
        Err("Excel 导入暂未支持，请先另存为 CSV 或 JSON".to_string())
    } else {
        Err("不支持的导入文件类型".to_string())
    }
}

/// 空表头回落为 column_N（1 起），保留其余表头原样（去首尾空白）。
pub fn normalize_header(value: &str, index: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        format!("column_{}", index + 1)
    } else {
        trimmed.to_string()
    }
}

/// 单个 CSV 单元格 → JSON 值：空串视为 NULL，其余按字符串原样保留（类型转换在
/// 生成 INSERT 时由 value_to_sql 处理，导入只忠实搬运文本）。
pub fn csv_value(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_string())
    }
}

/// 解析带分隔符的文本（CSV/TSV 共用）。flexible 容忍行列数不齐。
pub fn parse_delimited_bytes(bytes: &[u8], delimiter: u8, preview_limit: usize) -> Result<ParsedImportFile, String> {
    let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).flexible(true).from_reader(bytes);
    let columns = reader
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .enumerate()
        .map(|(index, header)| normalize_header(header, index))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("导入文件没有列".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(record.get(index).map(csv_value).unwrap_or(Value::Null));
        }
        rows.push(row);
    }

    Ok(ParsedImportFile { columns, rows, total_rows })
}

pub fn parse_csv_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_delimited_bytes(bytes, b',', preview_limit)
}

/// 解析 JSON：对象数组（按并集取列）或二维数组（列名 column_N）。单个对象视为单行。
pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let items = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => return Err("JSON 导入必须是对象或数组".to_string()),
    };
    if items.is_empty() {
        return Err("导入文件没有数据行".to_string());
    }

    if items.iter().all(|item| item.is_object()) {
        let mut columns = Vec::new();
        for item in &items {
            if let Some(obj) = item.as_object() {
                for key in obj.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            return Err("导入文件没有列".to_string());
        }
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let obj = item.as_object().expect("checked object JSON row");
                columns.iter().map(|column| obj.get(column).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    if items.iter().all(|item| item.is_array()) {
        let max_cols = items.iter().filter_map(|item| item.as_array().map(|row| row.len())).max().unwrap_or(0);
        if max_cols == 0 {
            return Err("导入文件没有列".to_string());
        }
        let columns = (0..max_cols).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let arr = item.as_array().expect("checked array JSON row");
                (0..max_cols).map(|index| arr.get(index).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    Err("JSON 行必须全为对象或全为数组".to_string())
}

/// 按文件类型解析字节（CSV/TSV/JSON）。文件读取在 commands.rs 接线。
pub fn parse_import_bytes(kind: ImportFileKind, bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    match kind {
        ImportFileKind::Csv => parse_csv_bytes(bytes, preview_limit),
        ImportFileKind::Tsv => parse_delimited_bytes(bytes, b'\t', preview_limit),
        ImportFileKind::Json => parse_json_bytes(bytes, preview_limit),
    }
}

/// 校验并解析列映射 → (源列下标, 目标列名) 列表。
///
/// - 目标列为空串的映射视为「跳过」，直接忽略（对齐 dbx 前端 IMPORT_SKIP_TARGET）。
/// - 源列必须存在于解析结果中,否则报错。
/// - 同一目标列被映射多次报错。
/// - 全部跳过（无有效映射）报错。
pub fn mapping_indexes(
    data: &ParsedImportFile,
    mappings: &[ImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        if mapping.target_column.trim().is_empty() {
            continue; // 跳过未映射的源列
        }
        let source_index = data
            .columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("源列不存在: {}", mapping.source_column))?;
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!("目标列被重复映射: {}", mapping.target_column));
        }
        mapped.push((source_index, mapping.target_column.clone()));
    }
    if mapped.is_empty() {
        return Err("没有可导入的列映射".to_string());
    }
    Ok(mapped)
}

/// 由解析结果 + 列映射生成批量 INSERT 语句。
///
/// 复用 export::build_insert_statements 的拼装风格（quote_ident + value_to_sql +
/// qualified_table），按 batch_size 分批，每批一条多值 VALUES,语句以分号结尾。
#[allow(clippy::too_many_arguments)]
pub fn build_import_insert_batches(
    db: DatabaseType,
    has_schemas: bool,
    schema: Option<&str>,
    table: &str,
    data: &ParsedImportFile,
    mappings: &[ImportColumnMapping],
    batch_size: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    let mapped = mapping_indexes(data, mappings)?;
    let columns = mapped.iter().map(|(_, target)| target.clone()).collect::<Vec<_>>();
    let tbl = qualified_table(db, has_schemas, schema, table);
    let cols = columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
    let batch = batch_size.max(1);

    let batches = data
        .rows
        .chunks(batch)
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|row| {
                    let cells = mapped
                        .iter()
                        .map(|(source_index, _)| {
                            value_to_sql(row.get(*source_index).unwrap_or(&Value::Null))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({cells})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            ImportSqlBatch {
                sql: format!("INSERT INTO {tbl} ({cols}) VALUES {values};"),
                row_count: chunk.len(),
            }
        })
        .collect::<Vec<_>>();

    Ok(batches)
}

/// 清空目标表的语句（Truncate 模式预先执行）。SQLite 无 TRUNCATE，用 DELETE。
pub fn truncate_sql(db: DatabaseType, has_schemas: bool, schema: Option<&str>, table: &str) -> String {
    let tbl = qualified_table(db, has_schemas, schema, table);
    match db {
        DatabaseType::Sqlite => format!("DELETE FROM {tbl}"),
        _ => format!("TRUNCATE TABLE {tbl}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_file_kind_by_extension() {
        assert_eq!(import_file_kind("a/b/data.csv").unwrap(), ImportFileKind::Csv);
        assert_eq!(import_file_kind("DATA.TSV").unwrap(), ImportFileKind::Tsv);
        assert_eq!(import_file_kind("x.json").unwrap(), ImportFileKind::Json);
        assert!(import_file_kind("x.xlsx").is_err());
        assert!(import_file_kind("x.txt").is_err());
    }

    #[test]
    fn parses_csv_headers_and_preview_rows() {
        let parsed = parse_csv_bytes(b"id,name,active\n1,Ada,true\n2,,false\n", 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![json!("1"), json!("Ada"), json!("true")]);
        // 空字段 → NULL
        assert_eq!(parsed.rows[1], vec![json!("2"), Value::Null, json!("false")]);
    }

    #[test]
    fn preview_limit_truncates_rows_but_counts_total() {
        let parsed = parse_csv_bytes(b"id\n1\n2\n3\n4\n", 2).unwrap();
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.total_rows, 4);
    }

    #[test]
    fn normalizes_empty_header_to_column_n() {
        let parsed = parse_csv_bytes(b"id,,c\n1,2,3\n", 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "column_2", "c"]);
    }

    #[test]
    fn parses_tsv_with_tab_delimiter() {
        let parsed = parse_delimited_bytes(b"id\tname\n1\tAda\n", b'\t', 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.rows[0], vec![json!("1"), json!("Ada")]);
    }

    #[test]
    fn parses_json_array_of_objects_with_union_columns() {
        let parsed = parse_json_bytes(br#"[{"id":1,"name":"Ada"},{"id":2,"active":true}]"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![json!(1), json!("Ada"), Value::Null]);
        assert_eq!(parsed.rows[1], vec![json!(2), Value::Null, json!(true)]);
    }

    #[test]
    fn parses_json_array_of_arrays_with_indexed_columns() {
        let parsed = parse_json_bytes(br#"[[1,"Ada"],[2,"Linus"]]"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.rows[1], vec![json!(2), json!("Linus")]);
    }

    #[test]
    fn json_single_object_is_one_row() {
        let parsed = parse_json_bytes(br#"{"id":7}"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id"]);
        assert_eq!(parsed.total_rows, 1);
    }

    #[test]
    fn empty_json_array_errors() {
        assert!(parse_json_bytes(b"[]", 10).is_err());
    }

    #[test]
    fn mapping_skips_empty_targets_and_reorders() {
        let data = ParsedImportFile {
            columns: vec!["id".into(), "name".into(), "junk".into()],
            rows: vec![],
            total_rows: 0,
        };
        let mappings = vec![
            ImportColumnMapping { source_column: "id".into(), target_column: "user_id".into() },
            ImportColumnMapping { source_column: "junk".into(), target_column: "".into() },
            ImportColumnMapping { source_column: "name".into(), target_column: "display_name".into() },
        ];
        let mapped = mapping_indexes(&data, &mappings).unwrap();
        assert_eq!(mapped, vec![(0, "user_id".to_string()), (1, "display_name".to_string())]);
    }

    #[test]
    fn mapping_rejects_unknown_source_and_duplicate_target() {
        let data = ParsedImportFile { columns: vec!["a".into(), "b".into()], rows: vec![], total_rows: 0 };
        assert!(mapping_indexes(
            &data,
            &[ImportColumnMapping { source_column: "nope".into(), target_column: "x".into() }]
        )
        .is_err());
        assert!(mapping_indexes(
            &data,
            &[
                ImportColumnMapping { source_column: "a".into(), target_column: "dup".into() },
                ImportColumnMapping { source_column: "b".into(), target_column: "dup".into() },
            ]
        )
        .is_err());
    }

    #[test]
    fn mapping_all_skipped_errors() {
        let data = ParsedImportFile { columns: vec!["a".into()], rows: vec![], total_rows: 0 };
        assert!(mapping_indexes(
            &data,
            &[ImportColumnMapping { source_column: "a".into(), target_column: "".into() }]
        )
        .is_err());
    }

    #[test]
    fn builds_batched_inserts_from_mapped_columns() {
        let data = ParsedImportFile {
            columns: vec!["id".into(), "name".into(), "ignored".into()],
            rows: vec![
                vec![json!("1"), json!("Ada"), json!("x")],
                vec![json!("2"), json!("O'Hara"), json!("y")],
                vec![json!("3"), Value::Null, json!("z")],
            ],
            total_rows: 3,
        };
        let mappings = vec![
            ImportColumnMapping { source_column: "id".into(), target_column: "user_id".into() },
            ImportColumnMapping { source_column: "name".into(), target_column: "display_name".into() },
        ];
        let batches = build_import_insert_batches(
            DatabaseType::Postgres,
            true,
            Some("public"),
            "users",
            &data,
            &mappings,
            2,
        )
        .unwrap();
        assert_eq!(
            batches,
            vec![
                ImportSqlBatch {
                    sql: r#"INSERT INTO "public"."users" ("user_id", "display_name") VALUES ('1', 'Ada'), ('2', 'O''Hara');"#.to_string(),
                    row_count: 2,
                },
                ImportSqlBatch {
                    sql: r#"INSERT INTO "public"."users" ("user_id", "display_name") VALUES ('3', NULL);"#.to_string(),
                    row_count: 1,
                },
            ]
        );
    }

    #[test]
    fn mysql_inserts_use_backtick_quoting() {
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")]],
            total_rows: 1,
        };
        let mappings = vec![ImportColumnMapping { source_column: "id".into(), target_column: "id".into() }];
        let batches =
            build_import_insert_batches(DatabaseType::Mysql, false, None, "t", &data, &mappings, 500).unwrap();
        assert_eq!(batches[0].sql, "INSERT INTO `t` (`id`) VALUES ('1');");
    }

    #[test]
    fn zero_batch_size_falls_back_to_one_per_statement() {
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")], vec![json!("2")]],
            total_rows: 2,
        };
        let mappings = vec![ImportColumnMapping { source_column: "id".into(), target_column: "id".into() }];
        let batches =
            build_import_insert_batches(DatabaseType::Sqlite, false, None, "t", &data, &mappings, 0).unwrap();
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn truncate_sql_uses_delete_on_sqlite() {
        assert_eq!(truncate_sql(DatabaseType::Sqlite, false, None, "t"), "DELETE FROM \"t\"");
        assert_eq!(truncate_sql(DatabaseType::Mysql, false, None, "t"), "TRUNCATE TABLE `t`");
    }

    #[test]
    fn target_column_with_injection_chars_is_escaped() {
        // 防注入回归：目标列名含反引号/双引号/分号时，quote_ident 必须转义，
        // 生成的 SQL 不能因此被截断或注入额外语句。
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")]],
            total_rows: 1,
        };
        // 双引号方言（Postgres）：目标列含双引号 + 分号注入尝试。
        let pg_mappings = vec![ImportColumnMapping {
            source_column: "id".into(),
            target_column: r#"evil"; DROP TABLE users;--"#.into(),
        }];
        let pg = build_import_insert_batches(
            DatabaseType::Postgres, false, None, "t", &data, &pg_mappings, 500,
        )
        .unwrap();
        // 双引号被加倍转义为 ""，整个列名仍被包在一对引号内 → 不会逃逸出标识符。
        assert_eq!(
            pg[0].sql,
            r#"INSERT INTO "t" ("evil""; DROP TABLE users;--") VALUES ('1');"#
        );

        // 反引号方言（MySQL）：目标列含反引号。
        let my_mappings = vec![ImportColumnMapping {
            source_column: "id".into(),
            target_column: "ev`il".into(),
        }];
        let my = build_import_insert_batches(
            DatabaseType::Mysql, false, None, "t", &data, &my_mappings, 500,
        )
        .unwrap();
        assert_eq!(my[0].sql, "INSERT INTO `t` (`ev``il`) VALUES ('1');");
    }

    #[test]
    fn import_size_guard_rejects_oversize_files() {
        // 超过上限的文件应被拒绝（避免一次性把整文件 + 展开行同时驻留堆）。
        assert!(check_import_size(MAX_IMPORT_BYTES).is_ok());
        assert!(check_import_size(MAX_IMPORT_BYTES + 1).is_err());
        assert!(check_import_size(0).is_ok());
    }

    #[test]
    fn transaction_keywords_match_dialect() {
        // 支持事务的引擎用 BEGIN/COMMIT/ROLLBACK 包裹 truncate + INSERT。
        let (begin, commit, rollback) = transaction_keywords(DatabaseType::Sqlserver);
        assert_eq!((begin, commit, rollback), ("BEGIN TRANSACTION", "COMMIT", "ROLLBACK"));
        let (begin, _, _) = transaction_keywords(DatabaseType::Postgres);
        assert_eq!(begin, "BEGIN");
    }

    #[test]
    fn truncate_no_rollback_warning_only_for_non_transactional() {
        // 不支持事务的引擎（ClickHouse 等）在 truncate 模式下必须给出「无回滚」告警。
        assert!(truncate_no_rollback_warning(DatabaseType::Clickhouse).is_some());
        assert!(truncate_no_rollback_warning(DatabaseType::Redis).is_some());
        // 支持事务的引擎不需要告警（会被事务包裹）。
        assert!(truncate_no_rollback_warning(DatabaseType::Postgres).is_none());
        assert!(truncate_no_rollback_warning(DatabaseType::Sqlite).is_none());
    }
}
