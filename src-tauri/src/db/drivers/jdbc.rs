//! JDBC driver: bridges catio's `Driver` trait to the Java sidecar plugin
//! (`src-tauri/jdbc-plugin`) over a newline-delimited JSON line protocol — the
//! same shape proven by the plugin's H2 self-test.
//!
//! One Java process per connection; the connection params (incl. secret) ride in
//! every request's `connection` object and the plugin caches the live JDBC
//! Connection by session ID and key. Child sessions share the JVM, not transactions.
//! Parent disconnect/drop kills the process; a child closes only its own connection.
//!
//! Driver JARs for proprietary engines are user-supplied: every *.jar found in
//! the drivers dir (env `CATIO_JDBC_DRIVERS_DIR`, else <app>/jdbc/drivers) is
//! passed as `jdbc_driver_paths`. H2 is bundled in the plugin jar, so the
//! built-in self-test needs no external driver.

use async_trait::async_trait;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use std::sync::{Arc, atomic::{AtomicBool,Ordering}};
use super::jdbc_transport::JdbcProcess;
use serde_json::{json, Value};

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation, ColumnDef};
use crate::db::result::{QueryResult, ColumnInfo};
use super::jdbc_config;

pub struct JdbcDriver {
    proc: Arc<JdbcProcess>,
    operation: Arc<tokio::sync::Mutex<()>>,
    session_id: String,
    owns_process: bool,
    closed: Arc<AtomicBool>,
    can_cancel: bool,
    caps: crate::db::capabilities::Capabilities,
    // Credentials stay in memory; never log or persist this object.
    connection: Value,
    database: String,
}
struct JdbcAbandoned { proc:Arc<JdbcProcess>,params:Value,closed:Arc<AtomicBool>,armed:bool }
impl Drop for JdbcAbandoned {
    fn drop(&mut self){if self.armed {self.closed.store(true,Ordering::SeqCst);self.proc.detached("closeSession",self.params.clone());}}
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
        let child = cmd.spawn().map_err(|e| {
            DbError::ConnectFailed(format!(
                "无法启动 Java JDBC sidecar（{}）：{e}。请确认已安装 JDK/JRE 17+ 并在 PATH 中，\
                 或设置 JAVA_HOME / CATIO_JAVA_BIN。", java_bin()))
        })?;
        let proc=JdbcProcess::new(child)?;
        let mut driver=Self{proc,operation:Arc::new(tokio::sync::Mutex::new(())),session_id:String::new(),owns_process:true,
            closed:Arc::new(AtomicBool::new(false)),can_cancel:profile=="h2",connection,database,
            caps:crate::db::capabilities::capabilities_for(DatabaseType::Jdbc)};
        // Validate connectivity now (also primes the cached JDBC connection).
        let info = driver.rpc("connect", json!({})).await?;
        driver.caps.query_sessions = info.get("query_sessions").and_then(Value::as_bool).unwrap_or(false);
        driver.caps.transactions = info.get("transactions").and_then(Value::as_bool).unwrap_or(false);
        driver.caps.er = info.get("er").and_then(Value::as_bool).unwrap_or(false);
        driver.caps.writable = info.get("writable").and_then(Value::as_bool).unwrap_or(true);
        Ok(driver)
    }

    fn params(&self,mut params:Value)->Value {
        if !params.is_object(){params=json!({});}
        params["connection"]=self.connection.clone();params["sessionId"]=json!(self.session_id);params
    }
    fn redact(&self,message:&str)->String {
        match self.connection.get("password").and_then(Value::as_str).filter(|s|!s.is_empty()){
            Some(secret)=>message.replace(secret,"<redacted>"),None=>message.to_string(),
        }
    }
    fn response(&self,method:&str,result:Result<Value,String>)->Result<Value,DbError> {
        let mut value=result.map_err(|message|{
            let tail=self.proc.stderr_tail();DbError::ConnectFailed(self.redact(&format!("{message} {tail}")))
        })?;
        if let Some(error)=value.get("error") {
            if matches!(error.get("sql_state").and_then(Value::as_str),Some("57014"|"HY008")){return Err(DbError::Cancelled);}
            return Err(classify_sidecar_error(method,&self.redact(error.get("message").and_then(Value::as_str).unwrap_or("JDBC request failed"))));
        }
        Ok(value.as_object_mut().and_then(|v|v.remove("result")).unwrap_or(Value::Null))
    }
    async fn rpc_unlocked(&self,method:&str,extra:Value)->Result<Value,DbError> {
        let request=self.proc.start(method,self.params(extra))?;
        self.response(method,request.response().await)
    }
    async fn rpc(&self,method:&str,extra:Value)->Result<Value,DbError> {
        let _operation=self.operation.lock().await;
        if self.closed.load(std::sync::atomic::Ordering::SeqCst){return Err(DbError::NotFound("closed JDBC session".into()));}
        self.rpc_unlocked(method,extra).await
    }
    async fn execute_query(&self,sql:&str,max_rows:u32,namespace:Option<&str>,offset:u32,
        cancel:tokio_util::sync::CancellationToken)->Result<QueryResult,DbError> {
        let _operation=tokio::select!{_=cancel.cancelled()=>return Err(DbError::Cancelled),lock=self.operation.lock()=>lock};
        if self.closed.load(std::sync::atomic::Ordering::SeqCst){return Err(DbError::NotFound("closed JDBC session".into()));}
        if cancel.is_cancelled(){return Err(DbError::Cancelled);}
        let mut params=json!({"sql":sql,"maxRows":max_rows.max(1),"offsetRows":offset});
        if let Some(namespace)=namespace.filter(|s|!s.trim().is_empty()){params["database"]=json!(namespace);params["schema"]=json!(namespace);}
        let request=self.proc.start("executeQuery",self.params(params))?;
        let request_id=request.id;let mut response=Box::pin(request.response());
        let mut abandoned=JdbcAbandoned{proc:self.proc.clone(),params:self.params(json!({})),closed:self.closed.clone(),armed:true};
        let received=tokio::select! {
            result=&mut response=>result,
            _=cancel.cancelled()=>{
                let started=std::time::Instant::now();
                loop {
                    // A cancel racing with Statement.execute must not be lost; repeat
                    // only for this request ID, never for whichever statement runs next.
                    let _=tokio::time::timeout(Duration::from_millis(500),self.rpc_unlocked("cancelRequest",json!({"targetRequestId":request_id}))).await;
                    match tokio::time::timeout(Duration::from_millis(100),&mut response).await {
                        Ok(result)=>break result,
                        Err(_) if started.elapsed()>Duration::from_secs(5)=>return Err(DbError::QueryFailed(
                            "JDBC cancellation could not be confirmed. This session is unusable; disconnect the database to terminate its sidecar before retrying writes".into())),
                        Err(_)=>{},
                    }
                }
            }
        };
        abandoned.armed=false;
        Ok(map_query_result(&self.response("executeQuery",received)?,max_rows))
    }

    fn meta_params(&self, schema: &str) -> Value {
        json!({ "database": self.database, "schema": schema })
    }
}

