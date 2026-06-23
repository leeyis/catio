//! 跨库/跨表数据迁移纯函数（源表 → 列映射 → 按模式生成目标写语句）。
//!
//! 对齐 dbx crates/dbx-core/src/transfer.rs 的「模式（Append/Overwrite/Upsert）+ 列映射 +
//! 按引擎生成 INSERT / Upsert 语句」语义,但复用 Catio 既有方言助手
//! `dialect::{quote_ident, qualified_table}` 与 `dml::value_to_sql`,与 export.rs /
//! table_import.rs 的标识符引用 + 字面量转义保持一致。
//!
//! 真实的「逐批从源读 → 往目标写」I/O 编排在 commands.rs 接线（照搬 db_export_database
//! 的分页取数 + db_import_table 的逐批执行），本模块只做可单测的纯逻辑:
//!   - 列映射解析与校验（含 Upsert 键合法性）
//!   - 各引擎按模式的目标写 SQL 生成
//! 真实双库迁移需真机验证（见 commands 接线与 notes）。

use std::collections::HashSet;

use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, qualified_table};
use crate::db::dml::value_to_sql;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 迁移逐批从源读取的默认行数（对齐 export DEFAULT_INSERT_BATCH_SIZE）。
pub const DEFAULT_TRANSFER_BATCH_SIZE: usize = 1000;

/// 迁移写入模式。
/// - Append:  仅向目标表追加（INSERT）。
/// - Overwrite: 先清空目标表（TRUNCATE/DELETE）再追加。
/// - Upsert:  按 Upsert 键做「存在则更新、否则插入」（各引擎用各自原生语法）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    #[default]
    Append,
    Overwrite,
    Upsert,
}

/// 源列 → 目标列映射（目标为空串表示跳过该源列，不迁移）。
/// 与 table_import::ImportColumnMapping 同构,但语义是「源表列名 → 目标表列名」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferColumnMapping {
    pub source_column: String,
    pub target_column: String,
}

/// 校验并解析列映射 → (源列下标, 目标列名) 列表。
///
/// - 目标列为空串的映射视为「跳过」，直接忽略。
/// - 源列必须存在于源表列名中,否则报错。
/// - 同一目标列被映射多次报错。
/// - 全部跳过（无有效映射）报错。
///
/// 与 table_import::mapping_indexes 同语义,但源是「源表列名数组」而非解析后的文件。
pub fn resolve_transfer_mapping(
    source_columns: &[String],
    mappings: &[TransferColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        if mapping.target_column.trim().is_empty() {
            continue; // 跳过未映射的源列
        }
        let source_index = source_columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("源列不存在: {}", mapping.source_column))?;
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!("目标列被重复映射: {}", mapping.target_column));
        }
        mapped.push((source_index, mapping.target_column.clone()));
    }
    if mapped.is_empty() {
        return Err("没有可迁移的列映射".to_string());
    }
    Ok(mapped)
}

/// 校验 Upsert 键：必须非空,且每个键都出现在已映射的目标列里（否则冲突判定无意义）。
pub fn validate_upsert_keys(target_columns: &[String], upsert_keys: &[String]) -> Result<(), String> {
    if upsert_keys.is_empty() {
        return Err("Upsert 模式必须指定至少一个键列".to_string());
    }
    for key in upsert_keys {
        if !target_columns.iter().any(|c| c == key) {
            return Err(format!("Upsert 键不在目标列中: {key}"));
        }
    }
    Ok(())
}

/// 迁移执行前的纯逻辑前置校验（commands 层在做任何写入/清表前调用,失败即拒绝执行）:
/// - Upsert: 目标引擎必须原生支持 upsert（否则显式报错,不静默退化为 INSERT）,且 upsert_keys
///   必须合法（非空且都落在已映射目标列里）。
/// - Overwrite: 这是**破坏性**操作（会清空目标表）,必须由调用方显式传入 `allow_destructive=true`
///   表示已二次确认;否则拒绝执行,杜绝误点/恶意 renderer 直接触发清表（codex 阻断项）。
///
/// `target_columns` 为已映射（目标非空）的目标列名。
pub fn check_transfer_preconditions(
    mode: TransferMode,
    db: DatabaseType,
    target_columns: &[String],
    upsert_keys: &[String],
    allow_destructive: bool,
) -> Result<(), String> {
    match mode {
        TransferMode::Append => Ok(()),
        TransferMode::Overwrite => {
            if allow_destructive {
                Ok(())
            } else {
                Err("Overwrite 是破坏性操作（会清空目标表）,需显式确认后才能执行".to_string())
            }
        }
        TransferMode::Upsert => {
            ensure_upsert_supported(db)?;
            validate_upsert_keys(target_columns, upsert_keys)
        }
    }
}

