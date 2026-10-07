// adapted from dbx crates/dbx-core/src/db/sqlite.rs, Apache-2.0
//
// Each driver owns one mutexed physical connection; query and batch work runs on
// blocking workers with engine cancellation. Named, random shared-memory URIs let
// query tabs share a database while isolating their transactions and temp tables.

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ForeignKeyDef, TriggerDef, ErRelation};
use crate::db::result::{QueryResult, ColumnInfo, safe_i64_to_json, binary_to_json};

pub struct SqliteDriver {
    conn: Arc<Mutex<Connection>>,
    path: String,
    closed: std::sync::atomic::AtomicBool,
}

impl SqliteDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        // A random URI shares only this database across physical tab sessions.
        // The UI/profile still contains :memory:, not the private runtime URI.
        let path=if args.host.trim().eq_ignore_ascii_case(":memory:") {
            format!("file:catio-{:032x}?mode=memory&cache=shared",rand::random::<u128>())
        } else {args.host.clone()};
        let conn=Connection::open_with_flags(&path,rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_URI)
            .map_err(|e|DbError::ConnectFailed(e.to_string()))?;
        // Enforce declared foreign keys by default; an explicit PRAGMA remains a
        // user-controlled session setting. Do not silently accept orphan rows.
        conn.pragma_update(None, "foreign_keys", true).map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // Validate connectivity with a trivial query
        conn.execute_batch("SELECT 1")
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path, closed: std::sync::atomic::AtomicBool::new(false) })
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

