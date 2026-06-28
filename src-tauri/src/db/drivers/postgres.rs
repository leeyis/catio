// adapted from dbx crates/dbx-core/src/db/postgres.rs, Apache-2.0
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, PoolError, RecyclingMethod};
use tokio_postgres::NoTls;
use tokio_postgres::config::SslMode;
use tokio_postgres::error::SqlState;
use std::sync::Arc;
use crate::db::{DbError, DatabaseType};
use crate::db::dialect::quote_ident;
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::result::QueryResult;

pub struct PostgresDriver {
    pool: Pool,
    // reserved for family dialect dispatch (cockroachdb/redshift/etc.)
    #[allow(dead_code)]
    profile: Option<String>,
}

impl PostgresDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let dbname = args.database.clone()
            .or_else(|| default_database(args.driver_profile.as_deref()))
            .unwrap_or_else(|| "postgres".into());
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&args.host).port(args.port).user(&args.user).dbname(&dbname);
        if let Some(pw) = &args.secret { cfg.password(pw); }
        cfg.ssl_mode(pg_ssl_mode(args));

        // 仅 Disable 走纯 NoTls；其余(Require/Prefer)挂接 rustls connector。
        // Prefer 语义保持完整:cfg.ssl_mode 已设为 Prefer,tokio-postgres 会先尝试
        // TLS,若服务端拒绝 SSL 协商则自动以明文重连——挂接 connector 不会破坏这一
        // 回退(connector 只在服务端同意 SSL 时才被调用)。
        let pool = if !pg_uses_tls(args) {
            let mgr = Manager::from_config(cfg, NoTls, ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            });
            Pool::builder(mgr).max_size(4).build()
                .map_err(|e| DbError::ConnectFailed(e.to_string()))?
        } else {
            let tls_config = build_tls_config(args)
                .map_err(|e| DbError::ConnectFailed(e))?;
            let connector = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config);
            let mgr = Manager::from_config(cfg, connector, ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            });
            Pool::builder(mgr).max_size(4).build()
                .map_err(|e| DbError::ConnectFailed(e.to_string()))?
        };
        // 立即取一个连接验证可达 + 认证
        let _client = pool.get().await.map_err(|e| map_pool_error(e))?;
        Ok(Self { pool, profile: args.driver_profile.clone() })
    }
}

/// 将 ConnectArgs 的 ssl/ssl_mode 映射为 tokio-postgres 的 `SslMode`。
///
/// 规则：ssl=false → Disable（无 TLS）。ssl=true 且未指定 ssl_mode → Require。
/// ssl_mode 字符串显式覆盖：disable/prefer/require/verify-ca/verify-full。
/// 注意 tokio-postgres 本身没有 verify-* 档位（证书校验由 rustls 验证器负责），
/// 故 verify-ca/verify-full 在协议层仍映射为 Require。
fn pg_ssl_mode(args: &crate::db::driver::ConnectArgs) -> SslMode {
    match args.ssl_mode.as_deref().map(|m| m.trim().to_ascii_lowercase()) {
        Some(ref m) if m == "disable" || m == "disabled" => SslMode::Disable,
        Some(ref m) if m == "prefer" || m == "preferred" => SslMode::Prefer,
        Some(ref m)
            if m == "require"
                || m == "required"
                || m == "verify-ca"
                || m == "verify_ca"
                || m == "verify-full"
                || m == "verify_full"
                || m == "verify-identity" =>
        {
            SslMode::Require
        }
        // 未指定 ssl_mode：由 ssl 开关决定。
        _ => {
            if args.ssl {
                SslMode::Require
            } else {
                SslMode::Disable
            }
        }
    }
}

/// 是否需要挂接 rustls TLS connector。除 `Disable` 外都需要——包括 `Prefer`:
/// connector 仅在服务端同意 SSL 协商时才会被 tokio-postgres 调用,服务端拒绝时
/// `Prefer` 仍按其语义回退到明文连接,故挂接 connector 不会破坏 `Prefer` 的降级。
fn pg_uses_tls(args: &crate::db::driver::ConnectArgs) -> bool {
    pg_ssl_mode(args) != SslMode::Disable
}

/// 是否接受无效服务器证书（自签/过期/主机名不符）。仅当用户显式把
/// ssl_reject_unauthorized 设为 false 时才接受；缺省与 true 都坚持校验。
fn pg_accepts_invalid_certs(args: &crate::db::driver::ConnectArgs) -> bool {
    args.ssl_reject_unauthorized == Some(false)
}

/// 读取 PEM 文件中的 CA 证书列表。文件缺失/无有效证书时返回 Err（不 panic）。
fn read_ca_certs(path: &str) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取 CA 证书 {path} 失败: {e}"))?;
    let mut reader = std::io::BufReader::new(&data[..]);
    let certs: Vec<_> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析 CA 证书 {path} 失败: {e}"))?;
    if certs.is_empty() {
        return Err(format!("CA 证书 {path} 中未找到有效证书"));
    }
    Ok(certs)
}

