//! Shared MCP core — transport- and identity-agnostic.
//!
//! The tools, [`tools_list`] and [`call_tool`] live here ONCE; both heads call in:
//!   * desktop (Tauri) — `super` (`mcp/mod.rs`) hand-rolled HTTP+SSE,
//!   * server (axum)   — `crate::server_mcp` (P3a-3).
//!
//! The JSON-RPC envelope (initialize/ping/tools/list/tools/call) and ALL logging stay
//! per-head (transport-specific); only the tool bodies are shared — same split as
//! `tunnel_open_core`. Identity is injected via [`McpTargets`]: it resolves a name|id to
//! a live id ONLY within the caller's visible set, so a crafted id can't reach outside it.
//! Desktop's visible set = the frontend-synced registry (single user); server's = the
//! calling user's OWNED resources.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::db::{DatabaseType, DbError};
use crate::db::driver::Driver;
use crate::db::manager::ConnManager;
use crate::db::table_import::{ImportColumnMapping, ImportSqlBatch, ParsedImportFile};
use crate::events::EventSink;
use crate::ssh::manager::SessionManager;

const INSERT_ROWS_MAX_ROWS: usize = 50_000;
const INSERT_ROWS_MAX_BATCH_SIZE: usize = 5_000;

// ---- identity / visible-set abstraction ----

/// A DB connection visible to the calling identity.
pub struct ConnEntry {
    pub conn_id: String,
    pub name: String,
    pub db_type: String,
}

/// An SSH host visible to the calling identity.
pub struct HostEntry {
    pub session_id: String,
    pub name: String,
    pub host: String,
}

/// Identity / visible-set abstraction. Resolves a name|id to its live id, but ONLY within
/// the caller's visible set, so a crafted id can't reach outside it. Desktop impl = the
/// frontend-synced registry (single user); server impl = the calling user's OWNED resources.
pub trait McpTargets: Send + Sync {
    fn list_connections(&self) -> Vec<ConnEntry>;
    /// name|connId -> connId, ONLY if inside the visible set (else None).
    fn resolve_db(&self, key: &str) -> Option<String>;
    fn list_hosts(&self) -> Vec<HostEntry>;
    /// name|sessionId -> sessionId. key=None|""|"default" -> sole visible host, else
    /// Err("no active SSH host connections") / Err("multiple hosts active; specify connectionName").
    fn resolve_host(&self, key: Option<&str>) -> Result<String, String>;
}

// ---- tool catalog ----

