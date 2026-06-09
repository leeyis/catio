// adapted from dbx crates/dbx-core/src/db/postgres.rs, Apache-2.0
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, PoolError, RecyclingMethod};
use tokio_postgres::NoTls; // 起步用 NoTls；TLS 变体见 Step 4 备注
use tokio_postgres::error::SqlState;
use crate::db::{DbError, DatabaseType};
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
        let mgr = Manager::from_config(cfg, NoTls, ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });
        let pool = Pool::builder(mgr).max_size(4).build()
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        // 立即取一个连接验证可达 + 认证
        let _client = pool.get().await.map_err(|e| map_pool_error(e))?;
        Ok(Self { pool, profile: args.driver_profile.clone() })
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
        use crate::db::result::{ColumnInfo, safe_i64_to_json, binary_to_json};
        use serde_json::Value;
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;
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
        use crate::db::driver::{ColumnDef, IndexDef, ForeignKeyDef};
        let client = self.pool.get().await
            .map_err(|e| DbError::ConnectFailed(e.to_string()))?;

        // ---- columns ----
        // adapted from dbx POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL L1321 (broadest compat)
        // Also collects FK column names so we can set key="FK" where appropriate.
        let col_rows = client.query(
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
             ) AS is_uni \
             FROM information_schema.columns c \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
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
        // adapted from dbx list_foreign_keys L1646 + referential_constraints for on_delete/on_update
        let fk_rows = client.query(
            "SELECT fk.column_name, \
             pk.table_schema AS ref_schema, pk.table_name AS ref_table, pk.column_name AS ref_column, \
             rc.delete_rule, rc.update_rule \
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
             ORDER BY fk.constraint_name, fk.ordinal_position",
            &[&schema, &table],
        ).await.map_err(|e| pg_query_err(&e))?;

        let fks: Vec<ForeignKeyDef> = fk_rows.iter().map(|r| {
            let ref_schema: String = r.get::<_, String>(1);
            let ref_table: String = r.get::<_, String>(2);
            let ref_col: String = r.get::<_, String>(3);
            ForeignKeyDef {
                column: r.get::<_, String>(0),
                references: format!("{}.{}.{}", ref_schema, ref_table, ref_col),
                on_delete: r.try_get::<_, String>(4).unwrap_or_else(|_| "NO ACTION".into()),
                on_update: r.try_get::<_, String>(5).unwrap_or_else(|_| "NO ACTION".into()),
            }
        }).collect();

        Ok(TableStructure { columns, indexes, fks })
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