/// 构建 rustls `ClientConfig`：
/// - 默认用系统/webpki 根 + 可选自定义 CA（ca_cert_path）校验服务器证书；
/// - 当 ssl_reject_unauthorized=Some(false) 时安装跳过校验的危险验证器（内网/测试）。
fn build_tls_config(args: &crate::db::driver::ConnectArgs) -> Result<rustls::ClientConfig, String> {
    // 安装进程级默认 crypto provider（幂等，忽略已安装的情形）。
    let _ = rustls::crypto::ring::default_provider().install_default();

    if pg_accepts_invalid_certs(args) {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        return Ok(rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(no_verify::NoCertVerifier::new(provider)))
            .with_no_client_auth());
    }

    let mut root_store = rustls::RootCertStore::empty();
    // 内置 webpki 根（公共 CA）。
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // 追加自定义 CA（私有/自签 CA 颁发的服务器证书）。
    if let Some(path) = args.ca_cert_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        for cert in read_ca_certs(path)? {
            root_store
                .add(cert)
                .map_err(|e| format!("将 CA 证书加入信任库失败: {e}"))?;
        }
    }
    Ok(rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth())
}

/// 跳过服务器证书校验的危险验证器，仅在用户显式关闭校验时使用。
/// 改编自 dbx postgres.rs 的 NoVerify 实现（Apache-2.0）。
mod no_verify {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use std::sync::Arc;

    #[derive(Debug)]
    pub struct NoCertVerifier {
        provider: Arc<CryptoProvider>,
    }

    impl NoCertVerifier {
        pub fn new(provider: Arc<CryptoProvider>) -> Self {
            Self { provider }
        }
    }

    impl ServerCertVerifier for NoCertVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.provider.signature_verification_algorithms.supported_schemes()
        }
    }
}

/// Map a deadpool PoolError to DbError.
/// tokio_postgres::Error::Display returns "db error" (no details); match on PoolError::Backend
/// to extract SqlState for auth failures (28P01 = invalid_password, 28000 = invalid_auth).
fn map_pool_error(e: PoolError) -> DbError {
    if let PoolError::Backend(ref pg_err) = e {
        if let Some(code) = pg_err.code() {
            if code == &SqlState::INVALID_PASSWORD
                || code == &SqlState::INVALID_AUTHORIZATION_SPECIFICATION
            {
                return DbError::AuthFailed;
            }
        }
    }
    DbError::ConnectFailed(e.to_string())
}

/// Extract a human-readable message from a query error. `tokio_postgres::Error`'s
/// Display is the useless "db error"; the real server message (e.g. `relation
/// "foo" does not exist`) lives in `as_db_error()`. Append the server HINT when
/// present (Postgres often suggests the right schema-qualified name there).
fn pg_query_err(e: &tokio_postgres::Error) -> DbError {
    if let Some(db) = e.as_db_error() {
        let mut msg = db.message().to_string();
        if let Some(hint) = db.hint() {
            msg.push_str(" (hint: ");
            msg.push_str(hint);
            msg.push(')');
        }
        DbError::QueryFailed(msg)
    } else {
        DbError::QueryFailed(e.to_string())
    }
}

async fn pg_query_on_client(
    client: &tokio_postgres::Client,
    sql: &str,
    max_rows: u32,
) -> Result<QueryResult, DbError> {
    use crate::db::result::{ColumnInfo, safe_i64_to_json, binary_to_json};
    use serde_json::Value;

    let stmt = client.prepare(sql).await
        .map_err(|e| pg_query_err(&e))?;

    // Write statements (UPDATE/INSERT/DELETE/DDL) have no result columns.
    // Use execute() to get rows_affected count instead of fetching rows.
    if stmt.columns().is_empty() {
        let affected = client.execute(&stmt, &[]).await
            .map_err(|e| pg_query_err(&e))?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(affected),
            truncated: false,
        });
    }

    let cols: Vec<ColumnInfo> = stmt.columns().iter().map(|c| ColumnInfo {
        name: c.name().to_string(),
        type_name: c.type_().name().to_string(),
        pk: false,
    }).collect();

    let pg_rows = client.query(&stmt, &[]).await
        .map_err(|e| pg_query_err(&e))?;

    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    for (i, row) in pg_rows.iter().enumerate() {
        if i as u32 >= max_rows {
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(cols.len());
        for (idx, col) in stmt.columns().iter().enumerate() {
            let v = pg_value_to_json(row, idx, col.type_(), &safe_i64_to_json, &binary_to_json);
            out.push(v);
        }
        rows.push(out);
    }
    Ok(QueryResult { columns: cols, rows, rows_affected: None, truncated })
}

