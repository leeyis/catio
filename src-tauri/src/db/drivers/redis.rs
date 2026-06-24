// adapted from dbx crates/dbx-core/src/db/redis_driver.rs + redis_ops.rs, Apache-2.0
//! Redis driver — pseudo-tabular keyspace mapping.
//!
//! Mapping: logical DB (db0..dbN) → schema, key namespace → "table",
//! key/type/value/TTL → row.  `query(sql)` treats `sql` as a SCAN glob
//! pattern (default "*").  v1 operates on db0 / the DB encoded at connect.
//! A dedicated `SELECT N` is issued for `list_tables(schema)` and
//! `query(sql)` to handle multi-db read paths in tests.

use async_trait::async_trait;
// Resolve redis crate paths with leading :: to avoid conflict with this module name.
use ::redis::aio::{ConnectionLike, MultiplexedConnection};
use ::redis::cluster_async::ClusterConnection;
use ::redis::Value as RedisValue;
use tokio::sync::Mutex;

use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::drivers::redis_connect::{
    build_cluster_spec, build_sentinel_spec, build_standalone_spec, option_value, parse_redis_mode, RedisMode,
};
use crate::db::result::{ColumnInfo, QueryResult};

const DEFAULT_DB_COUNT: u32 = 16;
const SCAN_BATCH: usize = 200;

/// Redis 连接句柄:单机/Sentinel 解析后都得到一个 MultiplexedConnection,
/// Cluster 得到一个 ClusterConnection。两者都实现 `ConnectionLike`,故所有
/// 读写助手都对 `&mut impl ConnectionLike` 泛型化,按变体分发即可复用同一套逻辑。
pub enum RedisConn {
    Single(MultiplexedConnection),
    Cluster(ClusterConnection),
}

// 把 RedisConn 实现成 ConnectionLike,转发到内部变体。这样所有读写助手都能
// 直接吃 `&mut RedisConn`,既无需为每个方法按变体分发,也让既有的
// `cmd().query_async(&mut *conn)` 调用点零改动继续工作。
impl ConnectionLike for RedisConn {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a ::redis::Cmd) -> ::redis::RedisFuture<'a, RedisValue> {
        match self {
            RedisConn::Single(c) => c.req_packed_command(cmd),
            RedisConn::Cluster(c) => c.req_packed_command(cmd),
        }
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        cmd: &'a ::redis::Pipeline,
        offset: usize,
        count: usize,
    ) -> ::redis::RedisFuture<'a, Vec<RedisValue>> {
        match self {
            RedisConn::Single(c) => c.req_packed_commands(cmd, offset, count),
            RedisConn::Cluster(c) => c.req_packed_commands(cmd, offset, count),
        }
    }

    fn get_db(&self) -> i64 {
        match self {
            RedisConn::Single(c) => c.get_db(),
            RedisConn::Cluster(c) => c.get_db(),
        }
    }
}

pub struct RedisDriver {
    /// We wrap the connection in a Mutex because commands need `&mut`.
    conn: Mutex<RedisConn>,
    /// The database index selected at connect time (parsed from ConnectArgs.database "dbN" or 0).
    /// Cluster 不支持 SELECT(只有 db0),故在 Cluster 模式下忽略。
    default_db: u32,
    /// 是否为 Cluster 连接(用于跳过 SELECT —— 集群协议不支持多逻辑库)。
    is_cluster: bool,
}

impl RedisDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let host = &args.host;
        let port = args.port;
        let password = args.secret.as_deref();
        // ssl 切 rediss://;ssl_reject_unauthorized==Some(false) 时跳过证书校验。
        let ssl = args.ssl;
        let insecure = args.ssl_reject_unauthorized == Some(false);
        let opts = args.options.as_deref();
        let mode = parse_redis_mode(opts);
        let nodes = option_value(opts, "nodes").unwrap_or("");
        let master = option_value(opts, "master").unwrap_or("");

        // Parse the default DB from ConnectArgs.database ("db5" → 5, or 0)
        let default_db = parse_db_number(args.database.as_deref()).unwrap_or(0);

        match mode {
            RedisMode::Standalone => {
                let spec = build_standalone_spec(host, port, password, ssl, insecure);
                let mut conn = open_single(&spec.url).await?;
                ping_single(&mut conn).await?;
                Ok(Self { conn: Mutex::new(RedisConn::Single(conn)), default_db, is_cluster: false })
            }
            RedisMode::Sentinel => {
                let spec = build_sentinel_spec(master, nodes, host, port, password, ssl, insecure)
                    .map_err(DbError::ConnectFailed)?;
                let mut conn = open_sentinel(&spec.master_name, &spec.sentinel_urls).await?;
                ping_single(&mut conn).await?;
                Ok(Self { conn: Mutex::new(RedisConn::Single(conn)), default_db, is_cluster: false })
            }
            RedisMode::Cluster => {
                let spec = build_cluster_spec(nodes, host, port, password, ssl, insecure);
                let mut conn = open_cluster(&spec.seed_urls).await?;
                // Cluster 用 ConnectionLike 直接 PING。
                let pong: String = ::redis::cmd("PING")
                    .query_async(&mut conn)
                    .await
                    .map_err(|e| map_redis_connect_error(&e.to_string()))?;
                let _ = pong;
                Ok(Self { conn: Mutex::new(RedisConn::Cluster(conn)), default_db, is_cluster: true })
            }
        }
    }
}

