//! 数据库对象管理 SQL 生成（纯函数，易 TDD）。
//!
//! 按 DatabaseType/方言生成 DROP TABLE|VIEW|PROCEDURE|FUNCTION、RENAME、TRUNCATE
//! TABLE、复制表结构 的 SQL。参考 dbx crates/dbx-core/src/db_admin_sql.rs，按
//! Catio 现有的较小引擎集（Postgres/Mysql/Sqlite/Duckdb/Sqlserver/Clickhouse/
//! Rqlite/Mongodb/Elasticsearch/Redis/Jdbc）裁剪 + 适配。
//!
//! 标识符引用复用 dialect::quote_ident（PG/SQLite/… 用 "x"，MySQL 用 `x`，
//! SQLServer 用 [x]），schema 限定复用 dialect::qualified_table。

use serde::{Deserialize, Serialize};

use crate::db::DatabaseType;
use crate::db::capabilities::capabilities_for;
use crate::db::dialect::{qualified_table, quote_ident};

/// 可被删除/重命名的顶层数据库对象类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatabaseObjectType {
    Table,
    View,
    Procedure,
    Function,
}

/// DROP 对象的入参。schema 仅在 schema-aware 引擎且非空时参与限定。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropObjectSqlOptions {
    pub database_type: DatabaseType,
    pub object_type: DatabaseObjectType,
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
}

/// RENAME 对象的入参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameObjectSqlOptions {
    pub database_type: DatabaseType,
    pub object_type: DatabaseObjectType,
    #[serde(default)]
    pub schema: Option<String>,
    pub old_name: String,
    pub new_name: String,
}

/// TRUNCATE / 清空表的入参（也用于复制表结构的“源/目标”载体之外的简单表操作）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableAdminSqlOptions {
    pub database_type: DatabaseType,
    #[serde(default)]
    pub schema: Option<String>,
    pub table_name: String,
}

/// 复制表结构（新建一张同结构空表）的入参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTableStructureSqlOptions {
    pub database_type: DatabaseType,
    #[serde(default)]
    pub schema: Option<String>,
    pub source_name: String,
    pub target_name: String,
}

/// 该引擎在对象管理 DDL 里是否应让传入的 schema 参与限定。
///
/// 对 schema-aware 引擎（PG/SQLServer/DuckDB/JDBC）复用 capabilities 判定。但 MySQL
/// 与 ClickHouse 的 `capabilities.schemas == false`（它们没有 PG 式的 schema 命名空间），
/// 而 schema browser 给这两类引擎传入的“schema”实为**数据库名**：在破坏性 DDL
/// （DROP/RENAME/TRUNCATE/duplicate）中必须生成 `db.table` 限定，否则会落到连接当前
/// 选中的库上，造成跨库误操作。因此这里对 MySQL/ClickHouse 强制按可限定处理。
///
/// 注意：表数据预览/DML 走的是 dialect::qualified_table + capabilities.schemas，那条
/// 路径连接已通过 `USE <db>` 切到目标库，无需（也不应）再叠库名限定；二者口径不同
/// 是有意为之，仅在对象管理 DDL 这里收紧。
fn should_qualify_with_schema(db: DatabaseType) -> bool {
    use DatabaseType::*;
    matches!(db, Mysql | Clickhouse) || capabilities_for(db).schemas
}

/// schema 限定的对象名。MySQL/ClickHouse 的 schema 即库名，参与 `db.table` 限定。
fn qualified(db: DatabaseType, schema: Option<&str>, name: &str) -> String {
    qualified_table(db, should_qualify_with_schema(db), schema, name)
}

fn object_type_keyword(object_type: DatabaseObjectType) -> &'static str {
    match object_type {
        DatabaseObjectType::Table => "TABLE",
        DatabaseObjectType::View => "VIEW",
        DatabaseObjectType::Procedure => "PROCEDURE",
        DatabaseObjectType::Function => "FUNCTION",
    }
}