fn sqlite_query_on_conn(conn: &Connection, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::atomic::{AtomicBool, Ordering};
        // Classify the engine's top-level write during preparation, not a SQL prefix
        // (WITH/EXPLAIN/comments make prefix checks unreliable). Shadow-table writes
        // performed later by virtual-table DDL must not become an affected-row receipt.
        // All callers own the connection mutex; no other authorizer is installed here.
        let dml = Arc::new(AtomicBool::new(false));
        let observed = dml.clone();
        let command = Arc::new(AtomicBool::new(false));
        let observed_command = command.clone();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if context.accessor.is_none() {
                match context.action {
                    AuthAction::Insert { table_name } | AuthAction::Delete { table_name }
                    | AuthAction::Update { table_name, .. } => {
                        if !table_name.starts_with("sqlite_") { observed.store(true, Ordering::Relaxed); }
                    }
                    AuthAction::Read { .. } | AuthAction::Select | AuthAction::Function { .. } | AuthAction::Recursive => {}
                    _ => { observed_command.store(true, Ordering::Relaxed); }
                }
            }
            Authorization::Allow
        }));
        let prepared = conn.prepare(sql);
        // Clear on prepare errors as well as success. Never leave a callback on the connection.
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let mut stmt = prepared.map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let col_count = stmt.column_count();

        // Non-row-returning statement (DDL, INSERT, UPDATE, DELETE)
        // Do not confuse command completion with directly affected user rows.
        if col_count == 0 {
            // sqlite3_changes is unchanged by DDL/session commands. Only trust the
            // statement's direct change count when this execution changed total_changes.
            // Do not report the delta itself: it also includes trigger/FK side effects.
            let before = conn.total_changes();
            let direct = stmt.execute([])
                .map_err(|e| DbError::QueryFailed(e.to_string()))?;
            let affected = if dml.load(Ordering::Relaxed) && !command.load(Ordering::Relaxed) && conn.total_changes() != before { direct } else { 0 };
            return Ok(QueryResult {
                binary_cells: Vec::new(),
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
        let mut binary_cells = Vec::new();
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
                let raw = row.get_ref(i).map_err(|e| DbError::QueryFailed(e.to_string()))?;
                if matches!(raw, ValueRef::Blob(_)) { binary_cells.push([rows.len(), i]); }
                let val = value_ref_to_json(raw);
                out.push(val);
            }
            rows.push(out);
        }

        Ok(QueryResult { binary_cells, columns, rows, rows_affected: None, truncated })
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
    fn close(&self) {self.closed.store(true,std::sync::atomic::Ordering::SeqCst);}
    async fn fork_query_session(&self) -> Result<Arc<dyn Driver>,DbError> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {return Err(DbError::NotFound("closed connection".into()));}
        let conn=Connection::open_with_flags(&self.path,rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_URI)
            .map_err(|e|DbError::ConnectFailed(e.to_string()))?;
        conn.pragma_update(None,"foreign_keys",true).map_err(|e|DbError::QueryFailed(e.to_string()))?;
        Ok(Arc::new(Self{conn:Arc::new(Mutex::new(conn)),path:self.path.clone(),closed:std::sync::atomic::AtomicBool::new(false)}))
    }
    async fn transaction_state(&self) -> Result<crate::db::query_session::TransactionState,DbError> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {return Err(DbError::NotFound("closed SQL session".into()));}
        Ok(if self.conn.lock().await.is_autocommit(){crate::db::query_session::TransactionState::Idle}else{crate::db::query_session::TransactionState::Active})
    }
    async fn close_query_session(&self) -> Result<(),DbError> {
        self.close();let conn=self.conn.lock().await;
        if !conn.is_autocommit(){conn.execute_batch("ROLLBACK").map_err(|e|DbError::QueryFailed(e.to_string()))?;}
        Ok(())
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        self.query_cancellable(sql, max_rows, None, tokio_util::sync::CancellationToken::new()).await
    }

    async fn query_cancellable(&self, sql: &str, max_rows: u32, _namespace: Option<&str>,
        cancel: tokio_util::sync::CancellationToken) -> Result<QueryResult, DbError> {
        let conn = tokio::select! {
            _ = cancel.cancelled() => return Err(DbError::Cancelled),
            conn = self.conn.clone().lock_owned() => conn,
        };
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {return Err(DbError::NotFound("closed SQL session".into()));}
        let sql = sql.to_string();
        tokio::task::spawn_blocking(move || {
            if cancel.is_cancelled() { return Err(DbError::Cancelled); }
            let hook = cancel.clone();
            // A progress hook handles cancellation-before-execution too. Calling only
            // sqlite3_interrupt before a statement starts would lose that signal.
            conn.progress_handler(1000, Some(move || hook.is_cancelled()));
            let result = sqlite_query_on_conn(&conn, &sql, max_rows);
            conn.progress_handler(0, None::<fn() -> bool>);
            if result.is_err() && cancel.is_cancelled() { Err(DbError::Cancelled) } else { result }
        }).await.map_err(|e| DbError::QueryFailed(e.to_string()))?
    }

    async fn default_namespace(&self)->Result<Option<String>,DbError>{Ok(Some("main".into()))}
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
                    comment: String::new(),
                }
            })
            .collect();

        // ---- foreign keys ----
        // SQLite FK 没有可用于 ALTER TABLE DROP 的命名约束(只能整表重建),故 constraint_name 留空;
        // 前端据此不提供「删除外键」入口(与 T02 拒绝 SQLite DROP FOREIGN KEY 一致)。
        let fks: Vec<ForeignKeyDef> = fk_rows.into_iter().map(|(col, ref_table, ref_col, on_delete, on_update)| {
            ForeignKeyDef {
                column: col,
                references: format!("main.{}.{}", ref_table, ref_col),
                on_delete,
                on_update,
                constraint_name: None,
            }
        }).collect();

        // ---- triggers via sqlite_master ----
        let trg_sql = "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 ORDER BY name";
        let mut trg_stmt = conn.prepare(trg_sql)
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let triggers: Vec<TriggerDef> = trg_stmt
            .query_map([table], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
            .into_iter()
            .map(|name| TriggerDef { name, timing: None, event: None })
            .collect();

        Ok(TableStructure { comment: String::new(), columns, indexes, fks, triggers })
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        let conn=self.conn.lock().await;
        let namespace=if schema.is_empty(){"main"}else{schema};
        let ns=namespace.replace('"',"\"\"");
        let mut stmt=conn.prepare(&format!("SELECT name FROM \"{ns}\".sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
            .map_err(|e|DbError::QueryFailed(e.to_string()))?;
        let tables=stmt.query_map([],|row|row.get::<_,String>(0)).map_err(|e|DbError::QueryFailed(e.to_string()))?
            .collect::<Result<Vec<_>,_>>().map_err(|e|DbError::QueryFailed(e.to_string()))?;
        let mut relations=Vec::new();
        for table in tables {
            let quoted=table.replace('"',"\"\"");
            let mut stmt=conn.prepare(&format!("PRAGMA \"{ns}\".foreign_key_list(\"{quoted}\")")).map_err(|e|DbError::QueryFailed(e.to_string()))?;
            let keys=stmt.query_map([],|row|Ok((row.get::<_,i64>("id")?,row.get::<_,i64>("seq")?,row.get::<_,String>("from")?,row.get::<_,String>("table")?,row.get::<_,Option<String>>("to")?)))
                .map_err(|e|DbError::QueryFailed(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|DbError::QueryFailed(e.to_string()))?;
            for (id,seq,from_col,target,to_col) in &keys {
                let width=keys.iter().filter(|k|k.0==*id).count();
                let to_col=if let Some(col)=to_col{col.clone()}else{
                    // REFERENCES table with no explicit column list means its ordered PK.
                    let target_quoted=target.replace('"',"\"\"");
                    let mut primary=conn.prepare(&format!("PRAGMA \"{ns}\".table_info(\"{target_quoted}\")")).map_err(|e|DbError::QueryFailed(e.to_string()))?;
                    let mut columns=primary.query_map([],|row|Ok((row.get::<_,i64>("pk")?,row.get::<_,String>("name")?)))
                        .map_err(|e|DbError::QueryFailed(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|DbError::QueryFailed(e.to_string()))?;
                    columns.retain(|(pk,_)|*pk>0);columns.sort_by_key(|(pk,_)|*pk);
                    if columns.len()==width{columns.get(*seq as usize).map(|(_,name)|name.clone()).unwrap_or_default()}else{String::new()}
                };
                relations.push(ErRelation{from:table.clone(),from_col:from_col.clone(),to:target.clone(),to_col,
                    from_schema:Some(namespace.into()),to_schema:Some(namespace.into()),constraint_id:Some(format!("sqlite-fk-{id}")),
                    ordinal:Some(*seq as u32+1),column_count:Some(width as u32)});
            }
        }
        Ok(ErRelation::complete_groups(relations))
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;

    fn affected(conn: &Connection, sql: &str) -> Option<u64> {
        sqlite_query_on_conn(conn, sql, 100).unwrap().rows_affected
    }

    #[test]
    fn commands_do_not_inherit_previous_dml_changes() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(affected(&conn, "CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)"), Some(0));
        assert_eq!(affected(&conn, "INSERT INTO t VALUES (1,'a'), (2,'b')"), Some(2));
        for sql in ["CREATE INDEX idx ON t(value)", "PRAGMA user_version=3", "BEGIN", "SAVEPOINT s", "RELEASE s", "COMMIT", "CREATE TABLE copy AS SELECT * FROM t", "DROP TABLE copy"] {
            assert_eq!(affected(&conn, sql), Some(0), "stale receipt for {sql}");
        }
        assert_eq!(affected(&conn, "UPDATE t SET value='none' WHERE id=999"), Some(0));
        assert_eq!(affected(&conn, "UPDATE t SET value='changed' WHERE id=1"), Some(1));
        assert_eq!(affected(&conn, "DELETE FROM t WHERE id=2"), Some(1));
    }

    #[test]
    fn virtual_table_commands_do_not_report_shadow_table_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1),(2);").unwrap();
        assert_eq!(affected(&conn, "CREATE VIRTUAL TABLE search USING fts5(body)"), Some(0));
        assert_eq!(affected(&conn, "INSERT INTO search VALUES('hello')"), Some(1));
        assert_eq!(affected(&conn, "DROP TABLE search"), Some(0));
        assert_eq!(affected(&conn, "WITH values_to_add(id) AS (SELECT 3) INSERT INTO t SELECT id FROM values_to_add"), Some(1));
        assert!(sqlite_query_on_conn(&conn, "INSERT invalid SQL", 10).is_err());
        assert_eq!(affected(&conn, "INSERT INTO t VALUES(4)"), Some(1));
    }

    #[test]
    fn row_count_excludes_trigger_side_effects() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(id INTEGER); CREATE TABLE audit(id INTEGER); CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.id); INSERT INTO audit VALUES(new.id); END;").unwrap();
        assert_eq!(affected(&conn, "INSERT INTO t VALUES(1),(2)"), Some(2));
        assert_eq!(affected(&conn, "CREATE TABLE another(id INTEGER)"), Some(0));
        let result = sqlite_query_on_conn(&conn, "SELECT count(*) FROM audit", 100).unwrap();
        assert_eq!(result.rows_affected, None);
        assert_eq!(result.rows[0][0], serde_json::json!(4));
    }
}
