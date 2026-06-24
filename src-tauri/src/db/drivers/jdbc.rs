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
use std::time::Duration;
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
    /// Tail of the sidecar's stderr, drained on a background thread. Surfaced when
    /// the process dies unexpectedly so a JVM crash (e.g. a driver `Error`, a bad
    /// JAR, or an incompatible Java version) is diagnosable instead of an opaque EOF.
    stderr_buf: Arc<Mutex<String>>,
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

/// A jar is usable only if it exists *and* is non-empty — a 0-byte file (e.g. the
/// gitignored dev placeholder, or a `mvn package` that failed mid-bundle) must be
/// treated as absent so we surface the clear "not found" error instead of spawning
/// Java against an empty jar.
fn jar_is_usable(p: &std::path::Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

/// Strip Windows verbatim/extended-length prefixes (`\\?\`, `\\?\UNC\`). Tauri's
/// `resolve(BaseDirectory::Resource)` returns such a path, but the JVM's `-jar`
/// launcher cannot open a jar addressed by a verbatim path — it fails with
/// "错误: 尝试打开文件 \\?\…jar 时出现意外错误". No-op on non-Windows / plain paths.
fn de_verbatim(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

/// Locate the bundled plugin jar. Env override first (tests/dev + the resource path
/// the app injects at startup), then the build output relative to the crate. The
/// returned path is de-verbatim'd so `java -jar` can open it on Windows.
fn plugin_jar_path() -> Result<PathBuf, DbError> {
    if let Ok(p) = std::env::var("CATIO_JDBC_PLUGIN_JAR") {
        let pb = PathBuf::from(p);
        if jar_is_usable(&pb) { return Ok(de_verbatim(pb)); }
    }
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("jdbc-plugin/target/catio-jdbc-plugin.jar");
    if jar_is_usable(&built) { return Ok(de_verbatim(built)); }
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
        .map(|p| de_verbatim(p).to_string_lossy().into_owned())
        .collect()
}

/// 把 sidecar 回传的驱动错误归类。连接/测试阶段的失败属于 `ConnectFailed`，
/// 不该被包成 `QueryFailed`——否则前端把"连不上数据库"误显示成"query failed"，
/// 误导用户以为是 SQL/库名问题。其余阶段（executeQuery 等）维持 `QueryFailed`。
fn classify_sidecar_error(method: &str, msg: &str) -> DbError {
    if matches!(method, "connect" | "testConnection") {
        DbError::ConnectFailed(enrich_connect_message(msg))
    } else {
        DbError::QueryFailed(msg.to_string())
    }
}

/// 为常见的网络层连接报错补一句可执行的定位提示。达梦（DM）等驱动在主机不可达、
/// 端口错误、服务未启动或被防火墙/IP 白名单拦截时抛"网络通信异常"——这与"数据库
/// 不存在"无关（达梦不在 URL 里带 database，库名/schema 不影响建连），提示如实指向网络层。
fn enrich_connect_message(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if msg.contains("网络通信异常")
        || lower.contains("communication")
        || lower.contains("connection refused")
        || lower.contains("connection timed out")
    {
        format!("{msg}（无法与数据库服务器建立网络连接：请检查主机名/IP 与端口是否正确、\
                 数据库服务是否已启动、网络与防火墙/IP 白名单是否放行）")
    } else {
        msg.to_string()
    }
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
            // 达梦等数据库首次握手较慢(DBeaver 能连成功但耗时偏长),
            // plugin 默认 30s 在弱网/冷启动时偶尔不够,放宽到 60s。
            "connect_timeout_secs": 60,
        });

        let jar = plugin_jar_path()?;
        let mut cmd = Command::new(java_bin());
        cmd.arg("-Dfile.encoding=UTF-8")
            .arg("-jar").arg(&jar)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| {
            DbError::ConnectFailed(format!(
                "无法启动 Java JDBC sidecar（{}）：{e}。请确认已安装 JDK/JRE 17+ 并在 PATH 中，\
                 或设置 JAVA_HOME / CATIO_JAVA_BIN。", java_bin()))
        })?;
        let stdin = BufWriter::new(child.stdin.take().ok_or_else(|| DbError::ConnectFailed("no sidecar stdin".into()))?);
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| DbError::ConnectFailed("no sidecar stdout".into()))?);
        // Drain stderr on a background thread so the OS pipe never fills (which would
        // deadlock the JVM), keeping the tail for crash diagnostics.
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(err) = child.stderr.take() {
            let buf = stderr_buf.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(err);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Ok(mut g) = buf.lock() {
                                if g.len() < 8192 { g.push_str(&line); }
                            }
                        }
                    }
                }
            });
        }
        let proc = Arc::new(Mutex::new(JdbcProc { child, stdin, stdout, next_id: 0, stderr_buf }));

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
                // The sidecar exited without answering. Give the stderr-drain thread
                // a moment to flush the JVM's dying output, then surface it — that's
                // the actual cause (driver Error, incompatible Java, bad JAR, …).
                std::thread::sleep(Duration::from_millis(150));
                let detail = p.stderr_buf.lock().ok().map(|g| g.trim().to_string()).unwrap_or_default();
                return Err(DbError::ConnectFailed(if detail.is_empty() {
                    "JDBC sidecar 意外退出（Java 是否已安装？驱动 JAR 是否就绪？）".into()
                } else {
                    format!("JDBC sidecar 意外退出：{detail}")
                }));
            }
            let v: Value = serde_json::from_str(resp.trim())
                .map_err(|e| DbError::QueryFailed(format!("bad JSON from JDBC sidecar: {e}")))?;
            if let Some(err) = v.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown JDBC error");
                return Err(classify_sidecar_error(&method, msg));
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

