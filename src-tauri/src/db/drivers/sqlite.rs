// adapted from dbx crates/dbx-core/src/db/sqlite.rs, Apache-2.0
//
// Async-wrapping choice: SqliteDriver holds Arc<tokio::sync::Mutex<rusqlite::Connection>>.
// All Driver methods lock the mutex and call rusqlite synchronously *without* spawn_blocking.
// Rationale: rusqlite::Connection is !Sync, so it cannot be moved into spawn_blocking without
// Arc<std::sync::Mutex<>> + unwrap dance. For SQLite (local/in-memory, fast ops) doing the sync
// work while holding a tokio async Mutex is acceptable — no network latency, no long blocking.
// The critical correctness requirement for :memory: is satisfied: the SAME Connection instance
// is reused across all calls (no new open per query).

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, ErRelation};
use crate::db::result::{QueryResult, ColumnInfo, safe_i64_to_json, binary_to_json};

pub struct SqliteDriver {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteDriver {
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

/// Map a rusqlite ValueRef to serde_json::Value.
/// Adapted from dbx crates/dbx-core/src/db/sqlite.rs value_ref_to_json, Apache-2.0.
fn value_ref_to_json(val: ValueRef<'_>) -> serde_json::Value {
    match val {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(v) => safe_i64_to_json(v),
        ValueRef::Real(v) => serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(v) => serde_json::Value::String(
            String::from_utf8_lossy(v).to_string(),
        ),
        ValueRef::Blob(v) => binary_to_json(v),
    }
}

#[async_trait]
impl Driver for SqliteDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Sqlite }