/// 协议族默认库名（照搬 dbx models/connection.rs default_database）。
/// PG-wire 兼容引擎（openGauss/GaussDB/KingBase/Vastbase）默认库即 "postgres"；
/// CockroachDB/KWDB 用 "defaultdb"，Redshift 用 "dev"，Highgo 用 "highgo"。
fn default_database(profile: Option<&str>) -> Option<String> {
    match profile {
        Some("cockroachdb") | Some("kwdb") => Some("defaultdb".into()),
        Some("redshift") => Some("dev".into()),
        Some("highgo") => Some("highgo".into()),
        _ => Some("postgres".into()),
    }
}

/// Column introspection SQL for PostgreSQL.
/// Params: $1 = schema, $2 = table. Column 7 (0-based) is the column comment via
/// col_description(table oid, attnum), resolved through pg_attribute for accuracy.
fn pg_columns_sql() -> &'static str {
    "SELECT c.column_name, \
     CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS full_type, \
     c.is_nullable = 'YES' AS is_nullable, \
     c.column_default, \
     EXISTS ( \
       SELECT 1 FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON kcu.constraint_catalog = tc.constraint_catalog \
        AND kcu.constraint_schema  = tc.constraint_schema \
        AND kcu.constraint_name    = tc.constraint_name \
        AND kcu.table_schema       = tc.table_schema \
        AND kcu.table_name         = tc.table_name \
       WHERE tc.constraint_type = 'PRIMARY KEY' \
         AND tc.table_schema = c.table_schema \
         AND tc.table_name   = c.table_name \
         AND kcu.column_name = c.column_name \
     ) AS is_pk, \
     EXISTS ( \
       SELECT 1 FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON kcu.constraint_catalog = tc.constraint_catalog \
        AND kcu.constraint_schema  = tc.constraint_schema \
        AND kcu.constraint_name    = tc.constraint_name \
        AND kcu.table_schema       = tc.table_schema \
        AND kcu.table_name         = tc.table_name \
       WHERE tc.constraint_type = 'FOREIGN KEY' \
         AND tc.table_schema = c.table_schema \
         AND tc.table_name   = c.table_name \
         AND kcu.column_name = c.column_name \
     ) AS is_fk, \
     EXISTS ( \
       SELECT 1 FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON kcu.constraint_catalog = tc.constraint_catalog \
        AND kcu.constraint_schema  = tc.constraint_schema \
        AND kcu.constraint_name    = tc.constraint_name \
        AND kcu.table_schema       = tc.table_schema \
        AND kcu.table_name         = tc.table_name \
       WHERE tc.constraint_type = 'UNIQUE' \
         AND tc.table_schema = c.table_schema \
         AND tc.table_name   = c.table_name \
         AND kcu.column_name = c.column_name \
     ) AS is_uni, \
     ( \
       SELECT col_description(a.attrelid, a.attnum) \
       FROM pg_attribute a \
       JOIN pg_class cl ON cl.oid = a.attrelid \
       JOIN pg_namespace nc ON nc.oid = cl.relnamespace \
       WHERE nc.nspname = c.table_schema AND cl.relname = c.table_name \
         AND a.attname = c.column_name \
     ) AS column_comment \
     FROM information_schema.columns c \
     WHERE c.table_schema = $1 AND c.table_name = $2 \
     ORDER BY c.ordinal_position"
}

/// Table-comment SQL for PostgreSQL (obj_description(oid, 'pg_class')).
/// Params: $1 = schema, $2 = table.
fn pg_table_comment_sql() -> &'static str {
    "SELECT obj_description( \
       (quote_ident($1) || '.' || quote_ident($2))::regclass, 'pg_class')"
}

/// Foreign-key introspection SQL for PostgreSQL. Params: $1 = schema, $2 = table.
/// Columns: 0=fk column, 1=ref schema, 2=ref table, 3=ref column, 4=delete rule,
/// 5=update rule, 6=constraint name (needed for DROP CONSTRAINT).
/// adapted from dbx list_foreign_keys L1646 + referential_constraints for on_delete/on_update
fn pg_fk_sql() -> &'static str {
    "SELECT fk.column_name, \
     pk.table_schema AS ref_schema, pk.table_name AS ref_table, pk.column_name AS ref_column, \
     rc.delete_rule, rc.update_rule, tc.constraint_name \
     FROM information_schema.table_constraints tc \
     JOIN information_schema.key_column_usage fk \
       ON fk.constraint_name   = tc.constraint_name \
       AND fk.constraint_schema = tc.constraint_schema \
       AND fk.table_schema      = tc.table_schema \
       AND fk.table_name        = tc.table_name \
     JOIN information_schema.referential_constraints rc \
       ON rc.constraint_name   = tc.constraint_name \
       AND rc.constraint_schema = tc.constraint_schema \
     JOIN information_schema.key_column_usage pk \
       ON pk.constraint_name   = rc.unique_constraint_name \
       AND pk.constraint_schema = rc.unique_constraint_schema \
       AND pk.ordinal_position  = fk.position_in_unique_constraint \
     WHERE tc.constraint_type = 'FOREIGN KEY' \
       AND fk.table_schema = $1 AND fk.table_name = $2 \
     ORDER BY fk.constraint_name, fk.ordinal_position"
}

