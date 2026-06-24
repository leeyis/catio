//! Catio database backend (sub-project 3). Multi-engine via Driver trait.
//! Per-dialect logic adapted from dbx crates/dbx-core/src, Apache-2.0.

pub mod ids;
pub mod result;
pub mod capabilities;
pub mod dialect;
pub mod driver;
pub mod drivers;
pub mod manager;
pub mod commands;
pub mod dml;
pub mod export;
pub mod table_import;
pub mod transfer;
pub mod sql_file;
pub mod query_explain_sql;
pub mod db_admin_sql;
pub mod object_source_sql;
pub mod history;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// executionId → 取消令牌的并发表（SQL 文件批量执行的取消，照搬 scan::ScanState 模式）。
/// 由 lib.rs 经 `.manage(SqlFileState::default())` 注册。
#[derive(Default, Clone)]
pub struct SqlFileState {
    inner: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl SqlFileState {
    /// 登记一个 executionId 的取消令牌，返回其克隆供执行任务监听。
    pub async fn register(&self, execution_id: String) -> CancellationToken {
        let token = CancellationToken::new();
        self.inner.lock().await.insert(execution_id, token.clone());
        token
    }
    /// 触发某 executionId 的取消（不存在则 no-op）。
    pub async fn cancel(&self, execution_id: &str) {
        if let Some(token) = self.inner.lock().await.get(execution_id) {
            token.cancel();
        }
    }
    /// 执行结束后移除登记，避免取消表无限增长。
    pub async fn remove(&self, execution_id: &str) {
        self.inner.lock().await.remove(execution_id);
    }
}

/// 序列化成前端可判别标签联合：{ kind: "ConnectFailed", message: "..." }
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("connect failed: {0}")]
    ConnectFailed(String),
    #[error("authentication failed")]
    AuthFailed,
    #[error("connection not found: {0}")]
    NotFound(String),
    #[error("query failed: {0}")]
    QueryFailed(String),
    #[error("unsupported for this engine: {0}")]
    Unsupported(String),
    #[error("io error: {0}")]
    Io(String),
}

impl Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            DbError::ConnectFailed(_) => "ConnectFailed",
            DbError::AuthFailed => "AuthFailed",
            DbError::NotFound(_) => "NotFound",
            DbError::QueryFailed(_) => "QueryFailed",
            DbError::Unsupported(_) => "Unsupported",
            DbError::Io(_) => "Io",
        };
        let mut st = s.serialize_struct("DbError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// 引擎类型。协议族内差异由 driver_profile 区分（照搬 dbx models/connection.rs）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Postgres,
    Mysql,
    Sqlite,
    Duckdb,
    Sqlserver,
    Clickhouse,
    Elasticsearch,
    Rqlite,
    Mongodb,
    Redis,
    /// Generic JDBC, served by the Java sidecar plugin. The concrete engine
    /// (Oracle/DB2/Snowflake/Hive/…) is carried in `driver_profile`.
    Jdbc,
}