    async fn test(&self) -> Result<String, DbError> {
        let conn = self.conn.lock().await;
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(format!("SQLite {}", version))
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let conn = self.conn.lock().await;

        let mut stmt = conn.prepare(sql)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let col_count = stmt.column_count();

        // Non-row-returning statement (DDL, INSERT, UPDATE, DELETE)
        // Use the already-prepared statement to avoid recompiling the SQL.
        if col_count == 0 {
            let affected = stmt.execute([])
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            return Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(affected as u64),
                truncated: false,
            });
        }

        // Build column info using column_decltype feature (name + declared type)
        let columns: Vec<ColumnInfo> = stmt.columns().into_iter().map(|c| {
            let name = c.name().to_string();
            let type_name = c.decl_type().unwrap_or("").to_string();
            ColumnInfo { name, type_name, pk: false }
        }).collect();

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut truncated = false;

        let mut query_rows = stmt.query([])
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

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

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Ok(vec!["main".to_string()])
    }

    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
        // adapted from dbx crates/dbx-core/src/db/sqlite.rs list_tables, Apache-2.0
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let rows = stmt.query_map([], |row| {
            let name: String = row.get(0)?;
            let ttype: String = row.get(1)?;
            Ok((name, ttype))
        }).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut tables = Vec::new();
        for item in rows {
            let (name, ttype) = item.map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let kind = if ttype == "view" { "view" } else { "table" };
            tables.push(TableInfo { name, kind: kind.into(), rows_estimate: None });
        }
        Ok(tables)
    }

    async fn table_structure(&self, _schema: &str, table: &str) -> Result<TableStructure, DbError> {
        // adapted from dbx crates/dbx-core/src/db/sqlite.rs get_columns/list_indexes/list_foreign_keys, Apache-2.0
        let conn = self.conn.lock().await;
        let safe_table = table.replace('"', "\"\"");

        // ---- collect FK columns for key annotation ----
        let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", safe_table);
        let mut fk_stmt = conn.prepare(&fk_sql)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let fk_rows: Vec<(String, String, String, String, String)> = fk_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>("from")?,      // local column
                    row.get::<_, String>("table")?,     // referenced table
                    row.get::<_, String>("to")?,        // referenced column
                    row.get::<_, String>("on_delete").unwrap_or_else(|_| "NO ACTION".into()),
                    row.get::<_, String>("on_update").unwrap_or_else(|_| "NO ACTION".into()),
                ))
            })
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let fk_cols: std::collections::HashSet<String> =
            fk_rows.iter().map(|(col, _, _, _, _)| col.clone()).collect();

        // ---- indexes via PRAGMA index_list + index_info ----
        // Collected before columns so we can build uni_cols for key annotation.
        let idx_list_sql = format!("PRAGMA index_list(\"{}\")", safe_table);
        let mut idx_stmt = conn.prepare(&idx_list_sql)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let idx_list: Vec<(String, bool)> = idx_stmt
            .query_map([], |row| {
                let name: String = row.get("name")?;
                let unique: i32 = row.get("unique")?;
                Ok((name, unique != 0))
            })
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut indexes: Vec<IndexDef> = Vec::new();
        // Columns that belong to a single-column UNIQUE index (for "UNI" key annotation).
        let mut uni_cols: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (idx_name, unique) in idx_list {
            let safe_idx = idx_name.replace('"', "\"\"");
            let col_info_sql = format!("PRAGMA index_info(\"{}\")", safe_idx);
            let mut ci_stmt = conn.prepare(&col_info_sql)
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let col_names: Vec<String> = ci_stmt
                .query_map([], |row| row.get::<_, String>("name"))
                .map_err(|e| DbError::QueryFailed(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            // A single-column unique index makes that column "UNI".
            if unique && col_names.len() == 1 {
                uni_cols.insert(col_names[0].clone());
            }
            indexes.push(IndexDef {
                name: idx_name,
                columns: col_names.join(", "),
                unique,
                method: "btree".into(),
            });
        }

        // ---- columns via PRAGMA table_info ----
        let col_sql = format!("PRAGMA table_info(\"{}\")", safe_table);
        let mut col_stmt = conn.prepare(&col_sql)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let columns: Vec<ColumnDef> = col_stmt
            .query_map([], |row| {
                let name: String = row.get("name")?;
                let type_name: Option<String> = row.get("type")?;
                let notnull: i32 = row.get("notnull")?;
                let dflt: Option<String> = row.get("dflt_value")?;
                let pk: i32 = row.get("pk")?;
                Ok((name, type_name.unwrap_or_default(), notnull, dflt, pk))
            })
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .into_iter()
            .map(|(name, type_name, notnull, default, pk)| {
                // Key precedence: PK > FK > UNI > ""
                let key = if pk > 0 {
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
                    nullable: notnull == 0,
                    default,
                    key: key.into(),
                }
            })
            .collect();

        // ---- foreign keys ----
        let fks: Vec<ForeignKeyDef> = fk_rows.into_iter().map(|(col, ref_table, ref_col, on_delete, on_update)| {
            ForeignKeyDef {
                column: col,
                references: format!("main.{}.{}", ref_table, ref_col),
                on_delete,
                on_update,
            }
        }).collect();

        Ok(TableStructure { columns, indexes, fks })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        // adapted from dbx crates/dbx-core/src/db/sqlite.rs list_foreign_keys (schema-level), Apache-2.0
        // Iterate all tables and collect their foreign_key_list relations.
        let conn = self.conn.lock().await;

        let mut tbl_stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let tables: Vec<String> = tbl_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut relations: Vec<ErRelation> = Vec::new();
        for tbl in tables {
            let safe_tbl = tbl.replace('"', "\"\"");
            let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", safe_tbl);
            let mut fk_stmt = conn.prepare(&fk_sql)
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let fk_rows = fk_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>("from")?,
                        row.get::<_, String>("table")?,
                        row.get::<_, String>("to")?,
                    ))
                })
                .map_err(|e| DbError::QueryFailed(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            for (from_col, to_tbl, to_col) in fk_rows {
                relations.push(ErRelation {
                    from: tbl.clone(),
                    from_col,
                    to: to_tbl,
                    to_col,
                });
            }
        }

        Ok(relations)
    }
}