/// 打开一个单机 MultiplexedConnection(不含 PING)。
async fn open_single(url: &str) -> Result<MultiplexedConnection, DbError> {
    let client = ::redis::Client::open(url).map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| map_redis_connect_error(&e.to_string()))
}

/// PING 校验一个 MultiplexedConnection。
async fn ping_single(conn: &mut MultiplexedConnection) -> Result<(), DbError> {
    let pong: String = ::redis::cmd("PING")
        .query_async(conn)
        .await
        .map_err(|e| map_redis_connect_error(&e.to_string()))?;
    let _ = pong; // "PONG" expected
    Ok(())
}

/// 通过 Sentinel 解析 master 并连接(返回指向 master 的 MultiplexedConnection)。
/// 真实哨兵握手走 redis-rs I/O,需真机验证。
async fn open_sentinel(master_name: &str, sentinel_urls: &[String]) -> Result<MultiplexedConnection, DbError> {
    use ::redis::sentinel::{SentinelClient, SentinelServerType};
    let mut client = SentinelClient::build(sentinel_urls.to_vec(), master_name.to_string(),
        None, SentinelServerType::Master)
        .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    client
        .get_async_connection()
        .await
        .map_err(|e| map_redis_connect_error(&e.to_string()))
}

/// 用种子节点建立 Cluster 连接。真实集群拓扑发现走 redis-rs I/O,需真机验证。
async fn open_cluster(seed_urls: &[String]) -> Result<ClusterConnection, DbError> {
    let client = ::redis::cluster::ClusterClient::new(seed_urls.to_vec())
        .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    client
        .get_async_connection()
        .await
        .map_err(|e| map_redis_connect_error(&e.to_string()))
}

impl RedisDriver {
    /// SELECT 一个逻辑库 —— 但 Cluster 不支持多库(只有 db0),此时直接 no-op,
    /// 避免向集群发送会被拒绝的 SELECT。
    async fn maybe_select(&self, conn: &mut RedisConn, db: u32) {
        if !self.is_cluster {
            let _ = select_db(conn, db).await;
        }
    }
}

/// Build a Redis URL. `ssl` 切换 scheme 到 `rediss://`(TLS);`insecure` 为 true 时
/// 追加 `#insecure` 片段,让 redis-rs 跳过证书校验(自签/内网用)。无 TLS 时维持
/// 原有 `redis://[:pw@]host:port/` 路径。
pub(crate) fn build_redis_url(host: &str, port: u16, password: Option<&str>, ssl: bool, insecure: bool) -> String {
    let scheme = if ssl { "rediss" } else { "redis" };
    let fragment = if ssl && insecure { "#insecure" } else { "" };
    match password.filter(|p| !p.is_empty()) {
        // 密码必须 percent-encode:含 @ / : ? # 等字符会破坏 URL 解析
        // (@ 之后被当 host、# 被当 fragment),导致连接失败或用错凭据。
        Some(pw) => format!("{scheme}://:{}@{host}:{port}/{fragment}", percent_encode_userinfo(pw)),
        None => format!("{scheme}://{host}:{port}/{fragment}"),
    }
}