/// The tool catalog advertised over `tools/list`. Identical for both heads.
pub fn tools_list() -> Value {
    json!([
        {
            "name": "list_connections",
            "description": "List the database connections currently active in Catio (name, engine, id).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_schemas",
            "description": "List databases/schemas available on a connected database. Use the `connection` arg (call list_connections first to get a valid name/id).",
            "inputSchema": {
                "type": "object",
                "properties": { "connection": { "type": "string", "description": "Connection name or id" } },
                "required": ["connection"]
            }
        },
        {
            "name": "list_tables",
            "description": "List tables and views in a connected database. Use the `connection` arg (call list_connections first); optionally pass a `schema` (defaults to the first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "schema": { "type": "string", "description": "Schema name (optional)" }
                },
                "required": ["connection"]
            }
        },
        {
            "name": "get_ddl",
            "description": "Get the DDL / structure of a table or view (columns, types, keys, indexes, foreign keys; or the view source). Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "table": { "type": "string", "description": "Table or view name" },
                    "schema": { "type": "string", "description": "Schema name (optional)" }
                },
                "required": ["connection", "table"]
            }
        },
        {
            "name": "query_sql",
            "description": "Execute a read query (SELECT/SHOW/…) and return rows. Use the `connection` arg (call list_connections first). `maxRows` defaults to 200. SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "Read SQL to execute" },
                    "maxRows": { "type": "number", "description": "Row cap (default 200)" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "insert_sql",
            "description": "Execute an INSERT statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "INSERT statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "insert_rows",
            "description": "Bulk insert structured rows into one table. Catio generates dialect-correct multi-value INSERT statements and executes them in batches. Use this instead of many single-row insert_sql calls. SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "schema": { "type": "string", "description": "Schema name (optional; ignored by engines without schema namespaces)" },
                    "table": { "type": "string", "description": "Target table name" },
                    "columns": {
                        "type": "array",
                        "description": "Target columns in insert order",
                        "items": { "type": "string" }
                    },
                    "rows": {
                        "type": "array",
                        "description": "Rows to insert. Each row may be an array aligned to columns, or an object keyed by column name.",
                        "items": { "type": ["array", "object"] }
                    },
                    "batchSize": {
                        "type": "number",
                        "description": "Rows per generated INSERT statement (default 500, max 5000)"
                    }
                },
                "required": ["connection", "table", "columns", "rows"]
            }
        },
        {
            "name": "update_sql",
            "description": "Execute an UPDATE statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "UPDATE statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "delete_sql",
            "description": "Execute a DELETE statement. Returns rows affected. Use the `connection` arg (call list_connections first). SQL engines only; not supported on MongoDB / Redis / Elasticsearch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "DELETE statement" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "list_hosts",
            "description": "List the SSH host connections currently active in Catio (name, host, session id).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "execute_command",
            "description": "Execute a command on a connected SSH host and return the output. Use the `connectionName` arg (call list_hosts first; defaults to the only active host).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cmdString": { "type": "string", "description": "Command to execute" },
                    "directory": { "type": "string", "description": "Working directory for command execution" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional; defaults to the only active host)" },
                    "timeout": { "type": "number", "description": "Command timeout in milliseconds (optional, default 30000)" }
                },
                "required": ["cmdString"]
            }
        },
        {
            "name": "upload_file",
            "description": "Upload a local file to a connected SSH host. Use the `connectionName` arg (call list_hosts first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "localPath": { "type": "string", "description": "Local path" },
                    "remotePath": { "type": "string", "description": "Remote path" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional)" }
                },
                "required": ["localPath", "remotePath"]
            }
        },
        {
            "name": "download_file",
            "description": "Download a file from a connected SSH host. Use the `connectionName` arg (call list_hosts first).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "remotePath": { "type": "string", "description": "Remote path" },
                    "localPath": { "type": "string", "description": "Local path" },
                    "connectionName": { "type": "string", "description": "SSH connection name (optional)" }
                },
                "required": ["remotePath", "localPath"]
            }
        }
    ])
}

/// Run one tool by name. Parameterized over the visible set ([`McpTargets`]), the live
/// managers, and a byte-progress sink (SFTP only) — so the SAME 12 implementations serve
/// both heads. `progress` is the existing transport-agnostic [`EventSink`]: desktop passes
/// a `TauriSink`, server (P3a) passes a no-op.
pub async fn call_tool(
    targets: &dyn McpTargets,
    conns: &ConnManager,
    sessions: &SessionManager,
    progress: &Arc<dyn EventSink>,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    match name {
        // ---- database ----
        "list_connections" => Ok(tool_list_connections(targets)),
        "list_schemas" => tool_list_schemas(targets, conns, args).await,
        "list_tables" => tool_list_tables(targets, conns, args).await,
        "get_ddl" => tool_get_ddl(targets, conns, args).await,
        "query_sql" => tool_query_sql(targets, conns, args).await,
        "insert_sql" => tool_write_sql(targets, conns, args, "INSERT").await,
        "insert_rows" => tool_insert_rows(targets, conns, args).await,
        "update_sql" => tool_write_sql(targets, conns, args, "UPDATE").await,
        "delete_sql" => tool_write_sql(targets, conns, args, "DELETE").await,
        // ---- host ----
        "list_hosts" => Ok(tool_list_hosts(targets)),
        "execute_command" => tool_execute_command(targets, sessions, args).await,
        "upload_file" => tool_upload_file(targets, sessions, progress, args).await,
        "download_file" => tool_download_file(targets, sessions, progress, args).await,
        other => Err(format!("unknown tool: {other}")),
    }
}

// ---- database tools ----