impl Drop for JdbcDriver {
    fn drop(&mut self) { self.close(); }
}

/// Map the plugin's executeQuery result → catio QueryResult.
fn map_query_result(v: &Value, max_rows: u32) -> QueryResult {
    let columns: Vec<ColumnInfo> = v.get("columns").and_then(|c| c.as_array()).map(|arr| {
        arr.iter().enumerate().map(|(index, n)| ColumnInfo {
            name: n.as_str().unwrap_or_default().to_string(),
            type_name: v.get("column_types").and_then(Value::as_array).and_then(|types| types.get(index)).and_then(Value::as_str).unwrap_or("").to_string(),
            pk: false,
        }).collect()
    }).unwrap_or_default();

    let mut truncated = v.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false);
    let mut rows: Vec<Vec<Value>> = v.get("rows").and_then(|r| r.as_array()).map(|arr| {
        arr.iter().filter_map(|row| row.as_array().cloned()).collect()
    }).unwrap_or_default();
    if rows.len() as u32 > max_rows {
        rows.truncate(max_rows as usize);
        truncated = true;
    }

    let affected = v.get("affected_rows").and_then(|a| a.as_u64());
    let rows_affected = if columns.is_empty() { affected.or(Some(0)) } else { None };
    crate::db::typed_value::mark_binary_columns(QueryResult { binary_cells: Vec::new(), columns, rows, rows_affected, truncated })
}

