// adapted from dbx crates/dbx-core/src/db/duckdb_driver.rs + schema.rs, Apache-2.0
//
// Async-wrapping choice: DuckDbDriver holds Arc<tokio::sync::Mutex<duckdb::Connection>>.
// All Driver methods lock the mutex and call duckdb synchronously *without* spawn_blocking.
// Rationale: duckdb::Connection is !Sync. For DuckDB (local/in-memory, fast ops) doing the sync
// work while holding a tokio async Mutex is acceptable — no network latency, no long blocking.
// The critical correctness requirement for :memory: is satisfied: the SAME Connection instance
// is reused across all calls (no new open per query).
//
// NOTE: the module name `duckdb` shadows the `duckdb` crate. Inside this file we use the crate
// via its canonical name because `use duckdb as ...` re-exports would be confusing; instead we
// rely on `::duckdb` (crate-root) where disambiguation is required. In practice, local `use`
// statements resolve unambiguously because the module file path is src/db/drivers/duckdb.rs and
// the compiler knows `duckdb` at use-site refers to the extern crate, not the module itself.

use async_trait::async_trait;
use duckdb::types::ValueRef;
use duckdb::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db::{DbError, DatabaseType};
use crate::db::dialect::quote_ident;
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{QueryResult, ColumnInfo, safe_i64_to_json, binary_to_json};

pub struct DuckDbDriver {
    conn: Arc<Mutex<Connection>>,
}

impl DuckDbDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let path = args.host.clone();
        // Open in-memory or file connection
        let conn = if path.trim().eq_ignore_ascii_case(":memory:") {
            Connection::open_in_memory()
                .map_err(|e| DbError::ConnectFailed(e.to_string()))?
        } else {
            Connection::open(&path)
                .map_err(|e| DbError::ConnectFailed(e.to_string()))?
        };
        // Validate connectivity with a trivial query
        conn.execute_batch("SELECT 1")
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }
}

/// Map a duckdb ValueRef to serde_json::Value.
/// Adapted from dbx crates/dbx-core/src/db/duckdb_driver.rs value mapping, Apache-2.0.
fn value_ref_to_json(val: ValueRef<'_>) -> serde_json::Value {
    match val {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Boolean(v) => serde_json::Value::Bool(v),
        ValueRef::TinyInt(v) => safe_i64_to_json(v as i64),
        ValueRef::SmallInt(v) => safe_i64_to_json(v as i64),
        ValueRef::Int(v) => safe_i64_to_json(v as i64),
        ValueRef::BigInt(v) => safe_i64_to_json(v),
        ValueRef::HugeInt(v) => {
            // HugeInt is i128; represent as string to avoid precision loss
            serde_json::Value::String(v.to_string())
        }
        ValueRef::UTinyInt(v) => safe_i64_to_json(v as i64),
        ValueRef::USmallInt(v) => safe_i64_to_json(v as i64),
        ValueRef::UInt(v) => safe_i64_to_json(v as i64),
        ValueRef::UBigInt(v) => {
            // u64 may exceed JS safe integer; use safe_i64_to_json via i64 cast when safe
            if v <= i64::MAX as u64 {
                safe_i64_to_json(v as i64)
            } else {
                serde_json::Value::String(v.to_string())
            }
        }
        ValueRef::Float(v) => serde_json::Number::from_f64(v as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Double(v) => serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Decimal(v) => {
            // Decimal: convert to f64 via ToPrimitive then to JSON Number
            use rust_decimal::prelude::ToPrimitive;
            let f = v.to_f64().unwrap_or(f64::NAN);
            serde_json::Number::from_f64(f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Text(v) => serde_json::Value::String(
            String::from_utf8_lossy(v).to_string(),
        ),
        ValueRef::Blob(v) => binary_to_json(v),
        ValueRef::Date32(v) => {
            // days since epoch; represent as string
            serde_json::Value::String(v.to_string())
        }
        ValueRef::Time64(_, v) => {
            serde_json::Value::String(v.to_string())
        }
        ValueRef::Timestamp(_, v) => {
            serde_json::Value::String(v.to_string())
        }
        ValueRef::Interval { months, days, nanos } => {
            serde_json::Value::String(format!("{}mo {}d {}ns", months, days, nanos))
        }
        ValueRef::List(_, _) | ValueRef::Struct(_, _) | ValueRef::Array(_, _) | ValueRef::Map(_, _) | ValueRef::Union(_, _) | ValueRef::Enum(_, _) => {
            // Compound types: fall back to debug string
            serde_json::Value::String(format!("{:?}", val))
        }
    }
}

/// Resolve "main" to the actual DuckDB catalog name via `current_database()`.
/// Adapted from dbx crates/dbx-core/src/schema.rs duckdb_catalog_name, Apache-2.0.
fn resolve_catalog(conn: &Connection, database: &str) -> Result<String, DbError> {
    if database.trim().is_empty() || database == "main" {
        conn.query_row("SELECT current_database()", [], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))
    } else {
        Ok(database.to_string())
    }
}

fn duckdb_query_on_conn(conn: &Connection, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
    // DuckDB's column_count() panics if the statement has not been executed yet
    // (unlike rusqlite). We always use stmt.query() which internally calls execute()
    // and then wraps the result. After query() returns, column_count() is safe via
    // rows.as_ref(). DDL/DML statements return col_count == 0, SELECT returns > 0.
    let mut stmt = conn.prepare(sql)
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let mut query_rows = stmt.query([])
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;

    // After query(), the statement is executed; column_count() is now safe.
    let col_count = query_rows.as_ref()
        .map(|s| s.column_count())
        .unwrap_or(0);

    // Non-row-returning statement (DDL, INSERT, UPDATE, DELETE): col_count == 0
    if col_count == 0 {
        // rows_changed is available via raw_statement row_count but is 0 for DDL.
        // For DML, we can get rows changed via conn.execute(); however since we already
        // ran via query(), we return None for rows_affected (consistent behavior).
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: None,
            truncated: false,
        });
    }

    // Build column info from the executed statement
    let columns: Vec<ColumnInfo> = (0..col_count).map(|i| {
        let name = query_rows.as_ref()
            .and_then(|s| s.column_name(i).ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("col{}", i));
        ColumnInfo { name, type_name: String::new(), pk: false }
    }).collect();

    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    while let Some(row) = query_rows.next()
        .map_err(|e| DbError::QueryFailed(e.to_string()))?
    {
        if rows.len() as u32 >= max_rows {
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let val = row.get_ref(i)
                .map(value_ref_to_json)
                .unwrap_or(serde_json::Value::Null);
            out.push(val);
        }
        rows.push(out);
    }

    Ok(QueryResult { columns, rows, rows_affected: None, truncated })
}