fn database_label(db: DatabaseType) -> String {
    serde_json::to_value(db)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "this database".to_string())
}

/// 该引擎是否支持任意（关系型 DDL）对象管理操作。文档/KV/检索引擎（Mongo/
/// Redis/Elasticsearch）没有 SQL DDL 概念，统一拒绝，避免生成出无意义的 SQL。
fn is_sql_engine(db: DatabaseType) -> bool {
    !matches!(
        db,
        DatabaseType::Mongodb | DatabaseType::Redis | DatabaseType::Elasticsearch
    )
}

fn ensure_sql_engine(db: DatabaseType) -> Result<(), String> {
    if is_sql_engine(db) {
        Ok(())
    } else {
        Err(format!("Object administration is not supported for {}.", database_label(db)))
    }
}

/// DROP TABLE|VIEW|PROCEDURE|FUNCTION。
pub fn build_drop_object_sql(options: DropObjectSqlOptions) -> Result<String, String> {
    ensure_sql_engine(options.database_type)?;
    Ok(format!(
        "DROP {} {};",
        object_type_keyword(options.object_type),
        qualified(options.database_type, options.schema.as_deref(), &options.name)
    ))
}

/// TRUNCATE TABLE。SQLite/DuckDB 无 TRUNCATE，退化为 DELETE FROM；ClickHouse 支持
/// TRUNCATE TABLE。
pub fn build_truncate_table_sql(options: TableAdminSqlOptions) -> Result<String, String> {
    ensure_sql_engine(options.database_type)?;
    let table = qualified(options.database_type, options.schema.as_deref(), &options.table_name);
    Ok(
        if matches!(options.database_type, DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Duckdb) {
            format!("DELETE FROM {table};")
        } else {
            format!("TRUNCATE TABLE {table};")
        },
    )
}

/// 该引擎+对象类型是否支持重命名。Catio 引擎集下：
/// - SQLServer：表/视图/过程/函数都能 sp_rename。
/// - MySQL：表/视图（RENAME TABLE）。
/// - SQLite/Rqlite：仅表（ALTER TABLE ... RENAME TO）。
/// - Postgres：表/视图（ALTER TABLE/VIEW ... RENAME TO）。
/// - ClickHouse：表（RENAME TABLE）。
/// - DuckDB：表/视图（ALTER TABLE/VIEW ... RENAME TO）。
/// - JDBC：保守地按 PG 语义支持表/视图（多数关系型 JDBC 引擎可用）。
pub fn supports_object_rename(db: DatabaseType, object_type: DatabaseObjectType) -> bool {
    use DatabaseObjectType::*;
    use DatabaseType::*;
    match db {
        Sqlserver => true,
        Mysql => matches!(object_type, Table | View),
        Postgres | Duckdb | Jdbc => matches!(object_type, Table | View),
        Sqlite | Rqlite | Clickhouse => object_type == Table,
        // 文档/KV/检索引擎无 DDL 重命名。
        Mongodb | Redis | Elasticsearch => false,
    }
}