/// Map the plugin's getColumns result → catio ColumnDef list.
/// Column comments come from each entry's `comment` (sidecar maps it from the
/// DatabaseMetaData.getColumns() REMARKS column).
fn column_type_name(column: &Value) -> String {
    let name = column["data_type"].as_str().unwrap_or_default();
    if name.contains('(') { return name.into(); }
    let kind = name.to_ascii_uppercase();
    if matches!(kind.as_str(), "DECIMAL" | "NUMERIC") {
        if let Some(precision) = column["numeric_precision"].as_i64().filter(|p| *p > 0) {
            return match column["numeric_scale"].as_i64() {
                Some(scale) => format!("{name}({precision},{scale})"), None => format!("{name}({precision})"),
            };
        }
    }
    if matches!(kind.as_str(), "CHAR" | "VARCHAR" | "NCHAR" | "NVARCHAR" | "CHARACTER" | "CHARACTER VARYING" | "BINARY" | "VARBINARY" | "BINARY VARYING") {
        if let Some(length) = column["character_maximum_length"].as_i64().filter(|length| *length > 0 && *length < i32::MAX as i64) {
            return format!("{name}({length})");
        }
    }
    if matches!(kind.as_str(), "TIMESTAMP" | "TIME" | "TIMESTAMP WITH TIME ZONE" | "TIME WITH TIME ZONE" | "TIMESTAMP WITHOUT TIME ZONE" | "TIME WITHOUT TIME ZONE") {
        if let Some(scale) = column["numeric_scale"].as_i64().filter(|scale| (0..=9).contains(scale)) {
            let (base, suffix) = name.split_once(' ').map(|(base, suffix)| (base, format!(" {suffix}"))).unwrap_or((name, String::new()));
            return format!("{base}({scale}){suffix}");
        }
    }
    name.into()
}