/// Trigger-list SQL for PostgreSQL. Params: $1 = schema, $2 = table.
/// Columns: 0=trigger name, 1=timing (BEFORE/AFTER/INSTEAD OF), 2=events (comma list).
/// Excludes internal constraint-enforcement triggers (tgisinternal); groups by name
/// because pg_trigger has one row per event and we surface one entry per trigger.
fn pg_triggers_sql() -> &'static str {
    "SELECT t.tgname, \
     CASE \
       WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF' \
       WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' \
       ELSE 'AFTER' \
     END AS timing, \
     array_to_string(ARRAY[ \
       CASE WHEN (t.tgtype & 4)  <> 0 THEN 'INSERT' END, \
       CASE WHEN (t.tgtype & 8)  <> 0 THEN 'DELETE' END, \
       CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END \
     ]::text[], ' OR ') AS events \
     FROM pg_trigger t \
     JOIN pg_class c ON c.oid = t.tgrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal \
     ORDER BY t.tgname"
}

#[cfg(test)]
mod comment_sql_tests {
    use super::{pg_columns_sql, pg_table_comment_sql, pg_fk_sql, pg_triggers_sql};

    #[test]
    fn columns_sql_selects_col_description() {
        let sql = pg_columns_sql();
        assert!(sql.contains("col_description"), "列 SQL 必须用 col_description 取列注释");
        assert!(sql.contains("column_comment"));
    }

    #[test]
    fn table_comment_sql_uses_obj_description() {
        let sql = pg_table_comment_sql();
        assert!(sql.contains("obj_description"), "表注释 SQL 必须用 obj_description");
        assert!(sql.contains("pg_class"));
    }

    #[test]
    fn fk_sql_selects_constraint_name() {
        // D1: FK 内省必须带出约束名,前端删除外键要用它。
        let sql = pg_fk_sql();
        assert!(sql.contains("tc.constraint_name"), "FK SQL 必须选出 constraint_name 以支持删除");
        assert!(sql.contains("referential_constraints"), "仍保留 on_delete/on_update 来源");
    }

    #[test]
    fn triggers_sql_uses_pg_trigger() {
        // D1: 触发器列表来自 pg_trigger,排除内部约束触发器(tgisinternal)。
        let sql = pg_triggers_sql();
        assert!(sql.contains("pg_trigger"), "触发器 SQL 必须查 pg_trigger");
        assert!(sql.contains("tgisinternal"), "应排除内部约束触发器");
    }
}

#[cfg(test)]
mod tls_tests {
    use super::{pg_accepts_invalid_certs, pg_ssl_mode, pg_uses_tls, read_ca_certs};
    use crate::db::driver::ConnectArgs;
    use crate::db::DatabaseType;
    use tokio_postgres::config::SslMode;

    fn args() -> ConnectArgs {
        ConnectArgs {
            db_type: DatabaseType::Postgres,
            host: "h".into(),
            port: 5432,
            user: "u".into(),
            database: None,
            driver_profile: None,
            options: None,
            secret: None,
            ssl: false,
            ssl_mode: None,
            ca_cert_path: None,
            ssl_reject_unauthorized: None,
        }
    }

    #[test]
    fn ssl_disabled_maps_to_disable() {
        let a = args();
        assert_eq!(pg_ssl_mode(&a), SslMode::Disable);
    }

    #[test]
    fn ssl_enabled_defaults_to_require() {
        let mut a = args();
        a.ssl = true;
        assert_eq!(pg_ssl_mode(&a), SslMode::Require);
    }

    #[test]
    fn ssl_mode_string_overrides() {
        let mut a = args();
        a.ssl = true;
        a.ssl_mode = Some("prefer".into());
        assert_eq!(pg_ssl_mode(&a), SslMode::Prefer);
        a.ssl_mode = Some("verify-full".into());
        // tokio-postgres has no verify-* SslMode; verification is enforced via the
        // rustls verifier, so verify-* still maps to Require at the protocol layer.
        assert_eq!(pg_ssl_mode(&a), SslMode::Require);
        // 显式 disable 即便 ssl=true 也尊重它。
        a.ssl_mode = Some("disable".into());
        assert_eq!(pg_ssl_mode(&a), SslMode::Disable);
    }

    #[test]
    fn tls_connector_used_for_every_mode_except_disable() {
        let mut a = args();
        // 默认(ssl=false)→ Disable → 不挂 TLS connector(纯 NoTls)。
        assert!(!pg_uses_tls(&a), "默认无 TLS 不应挂接 connector");
        // ssl=true 默认 Require → 挂接 connector。
        a.ssl = true;
        assert!(pg_uses_tls(&a));
        // Prefer 也挂接 connector;cfg.ssl_mode=Prefer 保证服务端拒绝时回退明文,
        // connector 只在服务端同意 SSL 时被调用,不破坏 Prefer 的降级语义。
        a.ssl_mode = Some("prefer".into());
        assert_eq!(pg_ssl_mode(&a), SslMode::Prefer);
        assert!(pg_uses_tls(&a), "Prefer 仍需挂接 connector 以便在服务端支持时升级到 TLS");
        // 显式 disable → 不挂接,回到纯明文路径。
        a.ssl_mode = Some("disable".into());
        assert!(!pg_uses_tls(&a));
    }

