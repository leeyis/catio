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

struct DuckQueryCompletion {
    state: Arc<parking_lot::Mutex<Option<Arc<duckdb::InterruptHandle>>>>,
    done: tokio_util::sync::CancellationToken,
}
impl Drop for DuckQueryCompletion {
    fn drop(&mut self) { self.state.lock().take(); self.done.cancel(); }
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

/// Decode Arrow directly: duckdb-rs ValueRef converts DECIMAL(38,s) through a
/// 96-bit rust_decimal mantissa, which can panic. No lossy intermediate conversion.
fn duck_arrow_value(column: &dyn duckdb::arrow::array::Array, row: usize) -> Result<serde_json::Value, DbError> {
    use duckdb::arrow::{array::*, datatypes::*};
    use serde_json::Value as J;
    if column.is_null(row) { return Ok(J::Null); }
    macro_rules! array { ($t:ty) => { column.as_any().downcast_ref::<$t>()
        .ok_or_else(|| DbError::QueryFailed("Unexpected DuckDB Arrow column representation".into()))? }; }
    macro_rules! list { ($t:ty) => {{ let values = array!($t).value(row);
        J::Array((0..values.len()).map(|i| duck_arrow_value(values.as_ref(), i)).collect::<Result<Vec<_>, _>>()?) }}; }
    macro_rules! dictionary { ($t:ty) => {{ let values = array!(DictionaryArray<$t>);
        duck_arrow_value(values.values().as_ref(), values.keys().value(row) as usize)? }}; }
    Ok(match column.data_type() {
        DataType::Boolean => J::Bool(array!(BooleanArray).value(row)),
        DataType::Int8 => safe_i64_to_json(array!(Int8Array).value(row) as i64),
        DataType::Int16 => safe_i64_to_json(array!(Int16Array).value(row) as i64),
        DataType::Int32 => safe_i64_to_json(array!(Int32Array).value(row) as i64),
        DataType::Int64 => safe_i64_to_json(array!(Int64Array).value(row)),
        DataType::UInt8 => safe_i64_to_json(array!(UInt8Array).value(row) as i64),
        DataType::UInt16 => safe_i64_to_json(array!(UInt16Array).value(row) as i64),
        DataType::UInt32 => safe_i64_to_json(array!(UInt32Array).value(row) as i64),
        DataType::UInt64 => { let v = array!(UInt64Array).value(row); if v <= i64::MAX as u64 { safe_i64_to_json(v as i64) } else { J::String(v.to_string()) } },
        DataType::Float32 => { let v = array!(Float32Array).value(row); serde_json::Number::from_f64(v as f64).map(J::Number).unwrap_or_else(|| J::String(v.to_string())) },
        DataType::Float64 => { let v = array!(Float64Array).value(row); serde_json::Number::from_f64(v).map(J::Number).unwrap_or_else(|| J::String(v.to_string())) },
        DataType::Decimal128(_, scale) => J::String(crate::db::result::decimal_i128_to_string(array!(Decimal128Array).value(row), *scale)),
        DataType::Binary => binary_to_json(array!(BinaryArray).value(row)),
        DataType::LargeBinary => binary_to_json(array!(LargeBinaryArray).value(row)),
        DataType::FixedSizeBinary(_) => binary_to_json(array!(FixedSizeBinaryArray).value(row)),
        DataType::List(_) => list!(ListArray),
        DataType::LargeList(_) => list!(LargeListArray),
        DataType::FixedSizeList(_, _) => list!(FixedSizeListArray),
        DataType::Struct(fields) => {
            let value = array!(StructArray);
            J::Object(fields.iter().enumerate().map(|(i, field)| Ok((field.name().clone(),
                duck_arrow_value(value.column(i).as_ref(), row)?))).collect::<Result<_, DbError>>()?)
        }
        DataType::Map(_, _) => {
            let entries = array!(MapArray).value(row);
            J::Array((0..entries.len()).map(|i| Ok(serde_json::json!({
                "key": duck_arrow_value(entries.column(0).as_ref(), i)?,
                "value": duck_arrow_value(entries.column(1).as_ref(), i)?,
            }))).collect::<Result<Vec<_>, DbError>>()?)
        }
        DataType::Union(_, _) => { let values = array!(UnionArray); duck_arrow_value(values.child(values.type_id(row)).as_ref(), values.value_offset(row))? }
        DataType::Dictionary(key, _) => match key.as_ref() {
            DataType::Int8 => dictionary!(Int8Type), DataType::Int16 => dictionary!(Int16Type),
            DataType::Int32 => dictionary!(Int32Type), DataType::Int64 => dictionary!(Int64Type),
            DataType::UInt8 => dictionary!(UInt8Type), DataType::UInt16 => dictionary!(UInt16Type),
            DataType::UInt32 => dictionary!(UInt32Type), DataType::UInt64 => dictionary!(UInt64Type),
            _ => return Err(DbError::Unsupported("Unsupported DuckDB dictionary key type".into())),
        },
        // Arrow's formatter preserves date/time units, timezone, strings, intervals
        // and Decimal256 without converting through epoch integers or Debug dumps.
        _ => J::String(duckdb::arrow::util::display::array_value_to_string(column, row)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?),
    })
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
    if !crate::db::pagination::returns_rows(DatabaseType::Duckdb, sql) {
        let affected = conn.execute(sql, []).map_err(|e| DbError::QueryFailed(e.to_string()))?;
        return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: Some(affected as u64), truncated: false });
    }
    let mut stmt = conn.prepare(sql).map_err(|e| DbError::QueryFailed(e.to_string()))?;
    let arrow = stmt.query_arrow([]).map_err(|e| DbError::QueryFailed(e.to_string()))?;
    let schema = arrow.get_schema();
    let columns = schema.fields().iter().map(|field| ColumnInfo {
        name: field.name().clone(),
        type_name: match field.data_type() {
            duckdb::arrow::datatypes::DataType::Timestamp(_, Some(_)) => "TIMESTAMPTZ".into(),
            ty => ty.to_string(),
        }, pk: false,
    }).collect();
    let mut rows = Vec::new(); let mut truncated = false;
    'batches: for batch in arrow {
        for row in 0..batch.num_rows() {
            if rows.len() >= max_rows as usize { truncated = true; break 'batches; }
            rows.push(batch.columns().iter().map(|column| duck_arrow_value(column.as_ref(), row))
                .collect::<Result<Vec<_>, _>>()?);
        }
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

    async fn exec_statement_batch(&self, statements: crate::db::driver::StatementBatch) -> Result<u64, DbError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = conn.blocking_lock();
            let tx = conn.transaction().map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let mut affected = 0u64;
            for s in statements {
                affected += tx.execute(s?.as_str(), []).map_err(|e| DbError::QueryFailed(e.to_string()))? as u64;
            }
            tx.commit().map_err(|e| DbError::QueryFailed(e.to_string()))?;
            Ok(affected)
        }).await.map_err(|e| DbError::QueryFailed(e.to_string()))?
    }

    fn supports_query_cancel(&self) -> bool { true }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        self.query_cancellable(sql, max_rows, None, tokio_util::sync::CancellationToken::new()).await
    }

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, namespace: Option<&str>) -> Result<QueryResult, DbError> {
        self.query_cancellable(sql, max_rows, namespace, tokio_util::sync::CancellationToken::new()).await
    }

    async fn query_cancellable(&self, sql: &str, max_rows: u32, namespace: Option<&str>, cancel: tokio_util::sync::CancellationToken) -> Result<QueryResult, DbError> {
        let conn = tokio::select! {
            _ = cancel.cancelled() => return Err(DbError::Cancelled),
            conn = self.conn.clone().lock_owned() => conn,
        };
        let state = Arc::new(parking_lot::Mutex::new(Some(conn.interrupt_handle())));
        let done = tokio_util::sync::CancellationToken::new();
        let watcher_state = state.clone(); let watcher_done = done.clone(); let watcher_cancel = cancel.clone();
        let watcher = tokio::spawn(async move {
            tokio::select! { _ = watcher_done.cancelled() => return, _ = watcher_cancel.cancelled() => {} }
            loop {
                // Checking the active handle and interrupting are one critical section.
                // Completion clears it BEFORE releasing the connection: never interrupt
                // the next tab's query. Repetition closes the cancel-before-start race.
                if let Some(handle) = watcher_state.lock().as_ref() { handle.interrupt(); }
                tokio::select! {
                    _ = watcher_done.cancelled() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
                }
            }
        });
        let abandoned = cancel.clone().drop_guard();
        let sql = sql.to_string(); let namespace = namespace.map(str::to_string);
        let result = tokio::task::spawn_blocking(move || {
            let _completion = DuckQueryCompletion { state: state.clone(), done };
            if cancel.is_cancelled() { return Err(DbError::Cancelled); }
            let result = (|| {
                let original = if let Some(schema) = namespace.as_deref().filter(|s| !s.trim().is_empty()) {
                    let current: String = conn.query_row("SELECT current_schema()", [], |r| r.get(0))
                        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
                    conn.execute_batch(&format!("USE {}", quote_ident(DatabaseType::Duckdb, schema)))
                        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
                    Some(current)
                } else { None };
                let result = duckdb_query_on_conn(&conn, &sql, max_rows);
                // Stop interrupts before restoring session state; the lock is still held.
                state.lock().take();
                if let Some(original) = original {
                    conn.execute_batch(&format!("USE {}", quote_ident(DatabaseType::Duckdb, &original)))
                        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
                }
                result
            })();
            if result.is_err() && cancel.is_cancelled() { Err(DbError::Cancelled) } else { result }
        }).await.map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let _ = watcher.await;
        let _ = abandoned.disarm();
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

        // ---- Per-column comments via duckdb_columns() (DuckDB-specific view) ----
        // Best-effort: empty map if the view/column is unavailable.
        let column_comments = query_column_comments(&conn, &catalog, schema_name, table)
            .unwrap_or_default();

        // ---- Table comment via duckdb_tables() (DuckDB-specific view) ----
        let table_comment = query_table_comment(&conn, &catalog, schema_name, table)
            .unwrap_or_default();

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
                let comment = column_comments.get(&name).cloned().unwrap_or_default();
                ColumnDef {
                    name,
                    type_name,
                    nullable,
                    default,
                    key: key.into(),
                    comment,
                }
            })
            .collect();

        // DuckDB 暂无表级触发器概念(本驱动不内省触发器)。
        Ok(TableStructure { comment: table_comment, columns, indexes, fks, triggers: Vec::new() })
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
            // DuckDB 当前内省查询未带出约束名;留空,前端不提供删除外键入口。
            constraint_name: None,
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