fn map_column_defs(v: &Value) -> Vec<ColumnDef> {
    v.as_array().map(|arr| {
        arr.iter().map(|c| {
            let is_pk = c.get("is_primary_key").and_then(|x| x.as_bool()).unwrap_or(false);
            ColumnDef {
                name: c.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                type_name: column_type_name(c),
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
    fn capabilities(&self) -> crate::db::capabilities::Capabilities { self.caps }
    fn close(&self) {
        self.closed.store(true,Ordering::SeqCst);
        if self.owns_process {self.proc.close();}else{self.proc.detached("closeSession",self.params(json!({})));}
    }
    fn supports_query_cancel(&self)->bool {self.can_cancel}
    async fn fork_query_session(&self)->Result<Arc<dyn Driver>,DbError> {
        if !self.caps.query_sessions{return Err(DbError::Unsupported("This JDBC plugin does not support independent sessions".into()));}
        if self.closed.load(Ordering::SeqCst){return Err(DbError::NotFound("closed JDBC parent connection".into()));}
        let child=Self{proc:self.proc.clone(),operation:Arc::new(tokio::sync::Mutex::new(())),
            session_id:format!("jdbc-{:032x}",rand::random::<u128>()),owns_process:false,closed:Arc::new(AtomicBool::new(false)),
            can_cancel:self.can_cancel,caps:self.caps,connection:self.connection.clone(),database:self.database.clone()};
        child.rpc("openSession",json!({})).await?;
        Ok(Arc::new(child))
    }
    async fn transaction_state(&self)->Result<crate::db::query_session::TransactionState,DbError> {
        let state=self.rpc("sessionStatus",json!({})).await?;
        Ok(match state.get("transactionState").and_then(Value::as_str) {
            Some("idle")=>crate::db::query_session::TransactionState::Idle,
            Some("manual")=>crate::db::query_session::TransactionState::Manual,
            _=>crate::db::query_session::TransactionState::Unknown,
        })
    }
    async fn transaction_command(&self,action:crate::db::query_session::TransactionAction,cancel:tokio_util::sync::CancellationToken)->Result<(),DbError> {
        use crate::db::query_session::TransactionAction as A;
        if !self.caps.transactions{return Err(DbError::Unsupported("This JDBC engine has no transactions".into()));}
        if cancel.is_cancelled(){return Err(DbError::Cancelled);}
        let method=match action{A::Begin=>"beginTransaction",A::Commit=>"commitTransaction",A::Rollback=>"rollbackTransaction"};
        self.rpc(method,json!({})).await?;Ok(())
    }
    async fn close_query_session(&self)->Result<(),DbError> {
        self.closed.store(true,Ordering::SeqCst);
        let result=self.rpc_unlocked("closeSession",json!({})).await;
        if self.owns_process{self.proc.close();}
        result.map(|_|())
    }
    async fn exec_statement_batch(&self,statements:crate::db::driver::StatementBatch)->Result<u64,DbError> {
        if !self.caps.transactions{return Err(DbError::Unsupported("This JDBC driver does not support transactions".into()));}
        let _operation=self.operation.lock().await;
        if self.closed.load(Ordering::SeqCst){return Err(DbError::NotFound("closed JDBC session".into()));}
        let mut abandoned=JdbcAbandoned{proc:self.proc.clone(),params:self.params(json!({})),closed:self.closed.clone(),armed:true};
        self.rpc_unlocked("beginTransaction",json!({})).await?;
        let mut affected=0;
        for statement in statements {
            let result=match statement {Ok(sql)=>self.rpc_unlocked("executeUpdate",json!({"sql":sql})).await,Err(error)=>Err(error)};
            match result {
                Ok(value)=>affected+=value.get("affected_rows").and_then(Value::as_u64).unwrap_or(0),
                Err(error)=>{if self.rpc_unlocked("rollbackTransaction",json!({})).await.is_ok(){abandoned.armed=false;}return Err(error);}
            }
        }
        self.rpc_unlocked("commitTransaction",json!({})).await?;abandoned.armed=false;Ok(affected)
    }

    async fn test(&self) -> Result<String, DbError> {
        let r = self.rpc("testConnection", json!({})).await?;
        Ok(r.get("version").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .unwrap_or("JDBC connected").to_string())
    }

    async fn query(&self,sql:&str,max_rows:u32)->Result<QueryResult,DbError>{
        self.execute_query(sql,max_rows,None,0,tokio_util::sync::CancellationToken::new()).await
    }
    async fn query_with_default_namespace(&self,sql:&str,max_rows:u32,namespace:Option<&str>)->Result<QueryResult,DbError>{
        self.execute_query(sql,max_rows,namespace,0,tokio_util::sync::CancellationToken::new()).await
    }
    async fn query_cancellable(&self,sql:&str,max_rows:u32,namespace:Option<&str>,cancel:tokio_util::sync::CancellationToken)->Result<QueryResult,DbError>{
        self.execute_query(sql,max_rows,namespace,0,cancel).await
    }
    async fn paginated_query_with_default_namespace(&self,sql:&str,limit:u32,offset:u32,namespace:Option<&str>)->Result<QueryResult,DbError>{
        self.paginated_query_cancellable(sql,limit,offset,namespace,tokio_util::sync::CancellationToken::new()).await
    }
    async fn paginated_query_cancellable(&self,sql:&str,limit:u32,offset:u32,namespace:Option<&str>,cancel:tokio_util::sync::CancellationToken)->Result<QueryResult,DbError>{
        let plan=crate::db::pagination::build_page_plan(DatabaseType::Jdbc,sql,limit,offset)?;
        self.execute_query(&plan.sql,limit,namespace,offset,cancel).await
    }

    async fn default_namespace(&self)->Result<Option<String>,DbError> {
        let result=self.rpc("getExecutionContext",json!({})).await?;
        Ok(result.get("default_namespace").and_then(Value::as_str).filter(|s|!s.trim().is_empty()).map(str::to_string))
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
        let r = self.rpc("getColumns", params.clone()).await?;
        // Column comments ride in each column's `comment` (sidecar maps it from
        // DatabaseMetaData.getColumns()'s REMARKS).
        let mut columns = map_column_defs(&r);
        // Table comment comes from getTables()'s REMARKS — the listTables RPC already
        // surfaces it per table, so fetch and pick the matching row (best-effort).
        let comment = match self.rpc("listTables", self.meta_params(schema)).await {
            Ok(tables) => table_comment_for(&tables, table),
            Err(_) => String::new(),
        };
        let indexes_value = self.rpc("getIndexes", params.clone()).await?;
        let keys_value = self.rpc("getForeignKeys", params).await?;
        let indexes = indexes_value.as_array().into_iter().flatten().map(|index| crate::db::driver::IndexDef {
            name: index["name"].as_str().unwrap_or("").into(), columns: index["columns"].as_str().unwrap_or("").into(),
            unique: index["unique"].as_bool().unwrap_or(false), method: index["method"].as_str().unwrap_or("").into(),
        }).collect();
        let fks: Vec<_> = keys_value.as_array().into_iter().flatten().map(|key| crate::db::driver::ForeignKeyDef {
            column: key["column"].as_str().unwrap_or("").into(), references: key["references"].as_str().unwrap_or("").into(),
            on_delete: key["on_delete"].as_str().unwrap_or("NO ACTION").into(), on_update: key["on_update"].as_str().unwrap_or("NO ACTION").into(),
            constraint_name: key["constraint_name"].as_str().map(str::to_string),
        }).collect();
        for column in &mut columns {
            if column.key.is_empty() && fks.iter().any(|key| key.column == column.name) { column.key = "FK".into(); }
        }
        Ok(TableStructure { comment, columns, indexes, fks, triggers: vec![] })
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        if !self.caps.er{return Err(DbError::Unsupported("JDBC driver does not advertise relational integrity metadata".into()));}
        let mut relations=Vec::new();
        for table in self.list_tables(schema).await? {
            let mut params=self.meta_params(schema);params["table"]=json!(table.name);
            let keys=self.rpc("getForeignKeys",params).await?;
            for key in keys.as_array().into_iter().flatten(){
                relations.push(ErRelation{from:table.name.clone(),from_col:key["column"].as_str().unwrap_or("").into(),to:key["ref_table"].as_str().unwrap_or("").into(),to_col:key["ref_column"].as_str().unwrap_or("").into(),
                    from_schema:key["from_schema"].as_str().map(str::to_string),to_schema:key["ref_schema"].as_str().map(str::to_string),constraint_id:key["constraint_name"].as_str().map(str::to_string),
                    ordinal:key["key_seq"].as_u64().map(|v|v as u32),column_count:None});
            }
        }
        Ok(ErRelation::complete_groups(relations))
    }

    async fn column_names(&self, schema: &str, table: &str) -> Result<Vec<String>, DbError> {
        let mut params = self.meta_params(schema); params["table"] = json!(table);
        let columns = self.rpc("getColumns", params).await?;
        Ok(map_column_defs(&columns).into_iter().map(|c| c.name).collect())
    }

    async fn schema_columns(&self, schema: &str) -> Result<Vec<(String, Vec<String>)>, DbError> {
        let mut result = Vec::new();
        for table in self.list_tables(schema).await?.into_iter().take(200) {
            let mut params = self.meta_params(schema); params["table"] = json!(table.name);
            let columns = self.rpc("getColumns", params).await?;
            result.push((table.name, map_column_defs(&columns).into_iter().map(|c| c.name).collect()));
        }
        Ok(result)
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