// Renders from targets.list_connections() (the caller's visible set). No driver call.
fn tool_list_connections(targets: &dyn McpTargets) -> String {
    let arr: Vec<Value> = targets
        .list_connections()
        .iter()
        .map(|c| json!({ "name": c.name, "connId": c.conn_id, "dbType": c.db_type }))
        .collect();
    serde_json::to_string_pretty(&json!({ "connections": arr })).unwrap_or_default()
}

async fn driver_for(
    targets: &dyn McpTargets,
    conns: &ConnManager,
    conn: &str,
) -> Result<Arc<dyn Driver>, String> {
    let conn_id = targets.resolve_db(conn).ok_or_else(|| format!("connection not found: {conn}"))?;
    conns.get(&conn_id).await.ok_or_else(|| format!("no active connection: {conn}"))
}

fn conn_arg(args: &Value) -> Result<&str, String> {
    args.get("connection").and_then(Value::as_str).ok_or_else(|| "missing 'connection'".to_string())
}

async fn first_schema(driver: &Arc<dyn Driver>, args: &Value) -> Result<String, String> {
    match args.get("schema").and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()),
        None => Ok(driver
            .list_schemas()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .unwrap_or_default()),
    }
}

// → driver.list_schemas(). All engines (non-SQL return their database/keyspace list).
async fn tool_list_schemas(targets: &dyn McpTargets, conns: &ConnManager, args: &Value) -> Result<String, String> {
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    let schemas = driver.list_schemas().await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({ "schemas": schemas })).unwrap_or_default())
}

// → driver.list_tables(schema); schema defaults to the first via first_schema().
//   All engines (non-SQL return collections/indices/keyspaces).
async fn tool_list_tables(targets: &dyn McpTargets, conns: &ConnManager, args: &Value) -> Result<String, String> {
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    let schema = first_schema(&driver, args).await?;
    let tables = driver.list_tables(&schema).await.map_err(|e| e.to_string())?;
    let arr: Vec<Value> = tables
        .iter()
        .map(|t| json!({ "name": t.name, "kind": t.kind, "rowsEstimate": t.rows_estimate }))
        .collect();
    Ok(serde_json::to_string_pretty(&json!({ "schema": schema, "tables": arr })).unwrap_or_default())
}

// → heuristic: driver.object_source(schema, table, "view") (empty string when the
//   engine has no DDL introspection, never errors), else driver.table_structure().
//   SQL engines only — MongoDB/Redis/Elasticsearch have no DDL/view concept.
async fn tool_get_ddl(targets: &dyn McpTargets, conns: &ConnManager, args: &Value) -> Result<String, String> {
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    if is_non_sql_dml_engine(driver.db_type()) {
        return Err("get_ddl 仅支持 SQL 引擎".into());
    }
    let table = args.get("table").and_then(Value::as_str).ok_or("missing 'table'")?;
    let schema = first_schema(&driver, args).await?;
    // View-detection heuristic: a non-empty object_source(…, "view") means it's a view;
    // object_source returns "" for engines/objects without source, so stored procedures
    // and functions fall through to the table-structure branch below (known limitation).
    if let Ok(src) = driver.object_source(&schema, table, "view").await {
        if !src.trim().is_empty() {
            return Ok(serde_json::to_string_pretty(&json!({ "schema": schema, "name": table, "kind": "view", "ddl": src })).unwrap_or_default());
        }
    }
    let st = driver.table_structure(&schema, table).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({
        "schema": schema, "name": table, "kind": "table",
        "columns": st.columns, "indexes": st.indexes, "foreignKeys": st.fks
    })).unwrap_or_default())
}

// → driver.query(sql, maxRows) (maxRows default 200). SQL engines only —
//   guarded against MongoDB/Redis/Elasticsearch (no raw-SQL query path).
async fn tool_query_sql(targets: &dyn McpTargets, conns: &ConnManager, args: &Value) -> Result<String, String> {
    let sql = args.get("sql").and_then(Value::as_str).ok_or("missing 'sql'")?;
    let max_rows = args.get("maxRows").and_then(Value::as_u64).unwrap_or(200) as u32;
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    if is_non_sql_dml_engine(driver.db_type()) {
        return Err("query_sql 仅支持 SQL 引擎".into());
    }
    let res = driver.query(sql, max_rows).await.map_err(|e| e.to_string())?;
    let cols: Vec<&str> = res.columns.iter().map(|c| c.name.as_str()).collect();
    Ok(serde_json::to_string_pretty(&json!({
        "columns": cols, "rows": res.rows, "rowsAffected": res.rows_affected, "truncated": res.truncated
    })).unwrap_or_default())
}