/// Map the plugin's getColumns result → catio ColumnDef list.
/// Column comments come from each entry's `comment` (sidecar maps it from the
/// DatabaseMetaData.getColumns() REMARKS column).
fn map_column_defs(v: &Value) -> Vec<ColumnDef> {
    v.as_array().map(|arr| {
        arr.iter().map(|c| {
            let is_pk = c.get("is_primary_key").and_then(|x| x.as_bool()).unwrap_or(false);
            ColumnDef {
                name: c.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                type_name: c.get("data_type").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                nullable: c.get("is_nullable").and_then(|n| n.as_bool()).unwrap_or(true),
                default: c.get("column_default").and_then(|n| n.as_str()).map(str::to_string),
                key: if is_pk { "PK".into() } else { String::new() },
                comment: c.get("comment").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
            }
        }).collect()
    }).unwrap_or_default()
}

/// Find the table-level comment for `table` in a listTables result. The comment
/// comes from getTables()'s REMARKS column (surfaced as `comment` per table).
fn table_comment_for(tables: &Value, table: &str) -> String {
    tables.as_array().and_then(|arr| {
        arr.iter().find(|t| {
            t.get("name").and_then(|n| n.as_str()) == Some(table)
        }).and_then(|t| t.get("comment").and_then(|c| c.as_str()).map(str::to_string))
    }).unwrap_or_default()
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

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        let plugin_max = if max_rows == 0 { 1_000_000 } else { max_rows };
        let mut params = json!({ "sql": sql, "maxRows": plugin_max });
        if let Some(namespace) = default_namespace.map(str::trim).filter(|s| !s.is_empty()) {
            if let Value::Object(ref mut m) = params {
                // The sidecar mirrors DBX's execution context support:
                // JDBC catalog/database engines consume `database`, schema-aware
                // engines consume `schema`, unsupported drivers ignore either.
                m.insert("database".into(), json!(namespace));
                m.insert("schema".into(), json!(namespace));
            }
        }
        let r = self.rpc("executeQuery", params).await?;
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
        // Column comments ride in each column's `comment` (sidecar maps it from
        // DatabaseMetaData.getColumns()'s REMARKS).
        let columns = map_column_defs(&r);
        // Table comment comes from getTables()'s REMARKS — the listTables RPC already
        // surfaces it per table, so fetch and pick the matching row (best-effort).
        let comment = match self.rpc("listTables", self.meta_params(schema)).await {
            Ok(tables) => table_comment_for(&tables, table),
            Err(_) => String::new(),
        };
        // The simple plugin protocol exposes columns only (no index/FK/trigger introspection).
        Ok(TableStructure { comment, columns, indexes: vec![], fks: vec![], triggers: vec![] })
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
    use super::{classify_sidecar_error, map_column_defs, map_query_result, table_comment_for};
    use crate::db::DbError;
    use serde_json::json;

    #[test]
    fn map_column_defs_pulls_comment_from_remarks() {
        let v = json!([
            { "name": "id", "data_type": "INTEGER", "is_nullable": false, "is_primary_key": true, "comment": "" },
            { "name": "email", "data_type": "VARCHAR", "is_nullable": true, "comment": "用户邮箱" }
        ]);
        let cols = map_column_defs(&v);
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].comment, "", "无注释列保持空字符串");
        assert_eq!(cols[1].comment, "用户邮箱", "列注释应来自 getColumns 的 REMARKS→comment");
        assert_eq!(cols[0].key, "PK");
    }

    #[test]
    fn table_comment_for_picks_matching_table_remarks() {
        let tables = json!([
            { "name": "orders", "table_type": "TABLE", "comment": "订单表" },
            { "name": "users", "table_type": "TABLE", "comment": "用户表" }
        ]);
        assert_eq!(table_comment_for(&tables, "users"), "用户表", "表注释应来自 getTables 的 REMARKS");
        assert_eq!(table_comment_for(&tables, "missing"), "", "未找到的表返回空字符串");
    }

    #[test]
    fn connect_phase_errors_are_connect_failed_not_query_failed() {
        // 达梦在建连阶段抛"网络通信异常"应归为 ConnectFailed，且补网络层提示。
        let e = classify_sidecar_error("connect", "网络通信异常");
        assert!(matches!(e, DbError::ConnectFailed(_)));
        let msg = e.to_string();
        assert!(msg.contains("网络通信异常"));
        assert!(msg.contains("防火墙"), "应补充可执行的网络层定位提示");

        // testConnection 同样属于建连阶段。
        assert!(matches!(classify_sidecar_error("testConnection", "boom"), DbError::ConnectFailed(_)));
    }

    #[test]
    fn query_phase_errors_stay_query_failed() {
        let e = classify_sidecar_error("executeQuery", "ORA-00942: table does not exist");
        assert!(matches!(e, DbError::QueryFailed(_)));
        // 非网络类报错不加提示，原样透传。
        assert_eq!(e.to_string(), "query failed: ORA-00942: table does not exist");
    }

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