/// Query per-column comments from the DuckDB-specific `duckdb_columns()` view.
/// Returns a map of column_name → comment (only non-empty comments are kept).
/// Best-effort: returns empty map on any error (older DuckDB without the comment column).
fn query_column_comments(
    conn: &Connection,
    catalog: &str,
    schema: &str,
    table: &str,
) -> Result<std::collections::HashMap<String, String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT column_name, comment \
         FROM duckdb_columns() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ?",
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let rows = stmt.query_map(
        [catalog, schema, table],
        |row| {
            let name: String = row.get(0)?;
            let comment: Option<String> = row.get(1)?;
            Ok((name, comment))
        },
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

    let mut map = std::collections::HashMap::new();
    for item in rows {
        let (name, comment) = item.map_err(|e| DbError::QueryFailed(e.to_string()))?;
        if let Some(c) = comment.filter(|s| !s.is_empty()) {
            map.insert(name, c);
        }
    }
    Ok(map)
}

/// Query the table-level comment from the DuckDB-specific `duckdb_tables()` view.
/// Best-effort: returns empty string on any error (older DuckDB without the comment column).
fn query_table_comment(
    conn: &Connection,
    catalog: &str,
    schema: &str,
    table: &str,
) -> Result<String, DbError> {
    let comment: Option<String> = conn.query_row(
        "SELECT comment FROM duckdb_tables() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ?",
        [catalog, schema, table],
        |row| row.get::<_, Option<String>>(0),
    ).map_err(|e| DbError::QueryFailed(e.to_string()))?;
    Ok(comment.unwrap_or_default())
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

#[cfg(test)]
mod comment_tests {
    use super::*;

    /// 端到端：建表 + COMMENT ON，验证列注释与表注释被读出并填入结构。
    #[tokio::test]
    async fn structure_populates_column_and_table_comments() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name VARCHAR); \
             COMMENT ON TABLE t IS 'people table'; \
             COMMENT ON COLUMN t.name IS 'full name';",
        ).unwrap();
        let driver = DuckDbDriver { conn: Arc::new(Mutex::new(conn)) };

        let st = driver.table_structure("main", "t").await.unwrap();
        assert_eq!(st.comment, "people table", "表注释应来自 duckdb_tables().comment");

        let name_col = st.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name_col.comment, "full name", "列注释应来自 duckdb_columns().comment");

        let id_col = st.columns.iter().find(|c| c.name == "id").unwrap();
        assert_eq!(id_col.comment, "", "无注释的列保持空字符串");
    }
}