/// 对 URL userinfo(密码)做 percent-encoding。仅保留 RFC 3986 的 unreserved 字符
/// (ALPHA / DIGIT / `-` `.` `_` `~`)不转义,其余一律转成 `%XX`——这比只转 @/:/# 更
/// 稳妥(也覆盖空格、中文等),且对普通密码是恒等映射。
pub(crate) fn percent_encode_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod redis_tls_url_tests {
    use super::build_redis_url;

    #[test]
    fn no_tls_keeps_redis_scheme() {
        assert_eq!(build_redis_url("h", 6379, None, false, false), "redis://h:6379/");
        assert_eq!(build_redis_url("h", 6379, Some("pw"), false, false), "redis://:pw@h:6379/");
    }

    #[test]
    fn tls_switches_to_rediss() {
        assert_eq!(build_redis_url("h", 6379, None, true, false), "rediss://h:6379/");
        assert_eq!(build_redis_url("h", 6379, Some("pw"), true, false), "rediss://:pw@h:6379/");
    }

    #[test]
    fn tls_insecure_appends_fragment() {
        assert_eq!(build_redis_url("h", 6379, None, true, true), "rediss://h:6379/#insecure");
        // insecure 只在 ssl 开启时生效。
        assert_eq!(build_redis_url("h", 6379, None, false, true), "redis://h:6379/");
    }

    #[test]
    fn password_special_chars_are_percent_encoded() {
        // 含 @ / : ? # 等会破坏 URL 解析的字符必须 percent-encode,
        // 否则 redis-rs 会把 @ 之后误当作 host、或把 # 当作 fragment。
        let url = build_redis_url("h", 6379, Some("p@ss:w/o?rd#x"), false, false);
        assert!(
            !url.contains("p@ss"),
            "原始密码不应裸露在 URL 里(会破坏解析): {url}"
        );
        // 关键的破坏性字符都已转义。
        assert!(url.contains("%40"), "@ 应转义为 %40: {url}");
        assert!(url.contains("%2F"), "/ 应转义为 %2F: {url}");
        assert!(url.contains("%3F"), "? 应转义为 %3F: {url}");
        assert!(url.contains("%23"), "# 应转义为 %23: {url}");
        assert!(url.contains("%3A"), ": 应转义为 %3A: {url}");
        // URL 仍能被 redis-rs 解析,且密码里的字符不会污染 host/port。
        let parsed = ::redis::parse_redis_url(&url).expect("URL 应可被 redis-rs 解析");
        assert_eq!(parsed.host_str(), Some("h"), "host 不应被密码里的字符污染");
        assert_eq!(parsed.port(), Some(6379));
        // redis-rs 内部对 userinfo 做 percent-decode(connection.rs),故编码后的密码
        // 必须能精确还原回原文(往返验证)。
        let raw = parsed.password().expect("应有密码");
        let decoded = percent_decode_str(raw);
        assert_eq!(decoded, "p@ss:w/o?rd#x", "percent-decode 应还原原始密码");
    }

    #[test]
    fn ordinary_password_round_trips() {
        let url = build_redis_url("h", 6379, Some("simplepw"), false, false);
        let parsed = ::redis::parse_redis_url(&url).expect("URL 应可被解析");
        // 普通密码是恒等映射,无需解码即等于原文。
        assert_eq!(parsed.password(), Some("simplepw"));
    }

    /// 测试用 percent-decode 助手(把 %XX 还原为字节再解 UTF-8)。
    fn percent_decode_str(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hi = (bytes[i + 1] as char).to_digit(16).unwrap();
                let lo = (bytes[i + 2] as char).to_digit(16).unwrap();
                out.push((hi * 16 + lo) as u8);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }
}

/// Map redis error messages to DbError variants.
fn map_redis_connect_error(msg: &str) -> DbError {
    let lower = msg.to_lowercase();
    if lower.contains("noauth") || lower.contains("wrongpass") || lower.contains("invalid password") {
        DbError::AuthFailed
    } else {
        DbError::ConnectFailed(msg.to_string())
    }
}

/// Parse "db5" → Some(5); "" or None → None.
fn parse_db_number(db: Option<&str>) -> Option<u32> {
    let s = db?.strip_prefix("db").unwrap_or(db?);
    s.parse().ok()
}

/// SELECT a logical DB on the connection, issuing a no-op if db==0 already.
/// (On a fresh connection, db0 is already selected so this is cheap.)
async fn select_db<C: ConnectionLike + Send>(conn: &mut C, db: u32) -> Result<(), DbError> {
    let _: () = ::redis::cmd("SELECT")
        .arg(db)
        .query_async(conn)
        .await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
    Ok(())
}