// insert_sql / update_sql / delete_sql → keyword-checks the first token, then
// driver.query(sql, 0); returns rowsAffected. Guarded: read-only engine
// (capabilities().writable) + non-SQL engines (MongoDB/Redis/Elasticsearch) rejected —
// Redis edits go through web head's db_redis_edit, not SQL DML.
async fn tool_write_sql(targets: &dyn McpTargets, conns: &ConnManager, args: &Value, keyword: &str) -> Result<String, String> {
    let sql = args.get("sql").and_then(Value::as_str).ok_or("missing 'sql'")?;
    let first = sql.trim_start().split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    if first != keyword {
        return Err(format!("this tool only runs {keyword} statements (got '{first}')"));
    }
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    if !driver.capabilities().writable {
        return Err("read-only engine".into());
    }
    if is_non_sql_dml_engine(driver.db_type()) {
        return Err("editing via SQL DML is not supported for this engine".into());
    }
    let res = driver.query(sql, 0).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({ "rowsAffected": res.rows_affected })).unwrap_or_default())
}

fn is_non_sql_dml_engine(db: DatabaseType) -> bool {
    matches!(db, DatabaseType::Mongodb | DatabaseType::Redis | DatabaseType::Elasticsearch)
}

#[derive(Debug, Clone)]
struct InsertRowsArgs {
    schema: Option<String>,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    batch_size: usize,
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing '{key}'"))
}

fn parse_insert_rows_args(args: &Value) -> Result<InsertRowsArgs, String> {
    let table = string_arg(args, "table")?.to_string();
    let schema = args
        .get("schema")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let columns_value = args.get("columns").and_then(Value::as_array).ok_or("missing 'columns'")?;
    if columns_value.is_empty() {
        return Err("'columns' must not be empty".into());
    }
    let mut columns = Vec::with_capacity(columns_value.len());
    for (idx, value) in columns_value.iter().enumerate() {
        let column = value
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("columns[{idx}] must be a non-empty string"))?;
        columns.push(column.to_string());
    }

    let rows_value = args.get("rows").and_then(Value::as_array).ok_or("missing 'rows'")?;
    if rows_value.is_empty() {
        return Err("'rows' must not be empty".into());
    }
    if rows_value.len() > INSERT_ROWS_MAX_ROWS {
        return Err(format!(
            "'rows' has {} entries, over the limit {}; split the import into multiple insert_rows calls",
            rows_value.len(),
            INSERT_ROWS_MAX_ROWS
        ));
    }

    let mut rows = Vec::with_capacity(rows_value.len());
    for (row_idx, row) in rows_value.iter().enumerate() {
        match row {
            Value::Array(cells) => {
                if cells.len() != columns.len() {
                    return Err(format!(
                        "rows[{row_idx}] has {} values but columns has {}",
                        cells.len(),
                        columns.len()
                    ));
                }
                rows.push(cells.clone());
            }
            Value::Object(obj) => {
                let mut cells = Vec::with_capacity(columns.len());
                for column in &columns {
                    let value = obj
                        .get(column)
                        .ok_or_else(|| format!("rows[{row_idx}] object is missing column '{column}'"))?;
                    cells.push(value.clone());
                }
                rows.push(cells);
            }
            _ => return Err(format!("rows[{row_idx}] must be an array or object")),
        }
    }

    let batch_size = match args.get("batchSize") {
        Some(v) => {
            let n = v.as_u64().ok_or("'batchSize' must be a positive integer")?;
            if n == 0 {
                return Err("'batchSize' must be a positive integer".into());
            }
            let n = usize::try_from(n).map_err(|_| "'batchSize' is too large")?;
            n.min(INSERT_ROWS_MAX_BATCH_SIZE)
        }
        None => crate::db::table_import::DEFAULT_BATCH_SIZE,
    };

    Ok(InsertRowsArgs { schema, table, columns, rows, batch_size })
}