    #[test]
    fn accepts_invalid_certs_only_when_explicitly_rejecting_off() {
        let mut a = args();
        a.ssl = true;
        assert!(!pg_accepts_invalid_certs(&a), "默认必须校验证书");
        a.ssl_reject_unauthorized = Some(true);
        assert!(!pg_accepts_invalid_certs(&a));
        a.ssl_reject_unauthorized = Some(false);
        assert!(pg_accepts_invalid_certs(&a), "显式关闭校验时接受无效证书");
    }

    /// A real self-signed X.509 cert (RSA-2048, CN=catio-test-ca, openssl).
    /// Using a genuine DER body (not bogus base64) ensures rustls-pemfile 2.x's
    /// strict base64 decoding succeeds — the codex-flagged risk that fake
    /// base64 could yield a false pass / runtime failure no longer applies.
    const TEST_CA_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIIC4TCCAcmgAwIBAgIUFwX6DVBaM5oRsKWJLVQcW0wR7cQwDQYJKoZIhvcNAQEL
BQAwADAeFw0yNjA2MjIyMTQ4MzhaFw0zNjA2MTkyMTQ4MzhaMAAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDSkDnBAdWNMxK9YQFuVt4O8Djd9uMyP+l9
Ri12B4eQgndsyMqTMUoGprcKNXpWadF6dDAKK6Kg4F7akmToSteUXjx24bMxPebo
NcjaJOhBDqYJRktTzH2e+kEE9w/1LNMdtNeajU97T7BtAFzzhcMxrXrJvJxpLFxo
NPQNbiFwcr9w3hiP+TNa4yT5uNvko17Q/Ic9ASOskXIJuDhPk28wTqA/lJMFRstO
hq6tmgf8sgU0wdbQAWj4wUAL59MptgR/l4cx1Uq6wmQ2bEN1iIYeCg6/znHxN881
03KG37sd0tik7WZ2qZdsdJ3pO+dkUfbhA4AGFkQDtCd4E7ba/r9zAgMBAAGjUzBR
MB0GA1UdDgQWBBQzwRlhYiKXO0tEphqsKDWKD0B0ZDAfBgNVHSMEGDAWgBQzwRlh
YiKXO0tEphqsKDWKD0B0ZDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCJ9owczTJIQ07VTcw8HXh8TaXyHVOlkap7SoGj2KLeN/0UE3/aCtz25jvP
BWO972GFUBPHNlmk+F1/3++rk3Eh1IZzznty3L3aXNfW+/09n/bjMOwQ4YtxHz2N
c/92bIWpZIX5DxoHien02HzlzRvwjQjbPZdRqPLs1kaKgw4eEw6Lksu4EAA5k3aF
zwhEX7GxUI82mQXcFzw60cqKtih8ieSlL1SnhWDwmUOfXfFCoageXpuMogF/Tdhf
7siEPBLM5YnL1DqujsgiFSel8blUER7p3W5NSgg7jley6Enj8xxYRvWRkiNFcPed
KSL56AK8J0Mimlbt0k2itepUJtZe
-----END CERTIFICATE-----
";

    #[test]
    fn read_ca_certs_parses_pem() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("catio_test_ca_{}.pem", std::process::id()));
        std::fs::write(&path, TEST_CA_PEM).unwrap();
        let certs = read_ca_certs(path.to_str().unwrap()).expect("should parse one PEM cert");
        assert_eq!(certs.len(), 1, "应解析出一张 CA 证书");
        // The parsed DER must round-trip into the rustls trust store (proves it is
        // a real, structurally-valid cert, not just base64 that happened to decode).
        let mut store = rustls::RootCertStore::empty();
        store.add(certs[0].clone()).expect("real CA cert should add to the trust store");
        let _ = std::fs::remove_file(&path);
    }

    /// Garbage that is NOT valid base64 inside the PEM guards must surface an Err
    /// (rustls-pemfile 2.x rejects it) rather than silently yielding a bogus cert.
    #[test]
    fn read_ca_certs_rejects_invalid_base64() {
        let pem = "-----BEGIN CERTIFICATE-----\n!!!not-base64!!!\n-----END CERTIFICATE-----\n";
        let dir = std::env::temp_dir();
        let path = dir.join(format!("catio_test_bad_ca_{}.pem", std::process::id()));
        std::fs::write(&path, pem).unwrap();
        let res = read_ca_certs(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(res.is_err(), "非法 base64 的 PEM 应报错,而不是假装解析出证书");
    }

    #[test]
    fn read_ca_certs_missing_file_errors() {
        let err = read_ca_certs("/no/such/ca-file-xyz.pem");
        assert!(err.is_err(), "缺失文件应报错而不是 panic");
    }
}

