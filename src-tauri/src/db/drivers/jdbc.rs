//! JDBC driver: bridges catio's `Driver` trait to the Java sidecar plugin
//! (`src-tauri/jdbc-plugin`) over a newline-delimited JSON line protocol — the
//! same shape proven by the plugin's H2 self-test.
//!
//! One Java process per connection; the connection params (incl. secret) ride in
//! every request's `connection` object and the plugin caches the live JDBC
//! Connection by key, so repeated calls reuse it. The process is killed on drop.
//!
//! Driver JARs for proprietary engines are user-supplied: every *.jar found in
//! the drivers dir (env `CATIO_JDBC_DRIVERS_DIR`, else <app>/jdbc/drivers) is
//! passed as `jdbc_driver_paths`. H2 is bundled in the plugin jar, so the
//! built-in self-test needs no external driver.

use async_trait::async_trait;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation, ColumnDef};
use crate::db::result::{QueryResult, ColumnInfo};
use super::jdbc_config;

struct JdbcProc {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

pub struct JdbcDriver {
    proc: Arc<Mutex<JdbcProc>>,
    /// The `connection` object sent with every request (holds the secret —
    /// in-memory only, never logged or persisted).
    connection: Value,
    /// The database the user connected to (passed as `database` in metadata calls).
    database: String,
}

// ── process / jar / java location ────────────────────────────────────────────

/// Locate the bundled plugin jar. Env override first (tests/dev), then the
/// build output relative to the crate, then a Tauri-resource-style fallback.
fn plugin_jar_path() -> Result<PathBuf, DbError> {
    if let Ok(p) = std::env::var("CATIO_JDBC_PLUGIN_JAR") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Ok(pb); }
    }
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("jdbc-plugin/target/catio-jdbc-plugin.jar");
    if built.exists() { return Ok(built); }
    Err(DbError::ConnectFailed(
        "JDBC plugin jar not found — build src-tauri/jdbc-plugin (mvn package) \
         or set CATIO_JDBC_PLUGIN_JAR".into()))
}

/// Locate the `java` binary: env override, JAVA_HOME, else PATH.
fn java_bin() -> String {
    if let Ok(b) = std::env::var("CATIO_JAVA_BIN") {
        if !b.is_empty() { return b; }
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let candidate = PathBuf::from(&home).join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
        if candidate.exists() { return candidate.to_string_lossy().into_owned(); }
    }
    "java".to_string()
}

/// Collect user-supplied driver JAR paths from the drivers dir (best-effort).
fn driver_jar_paths() -> Vec<String> {
    let dir = match std::env::var("CATIO_JDBC_DRIVERS_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => return vec![],
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("jar")) == Some(true))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