fn build_insert_row_batches(
    db: DatabaseType,
    has_schemas: bool,
    args: &InsertRowsArgs,
) -> Result<Vec<ImportSqlBatch>, String> {
    let data = ParsedImportFile {
        columns: args.columns.clone(),
        rows: args.rows.clone(),
        total_rows: args.rows.len(),
    };
    let mappings = args
        .columns
        .iter()
        .map(|column| ImportColumnMapping {
            source_column: column.clone(),
            target_column: column.clone(),
        })
        .collect::<Vec<_>>();

    crate::db::table_import::build_import_insert_batches(
        db,
        has_schemas,
        args.schema.as_deref(),
        &args.table,
        &data,
        &mappings,
        args.batch_size,
    )
}

async fn execute_insert_batches(
    driver: &Arc<dyn Driver>,
    batches: &[ImportSqlBatch],
) -> Result<(Option<u64>, bool), String> {
    if batches.len() == 1 {
        let res = driver.query(&batches[0].sql, 0).await.map_err(|e| e.to_string())?;
        return Ok((res.rows_affected, true));
    }

    let statements = batches.iter().map(|b| b.sql.clone()).collect::<Vec<_>>();
    match driver.exec_batch(&statements).await {
        Ok(n) => return Ok((Some(n), true)),
        Err(DbError::Unsupported(_)) => {
            // Fall through: not all writable SQL engines implement transactional batch
            // execution. We still support bulk insert by executing each generated
            // multi-row INSERT, and report that the fallback was non-transactional.
        }
        Err(e) => return Err(e.to_string()),
    }

    let mut affected = Some(0u64);
    for batch in batches {
        let res = driver.query(&batch.sql, 0).await.map_err(|e| e.to_string())?;
        affected = match (affected, res.rows_affected) {
            (Some(total), Some(n)) => Some(total + n),
            _ => None,
        };
    }
    Ok((affected, false))
}

// insert_rows → validate structured rows, generate dialect-correct multi-value
// INSERT batches (quote_ident + value_to_sql via table_import), then execute all
// batches inside a Driver::exec_batch transaction when the driver supports it.
async fn tool_insert_rows(targets: &dyn McpTargets, conns: &ConnManager, args: &Value) -> Result<String, String> {
    let parsed = parse_insert_rows_args(args)?;
    let driver = driver_for(targets, conns, conn_arg(args)?).await?;
    if !driver.capabilities().writable {
        return Err("read-only engine".into());
    }
    if is_non_sql_dml_engine(driver.db_type()) {
        return Err("editing via SQL DML is not supported for this engine".into());
    }

    let db = driver.db_type();
    let has_schemas = driver.capabilities().schemas;
    let batches = build_insert_row_batches(db, has_schemas, &parsed)?;
    let rows_submitted = parsed.rows.len();
    let (rows_affected, transactional) = execute_insert_batches(&driver, &batches).await?;

    Ok(serde_json::to_string_pretty(&json!({
        "rowsSubmitted": rows_submitted,
        "batches": batches.len(),
        "rowsAffected": rows_affected,
        "transactional": transactional
    })).unwrap_or_default())
}