/// Overwrite 模式的前置清表语句（迁移数据前执行一次）。SQLite 无 TRUNCATE，用 DELETE。
/// 复用 table_import::truncate_sql 的方言判定,保持一致。
pub fn build_overwrite_pre_sql(db: DatabaseType, has_schemas: bool, schema: Option<&str>, table: &str) -> String {
    crate::db::table_import::truncate_sql(db, has_schemas, schema, table)
}

/// 一批行 → 多值 VALUES 片段 `('a', 1), ('b', 2)`（按映射后的源列下标取值）。
fn value_rows(rows: &[Vec<Value>], source_indexes: &[usize]) -> String {
    rows.iter()
        .map(|row| {
            let cells = source_indexes
                .iter()
                .map(|&i| value_to_sql(row.get(i).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("({cells})")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// 由源数据 + 映射生成「一批」目标写 SQL（不含分号,与 export 风格一致；调用方逐批执行）。
///
/// - Append / Overwrite: 多值 INSERT（Overwrite 的清表由 build_overwrite_pre_sql 单独前置）。
/// - Upsert: 各引擎原生 upsert（PG/SQLite/DuckDB→ON CONFLICT；MySQL→ON DUPLICATE KEY；
///   SQLServer→MERGE）。调用方必须先用 `ensure_upsert_supported` 拒绝不支持的引擎;本函数对
///   未知引擎的 `_ => base_insert` 仅是不可达的防御性兜底（命令层已先行拒绝）。
///
/// MySQL 语义警告：`ON DUPLICATE KEY UPDATE` 由 MySQL 协议对**任意** UNIQUE/PRIMARY 冲突触发,
/// 无法限定为所选 `upsert_keys`——若目标表在非键列（如 email）上另有 UNIQUE 约束,该列冲突时同样
/// 会被覆盖。这是 MySQL 引擎层行为（dbx 亦如此),已由 `mysql_upsert_documents_any_unique_conflict_semantics`
/// 固化;若需严格按所选键 upsert,请确保目标表仅在所选键上存在唯一约束。
///
/// `source_columns` 为源表列名（用于解析映射）；`rows` 的每行与 source_columns 对齐。
/// 空映射 / 空行返回空串（无可写内容）。
#[allow(clippy::too_many_arguments)]
pub fn build_transfer_write_sql(
    mode: TransferMode,
    db: DatabaseType,
    has_schemas: bool,
    schema: Option<&str>,
    table: &str,
    mapped: &[(usize, String)],
    rows: &[Vec<Value>],
    upsert_keys: &[String],
) -> String {
    if mapped.is_empty() || rows.is_empty() {
        return String::new();
    }
    let tbl = qualified_table(db, has_schemas, schema, table);
    let target_columns = mapped.iter().map(|(_, t)| t.clone()).collect::<Vec<_>>();
    let source_indexes = mapped.iter().map(|(i, _)| *i).collect::<Vec<_>>();
    let col_list = target_columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
    let values = value_rows(rows, &source_indexes);

    let base_insert = format!("INSERT INTO {tbl} ({col_list}) VALUES {values}");

    if mode != TransferMode::Upsert {
        return base_insert;
    }

    // 非键列（用于 UPDATE SET）。
    let non_key: Vec<&String> = target_columns.iter().filter(|c| !upsert_keys.contains(c)).collect();

    match db {
        DatabaseType::Postgres | DatabaseType::Sqlite | DatabaseType::Duckdb => {
            let conflict = upsert_keys.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
            if non_key.is_empty() {
                format!("{base_insert} ON CONFLICT ({conflict}) DO NOTHING")
            } else {
                let set = non_key
                    .iter()
                    .map(|c| {
                        let q = quote_ident(db, c);
                        format!("{q} = EXCLUDED.{q}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{base_insert} ON CONFLICT ({conflict}) DO UPDATE SET {set}")
            }
        }
        DatabaseType::Mysql => {
            if non_key.is_empty() {
                // 无可更新列：MySQL 需要一个 no-op set 才能让 ON DUPLICATE KEY 生效。
                let first = quote_ident(db, &upsert_keys[0]);
                format!("{base_insert} ON DUPLICATE KEY UPDATE {first} = {first}")
            } else {
                let set = non_key
                    .iter()
                    .map(|c| {
                        let q = quote_ident(db, c);
                        format!("{q} = VALUES({q})")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{base_insert} ON DUPLICATE KEY UPDATE {set}")
            }
        }
        DatabaseType::Sqlserver => {
            let src_cols = target_columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
            let on = upsert_keys
                .iter()
                .map(|c| {
                    let q = quote_ident(db, c);
                    format!("target.{q} = src.{q}")
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            let mut sql = format!(
                "MERGE INTO {tbl} AS target USING (VALUES {values}) AS src ({src_cols}) ON {on}"
            );
            if !non_key.is_empty() {
                let set = non_key
                    .iter()
                    .map(|c| {
                        let q = quote_ident(db, c);
                        format!("target.{q} = src.{q}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                sql.push_str(&format!(" WHEN MATCHED THEN UPDATE SET {set}"));
            }
            let insert_cols = target_columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
            let insert_vals =
                target_columns.iter().map(|c| format!("src.{}", quote_ident(db, c))).collect::<Vec<_>>().join(", ");
            sql.push_str(&format!(" WHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals});"));
            sql
        }
        // 其余引擎无统一原生 upsert（ClickHouse/Rqlite/JDBC 等）→ 退化为普通 INSERT。
        _ => base_insert,
    }
}

/// Upsert 前置校验：不支持原生 upsert 的引擎（ClickHouse/Rqlite/JDBC 等）必须**显式拒绝**,
/// 不得静默退化为普通 INSERT——否则用户以为在 upsert,实际产生重复行或触发唯一键失败（codex 阻断项）。
/// commands 层在 Upsert 模式下先调用本函数,失败即返回错误、不执行任何写入。
pub fn ensure_upsert_supported(db: DatabaseType) -> Result<(), String> {
    if supports_native_upsert(db) {
        Ok(())
    } else {
        Err(format!("目标引擎 {db:?} 不支持原生 Upsert,请改用 Append 或 Overwrite 模式"))
    }
}

/// 该引擎是否支持原生 Upsert（供 UI / commands 决定是否暴露 Upsert 模式或给出退化提示）。
pub fn supports_native_upsert(db: DatabaseType) -> bool {
    matches!(
        db,
        DatabaseType::Postgres
            | DatabaseType::Sqlite
            | DatabaseType::Duckdb
            | DatabaseType::Mysql
            | DatabaseType::Sqlserver
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn map(pairs: &[(&str, &str)]) -> Vec<TransferColumnMapping> {
        pairs
            .iter()
            .map(|(s, t)| TransferColumnMapping { source_column: s.to_string(), target_column: t.to_string() })
            .collect()
    }

    #[test]
    fn mode_deserializes_camel_case() {
        assert_eq!(serde_json::from_str::<TransferMode>("\"append\"").unwrap(), TransferMode::Append);
        assert_eq!(serde_json::from_str::<TransferMode>("\"overwrite\"").unwrap(), TransferMode::Overwrite);
        assert_eq!(serde_json::from_str::<TransferMode>("\"upsert\"").unwrap(), TransferMode::Upsert);
        assert_eq!(TransferMode::default(), TransferMode::Append);
    }

    #[test]
    fn mapping_skips_empty_targets_and_reorders() {
        let source = cols(&["id", "name", "junk"]);
        let mappings = map(&[("id", "user_id"), ("junk", ""), ("name", "display_name")]);
        let mapped = resolve_transfer_mapping(&source, &mappings).unwrap();
        assert_eq!(mapped, vec![(0, "user_id".to_string()), (1, "display_name".to_string())]);
    }

    #[test]
    fn mapping_rejects_unknown_source_and_duplicate_target() {
        let source = cols(&["a", "b"]);
        assert!(resolve_transfer_mapping(&source, &map(&[("nope", "x")])).is_err());
        assert!(resolve_transfer_mapping(&source, &map(&[("a", "dup"), ("b", "dup")])).is_err());
    }

    #[test]
    fn mapping_all_skipped_errors() {
        let source = cols(&["a"]);
        assert!(resolve_transfer_mapping(&source, &map(&[("a", "")])).is_err());
    }

    #[test]
    fn validate_upsert_keys_rejects_empty_and_unmapped() {
        let targets = cols(&["id", "name"]);
        assert!(validate_upsert_keys(&targets, &[]).is_err());
        assert!(validate_upsert_keys(&targets, &cols(&["missing"])).is_err());
        assert!(validate_upsert_keys(&targets, &cols(&["id"])).is_ok());
    }

    #[test]
    fn append_builds_multivalue_insert_pg() {
        let source = cols(&["id", "name", "junk"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "user_id"), ("name", "display_name")])).unwrap();
        let rows = vec![
            vec![json!(1), json!("Ada"), json!("x")],
            vec![json!(2), json!("O'Hara"), json!("y")],
        ];
        let sql = build_transfer_write_sql(
            TransferMode::Append, DatabaseType::Postgres, true, Some("public"), "users", &mapped, &rows, &[],
        );
        assert_eq!(
            sql,
            r#"INSERT INTO "public"."users" ("user_id", "display_name") VALUES (1, 'Ada'), (2, 'O''Hara')"#
        );
    }

    #[test]
    fn overwrite_uses_same_insert_plus_pre_truncate() {
        // Overwrite 的写语句与 Append 相同；清表由 build_overwrite_pre_sql 单独前置。
        let source = cols(&["id"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id")])).unwrap();
        let rows = vec![vec![json!(1)]];
        let sql = build_transfer_write_sql(
            TransferMode::Overwrite, DatabaseType::Mysql, false, None, "t", &mapped, &rows, &[],
        );
        assert_eq!(sql, "INSERT INTO `t` (`id`) VALUES (1)");
        assert_eq!(build_overwrite_pre_sql(DatabaseType::Mysql, false, None, "t"), "TRUNCATE TABLE `t`");
        assert_eq!(build_overwrite_pre_sql(DatabaseType::Sqlite, false, None, "t"), "DELETE FROM \"t\"");
    }

    #[test]
    fn upsert_pg_uses_on_conflict_do_update() {
        let source = cols(&["id", "name"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id"), ("name", "name")])).unwrap();
        let rows = vec![vec![json!(1), json!("Ada")]];
        let sql = build_transfer_write_sql(
            TransferMode::Upsert, DatabaseType::Postgres, false, None, "t", &mapped, &rows, &cols(&["id"]),
        );
        assert_eq!(
            sql,
            r#"INSERT INTO "t" ("id", "name") VALUES (1, 'Ada') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name""#
        );
    }

    #[test]
    fn upsert_pg_all_keys_does_nothing() {
        let source = cols(&["id"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id")])).unwrap();
        let rows = vec![vec![json!(1)]];
        let sql = build_transfer_write_sql(
            TransferMode::Upsert, DatabaseType::Postgres, false, None, "t", &mapped, &rows, &cols(&["id"]),
        );
        assert_eq!(sql, r#"INSERT INTO "t" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING"#);
    }

    #[test]
    fn upsert_mysql_uses_on_duplicate_key_update() {
        let source = cols(&["id", "name"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id"), ("name", "name")])).unwrap();
        let rows = vec![vec![json!(1), json!("Ada")]];
        let sql = build_transfer_write_sql(
            TransferMode::Upsert, DatabaseType::Mysql, false, None, "t", &mapped, &rows, &cols(&["id"]),
        );
        assert_eq!(
            sql,
            "INSERT INTO `t` (`id`, `name`) VALUES (1, 'Ada') ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)"
        );
    }

    #[test]
    fn upsert_sqlserver_uses_merge() {
        let source = cols(&["id", "name"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id"), ("name", "name")])).unwrap();
        let rows = vec![vec![json!(1), json!("Ada")]];
        let sql = build_transfer_write_sql(
            TransferMode::Upsert, DatabaseType::Sqlserver, true, Some("dbo"), "t", &mapped, &rows, &cols(&["id"]),
        );
        assert_eq!(
            sql,
            "MERGE INTO [dbo].[t] AS target USING (VALUES (1, 'Ada')) AS src ([id], [name]) ON target.[id] = src.[id] \
WHEN MATCHED THEN UPDATE SET target.[name] = src.[name] \
WHEN NOT MATCHED THEN INSERT ([id], [name]) VALUES (src.[id], src.[name]);"
        );
    }

    #[test]
    fn preconditions_append_always_ok() {
        assert!(check_transfer_preconditions(
            TransferMode::Append, DatabaseType::Clickhouse, &cols(&["id"]), &[], false,
        ).is_ok());
    }

    #[test]
    fn preconditions_overwrite_requires_destructive_confirmation() {
        // 未确认 → 拒绝（不得清表）；已确认 → 放行（codex 阻断项: 破坏性操作必须显式确认）。
        assert!(check_transfer_preconditions(
            TransferMode::Overwrite, DatabaseType::Postgres, &cols(&["id"]), &[], false,
        ).is_err());
        assert!(check_transfer_preconditions(
            TransferMode::Overwrite, DatabaseType::Postgres, &cols(&["id"]), &[], true,
        ).is_ok());
    }

    #[test]
    fn preconditions_upsert_rejects_unsupported_engine_and_bad_keys() {
        // 不支持 upsert 的引擎 → 拒绝（即便 destructive 标志为真也无关）。
        assert!(check_transfer_preconditions(
            TransferMode::Upsert, DatabaseType::Clickhouse, &cols(&["id"]), &cols(&["id"]), false,
        ).is_err());
        // 支持的引擎但键非法 → 拒绝。
        assert!(check_transfer_preconditions(
            TransferMode::Upsert, DatabaseType::Postgres, &cols(&["id", "name"]), &[], false,
        ).is_err());
        assert!(check_transfer_preconditions(
            TransferMode::Upsert, DatabaseType::Postgres, &cols(&["id", "name"]), &cols(&["missing"]), false,
        ).is_err());
        // 支持的引擎 + 合法键 → 放行。
        assert!(check_transfer_preconditions(
            TransferMode::Upsert, DatabaseType::Postgres, &cols(&["id", "name"]), &cols(&["id"]), false,
        ).is_ok());
    }

    #[test]
    fn supports_native_upsert_classifies_engines() {
        assert!(!supports_native_upsert(DatabaseType::Clickhouse));
        assert!(supports_native_upsert(DatabaseType::Postgres));
    }

    #[test]
    fn ensure_upsert_supported_rejects_non_native_engines() {
        // 不支持原生 upsert 的引擎必须显式报错,而非静默退化为普通 INSERT（codex 阻断项）。
        assert!(ensure_upsert_supported(DatabaseType::Clickhouse).is_err());
        assert!(ensure_upsert_supported(DatabaseType::Rqlite).is_err());
        // 原生支持的引擎放行。
        assert!(ensure_upsert_supported(DatabaseType::Postgres).is_ok());
        assert!(ensure_upsert_supported(DatabaseType::Mysql).is_ok());
        assert!(ensure_upsert_supported(DatabaseType::Sqlite).is_ok());
        assert!(ensure_upsert_supported(DatabaseType::Duckdb).is_ok());
        assert!(ensure_upsert_supported(DatabaseType::Sqlserver).is_ok());
    }

    #[test]
    fn mysql_upsert_documents_any_unique_conflict_semantics() {
        // MySQL ON DUPLICATE KEY UPDATE 会对任意 UNIQUE/PRIMARY 冲突触发更新,无法限定为
        // 所选 upsert_keys。这是 MySQL 协议层语义（dbx 同样如此）——本测试固化该已知行为:
        // 生成的 SET 子句只更新「非键列」,但触发条件由引擎决定,无法只针对 id。
        let source = cols(&["id", "email", "name"]);
        let mapped =
            resolve_transfer_mapping(&source, &map(&[("id", "id"), ("email", "email"), ("name", "name")])).unwrap();
        let rows = vec![vec![json!(1), json!("a@b.c"), json!("Ada")]];
        let sql = build_transfer_write_sql(
            TransferMode::Upsert, DatabaseType::Mysql, false, None, "t", &mapped, &rows, &cols(&["id"]),
        );
        // 非键列 email/name 都会被 VALUES() 覆盖——若 email 上另有 UNIQUE,email 冲突时同样触发更新。
        assert_eq!(
            sql,
            "INSERT INTO `t` (`id`, `email`, `name`) VALUES (1, 'a@b.c', 'Ada') \
ON DUPLICATE KEY UPDATE `email` = VALUES(`email`), `name` = VALUES(`name`)"
        );
    }

    #[test]
    fn empty_rows_or_mapping_yields_empty_sql() {
        let source = cols(&["id"]);
        let mapped = resolve_transfer_mapping(&source, &map(&[("id", "id")])).unwrap();
        assert_eq!(
            build_transfer_write_sql(TransferMode::Append, DatabaseType::Postgres, false, None, "t", &mapped, &[], &[]),
            ""
        );
        assert_eq!(
            build_transfer_write_sql(
                TransferMode::Append, DatabaseType::Postgres, false, None, "t", &[], &[vec![json!(1)]], &[],
            ),
            ""
        );
    }

    #[test]
    fn target_column_injection_is_escaped() {
        // 防注入：目标列名含双引号/分号时仍被 quote_ident 加倍转义,不逃逸出标识符。
        let source = cols(&["id"]);
        let mapped =
            resolve_transfer_mapping(&source, &map(&[("id", r#"evil"; DROP TABLE x;--"#)])).unwrap();
        let rows = vec![vec![json!(1)]];
        let sql = build_transfer_write_sql(
            TransferMode::Append, DatabaseType::Postgres, false, None, "t", &mapped, &rows, &[],
        );
        assert_eq!(sql, r#"INSERT INTO "t" ("evil""; DROP TABLE x;--") VALUES (1)"#);
    }
}