/// Read a fixed-columns row for a key: [key, type, ttl, value_summary].
/// Returns None if the key has expired between SCAN and now.
async fn read_key_row<C: ConnectionLike + Send>(conn: &mut C, key: &str)
    -> Option<Vec<serde_json::Value>>
{
    // TYPE
    let key_type: Result<String, _> = ::redis::cmd("TYPE")
        .arg(key)
        .query_async(conn)
        .await;
    let key_type = match key_type {
        Ok(t) if t != "none" => t,
        _ => return None, // key expired or error
    };

    // TTL (-1 = no expiry, -2 = not found/expired)
    let ttl: i64 = ::redis::cmd("TTL")
        .arg(key)
        .query_async(conn)
        .await
        .unwrap_or(-2);
    if ttl == -2 {
        return None; // expired between SCAN and TTL
    }

    // Value summary depending on type
    let value_json = get_value_summary(conn, key, &key_type).await;

    Some(vec![
        serde_json::Value::String(key.to_string()),
        serde_json::Value::String(key_type),
        serde_json::Value::Number(ttl.into()),
        value_json,
    ])
}

/// Fetch a compact value summary for a key. On any error, returns Null.
async fn get_value_summary<C: ConnectionLike + Send>(conn: &mut C, key: &str, key_type: &str)
    -> serde_json::Value
{
    match key_type {
        "string" => {
            let raw: Result<RedisValue, _> = ::redis::cmd("GET").arg(key).query_async(conn).await;
            match raw {
                Ok(RedisValue::BulkString(bytes)) => {
                    let s = String::from_utf8_lossy(&bytes).into_owned();
                    serde_json::Value::String(s)
                }
                Ok(RedisValue::SimpleString(s)) => serde_json::Value::String(s),
                Ok(RedisValue::Nil) | Err(_) => serde_json::Value::Null,
                Ok(other) => serde_json::Value::String(format!("{:?}", other)),
            }
        }
        "list" => {
            // Get up to 10 elements as a preview
            let raw: Result<Vec<String>, _> = ::redis::cmd("LRANGE")
                .arg(key).arg(0i64).arg(9i64)
                .query_async(conn)
                .await;
            match raw {
                Ok(items) => serde_json::Value::String(format!("[{}]", items.join(", "))),
                Err(_) => serde_json::Value::Null,
            }
        }
        "hash" => {
            // Get all fields as flat list (field, value, ...)
            let raw: Result<Vec<String>, _> = ::redis::cmd("HGETALL")
                .arg(key)
                .query_async(conn)
                .await;
            match raw {
                Ok(pairs) => {
                    let mut map = serde_json::Map::new();
                    let mut iter = pairs.into_iter();
                    while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
                        map.insert(k, serde_json::Value::String(v));
                    }
                    serde_json::Value::Object(map)
                }
                Err(_) => serde_json::Value::Null,
            }
        }
        "set" => {
            let raw: Result<Vec<String>, _> = ::redis::cmd("SMEMBERS")
                .arg(key)
                .query_async(conn)
                .await;
            match raw {
                Ok(members) => {
                    let arr: Vec<serde_json::Value> = members.into_iter()
                        .map(serde_json::Value::String)
                        .collect();
                    serde_json::Value::Array(arr)
                }
                Err(_) => serde_json::Value::Null,
            }
        }
        "zset" => {
            // ZRANGE with WITHSCORES (10 elements)
            let raw: Result<Vec<String>, _> = ::redis::cmd("ZRANGE")
                .arg(key).arg(0i64).arg(9i64)
                .query_async(conn)
                .await;
            match raw {
                Ok(members) => {
                    let arr: Vec<serde_json::Value> = members.into_iter()
                        .map(serde_json::Value::String)
                        .collect();
                    serde_json::Value::Array(arr)
                }
                Err(_) => serde_json::Value::Null,
            }
        }
        _ => {
            // stream, ReJSON, or unknown: return a type label
            serde_json::Value::String(format!("<{}>", key_type))
        }
    }
}

/// SCAN loop: collect up to `max_keys` keys matching `pattern`.
/// Returns (keys, truncated).
async fn scan_keys<C: ConnectionLike + Send>(
    conn: &mut C,
    pattern: &str,
    max_keys: usize,
) -> Result<(Vec<String>, bool), DbError> {
    let mut cursor: u64 = 0;
    let mut keys: Vec<String> = Vec::new();

    loop {
        let raw: RedisValue = ::redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(SCAN_BATCH)
            .query_async(conn)
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        // SCAN returns: [cursor_bulk_str, [key, key, ...]]
        let (next_cursor, batch) = parse_scan_response(raw)?;

        for k in batch {
            keys.push(k);
            if keys.len() > max_keys {
                // Return early — truncated
                return Ok((keys, true));
            }
        }

        cursor = next_cursor;
        if cursor == 0 {
            break;
        }
    }

    Ok((keys, false))
}