// ---- host tools ----

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Renders from targets.list_hosts() (the caller's visible set). No SSH call.
fn tool_list_hosts(targets: &dyn McpTargets) -> String {
    let arr: Vec<Value> = targets
        .list_hosts()
        .iter()
        .map(|h| json!({ "name": h.name, "host": h.host, "sessionId": h.session_id }))
        .collect();
    serde_json::to_string_pretty(&json!({ "hosts": arr })).unwrap_or_default()
}

// → ssh::multiexec::run_on; optional `directory` runs as `cd <dir> && <cmd>`;
//   `timeout` default 30000ms; host picked via `connectionName` (defaults to sole active host).
async fn tool_execute_command(targets: &dyn McpTargets, sessions: &SessionManager, args: &Value) -> Result<String, String> {
    let cmd = args.get("cmdString").and_then(Value::as_str).ok_or("missing 'cmdString'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let directory = args.get("directory").and_then(Value::as_str);
    let timeout_ms = args.get("timeout").and_then(Value::as_u64).unwrap_or(30_000);
    let sid = targets.resolve_host(conn)?;
    let sess = sessions.get(&sid).await.ok_or_else(|| format!("session not found: {sid}"))?;
    let full = match directory {
        Some(d) if !d.is_empty() => format!("cd {} && {}", shell_quote(d), cmd),
        _ => cmd.to_string(),
    };
    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), crate::ssh::multiexec::run_on(sess, &full))
        .await
        .map_err(|_| "command timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// → ssh::sftp::upload_blocking. Host picked via `connectionName` (defaults to sole active host).
async fn tool_upload_file(targets: &dyn McpTargets, sessions: &SessionManager, progress: &Arc<dyn EventSink>, args: &Value) -> Result<String, String> {
    let local = args.get("localPath").and_then(Value::as_str).ok_or("missing 'localPath'")?;
    let remote = args.get("remotePath").and_then(Value::as_str).ok_or("missing 'remotePath'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let sid = targets.resolve_host(conn)?;
    let n = crate::ssh::sftp::upload_blocking(sessions, &sid, local, remote, progress)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Uploaded {n} bytes to {remote}"))
}

// → ssh::sftp::download_blocking. Host picked via `connectionName` (defaults to sole active host).
async fn tool_download_file(targets: &dyn McpTargets, sessions: &SessionManager, progress: &Arc<dyn EventSink>, args: &Value) -> Result<String, String> {
    let remote = args.get("remotePath").and_then(Value::as_str).ok_or("missing 'remotePath'")?;
    let local = args.get("localPath").and_then(Value::as_str).ok_or("missing 'localPath'")?;
    let conn = args.get("connectionName").and_then(Value::as_str);
    let sid = targets.resolve_host(conn)?;
    let n = crate::ssh::sftp::download_blocking(sessions, &sid, remote, local, progress)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Downloaded {n} bytes to {local}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tools_list_exposes_insert_rows() {
        let tools = tools_list();
        let names = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"insert_rows"));
    }

    #[test]
    fn insert_rows_rejects_array_row_width_mismatch() {
        let args = json!({
            "connection": "c",
            "table": "prices",
            "columns": ["day", "price"],
            "rows": [["2026-07-01"]]
        });
        let err = parse_insert_rows_args(&args).unwrap_err();
        assert!(err.contains("rows[0] has 1 values but columns has 2"));
    }

    #[test]
    fn insert_rows_parses_object_rows_in_column_order() {
        let args = json!({
            "connection": "c",
            "table": "prices",
            "columns": ["day", "price"],
            "rows": [
                { "price": 10.5, "day": "2026-07-01" }
            ]
        });
        let parsed = parse_insert_rows_args(&args).unwrap();
        assert_eq!(parsed.rows, vec![vec![json!("2026-07-01"), json!(10.5)]]);
    }

    #[test]
    fn insert_rows_builds_quoted_multi_value_batches() {
        let args = parse_insert_rows_args(&json!({
            "connection": "c",
            "schema": "public",
            "table": "daily prices",
            "columns": ["trade_day", "close\"price"],
            "rows": [
                ["2026-07-01", 10.5],
                ["2026-07-02", null],
                ["2026-07-03", "O'Brien"]
            ],
            "batchSize": 2
        })).unwrap();

        let batches = build_insert_row_batches(DatabaseType::Postgres, true, &args).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].row_count, 2);
        assert_eq!(
            batches[0].sql,
            r#"INSERT INTO "public"."daily prices" ("trade_day", "close""price") VALUES ('2026-07-01', 10.5), ('2026-07-02', NULL);"#
        );
        assert_eq!(
            batches[1].sql,
            r#"INSERT INTO "public"."daily prices" ("trade_day", "close""price") VALUES ('2026-07-03', 'O''Brien');"#
        );
    }
}