#[cfg(test)]
mod default_db_tests {
    use super::default_database;
    #[test]
    fn family_default_databases() {
        assert_eq!(default_database(Some("cockroachdb")).as_deref(), Some("defaultdb"));
        assert_eq!(default_database(Some("kwdb")).as_deref(), Some("defaultdb"));
        assert_eq!(default_database(Some("redshift")).as_deref(), Some("dev"));
        assert_eq!(default_database(Some("highgo")).as_deref(), Some("highgo"));
        // openGauss / GaussDB / KingBase / Vastbase / plain Postgres → "postgres"
        assert_eq!(default_database(Some("opengauss")).as_deref(), Some("postgres"));
        assert_eq!(default_database(Some("kingbase")).as_deref(), Some("postgres"));
        assert_eq!(default_database(None).as_deref(), Some("postgres"));
    }
}

/// Map a single PG column value to serde_json::Value.
/// Type branches adapted from dbx crates/dbx-core/src/db/postgres.rs execute_query, Apache-2.0.
fn pg_value_to_json(
    row: &tokio_postgres::Row,
    idx: usize,
    ty: &tokio_postgres::types::Type,
    safe_i64: &dyn Fn(i64) -> serde_json::Value,
    bin_to_json: &dyn Fn(&[u8]) -> serde_json::Value,
) -> serde_json::Value {
    use serde_json::Value;
    use tokio_postgres::types::Type;

    match ty {
        &Type::BOOL => match row.try_get::<_, Option<bool>>(idx) {
            Ok(Some(v)) => Value::Bool(v),
            _ => Value::Null,
        },
        &Type::INT2 => match row.try_get::<_, Option<i16>>(idx) {
            Ok(Some(v)) => Value::Number((v as i32).into()),
            _ => Value::Null,
        },
        &Type::INT4 => match row.try_get::<_, Option<i32>>(idx) {
            Ok(Some(v)) => Value::Number(v.into()),
            _ => Value::Null,
        },
        &Type::INT8 => match row.try_get::<_, Option<i64>>(idx) {
            Ok(Some(v)) => safe_i64(v),
            _ => Value::Null,
        },
        &Type::OID => match row.try_get::<_, Option<u32>>(idx) {
            Ok(Some(v)) => Value::Number(v.into()),
            _ => Value::Null,
        },
        &Type::FLOAT4 => match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::FLOAT8 => match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => serde_json::Number::from_f64(v)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        &Type::BYTEA => match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(v)) => bin_to_json(&v),
            _ => Value::Null,
        },
        // String-like types: TEXT, VARCHAR, BPCHAR, NAME, UUID
        &Type::TEXT | &Type::VARCHAR | &Type::BPCHAR | &Type::NAME | &Type::UUID => {
            match row.try_get::<_, Option<String>>(idx) {
                Ok(Some(v)) => Value::String(v),
                _ => Value::Null,
            }
        },
        // JSON / JSONB: try serde_json::Value directly
        &Type::JSON | &Type::JSONB => {
            match row.try_get::<_, Option<serde_json::Value>>(idx) {
                Ok(Some(v)) => v,
                _ => Value::Null,
            }
        },
        // Temporal types: tokio_postgres has NO `String` FromSql for DATE/TIME/
        // TIMESTAMP/TIMESTAMPTZ, so the old String fallback always yielded Null
        // (every date/timestamp column rendered blank). Decode via chrono (the
        // `with-chrono-0_4` feature is enabled) and format as an ISO-ish, SQL-
        // round-trippable string the grid's date/datetime editors can parse back.
        &Type::DATE => match row.try_get::<_, Option<chrono::NaiveDate>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%Y-%m-%d").to_string()),
            _ => Value::Null,
        },
        &Type::TIME => match row.try_get::<_, Option<chrono::NaiveTime>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%H:%M:%S").to_string()),
            _ => Value::Null,
        },
        &Type::TIMESTAMP => match row.try_get::<_, Option<chrono::NaiveDateTime>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%Y-%m-%d %H:%M:%S").to_string()),
            _ => Value::Null,
        },
        &Type::TIMESTAMPTZ => match row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx) {
            Ok(Some(v)) => Value::String(v.format("%Y-%m-%d %H:%M:%S%:z").to_string()),
            _ => Value::Null,
        },
        // NUMERIC / DECIMAL: likewise no `String` FromSql — decode via rust_decimal
        // (the `db-tokio-postgres` feature) and stringify so values aren't lost.
        // Out-of-Decimal-range values degrade to Null rather than failing the query.
        &Type::NUMERIC => match row.try_get::<_, Option<rust_decimal::Decimal>>(idx) {
            Ok(Some(v)) => Value::String(v.to_string()),
            _ => Value::Null,
        },
        // Fallback (other / unrecognised types): try String, then Null
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(Some(v)) => Value::String(v),
            _ => Value::Null,
        },
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Postgres }

    async fn test(&self) -> Result<String, DbError> {
        let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let row = client.query_one("SELECT version()", &[]).await
            .map_err(|e| pg_query_err(&e))?;
        Ok(row.get::<_, String>(0))
    }

    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        pg_query_on_client(&client, sql, max_rows).await
    }

    async fn exec_batch(&self, statements: &[String]) -> Result<u64, DbError> {
        let mut client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // Dropping `tx` without commit() rolls back (tokio_postgres Transaction Drop).
        let tx = client.transaction().await.map_err(|e| pg_query_err(&e))?;
        let mut affected = 0u64;
        for s in statements {
            affected += tx.execute(s.as_str(), &[]).await.map_err(|e| pg_query_err(&e))?;
        }
        tx.commit().await.map_err(|e| pg_query_err(&e))?;
        Ok(affected)
    }

    async fn query_with_default_namespace(&self, sql: &str, max_rows: u32, default_namespace: Option<&str>)
        -> Result<QueryResult, DbError> {
        let Some(schema) = default_namespace.map(str::trim).filter(|s| !s.is_empty()) else {
            return self.query(sql, max_rows).await;
        };
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let set_sql = format!("SET search_path TO {}", quote_ident(DatabaseType::Postgres, schema));
        client.batch_execute(&set_sql).await.map_err(|e| pg_query_err(&e))?;
        let result = pg_query_on_client(&client, sql, max_rows).await;
        let _ = client.batch_execute("RESET search_path").await;
        result
    }
    // ---- A7: schema / structure / ER introspection ----
    // SQL adapted from dbx crates/dbx-core/src/db/postgres.rs, Apache-2.0

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // adapted from dbx list_schemas L1248
        let rows = client.query(
            "SELECT n.nspname AS schema_name \
             FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
             AND n.nspname NOT LIKE 'pg_toast_temp_%' \
             AND n.nspname NOT LIKE 'pg_temp_%' \
             ORDER BY n.nspname",
            &[],
        ).await.map_err(|e| pg_query_err(&e))?;
        Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // adapted from dbx list_tables / postgres_tables_sql L1112
        let rows = client.query(
            "SELECT c.relname AS table_name, \
             CASE c.relkind \
               WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' \
               ELSE 'BASE TABLE' \
             END AS table_type, \
             c.reltuples::bigint AS rows_estimate \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
             ORDER BY c.relname",
            &[&schema],
        ).await.map_err(|e| pg_query_err(&e))?;
        Ok(rows.iter().map(|r| {
            let kind = if r.get::<_, String>(1) == "VIEW" { "view" } else { "table" };
            let est: Option<i64> = r.try_get::<_, Option<i64>>(2).ok().flatten()
                .filter(|&v| v >= 0);
            TableInfo { name: r.get::<_, String>(0), kind: kind.into(), rows_estimate: est }
        }).collect())
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        use crate::db::driver::{ColumnDef, IndexDef, ForeignKeyDef, TriggerDef};
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;

        // ---- columns ----
        // adapted from dbx POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL L1321 (broadest compat)
        // Also collects FK column names so we can set key="FK" where appropriate.
        let col_rows = client.query(
            pg_columns_sql(),
            &[&schema, &table],
        ).await.map_err(|e| pg_query_err(&e))?;

        let columns: Vec<ColumnDef> = col_rows.iter().map(|r| {
            let is_pk: bool = r.try_get(4).unwrap_or(false);
            let is_fk: bool = r.try_get(5).unwrap_or(false);
            let is_uni: bool = r.try_get(6).unwrap_or(false);
            let key = if is_pk { "PK" } else if is_fk { "FK" } else if is_uni { "UNI" } else { "" };
            ColumnDef {
                name: r.get::<_, String>(0),
                type_name: r.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default(),
                nullable: r.try_get::<_, bool>(2).unwrap_or(true),
                default: r.try_get::<_, Option<String>>(3).ok().flatten(),
                key: key.into(),
                comment: r.try_get::<_, Option<String>>(7).ok().flatten().unwrap_or_default(),
            }
        }).collect();

        // ---- indexes ----
        // adapted from dbx POSTGRES_INDEXES_SQL L1526; columns array_agg → join with ", "
        let idx_rows = client.query(
            "SELECT i.relname AS index_name, \
             array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) \
               ORDER BY k.n) AS columns, \
             ix.indisunique AS is_unique, \
             am.amname AS index_type \
             FROM pg_index ix \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_am am ON am.oid = i.relam \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, i.oid, ix.indisunique, ix.indpred, ix.indrelid, am.amname \
             ORDER BY i.relname",
            &[&schema, &table],
        ).await.map_err(|e| pg_query_err(&e))?;

        let indexes: Vec<IndexDef> = idx_rows.iter().map(|r| {
            let cols: Vec<String> = r.try_get::<_, Vec<String>>(1).unwrap_or_default();
            IndexDef {
                name: r.get::<_, String>(0),
                columns: cols.join(", "),
                unique: r.try_get::<_, bool>(2).unwrap_or(false),
                method: r.try_get::<_, String>(3).unwrap_or_else(|_| "btree".into()),
            }
        }).collect();

        // ---- foreign keys ----
        let fk_rows = client.query(pg_fk_sql(), &[&schema, &table])
            .await.map_err(|e| pg_query_err(&e))?;

        let fks: Vec<ForeignKeyDef> = fk_rows.iter().map(|r| {
            let ref_schema: String = r.get::<_, String>(1);
            let ref_table: String = r.get::<_, String>(2);
            let ref_col: String = r.get::<_, String>(3);
            ForeignKeyDef {
                column: r.get::<_, String>(0),
                references: format!("{}.{}.{}", ref_schema, ref_table, ref_col),
                on_delete: r.try_get::<_, String>(4).unwrap_or_else(|_| "NO ACTION".into()),
                on_update: r.try_get::<_, String>(5).unwrap_or_else(|_| "NO ACTION".into()),
                constraint_name: r.try_get::<_, Option<String>>(6).ok().flatten(),
            }
        }).collect();

        // ---- triggers ----
        let trg_rows = client.query(pg_triggers_sql(), &[&schema, &table])
            .await.map_err(|e| pg_query_err(&e))?;
        let triggers: Vec<TriggerDef> = trg_rows.iter().map(|r| TriggerDef {
            name: r.get::<_, String>(0),
            timing: r.try_get::<_, Option<String>>(1).ok().flatten(),
            event: r.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
        }).collect();

        // ---- table comment ----
        let comment = client.query_opt(pg_table_comment_sql(), &[&schema, &table])
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<_, Option<String>>(0).ok().flatten())
            .unwrap_or_default();

        Ok(TableStructure { comment, columns, indexes, fks, triggers })
    }

    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // adapted from dbx list_foreign_keys L1646; schema-level (no table filter)
        let rows = client.query(
            "SELECT fk.table_name AS from_table, fk.column_name AS from_col, \
             pk.table_name AS to_table, pk.column_name AS to_col \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage fk \
               ON fk.constraint_name   = tc.constraint_name \
               AND fk.constraint_schema = tc.constraint_schema \
               AND fk.table_schema      = tc.table_schema \
               AND fk.table_name        = tc.table_name \
             JOIN information_schema.referential_constraints rc \
               ON rc.constraint_name   = tc.constraint_name \
               AND rc.constraint_schema = tc.constraint_schema \
             JOIN information_schema.key_column_usage pk \
               ON pk.constraint_name   = rc.unique_constraint_name \
               AND pk.constraint_schema = rc.unique_constraint_schema \
               AND pk.ordinal_position  = fk.position_in_unique_constraint \
             WHERE tc.constraint_type = 'FOREIGN KEY' \
               AND fk.table_schema = $1 \
               AND pk.table_schema = $1 \
             ORDER BY fk.table_name, fk.constraint_name, fk.ordinal_position",
            &[&schema],
        ).await.map_err(|e| pg_query_err(&e))?;
        Ok(rows.iter().map(|r| ErRelation {
            from: r.get::<_, String>(0),
            from_col: r.get::<_, String>(1),
            to: r.get::<_, String>(2),
            to_col: r.get::<_, String>(3),
        }).collect())
    }

    async fn list_functions(&self, schema: &str) -> Result<Vec<String>, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // p.prokind 'f' = function, 'p' = procedure
        let rows = client.query(
            "SELECT p.proname \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND p.prokind IN ('f','p') \
             ORDER BY p.proname",
            &[&schema],
        ).await.map_err(|e| pg_query_err(&e))?;
        Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
    }

    async fn object_source(&self, schema: &str, name: &str, kind: &str) -> Result<String, DbError> {
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        if kind == "view" {
            // pg_get_viewdef returns just the SELECT body; prefix a CREATE header for readability.
            let rows = client.query(
                "SELECT pg_get_viewdef(c.oid, 0) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v','m') \
                 ORDER BY c.oid LIMIT 1",
                &[&schema, &name],
            ).await.map_err(|e| pg_query_err(&e))?;
            match rows.first() {
                Some(r) => {
                    let body: String = r.try_get::<_, Option<String>>(0).ok().flatten().unwrap_or_default();
                    if body.is_empty() {
                        Ok(String::new())
                    } else {
                        Ok(format!("CREATE OR REPLACE VIEW {}.{} AS\n{}", schema, name, body))
                    }
                }
                None => Ok(String::new()),
            }
        } else {
            // function/procedure: pg_get_functiondef returns the full CREATE text.
            let rows = client.query(
                "SELECT pg_get_functiondef(p.oid) \
                 FROM pg_catalog.pg_proc p \
                 JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 \
                 ORDER BY p.oid LIMIT 1",
                &[&schema, &name],
            ).await.map_err(|e| pg_query_err(&e))?;
            match rows.first() {
                Some(r) => Ok(r.try_get::<_, Option<String>>(0).ok().flatten().unwrap_or_default()),
                None => Ok(String::new()),
            }
        }
    }
}