/// 生成 RENAME 对象 SQL。不支持的组合返回 Err（前端按引擎隐藏入口，这里作为后端
/// 兜底防御）。
pub fn build_rename_object_sql(options: RenameObjectSqlOptions) -> Result<String, String> {
    let db = options.database_type;
    if !supports_object_rename(db, options.object_type) {
        return Err(format!(
            "Renaming {} is not supported for {}.",
            object_type_keyword(options.object_type),
            database_label(db)
        ));
    }

    let old = qualified(db, options.schema.as_deref(), &options.old_name);
    // 新名只是裸标识符（不带 schema —— 重命名不跨 schema）。
    let new_bare = quote_ident(db, &options.new_name);

    Ok(match db {
        DatabaseType::Sqlserver => {
            // sp_rename 'schema.old', 'new', 'OBJECT'
            let target = match options.schema.as_deref().filter(|s| !s.is_empty()) {
                Some(s) => format!("{s}.{}", options.old_name),
                None => options.old_name.clone(),
            };
            format!(
                "EXEC sp_rename {}, {}, N'OBJECT';",
                sqlserver_string(&target),
                sqlserver_string(&options.new_name)
            )
        }
        DatabaseType::Mysql | DatabaseType::Clickhouse => {
            // RENAME TABLE old TO new（视图在 MySQL 也走 RENAME TABLE）。
            format!("RENAME TABLE {old} TO {new_bare};")
        }
        DatabaseType::Sqlite | DatabaseType::Rqlite => {
            format!("ALTER TABLE {old} RENAME TO {new_bare};")
        }
        // Postgres/DuckDB/JDBC：ALTER TABLE|VIEW old RENAME TO new。
        _ => format!(
            "ALTER {} {old} RENAME TO {new_bare};",
            object_type_keyword(options.object_type)
        ),
    })
}

/// 复制一张表的结构（不含数据），新建空表。
pub fn build_duplicate_table_structure_sql(
    options: DuplicateTableStructureSqlOptions,
) -> Result<String, String> {
    let db = options.database_type;
    ensure_sql_engine(db)?;
    let source = qualified(db, options.schema.as_deref(), &options.source_name);
    let target = qualified(db, options.schema.as_deref(), &options.target_name);
    Ok(match db {
        DatabaseType::Mysql => format!("CREATE TABLE {target} LIKE {source};"),
        DatabaseType::Postgres => format!("CREATE TABLE {target} (LIKE {source} INCLUDING ALL);"),
        DatabaseType::Sqlserver => format!("SELECT TOP 0 * INTO {target} FROM {source};"),
        // SQLite/Rqlite/DuckDB/ClickHouse/JDBC：CREATE TABLE ... AS SELECT ... WHERE 0。
        _ => format!("CREATE TABLE {target} AS SELECT * FROM {source} WHERE 0;"),
    })
}