impl JdbcDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let profile = args.driver_profile.as_deref().ok_or_else(|| {
            DbError::ConnectFailed("JDBC connections require a driver_profile (engine id)".into())
        })?;
        let database = args.database.clone().unwrap_or_default();
        let target = jdbc_config::build(profile, &args.host, args.port, &database)?;

        let connection = json!({
            "connection_string": target.url,
            "jdbc_driver_class": target.driver_class,
            "jdbc_driver_paths": driver_jar_paths(),
            "username": args.user,
            "password": args.secret.clone().unwrap_or_default(),
            "database": database,
        });

        let jar = plugin_jar_path()?;
        let mut cmd = Command::new(java_bin());
        cmd.arg("-Dfile.encoding=UTF-8")
            .arg("-jar").arg(&jar)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| {
            DbError::ConnectFailed(format!("failed to spawn Java JDBC sidecar ({}): {e}", java_bin()))
        })?;
        let stdin = BufWriter::new(child.stdin.take().ok_or_else(|| DbError::ConnectFailed("no sidecar stdin".into()))?);
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| DbError::ConnectFailed("no sidecar stdout".into()))?);
        let proc = Arc::new(Mutex::new(JdbcProc { child, stdin, stdout, next_id: 0 }));

        let driver = Self { proc, connection, database };
        // Validate connectivity now (also primes the cached JDBC connection).
        driver.rpc("connect", json!({})).await?;
        Ok(driver)
    }

    /// One JSON-RPC round-trip. Runs the blocking line IO on a blocking thread.
    async fn rpc(&self, method: &str, extra: Value) -> Result<Value, DbError> {
        let proc = self.proc.clone();
        let connection = self.connection.clone();
        let method = method.to_string();
        tokio::task::spawn_blocking(move || -> Result<Value, DbError> {
            let mut guard = proc.lock().map_err(|_| DbError::QueryFailed("JDBC sidecar lock poisoned".into()))?;
            let p = &mut *guard;
            p.next_id += 1;
            let id = p.next_id;
            let mut params = extra;
            if let Value::Object(ref mut m) = params {
                m.insert("connection".into(), connection);
            } else {
                params = json!({ "connection": connection });
            }
            let req = json!({ "id": id, "method": method, "params": params });
            let line = serde_json::to_string(&req).map_err(|e| DbError::QueryFailed(e.to_string()))?;
            p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.write_all(b"\n")).and_then(|_| p.stdin.flush())
                .map_err(|e| DbError::ConnectFailed(format!("JDBC sidecar write failed: {e}")))?;

            let mut resp = String::new();
            let n = p.stdout.read_line(&mut resp)
                .map_err(|e| DbError::ConnectFailed(format!("JDBC sidecar read failed: {e}")))?;
            if n == 0 {
                return Err(DbError::ConnectFailed("JDBC sidecar closed unexpectedly (is Java installed / driver JAR present?)".into()));
            }
            let v: Value = serde_json::from_str(resp.trim())
                .map_err(|e| DbError::QueryFailed(format!("bad JSON from JDBC sidecar: {e}")))?;
            if let Some(err) = v.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown JDBC error");
                return Err(DbError::QueryFailed(msg.to_string()));
            }
            Ok(v.get("result").cloned().unwrap_or(Value::Null))
        })
        .await
        .map_err(|e| DbError::QueryFailed(format!("JDBC sidecar task failed: {e}")))?
    }

    fn meta_params(&self, schema: &str) -> Value {
        json!({ "database": self.database, "schema": schema })
    }
}

impl Drop for JdbcDriver {
    fn drop(&mut self) {
        if let Ok(mut g) = self.proc.lock() {
            let _ = g.child.kill();
            let _ = g.child.wait();
        }
    }
}

/// Map the plugin's executeQuery result → catio QueryResult.
fn map_query_result(v: &Value, max_rows: u32) -> QueryResult {
    let columns: Vec<ColumnInfo> = v.get("columns").and_then(|c| c.as_array()).map(|arr| {
        arr.iter().map(|n| ColumnInfo {
            name: n.as_str().unwrap_or_default().to_string(),
            type_name: String::new(),
            pk: false,
        }).collect()
    }).unwrap_or_default();

    let mut truncated = v.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false);
    let mut rows: Vec<Vec<Value>> = v.get("rows").and_then(|r| r.as_array()).map(|arr| {
        arr.iter().filter_map(|row| row.as_array().cloned()).collect()
    }).unwrap_or_default();
    if max_rows > 0 && rows.len() as u32 > max_rows {
        rows.truncate(max_rows as usize);
        truncated = true;
    }

    let affected = v.get("affected_rows").and_then(|a| a.as_u64());
    let rows_affected = if columns.is_empty() { affected.or(Some(0)) } else { None };
    QueryResult { columns, rows, rows_affected, truncated }
}