#[async_trait]
impl Driver for DuckDbDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Duckdb }

    async fn test(&self) -> Result<String, DbError> {
        let conn = self.conn.lock().await;
        let version: String = conn
            .query_row("SELECT version()", [], |row| row.get(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(format!("DuckDB {}", version))
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let conn = self.conn.lock().await;
        duckdb_query_on_conn(&conn, sql, max_rows)
    }

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        let Some(schema) = default_namespace.map(str::trim).filter(|s| !s.is_empty()) else {
            return self.query(sql, max_rows).await;
        };
        let conn = self.conn.lock().await;
        let original_schema = conn
            .query_row("SELECT current_schema()", [], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        if original_schema != schema {
            conn.execute_batch(&format!("USE {}", quote_ident(DatabaseType::Duckdb, schema)))
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        }
        let result = duckdb_query_on_conn(&conn, sql, max_rows);
        if original_schema != schema {
            conn.execute_batch(&format!("USE {}", quote_ident(DatabaseType::Duckdb, &original_schema)))
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        }
        result
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        // adapted from dbx crates/dbx-core/src/schema.rs duckdb_list_schemas, Apache-2.0
        // Query information_schema.schemata, excluding system schemas.
        let conn = self.conn.lock().await;
        let catalog = resolve_catalog(&conn, "main")?;
        let mut stmt = conn.prepare(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE catalog_name = ? \
               AND schema_name NOT IN ('information_schema', 'pg_catalog') \
             ORDER BY schema_name",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let rows = stmt.query_map([catalog.as_str()], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut schemas = Vec::new();
        for item in rows {
            let name = item.map_err(|e| DbError::QueryFailed(e.to_string()))?;
            schemas.push(name);
        }
        Ok(schemas)
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        // adapted from dbx crates/dbx-core/src/schema.rs duckdb_query_tables_in_database, Apache-2.0
        let conn = self.conn.lock().await;
        let catalog = resolve_catalog(&conn, "main")?;
        let schema_name = if schema.is_empty() { "main" } else { schema };

        let mut stmt = conn.prepare(
            "SELECT table_name, table_type \
             FROM information_schema.tables \
             WHERE table_catalog = ? AND table_schema = ? \
             ORDER BY table_name",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let rows = stmt.query_map(
            [catalog.as_str(), schema_name],
            |row| {
                let name: String = row.get(0)?;
                let ttype: String = row.get(1)?;
                Ok((name, ttype))
            },
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut tables = Vec::new();
        for item in rows {
            let (name, ttype) = item.map_err(|e| DbError::QueryFailed(e.to_string()))?;
            // DuckDB table_type values: "BASE TABLE", "VIEW", "LOCAL TEMPORARY"
            let kind = if ttype.to_uppercase().contains("VIEW") { "view" } else { "table" };
            tables.push(TableInfo { name, kind: kind.into(), rows_estimate: None });
        }
        Ok(tables)
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        // adapted from dbx crates/dbx-core/src/schema.rs duckdb_query_columns_in_database_with_attached, Apache-2.0
        let conn = self.conn.lock().await;
        let catalog = resolve_catalog(&conn, "main")?;
        let schema_name = if schema.is_empty() { "main" } else { schema };

        // ---- PK columns via information_schema.table_constraints + key_column_usage ----
        let mut pk_stmt = conn.prepare(
            "SELECT kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema    = kcu.table_schema \
              AND tc.table_name      = kcu.table_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_catalog = ? \
               AND tc.table_schema  = ? \
               AND tc.table_name    = ? \
             ORDER BY kcu.ordinal_position",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let pk_rows = pk_stmt.query_map(
            [catalog.as_str(), schema_name, table],
            |row| row.get::<_, String>(0),
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let primary_keys: std::collections::HashSet<String> = pk_rows
            .filter_map(|r| r.ok())
            .collect();

        // ---- FK info via information_schema.referential_constraints + key_column_usage ----
        // DuckDB FK introspection is limited; best-effort via constraint tables.
        let fks_result = query_fks(&conn, &catalog, schema_name, table);
        let (fk_cols, fks) = fks_result.unwrap_or_else(|_| (std::collections::HashSet::new(), vec![]));

        // ---- Indexes via duckdb_indexes() table function ----
        // DuckDB has limited index introspection; use duckdb_indexes() if available, else empty.
        let indexes = query_indexes(&conn, schema_name, table).unwrap_or_else(|_| vec![]);

        // Build uni_cols from indexes for "UNI" annotation
        let uni_cols: std::collections::HashSet<String> = indexes.iter()
            .filter(|idx| idx.unique && !idx.columns.contains(','))
            .map(|idx| idx.columns.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect();

        // ---- Columns via information_schema.columns ----
        let mut col_stmt = conn.prepare(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_catalog = ? AND table_schema = ? AND table_name = ? \
             ORDER BY ordinal_position",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let col_rows = col_stmt.query_map(
            [catalog.as_str(), schema_name, table],
            |row| {
                let name: String = row.get(0)?;
                let type_name: String = row.get(1)?;
                let is_nullable: String = row.get(2).unwrap_or_else(|_| "YES".to_string());
                let default: Option<String> = row.get(3)?;
                Ok((name, type_name, is_nullable, default))
            },
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let columns: Vec<ColumnDef> = col_rows
            .filter_map(|r| r.ok())
            .map(|(name, type_name, is_nullable, default)| {
                let nullable = is_nullable.eq_ignore_ascii_case("YES");
                // Key precedence: PK > FK > UNI > ""
                let key = if primary_keys.contains(&name) {
                    "PK"
                } else if fk_cols.contains(&name) {
                    "FK"
                } else if uni_cols.contains(&name) {
                    "UNI"
                } else {
                    ""
                };
                ColumnDef {
                    name,
                    type_name,
                    nullable,
                    default,
                    key: key.into(),
                }
            })
            .collect();

        Ok(TableStructure { columns, indexes, fks })
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // adapted from dbx crates/dbx-core/src/schema.rs FK introspection approach, Apache-2.0
        // DuckDB FK/ER introspection is limited; return best-effort or empty Vec.
        let conn = self.conn.lock().await;
        let catalog = resolve_catalog(&conn, "main")?;
        let schema_name = if schema.is_empty() { "main" } else { schema };

        // Get all tables in schema first
        let mut tbl_stmt = conn.prepare(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_catalog = ? AND table_schema = ? AND table_type = 'BASE TABLE' \
             ORDER BY table_name",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let tables: Vec<String> = tbl_stmt.query_map(
            [catalog.as_str(), schema_name],
            |row| row.get::<_, String>(0),
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

        let mut relations = Vec::new();
        for tbl in tables {
            if let Ok((_, fks)) = query_fks(&conn, &catalog, schema_name, &tbl) {
                for fk in fks {
                    // Parse "schema.table.col" from fk.references
                    let parts: Vec<&str> = fk.references.splitn(3, '.').collect();
                    let (to_tbl, to_col) = if parts.len() == 3 {
                        (parts[1].to_string(), parts[2].to_string())
                    } else {
                        continue;
                    };
                    relations.push(ErRelation {
                        from: tbl.clone(),
                        from_col: fk.column,
                        to: to_tbl,
                        to_col,
                    });
                }
            }
        }

        Ok(relations)
    }
}

/// Query foreign keys for a table from information_schema.
/// Returns (set of FK column names, list of ForeignKeyDef).
/// Best-effort: returns empty on any error (DuckDB FK introspection is limited).
fn query_fks(
    conn: &Connection,
    catalog: &str,
    schema: &str,
    table: &str,
) -> Result<(std::collections::HashSet<String>, Vec<ForeignKeyDef>), DbError> {
    // DuckDB supports information_schema.referential_constraints in newer versions;
    // use a JOIN approach on constraint tables similar to the PK query.
    let sql = "SELECT \
                 kcu.column_name, \
                 ccu.table_schema, \
                 ccu.table_name, \
                 ccu.column_name \
               FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage kcu \
                 ON tc.constraint_name = kcu.constraint_name \
                AND tc.table_schema    = kcu.table_schema \
                AND tc.table_name      = kcu.table_name \
               JOIN information_schema.referential_constraints rc \
                 ON tc.constraint_name = rc.constraint_name \
                AND tc.table_schema    = rc.constraint_schema \
               JOIN information_schema.key_column_usage ccu \
                 ON rc.unique_constraint_name = ccu.constraint_name \
                AND rc.unique_constraint_schema = ccu.constraint_schema \
               WHERE tc.constraint_type = 'FOREIGN KEY' \
                 AND tc.table_catalog = ? \
                 AND tc.table_schema  = ? \
                 AND tc.table_name    = ? \
               ORDER BY kcu.ordinal_position";

    let mut stmt = conn.prepare(sql)
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let rows = stmt.query_map(
        [catalog, schema, table],
        |row| {
            let from_col: String = row.get(0)?;
            let ref_schema: String = row.get(1)?;
            let ref_table: String = row.get(2)?;
            let ref_col: String = row.get(3)?;
            Ok((from_col, ref_schema, ref_table, ref_col))
        },
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let mut fk_cols = std::collections::HashSet::new();
    let mut fks = Vec::new();

    for item in rows {
        let (from_col, ref_schema, ref_table, ref_col) = item
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        fk_cols.insert(from_col.clone());
        fks.push(ForeignKeyDef {
            column: from_col,
            references: format!("{}.{}.{}", ref_schema, ref_table, ref_col),
            on_delete: "NO ACTION".into(),
            on_update: "NO ACTION".into(),
        });
    }

    Ok((fk_cols, fks))
}

/// Query indexes for a table using the duckdb_indexes() table function.
/// Returns empty Vec on any error (DuckDB index introspection is limited).
fn query_indexes(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexDef>, DbError> {
    // duckdb_indexes() is a DuckDB-specific table function available in DuckDB >= 0.8
    let mut stmt = conn.prepare(
        "SELECT index_name, is_unique, sql \
         FROM duckdb_indexes() \
         WHERE schema_name = ? AND table_name = ? \
         ORDER BY index_name",
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let rows = stmt.query_map(
        [schema, table],
        |row| {
            let name: String = row.get(0)?;
            let unique: bool = row.get(1)?;
            let sql: Option<String> = row.get(2)?;
            Ok((name, unique, sql))
        },
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let mut indexes = Vec::new();
    for item in rows {
        let (name, unique, sql) = item
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        // Extract column list from the SQL string (best effort)
        let columns = extract_index_columns(sql.as_deref()).unwrap_or_default();
        indexes.push(IndexDef {
            name,
            columns,
            unique,
            method: "art".into(), // DuckDB uses Adaptive Radix Tree (ART) indexes
        });
    }

    Ok(indexes)
}

/// Extract column names from a DuckDB CREATE INDEX SQL string.
/// E.g.: "CREATE INDEX idx ON t(col1, col2)" → "col1, col2"
/// Returns None if the SQL is malformed or not parseable.
fn extract_index_columns(sql: Option<&str>) -> Option<String> {
    let sql = sql?;
    let open = sql.find('(')?;
    let close = sql.rfind(')')?;
    if open >= close {
        return None;
    }
    Some(sql[open + 1..close].trim().to_string())
}