/// Parse the SCAN two-element array response into (next_cursor, keys).
fn parse_scan_response(raw: RedisValue) -> Result<(u64, Vec<String>), DbError> {
    match raw {
        RedisValue::Array(mut parts) if parts.len() == 2 => {
            let cursor_val = parts.remove(0);
            let keys_val = parts.remove(0);

            let cursor_str = redis_value_to_string(cursor_val)
                .ok_or_else(|| DbError::QueryFailed("invalid SCAN cursor".into()))?;
            let next_cursor: u64 = cursor_str.parse()
                .map_err(|_| DbError::QueryFailed("SCAN cursor parse failed".into()))?;

            let keys = match keys_val {
                RedisValue::Array(elems) => elems
                    .into_iter()
                    .filter_map(redis_value_to_string)
                    .collect(),
                _ => vec![],
            };

            Ok((next_cursor, keys))
        }
        _ => Err(DbError::QueryFailed("unexpected SCAN response shape".into())),
    }
}

fn redis_value_to_string(v: RedisValue) -> Option<String> {
    match v {
        RedisValue::BulkString(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        RedisValue::SimpleString(s) => Some(s),
        RedisValue::Int(n) => Some(n.to_string()),
        RedisValue::Okay => Some("OK".into()),
        _ => None,
    }
}

/// Determine the DB count via CONFIG GET databases, falling back to DEFAULT_DB_COUNT.
async fn get_db_count<C: ConnectionLike + Send>(conn: &mut C) -> u32 {
    let result: Result<RedisValue, _> = ::redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async(conn)
        .await;

    if let Ok(RedisValue::Array(parts)) = result {
        // Response: ["databases", "16"]
        let mut iter = parts.into_iter();
        while let (Some(_k), Some(v)) = (iter.next(), iter.next()) {
            if let Some(s) = redis_value_to_string(v) {
                if let Ok(n) = s.parse::<u32>() {
                    return n;
                }
            }
        }
    }

    DEFAULT_DB_COUNT
}

#[async_trait]
impl Driver for RedisDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Redis }

    /// Returns the Redis server version string.
    async fn test(&self) -> Result<String, DbError> {
        let mut conn = self.conn.lock().await;
        let info: String = ::redis::cmd("INFO")
            .arg("server")
            .query_async(&mut *conn)
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        // Parse "redis_version:7.0.11\r\n..."
        for line in info.lines() {
            if let Some(version) = line.strip_prefix("redis_version:") {
                return Ok(version.trim().to_string());
            }
        }
        Ok("unknown".to_string())
    }

    /// Returns logical DBs as ["db0", "db1", ...].
    /// Count determined via CONFIG GET databases; falls back to 16.
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        // Cluster 只有 db0(集群模式不支持多逻辑库),直接返回单元素。
        if self.is_cluster {
            return Ok(vec!["db0".to_string()]);
        }
        let count = {
            let mut conn = self.conn.lock().await;
            get_db_count(&mut *conn).await
        };
        let schemas: Vec<String> = (0..count).map(|i| format!("db{}", i)).collect();
        Ok(schemas)
    }

    /// Returns a single pseudo-table named "keys" for the given schema (dbN).
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let db = parse_db_number(Some(schema)).unwrap_or(self.default_db);

        let rows_estimate = {
            let mut conn = self.conn.lock().await;
            // SELECT the DB to get its DBSIZE
            self.maybe_select(&mut *conn, db).await;
            let size: Result<i64, _> = ::redis::cmd("DBSIZE")
                .query_async(&mut *conn)
                .await;
            // Restore default db
            self.maybe_select(&mut *conn, self.default_db).await;
            size.ok()
        };

        Ok(vec![TableInfo {
            name: "keys".to_string(),
            kind: "table".to_string(),
            rows_estimate,
        }])
    }

    /// Execute a real Redis command typed in the query console (GET/SET/KEYS/
    /// HGETALL/SCAN/ZRANGE/TTL/TYPE…). The input is parsed into argv, safety-
    /// classified (destructive/admin commands are rejected), executed, and the
    /// heterogeneous reply is mapped into a tabular QueryResult.
    /// v1: operates on default_db (db0 unless overridden at connect).
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use crate::db::drivers::redis_command::{classify_command, parse_command_argv, to_query_result, CmdSafety};

        let argv = parse_command_argv(sql).map_err(DbError::QueryFailed)?;
        let cmd_name = argv[0].to_ascii_uppercase();
        if classify_command(&cmd_name) == CmdSafety::Blocked {
            return Err(DbError::QueryFailed(format!(
                "命令 {cmd_name} 在查询控制台中被禁用(破坏性或管理类),请改用 redis-cli 执行"
            )));
        }

        let mut conn = self.conn.lock().await;
        // SELECT the default DB (ensures we are on the right db after any list_tables call).
        self.maybe_select(&mut *conn, self.default_db).await;

        let mut cmd = ::redis::cmd(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a.as_str());
        }
        let raw: RedisValue = cmd
            .query_async(&mut *conn)
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        Ok(to_query_result(raw, max_rows as usize))
    }

    /// Native key-space preview for the data grid: `schema` is the logical DB
    /// number, the pseudo-table is always "keys". Columns ["key","type","ttl",
    /// "value"]. SCAN has no offset, so we scan `offset+limit` keys and slice the
    /// page (key order is best-effort, as in other Redis browsers).
    async fn table_data(&self, schema: Option<&str>, _table: &str, limit: u32, offset: u32)
        -> Result<QueryResult, DbError> {
        let db = parse_db_number(schema).unwrap_or(self.default_db);
        let columns = vec![
            ColumnInfo { name: "key".into(),   type_name: "string".into(), pk: true  },
            ColumnInfo { name: "type".into(),  type_name: "string".into(), pk: false },
            ColumnInfo { name: "ttl".into(),   type_name: "integer".into(), pk: false },
            ColumnInfo { name: "value".into(), type_name: "mixed".into(),  pk: false },
        ];
        let mut conn = self.conn.lock().await;
        self.maybe_select(&mut *conn, db).await;

        let need = (offset as usize).saturating_add(limit as usize);
        let (keys, more) = scan_keys(&mut *conn, "*", need).await?;
        let start = (offset as usize).min(keys.len());
        let end = (start + limit as usize).min(keys.len());
        let truncated = more || keys.len() > end;

        let mut rows: Vec<Vec<serde_json::Value>> = Vec::with_capacity(end - start);
        for key in &keys[start..end] {
            if let Some(row) = read_key_row(&mut *conn, key).await {
                rows.push(row);
            }
        }
        self.maybe_select(&mut *conn, self.default_db).await;
        Ok(QueryResult { columns, rows, rows_affected: None, truncated })
    }

    /// Redis has no table structure concept.
    async fn table_structure(&self, _schema: &str, _table: &str) -> Result<TableStructure, DbError> {
        Err(DbError::Unsupported("redis has no table structure".into()))
    }

    /// No ER relations in Redis.
    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        Ok(vec![])
    }

    /// Keyspace overview for the structure panel: DBSIZE + a sampled type
    /// distribution (TYPE on up to SAMPLE_MAX scanned keys). Redis has no table
    /// structure, so this replaces the columns/DDL view in the UI.
    async fn keyspace_info(&self, schema: &str) -> Result<crate::db::driver::KeyspaceInfo, DbError> {
        use crate::db::driver::{KeyspaceInfo, KeyspaceType};
        const SAMPLE_MAX: usize = 1000;

        let db = parse_db_number(Some(schema)).unwrap_or(self.default_db);
        let mut conn = self.conn.lock().await;
        self.maybe_select(&mut *conn, db).await;

        let total: i64 = ::redis::cmd("DBSIZE").query_async(&mut *conn).await.unwrap_or(0);
        let (keys, _truncated) = scan_keys(&mut *conn, "*", SAMPLE_MAX).await?;
        let sample: Vec<String> = keys.into_iter().take(SAMPLE_MAX).collect();

        let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for key in &sample {
            let t: Result<String, _> = ::redis::cmd("TYPE").arg(key).query_async(&mut *conn).await;
            if let Ok(t) = t {
                if t != "none" {
                    *counts.entry(t).or_insert(0) += 1;
                }
            }
        }
        // Restore the default db for subsequent reads on the shared connection.
        self.maybe_select(&mut *conn, self.default_db).await;

        let mut types: Vec<KeyspaceType> =
            counts.into_iter().map(|(name, count)| KeyspaceType { name, count }).collect();
        // Most-common type first; stable tiebreak by name.
        types.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

        Ok(KeyspaceInfo { total_keys: total.max(0) as u64, sampled: sample.len() as u64, types })
    }
}