fn sqlserver_string(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── DROP ──────────────────────────────────────────────────────────────
    #[test]
    fn drops_postgres_table_with_schema() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Postgres,
                object_type: DatabaseObjectType::Table,
                schema: Some("public".into()),
                name: "events".into(),
            })
            .unwrap(),
            r#"DROP TABLE "public"."events";"#
        );
    }

    #[test]
    fn drops_mysql_view_bare_when_no_schema() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Mysql,
                object_type: DatabaseObjectType::View,
                schema: None,
                name: "active_users".into(),
            })
            .unwrap(),
            "DROP VIEW `active_users`;"
        );
    }

    // MySQL 的 schema browser 传入的 schema 即数据库名：必须参与 db.table 限定，
    // 否则 DROP/RENAME/TRUNCATE 会落到连接当前选中的库上，存在跨库误操作风险。
    #[test]
    fn drops_mysql_view_qualifies_with_database() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Mysql,
                object_type: DatabaseObjectType::View,
                schema: Some("mydb".into()),
                name: "active_users".into(),
            })
            .unwrap(),
            "DROP VIEW `mydb`.`active_users`;"
        );
    }

    #[test]
    fn drops_clickhouse_table_qualifies_with_database() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Clickhouse,
                object_type: DatabaseObjectType::Table,
                schema: Some("analytics".into()),
                name: "events".into(),
            })
            .unwrap(),
            r#"DROP TABLE "analytics"."events";"#
        );
    }

    #[test]
    fn drops_sqlserver_procedure_brackets() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Sqlserver,
                object_type: DatabaseObjectType::Procedure,
                schema: Some("dbo".into()),
                name: "refresh_cache".into(),
            })
            .unwrap(),
            "DROP PROCEDURE [dbo].[refresh_cache];"
        );
    }

    #[test]
    fn drop_quotes_injection_in_name() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: DatabaseType::Postgres,
                object_type: DatabaseObjectType::Table,
                schema: None,
                name: r#"a"b"#.into(),
            })
            .unwrap(),
            r#"DROP TABLE "a""b";"#
        );
    }

    #[test]
    fn drop_rejects_redis_and_mongo() {
        for db in [DatabaseType::Redis, DatabaseType::Mongodb, DatabaseType::Elasticsearch] {
            assert!(build_drop_object_sql(DropObjectSqlOptions {
                database_type: db,
                object_type: DatabaseObjectType::Table,
                schema: None,
                name: "x".into(),
            })
            .is_err());
        }
    }

    // ── TRUNCATE ──────────────────────────────────────────────────────────
    #[test]
    fn truncates_postgres_table() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: DatabaseType::Postgres,
                schema: Some("public".into()),
                table_name: "events".into(),
            })
            .unwrap(),
            r#"TRUNCATE TABLE "public"."events";"#
        );
    }

    #[test]
    fn truncates_sqlite_falls_back_to_delete() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: DatabaseType::Sqlite,
                schema: None,
                table_name: "events".into(),
            })
            .unwrap(),
            r#"DELETE FROM "events";"#
        );
    }

    #[test]
    fn truncates_duckdb_falls_back_to_delete() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: DatabaseType::Duckdb,
                schema: None,
                table_name: "events".into(),
            })
            .unwrap(),
            r#"DELETE FROM "events";"#
        );
    }

    #[test]
    fn truncates_clickhouse_uses_truncate() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: DatabaseType::Clickhouse,
                schema: None,
                table_name: "events".into(),
            })
            .unwrap(),
            r#"TRUNCATE TABLE "events";"#
        );
    }

    #[test]
    fn truncates_mysql_qualifies_with_database() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: DatabaseType::Mysql,
                schema: Some("mydb".into()),
                table_name: "events".into(),
            })
            .unwrap(),
            "TRUNCATE TABLE `mydb`.`events`;"
        );
    }

    #[test]
    fn truncate_rejects_redis() {
        assert!(build_truncate_table_sql(TableAdminSqlOptions {
            database_type: DatabaseType::Redis,
            schema: None,
            table_name: "x".into(),
        })
        .is_err());
    }

    // ── RENAME ────────────────────────────────────────────────────────────
    #[test]
    fn renames_mysql_table() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Mysql,
                object_type: DatabaseObjectType::Table,
                schema: None,
                old_name: "users".into(),
                new_name: "app users".into(),
            })
            .unwrap(),
            "RENAME TABLE `users` TO `app users`;"
        );
    }

    #[test]
    fn renames_mysql_table_qualifies_old_with_database() {
        // 旧名带库限定，新名为裸标识符（RENAME 不跨库）。
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Mysql,
                object_type: DatabaseObjectType::Table,
                schema: Some("mydb".into()),
                old_name: "users".into(),
                new_name: "app_users".into(),
            })
            .unwrap(),
            "RENAME TABLE `mydb`.`users` TO `app_users`;"
        );
    }

    #[test]
    fn renames_postgres_table_with_schema() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Postgres,
                object_type: DatabaseObjectType::Table,
                schema: Some("public".into()),
                old_name: "orders".into(),
                new_name: "archived orders".into(),
            })
            .unwrap(),
            r#"ALTER TABLE "public"."orders" RENAME TO "archived orders";"#
        );
    }

    #[test]
    fn renames_postgres_view() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Postgres,
                object_type: DatabaseObjectType::View,
                schema: Some("public".into()),
                old_name: "active_users".into(),
                new_name: "enabled_users".into(),
            })
            .unwrap(),
            r#"ALTER VIEW "public"."active_users" RENAME TO "enabled_users";"#
        );
    }

    #[test]
    fn renames_sqlite_table_only() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Sqlite,
                object_type: DatabaseObjectType::Table,
                schema: None,
                old_name: "t1".into(),
                new_name: "t2".into(),
            })
            .unwrap(),
            r#"ALTER TABLE "t1" RENAME TO "t2";"#
        );
        // SQLite 不支持视图重命名 → Err。
        assert!(build_rename_object_sql(RenameObjectSqlOptions {
            database_type: DatabaseType::Sqlite,
            object_type: DatabaseObjectType::View,
            schema: None,
            old_name: "v1".into(),
            new_name: "v2".into(),
        })
        .is_err());
    }

    #[test]
    fn renames_sqlserver_function_via_sp_rename() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Sqlserver,
                object_type: DatabaseObjectType::Function,
                schema: Some("dbo".into()),
                old_name: "fn_total".into(),
                new_name: "fn_order_total".into(),
            })
            .unwrap(),
            "EXEC sp_rename N'dbo.fn_total', N'fn_order_total', N'OBJECT';"
        );
    }

    #[test]
    fn renames_jdbc_table_pg_like() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Jdbc,
                object_type: DatabaseObjectType::Table,
                schema: Some("HR".into()),
                old_name: "EMPLOYEES".into(),
                new_name: "STAFF".into(),
            })
            .unwrap(),
            r#"ALTER TABLE "HR"."EMPLOYEES" RENAME TO "STAFF";"#
        );
    }

    #[test]
    fn rename_rejects_mysql_procedure() {
        assert!(!supports_object_rename(DatabaseType::Mysql, DatabaseObjectType::Procedure));
        assert!(build_rename_object_sql(RenameObjectSqlOptions {
            database_type: DatabaseType::Mysql,
            object_type: DatabaseObjectType::Procedure,
            schema: None,
            old_name: "p".into(),
            new_name: "p2".into(),
        })
        .unwrap_err()
        .contains("Renaming PROCEDURE is not supported"));
    }

    #[test]
    fn rename_rejects_redis() {
        assert!(!supports_object_rename(DatabaseType::Redis, DatabaseObjectType::Table));
    }

    // ── DUPLICATE STRUCTURE ─────────────────────────────────────────────────
    #[test]
    fn duplicates_mysql_with_like() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: DatabaseType::Mysql,
                schema: None,
                source_name: "users".into(),
                target_name: "users_copy".into(),
            })
            .unwrap(),
            "CREATE TABLE `users_copy` LIKE `users`;"
        );
    }

    #[test]
    fn duplicates_mysql_qualifies_with_database() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: DatabaseType::Mysql,
                schema: Some("mydb".into()),
                source_name: "users".into(),
                target_name: "users_copy".into(),
            })
            .unwrap(),
            "CREATE TABLE `mydb`.`users_copy` LIKE `mydb`.`users`;"
        );
    }

    #[test]
    fn duplicates_postgres_like_including_all() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: DatabaseType::Postgres,
                schema: Some("public".into()),
                source_name: "users".into(),
                target_name: "users_copy".into(),
            })
            .unwrap(),
            r#"CREATE TABLE "public"."users_copy" (LIKE "public"."users" INCLUDING ALL);"#
        );
    }

    #[test]
    fn duplicates_sqlserver_select_into() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: DatabaseType::Sqlserver,
                schema: Some("dbo".into()),
                source_name: "users".into(),
                target_name: "users_copy".into(),
            })
            .unwrap(),
            "SELECT TOP 0 * INTO [dbo].[users_copy] FROM [dbo].[users];"
        );
    }

    #[test]
    fn duplicates_sqlite_ctas_where_zero() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: DatabaseType::Sqlite,
                schema: None,
                source_name: "users".into(),
                target_name: "users_copy".into(),
            })
            .unwrap(),
            r#"CREATE TABLE "users_copy" AS SELECT * FROM "users" WHERE 0;"#
        );
    }

    #[test]
    fn duplicate_rejects_mongo() {
        assert!(build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
            database_type: DatabaseType::Mongodb,
            schema: None,
            source_name: "a".into(),
            target_name: "b".into(),
        })
        .is_err());
    }
}
