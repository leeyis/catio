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

/// 可被删除的“表的子对象”类型（索引/外键约束/触发器；列由前端 structureDdl
/// 的 buildDropColumn 处理，这里也保留 Column 以对齐 dbx 的枚举语义、便于后端兜底）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableChildObjectType {
    Column,
    Index,
    ForeignKey,
    Trigger,
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

/// DROP 表的子对象（索引/外键/触发器）的入参。`table_name` 是子对象所属的表，
/// `name` 是子对象自身的名字（索引名/约束名/触发器名）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTableChildObjectSqlOptions {
    pub database_type: DatabaseType,
    pub object_type: TableChildObjectType,
    #[serde(default)]
    pub schema: Option<String>,
    pub table_name: String,
    pub name: String,
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

/// `schema.name` 的 schema 限定（不带表名，用于 PG 系的 `DROP INDEX schema.idx`、
/// `DROP TRIGGER schema.trg`）。仅在该引擎应按 schema 限定且 schema 非空时加前缀。
fn schema_qualified(db: DatabaseType, schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if should_qualify_with_schema(db) && !s.is_empty() => {
            format!("{}.{}", quote_ident(db, s), quote_ident(db, name))
        }
        _ => quote_ident(db, name),
    }
}

/// DROP 表的子对象（列/索引/外键/触发器），按方言生成正确语法。不支持的组合返回
/// Err（前端按引擎隐藏入口，这里作后端兜底防御）。
///
/// 适配 Catio 引擎集（参考 dbx db_admin_sql.rs build_drop_table_child_object_sql）：
/// - 列：`ALTER TABLE t DROP COLUMN c`（所有 SQL 引擎）。
/// - 索引：MySQL/SQLServer 用 `DROP INDEX i ON t`；PG 系（schema 非空）用
///   `DROP INDEX schema.i`；SQLite/Rqlite/DuckDB/JDBC/PG（无 schema）用 `DROP INDEX i`；
///   ClickHouse 不支持单独删除二级索引（需 ALTER TABLE ... DROP INDEX，且形态特殊）→ Err。
/// - 外键：MySQL 用 `ALTER TABLE t DROP FOREIGN KEY fk`；SQLite/Rqlite 无 ALTER DROP
///   CONSTRAINT → Err；其余用 `ALTER TABLE t DROP CONSTRAINT fk`。
/// - 触发器：Postgres 用 `DROP TRIGGER trg ON t`；SQLServer 用 `DROP TRIGGER trg`；
///   ClickHouse 无触发器 → Err；其余（含 schema 限定）用 `DROP TRIGGER [schema.]trg`。
pub fn build_drop_table_child_object_sql(
    options: DropTableChildObjectSqlOptions,
) -> Result<String, String> {
    let db = options.database_type;
    ensure_sql_engine(db)?;
    let table = qualified(db, options.schema.as_deref(), &options.table_name);
    let name = quote_ident(db, &options.name);
    match options.object_type {
        TableChildObjectType::Column => Ok(format!("ALTER TABLE {table} DROP COLUMN {name};")),
        TableChildObjectType::Index => {
            if matches!(db, DatabaseType::Clickhouse) {
                return Err(format!("Dropping indexes is not supported for {}.", database_label(db)));
            }
            if matches!(db, DatabaseType::Mysql | DatabaseType::Sqlserver) {
                return Ok(format!("DROP INDEX {name} ON {table};"));
            }
            // Postgres/JDBC：索引按 schema 限定（DROP INDEX 不接表名）。
            Ok(format!("DROP INDEX {};", schema_qualified(db, options.schema.as_deref(), &options.name)))
        }
        TableChildObjectType::ForeignKey => {
            if matches!(db, DatabaseType::Mysql) {
                Ok(format!("ALTER TABLE {table} DROP FOREIGN KEY {name};"))
            } else if matches!(db, DatabaseType::Sqlite | DatabaseType::Rqlite) {
                Err(format!("Dropping foreign keys is not supported for {}.", database_label(db)))
            } else {
                Ok(format!("ALTER TABLE {table} DROP CONSTRAINT {name};"))
            }
        }
        TableChildObjectType::Trigger => {
            if matches!(db, DatabaseType::Clickhouse) {
                return Err(format!("Triggers are not supported for {}.", database_label(db)));
            }
            if matches!(db, DatabaseType::Postgres) {
                return Ok(format!("DROP TRIGGER {name} ON {table};"));
            }
            if matches!(db, DatabaseType::Sqlserver) {
                return Ok(format!("DROP TRIGGER {name};"));
            }
            // MySQL/SQLite/Rqlite/DuckDB/JDBC：DROP TRIGGER [schema.]trg。
            Ok(format!("DROP TRIGGER {};", schema_qualified(db, options.schema.as_deref(), &options.name)))
        }
    }
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
            // sp_rename 'schema.old', 'new', 'OBJECT'。schema 与 old_name 各自先做单引号
            // 转义再拼接，避免任一含单引号（如 O'Brien）时拼出畸形的 N'...' 字面量。
            let target = match options.schema.as_deref().filter(|s| !s.is_empty()) {
                Some(s) => format!("{}.{}", sqlserver_escape(s), sqlserver_escape(&options.old_name)),
                None => sqlserver_escape(&options.old_name),
            };
            format!(
                "EXEC sp_rename N'{}', {}, N'OBJECT';",
                target,
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

/// SQLServer 字符串字面量内的单引号转义（不含外层 N'…' 包裹），用于把多个标识符
/// 片段（schema / 对象名）各自转义后再拼接成 sp_rename 的目标字符串。
fn sqlserver_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn sqlserver_string(value: &str) -> String {
    format!("N'{}'", sqlserver_escape(value))
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

    // ── DROP TABLE CHILD OBJECT (index / FK / trigger / column) ─────────────
    fn child(
        db: DatabaseType,
        object_type: TableChildObjectType,
        schema: Option<&str>,
        table: &str,
        name: &str,
    ) -> Result<String, String> {
        build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
            database_type: db,
            object_type,
            schema: schema.map(str::to_string),
            table_name: table.into(),
            name: name.into(),
        })
    }

    #[test]
    fn drops_column_via_alter_table() {
        assert_eq!(
            child(DatabaseType::Postgres, TableChildObjectType::Column, Some("public"), "orders", "status").unwrap(),
            r#"ALTER TABLE "public"."orders" DROP COLUMN "status";"#
        );
    }

    #[test]
    fn drops_mysql_index_with_on_table() {
        assert_eq!(
            child(DatabaseType::Mysql, TableChildObjectType::Index, None, "orders", "idx_orders_status").unwrap(),
            "DROP INDEX `idx_orders_status` ON `orders`;"
        );
    }

    #[test]
    fn drops_mysql_index_qualifies_table_with_database() {
        // MySQL 的 schema 即库名：DROP INDEX i ON `db`.`t`，避免落到当前库。
        assert_eq!(
            child(DatabaseType::Mysql, TableChildObjectType::Index, Some("mydb"), "orders", "idx_status").unwrap(),
            "DROP INDEX `idx_status` ON `mydb`.`orders`;"
        );
    }

    #[test]
    fn drops_sqlserver_index_with_on_table() {
        assert_eq!(
            child(DatabaseType::Sqlserver, TableChildObjectType::Index, Some("dbo"), "orders", "ix_status").unwrap(),
            "DROP INDEX [ix_status] ON [dbo].[orders];"
        );
    }

    #[test]
    fn drops_postgres_index_schema_qualified_no_table() {
        assert_eq!(
            child(DatabaseType::Postgres, TableChildObjectType::Index, Some("public"), "orders", "idx_orders_status").unwrap(),
            r#"DROP INDEX "public"."idx_orders_status";"#
        );
    }

    #[test]
    fn drops_sqlite_index_bare() {
        assert_eq!(
            child(DatabaseType::Sqlite, TableChildObjectType::Index, None, "orders", "idx_status").unwrap(),
            r#"DROP INDEX "idx_status";"#
        );
    }

    #[test]
    fn drop_index_rejects_clickhouse() {
        assert!(child(DatabaseType::Clickhouse, TableChildObjectType::Index, None, "t", "i").is_err());
    }

    #[test]
    fn drops_mysql_foreign_key() {
        assert_eq!(
            child(DatabaseType::Mysql, TableChildObjectType::ForeignKey, None, "orders", "fk_orders_user").unwrap(),
            "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_user`;"
        );
    }

    #[test]
    fn drops_postgres_foreign_key_as_constraint() {
        assert_eq!(
            child(DatabaseType::Postgres, TableChildObjectType::ForeignKey, Some("public"), "orders", "fk_orders_user").unwrap(),
            r#"ALTER TABLE "public"."orders" DROP CONSTRAINT "fk_orders_user";"#
        );
    }

    #[test]
    fn drops_sqlserver_foreign_key_as_constraint() {
        assert_eq!(
            child(DatabaseType::Sqlserver, TableChildObjectType::ForeignKey, Some("dbo"), "orders", "fk_orders_user").unwrap(),
            "ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_orders_user];"
        );
    }

    #[test]
    fn drop_foreign_key_rejects_sqlite() {
        assert!(child(DatabaseType::Sqlite, TableChildObjectType::ForeignKey, None, "t", "fk").is_err());
        assert!(child(DatabaseType::Rqlite, TableChildObjectType::ForeignKey, None, "t", "fk").is_err());
    }

    #[test]
    fn drops_postgres_trigger_on_table() {
        assert_eq!(
            child(DatabaseType::Postgres, TableChildObjectType::Trigger, Some("public"), "orders", "orders_audit").unwrap(),
            r#"DROP TRIGGER "orders_audit" ON "public"."orders";"#
        );
    }

    #[test]
    fn drops_sqlserver_trigger_bare() {
        assert_eq!(
            child(DatabaseType::Sqlserver, TableChildObjectType::Trigger, Some("dbo"), "orders", "trg_audit").unwrap(),
            "DROP TRIGGER [trg_audit];"
        );
    }

    #[test]
    fn drops_mysql_trigger_qualified_with_database() {
        assert_eq!(
            child(DatabaseType::Mysql, TableChildObjectType::Trigger, Some("mydb"), "orders", "trg_audit").unwrap(),
            "DROP TRIGGER `mydb`.`trg_audit`;"
        );
    }

    #[test]
    fn drops_sqlite_trigger_bare() {
        assert_eq!(
            child(DatabaseType::Sqlite, TableChildObjectType::Trigger, None, "orders", "trg_audit").unwrap(),
            r#"DROP TRIGGER "trg_audit";"#
        );
    }

    #[test]
    fn drop_trigger_rejects_clickhouse() {
        assert!(child(DatabaseType::Clickhouse, TableChildObjectType::Trigger, None, "t", "trg").is_err());
    }

    #[test]
    fn drop_child_rejects_non_sql_engines() {
        for db in [DatabaseType::Redis, DatabaseType::Mongodb, DatabaseType::Elasticsearch] {
            assert!(child(db, TableChildObjectType::Index, None, "t", "i").is_err());
        }
    }

    #[test]
    fn drop_child_quotes_injection_in_name() {
        assert_eq!(
            child(DatabaseType::Postgres, TableChildObjectType::Index, None, "t", r#"a"b"#).unwrap(),
            r#"DROP INDEX "a""b";"#
        );
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

    // 复现 codex 阻断项：schema / old_name 含单引号（如 O'Brien）时，sp_rename 的目标
    // 字符串必须仍是合法的 N'...'（单引号成对转义）。
    #[test]
    fn renames_sqlserver_escapes_single_quote_in_schema_and_name() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: DatabaseType::Sqlserver,
                object_type: DatabaseObjectType::Table,
                schema: Some("O'Brien".into()),
                old_name: "ord'ers".into(),
                new_name: "arch'ive".into(),
            })
            .unwrap(),
            "EXEC sp_rename N'O''Brien.ord''ers', N'arch''ive', N'OBJECT';"
        );
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