#[async_trait]
impl Driver for JdbcDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Jdbc }

    async fn test(&self) -> Result<String, DbError> {
        let r = self.rpc("testConnection", json!({})).await?;
        Ok(r.get("version").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .unwrap_or("JDBC connected").to_string())
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        // maxRows 0 means "no cap" to us; the plugin defaults to its own cap, so
        // pass a large value when uncapped (writes ignore it).
        let plugin_max = if max_rows == 0 { 1_000_000 } else { max_rows };
        let r = self.rpc("executeQuery", json!({ "sql": sql, "maxRows": plugin_max })).await?;
        Ok(map_query_result(&r, max_rows))
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let r = self.rpc("listSchemas", self.meta_params("")).await?;
        let mut out: Vec<String> = r.as_array().map(|arr| {
            arr.iter().filter_map(|s| {
                // listSchemas yields plain strings; tolerate {name} objects too.
                s.as_str().map(str::to_string)
                    .or_else(|| s.get("name").and_then(|n| n.as_str()).map(str::to_string))
            }).collect()
        }).unwrap_or_default();
        if out.is_empty() {
            // Some engines (MySQL-family over JDBC) expose catalogs, not schemas;
            // fall back to the connected database so the tree is never empty.
            if !self.database.is_empty() { out.push(self.database.clone()); }
            else { out.push("default".into()); }
        }
        Ok(out)
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let r = self.rpc("listTables", self.meta_params(schema)).await?;
        Ok(r.as_array().map(|arr| {
            arr.iter().map(|t| {
                let ty = t.get("table_type").and_then(|x| x.as_str()).unwrap_or("TABLE");
                let kind = if ty.to_uppercase().contains("VIEW") { "view" } else { "table" };
                TableInfo {
                    name: t.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                    kind: kind.to_string(),
                    rows_estimate: None,
                }
            }).collect()
        }).unwrap_or_default())
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        let mut params = self.meta_params(schema);
        if let Value::Object(ref mut m) = params { m.insert("table".into(), json!(table)); }
        let r = self.rpc("getColumns", params).await?;
        let columns: Vec<ColumnDef> = r.as_array().map(|arr| {
            arr.iter().map(|c| {
                let is_pk = c.get("is_primary_key").and_then(|x| x.as_bool()).unwrap_or(false);
                ColumnDef {
                    name: c.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                    type_name: c.get("data_type").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                    nullable: c.get("is_nullable").and_then(|n| n.as_bool()).unwrap_or(true),
                    default: c.get("column_default").and_then(|n| n.as_str()).map(str::to_string),
                    key: if is_pk { "PK".into() } else { String::new() },
                }
            }).collect()
        }).unwrap_or_default();
        // The simple plugin protocol exposes columns only (no index/FK introspection).
        Ok(TableStructure { columns, indexes: vec![], fks: vec![] })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        Err(DbError::Unsupported("ER relations are not available over the JDBC sidecar".into()))
    }

    async fn list_functions(&self, schema: &str) -> Result<Vec<String>, DbError> {
        let r = self.rpc("listObjects", self.meta_params(schema)).await?;
        Ok(r.as_array().map(|arr| {
            arr.iter().filter(|o| {
                let ty = o.get("object_type").and_then(|x| x.as_str()).unwrap_or("").to_uppercase();
                ty == "FUNCTION" || ty == "PROCEDURE"
            }).filter_map(|o| o.get("name").and_then(|n| n.as_str()).map(str::to_string)).collect()
        }).unwrap_or_default())
    }

    async fn object_source(&self, schema: &str, name: &str, kind: &str) -> Result<String, DbError> {
        let mut params = self.meta_params(schema);
        if let Value::Object(ref mut m) = params {
            m.insert("name".into(), json!(name));
            m.insert("object_type".into(), json!(kind.to_uppercase()));
        }
        // get_object_source is Oracle-only in the plugin; others throw → "".
        match self.rpc("getObjectSource", params).await {
            Ok(r) => Ok(r.get("source").and_then(|s| s.as_str()).unwrap_or_default().to_string()),
            Err(_) => Ok(String::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::map_query_result;
    use serde_json::json;

    #[test]
    fn maps_select_result_columns_and_rows() {
        let v = json!({ "columns": ["ID","NAME"], "rows": [[1,"alpha"],[2,"beta"]], "affected_rows": 0, "truncated": false });
        let q = map_query_result(&v, 1000);
        assert_eq!(q.columns.len(), 2);
        assert_eq!(q.columns[0].name, "ID");
        assert_eq!(q.rows.len(), 2);
        assert_eq!(q.rows[1][1], json!("beta"));
        assert!(q.rows_affected.is_none(), "selects carry no rows_affected");
    }

    #[test]
    fn maps_write_result_to_rows_affected() {
        let v = json!({ "columns": [], "rows": [], "affected_rows": 3, "truncated": false });
        let q = map_query_result(&v, 0);
        assert_eq!(q.rows_affected, Some(3));
        assert!(q.columns.is_empty());
    }

    #[test]
    fn enforces_client_side_max_rows() {
        let v = json!({ "columns": ["N"], "rows": [[1],[2],[3],[4],[5]], "truncated": false });
        let q = map_query_result(&v, 3);
        assert_eq!(q.rows.len(), 3);
        assert!(q.truncated);
    }
}
