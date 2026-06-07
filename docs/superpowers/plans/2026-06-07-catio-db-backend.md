# Catio 数据库后端（子项目 3 · 第一期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真实数据库后端（连接/测连、执行任意 SQL、schema/表结构/ER 内省、可编辑数据网格）接入 Catio，经一套 `Driver` 抽象 + 全套原生 Rust 驱动覆盖 ~30 引擎（PG 族 / MySQL 族 / SQLite / DuckDB / SQL Server / ClickHouse / Elasticsearch / rqlite / MongoDB / Redis），替换 UI 外壳中的 mock，前端组件树与像素呈现不变。

**Architecture:** Rust `src-tauri/src/db/` 用一套 `Driver` trait（`async_trait`）抽象所有引擎，`ConnManager` 持 `Box<dyn Driver>`；逐方言内省 SQL 与连接逻辑**参考重写自 dbx**（Apache-2.0）。前端 `src/services/db.ts` 包装 Tauri command，非 Tauri 环境回退现有 mock（沿用 `services/models.ts` 的 `isTauri` 探测）。查询结果从写死的 `OrderRow` 泛化为通用 `columns + rows: unknown[][]`，DataGrid 改读通用行（像素不变）。

**Tech Stack:** Rust + tokio + async-trait + thiserror + serde + serde_json；驱动 crate：`tokio-postgres`/`deadpool-postgres`、`mysql_async`、`rusqlite`(bundled)、`duckdb`(bundled)、`tiberius`、`reqwest`、`mongodb`、`redis`；前端 React 18 + TypeScript；测试：`cargo test`（纯函数 + 嵌入式引擎进程内）+ docker 门控集成测试 + Vitest（前端）。

**Spec:** `docs/superpowers/specs/2026-06-07-catio-db-backend-design.md`

---

## 实现者须读：参考实现与 crate 漂移说明（非占位符，是工程指令）

**参考实现 dbx**（github.com/t8y2/dbx，**Apache-2.0**）已 clone 在 `I:\ai-projects\dbx-ref`。本子项目的逐方言内省 SQL、类型映射、各驱动连接逻辑**参考重写自 dbx `crates/dbx-core/src/`**。逐段拷贝/改写时在文件头注明：`// adapted from dbx crates/dbx-core/src/<file>, Apache-2.0`。dbx 关键源文件对照：

| 域 | dbx 源文件 |
| --- | --- |
| Postgres 族驱动 | `db/postgres.rs`（connect L760 / list_tables L1112 / get_columns L1375 / execute_query L1410 / list_indexes L1619 / list_foreign_keys L1646） |
| MySQL 族驱动 | `db/mysql.rs`、`db/ob_oracle.rs`（OceanBase Oracle 模式，走 mysql_async） |
| SQLite / DuckDB | `db/sqlite.rs`、`db/duckdb_driver.rs`、`schema.rs`（duckdb_query_* 系列） |
| SQL Server | `db/sqlserver.rs` |
| ClickHouse / ES / rqlite | `db/clickhouse_driver.rs`、`db/elasticsearch_driver.rs`、`db/rqlite_driver.rs` |
| MongoDB / Redis | `db/mongo_driver.rs`、`mongo_ops.rs`、`db/redis_driver.rs`、`redis_ops.rs` |
| 内省类型 | `types.rs`（DatabaseInfo/TableInfo/ColumnInfo/IndexInfo/ForeignKeyInfo） |
| 方言差异 / profile | `models/connection.rs`（DatabaseType、driver_profile）、`sql_dialect.rs`、`database_capabilities.rs` |
| 结果形状 | `data_grid_sql.rs`（columns + rows: Vec<Vec<Value>>） |

**dbx 用「每引擎一个模块 + 自由函数 + 按 DatabaseType match 派发」**；Catio 改用 `Driver` trait（更利于增量加引擎），**语义不变**——把 dbx 自由函数的函数体搬进对应 trait 方法。

**crate API 漂移**：版本以 `cargo add` 实测为准（本计划基于 dbx 锁定版本：tokio-postgres 0.7 / deadpool-postgres 0.14 / mysql_async 0.36 / rusqlite 0.32 / duckdb 1.3 / tiberius 0.12 / reqwest 0.12 / mongodb 3.2 / redis 0.32）。签名对不上时以编译器与该版本 docs.rs 为准微调，不要留 TODO。

**TLS/后端纪律**（与子项目 2 一致）：统一用 **rustls**（不要 native-tls / openssl）；`rusqlite`/`duckdb` 用 **bundled** feature（不依赖系统库）。子项目 2 已确认 Windows 无 NASM，避免 aws-lc。

**测试 DB 门控**：服务器引擎（PG/MySQL/SQLServer/ClickHouse/Mongo/Redis/ES）的集成测试经环境变量门控（如 `CATIO_TEST_PG_URL`），变量缺失时 `eprintln! + return`（skip）。嵌入式引擎（SQLite/DuckDB）与纯函数测试**无条件运行**。docker-compose 测试库见 Task E-fixtures（`deploy/test/docker-compose.yml`）。

---

## 文件结构

### Rust 后端 `src-tauri/src/db/`

| 文件 | 职责 |
| --- | --- |
| `mod.rs` | 模块导出；`DbError`（thiserror，serde 标签联合）；`DatabaseType` 枚举（+ driver_profile） |
| `ids.rs` | 单调 ID 生成器（`conn-N`），纯函数可单测（结构同 `ssh/ids.rs`） |
| `result.rs` | `ColumnInfo` / `QueryResult`（通用 `rows: Vec<Vec<Value>>`）；JS 安全整数 / 二进制 → JSON，纯函数可单测 |
| `capabilities.rs` | `Capabilities`（可写/事务/有无 schema/SQL 控制台/ER）+ `capabilities_for(db_type, profile)`，纯函数可单测 |
| `dialect.rs` | 标识符引用、值转义、分页 SQL；纯函数可单测 |
| `driver.rs` | `Driver` trait（async_trait）+ 内省类型（TableInfo/IndexInfo/ForeignKeyInfo）+ `connect(args) -> Box<dyn Driver>` 工厂派发 |
| `manager.rs` | `ConnManager`：`Mutex<HashMap<ConnId, Arc<dyn Driver>>>` |
| `dml.rs` | 内联编辑 → INSERT/UPDATE/DELETE 生成，纯函数可单测 |
| `commands.rs` | Tauri commands：`db_connect/db_disconnect/db_query/db_schema/db_table_structure/db_er_model/db_preview_dml/db_apply_edits/db_history/db_snippets` |
| `drivers/postgres.rs` | PG 族 `Driver` 实现（tokio-postgres + deadpool） |
| `drivers/mysql.rs` | MySQL 族 `Driver` 实现（mysql_async，含 OceanBase） |
| `drivers/sqlite.rs` `drivers/duckdb.rs` | 嵌入式引擎 |
| `drivers/sqlserver.rs` | tiberius |
| `drivers/clickhouse.rs` `drivers/elasticsearch.rs` `drivers/rqlite.rs` | reqwest HTTP |
| `drivers/mongo.rs` `drivers/redis.rs` | 非关系伪表格映射 |

### 前端 `src/`

| 文件 | 职责 |
| --- | --- |
| `services/db.ts`（新） | 包装所有 db command + 事件；`isTauri` 假时回退 mock |
| `services/index.ts`（改） | `runQuery/getSchema/getHistory/getSnippets/listConnections` 转调 `db.ts`；`QueryResult` 泛化 |
| `services/types.ts`（改） | `QueryResult` 改通用行；新增 `ColumnInfo`（查询结果列，区别于现有 `TableCol`） |
| `state/dbConnections.ts`（新） | DB 连接档案 localStorage 读写，key `catio-db-connections` |
| `components/dbviews/DataGrid.tsx`（改） | 改读通用 `{columns, rows}`；像素/样式不变 |
| `components/modals/DbConnectModal.tsx`（改/新） | db_type 选择 + 连接字段 + 连接时密码提示 |

### Tauri 权限

`src-tauri/capabilities/default.json` 不新增插件权限（db 走自定义 command，core 默认即可）。

---

# 阶段 A：驱动抽象 + Postgres 族 + seam 泛化

完成后可跑通：连 Postgres → 执行任意 SQL → 通用结果网格 + schema/structure/ER。

## Task A1: db 模块骨架 + 依赖 + DbError + DatabaseType

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加依赖**

Run（在 `src-tauri/`）：
```bash
cd src-tauri
cargo add async-trait serde_json
cargo add tokio-postgres --features with-chrono-0_4,with-uuid-1,with-serde_json-1
cargo add deadpool-postgres --features rt_tokio_1
cargo add tokio-postgres-rustls
```
Expected: `Cargo.toml` 出现这些 crate（`serde`/`thiserror`/`tokio` 子项目 2 已加）。

- [ ] **Step 2: 写 `DbError` + `DatabaseType`（先让它编译）**

Create `src-tauri/src/db/mod.rs`:
```rust
//! Catio database backend (sub-project 3). Multi-engine via Driver trait.
//! Per-dialect logic adapted from dbx crates/dbx-core/src, Apache-2.0.
pub mod ids;

use serde::{Deserialize, Serialize};

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
}
```

- [ ] **Step 3: 在 lib.rs 挂模块（暂不注册 command）**

Modify `src-tauri/src/lib.rs`：在 `pub mod ssh;` 下方加 `pub mod db;`。

- [ ] **Step 4: 编译**

Run: `cd src-tauri && cargo build`
Expected: 编译通过（unused warnings 可接受）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "feat(db): module skeleton + deps + DbError + DatabaseType"
```

---

## Task A2: ID 生成器 + 通用结果类型（纯函数 TDD）

**Files:**
- Create: `src-tauri/src/db/ids.rs`
- Create: `src-tauri/src/db/result.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 写 ids.rs（复用 ssh/ids.rs 结构）**

Create `src-tauri/src/db/ids.rs`:
```rust
use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调 ID 生成器。prefix 形如 "conn" → "conn-1","conn-2"...
pub struct IdGen {
    prefix: &'static str,
    n: AtomicU64,
}

impl IdGen {
    pub const fn new(prefix: &'static str) -> Self {
        Self { prefix, n: AtomicU64::new(0) }
    }
    pub fn next(&self) -> String {
        let v = self.n.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{}-{}", self.prefix, v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_monotonic_and_prefixed() {
        let g = IdGen::new("conn");
        assert_eq!(g.next(), "conn-1");
        assert_eq!(g.next(), "conn-2");
    }
}
```

- [ ] **Step 2: 写 result.rs 的失败测试 + 实现**

Create `src-tauri/src/db/result.rs`:
```rust
use serde::Serialize;
use serde_json::Value;

/// 查询结果列（区别于前端 schema 浏览的 TableCol）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub pk: bool,
}

/// 通用查询结果：行=与 columns 对齐的有序值数组。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// 超出 JS 安全整数范围的 i64 转成字符串，避免前端精度丢失（照搬 dbx db/mod.rs）。
pub fn safe_i64_to_json(v: i64) -> Value {
    if (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&v) {
        Value::Number(v.into())
    } else {
        Value::String(v.to_string())
    }
}

/// 二进制 → "0x..." 十六进制字符串。
pub fn binary_to_json(bytes: &[u8]) -> Value {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    Value::String(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_i64_becomes_string() {
        assert_eq!(safe_i64_to_json(42), Value::Number(42.into()));
        assert_eq!(safe_i64_to_json(i64::MAX), Value::String(i64::MAX.to_string()));
    }
    #[test]
    fn binary_is_hex() {
        assert_eq!(binary_to_json(&[0xde, 0xad]), Value::String("0xdead".into()));
    }
}
```

Modify `src-tauri/src/db/mod.rs`：在 `pub mod ids;` 下加 `pub mod result;`。

- [ ] **Step 3: 跑测试**

Run: `cd src-tauri && cargo test --lib db::`
Expected: `ids_are_monotonic_and_prefixed`、`large_i64_becomes_string`、`binary_is_hex` 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/ids.rs src-tauri/src/db/result.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): id generator + generic QueryResult + JS-safe value encoding"
```

---

## Task A3: 能力位 + 方言（纯函数 TDD）

**Files:**
- Create: `src-tauri/src/db/capabilities.rs`
- Create: `src-tauri/src/db/dialect.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: capabilities.rs（失败测试 + 实现）**

Create `src-tauri/src/db/capabilities.rs`:
```rust
use serde::Serialize;
use crate::db::DatabaseType;

/// 引擎能力位。前端按此灰显不适用的 tab/按钮（像素不变，仅 disabled）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub writable: bool,
    pub transactions: bool,
    pub schemas: bool,       // 有 schema 命名空间概念（PG 有，MySQL 无）
    pub sql_console: bool,   // 支持任意 SQL 控制台（Redis 无）
    pub er: bool,            // 支持 FK/ER 图
    pub structure_edit: bool,
}

/// 照搬 dbx database_capabilities.rs 的判定语义。
pub fn capabilities_for(db: DatabaseType) -> Capabilities {
    use DatabaseType::*;
    match db {
        Postgres | Sqlserver => Capabilities {
            writable: true, transactions: true, schemas: true,
            sql_console: true, er: true, structure_edit: true,
        },
        Mysql | Sqlite | Duckdb => Capabilities {
            writable: true, transactions: true, schemas: db == Duckdb,
            sql_console: true, er: true, structure_edit: true,
        },
        Clickhouse | Rqlite => Capabilities {
            writable: true, transactions: false, schemas: false,
            sql_console: true, er: false, structure_edit: false,
        },
        Elasticsearch | Mongodb => Capabilities {
            writable: true, transactions: false, schemas: db == Mongodb,
            sql_console: false, er: false, structure_edit: false,
        },
        Redis => Capabilities {
            writable: true, transactions: false, schemas: true,
            sql_console: false, er: false, structure_edit: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn postgres_is_full_featured() {
        let c = capabilities_for(DatabaseType::Postgres);
        assert!(c.schemas && c.er && c.sql_console && c.writable);
    }
    #[test]
    fn redis_has_no_sql_console_or_er() {
        let c = capabilities_for(DatabaseType::Redis);
        assert!(!c.sql_console && !c.er);
    }
    #[test]
    fn mysql_has_no_schema_namespace() {
        assert!(!capabilities_for(DatabaseType::Mysql).schemas);
    }
}
```

- [ ] **Step 2: dialect.rs（失败测试 + 实现）**

Create `src-tauri/src/db/dialect.rs`:
```rust
use crate::db::DatabaseType;

/// 标识符引用。照搬 dbx sql_dialect.rs：PG/SQLite 用 "x"，MySQL 用 `x`，SQLServer 用 [x]。
pub fn quote_ident(db: DatabaseType, ident: &str) -> String {
    use DatabaseType::*;
    match db {
        Mysql => format!("`{}`", ident.replace('`', "``")),
        Sqlserver => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

/// SQL 字符串字面量转义（单引号加倍）。
pub fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 给 SELECT 包一层分页。多数引擎用 LIMIT/OFFSET；SQLServer 用 OFFSET/FETCH。
pub fn paginate(db: DatabaseType, sql: &str, limit: u32, offset: u32) -> String {
    match db {
        DatabaseType::Sqlserver => {
            format!("{sql} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
        }
        _ => format!("{sql} LIMIT {limit} OFFSET {offset}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_per_dialect() {
        assert_eq!(quote_ident(DatabaseType::Postgres, "tbl"), "\"tbl\"");
        assert_eq!(quote_ident(DatabaseType::Mysql, "tbl"), "`tbl`");
        assert_eq!(quote_ident(DatabaseType::Sqlserver, "tbl"), "[tbl]");
    }
    #[test]
    fn escapes_injection_in_ident() {
        assert_eq!(quote_ident(DatabaseType::Postgres, "a\"b"), "\"a\"\"b\"");
    }
    #[test]
    fn literal_escapes_quote() {
        assert_eq!(quote_literal("O'Brien"), "'O''Brien'");
    }
    #[test]
    fn sqlserver_pagination_differs() {
        assert!(paginate(DatabaseType::Sqlserver, "SELECT 1", 10, 5).contains("FETCH NEXT 10"));
        assert!(paginate(DatabaseType::Postgres, "SELECT 1", 10, 5).contains("LIMIT 10 OFFSET 5"));
    }
}
```

Modify `src-tauri/src/db/mod.rs`：加 `pub mod capabilities; pub mod dialect;`。

- [ ] **Step 3: 跑测试**

Run: `cd src-tauri && cargo test --lib db::capabilities db::dialect`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/capabilities.rs src-tauri/src/db/dialect.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): capability flags + dialect quoting/pagination (pure, tested)"
```

---

## Task A4: Driver trait + 内省类型 + ConnManager

**Files:**
- Create: `src-tauri/src/db/driver.rs`
- Create: `src-tauri/src/db/manager.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: driver.rs — trait + 内省类型 + ConnectArgs**

Create `src-tauri/src/db/driver.rs`:
```rust
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use crate::db::{DbError, DatabaseType, result::QueryResult, capabilities::Capabilities};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    /// 协议族内变体（如 "cockroachdb"/"tidb"/"oceanbase-oracle"），照搬 dbx driver_profile。
    pub driver_profile: Option<String>,
    /// 密码；仅内存，不落盘、不回前端。
    pub secret: Option<String>,
}

/// schema 浏览：一张表的轻量信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: String, // "table" | "view"
    pub rows_estimate: Option<i64>,
}

/// 表结构：一列。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub key: String, // "PK" | "FK" | "UNI" | ""
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub columns: String,
    pub unique: bool,
    pub method: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    pub column: String,
    pub references: String, // "schema.table.col"
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    pub fks: Vec<ForeignKeyDef>,
}

/// ER 关系（表布局坐标由前端算，后端只给关系）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErRelation {
    pub from: String,
    pub from_col: String,
    pub to: String,
    pub to_col: String,
}

/// 所有引擎统一抽象。把 dbx 各模块自由函数的函数体搬进这些方法。
#[async_trait]
pub trait Driver: Send + Sync {
    fn db_type(&self) -> DatabaseType;
    fn capabilities(&self) -> Capabilities {
        crate::db::capabilities::capabilities_for(self.db_type())
    }
    /// 测连：成功返回服务器版本串。
    async fn test(&self) -> Result<String, DbError>;
    /// 执行任意 SQL（读+写）。max_rows 触达即 truncated。
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError>;
    /// schema 浏览：库下的 schema 名（无 schema 概念的引擎返回单元素如 ["default"]）。
    async fn list_schemas(&self) -> Result<Vec<String>, DbError>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError>;
    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError>;
    /// ER：该 schema 下所有 FK 关系。不支持的引擎返回 Unsupported。
    async fn er_relations(&self, schema: &str) -> Result<Vec<ErRelation>, DbError>;
}
```

- [ ] **Step 2: manager.rs**

Create `src-tauri/src/db/manager.rs`:
```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::db::driver::Driver;

#[derive(Default)]
pub struct ConnManager {
    pub conns: Mutex<HashMap<String, Arc<dyn Driver>>>,
}

impl ConnManager {
    pub async fn insert(&self, id: String, driver: Arc<dyn Driver>) {
        self.conns.lock().await.insert(id, driver);
    }
    pub async fn get(&self, id: &str) -> Option<Arc<dyn Driver>> {
        self.conns.lock().await.get(id).cloned()
    }
    pub async fn remove(&self, id: &str) -> bool {
        self.conns.lock().await.remove(id).is_some()
    }
}
```

Modify `src-tauri/src/db/mod.rs`：加 `pub mod driver; pub mod manager;`。

- [ ] **Step 3: 编译**

Run: `cd src-tauri && cargo build`
Expected: 通过（trait 无实现者，unused 可接受）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/driver.rs src-tauri/src/db/manager.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): Driver trait + introspection types + ConnManager"
```

---

## Task A5: Postgres 驱动 — 连接 + 测连（docker 门控集成测试）

**Files:**
- Create: `src-tauri/src/db/drivers/mod.rs`
- Create: `src-tauri/src/db/drivers/postgres.rs`
- Modify: `src-tauri/src/db/mod.rs`, `src-tauri/src/db/driver.rs`
- Create: `src-tauri/tests/db_postgres.rs`

- [ ] **Step 1: drivers 模块 + Postgres 连接骨架**

Create `src-tauri/src/db/drivers/mod.rs`:
```rust
pub mod postgres;
```

Create `src-tauri/src/db/drivers/postgres.rs`（连接逻辑参考 dbx `db/postgres.rs` connect L760，rustls TLS）：
```rust
// adapted from dbx crates/dbx-core/src/db/postgres.rs, Apache-2.0
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio_postgres::NoTls; // 起步用 NoTls；TLS 变体见 Step 4 备注
use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::result::QueryResult;

pub struct PostgresDriver {
    pool: Pool,
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
        let _client = pool.get().await.map_err(|e| {
            let s = e.to_string();
            if s.contains("password") || s.contains("authentication") {
                DbError::AuthFailed
            } else {
                DbError::ConnectFailed(s)
            }
        })?;
        Ok(Self { pool, profile: args.driver_profile.clone() })
    }
}

/// 协议族默认库名（照搬 dbx models/connection.rs default_database）。
fn default_database(profile: Option<&str>) -> Option<String> {
    match profile {
        Some("cockroachdb") | Some("kwdb") => Some("defaultdb".into()),
        Some("redshift") => Some("dev".into()),
        _ => Some("postgres".into()),
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Postgres }

    async fn test(&self) -> Result<String, DbError> {
        let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let row = client.query_one("SELECT version()", &[]).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        Ok(row.get::<_, String>(0))
    }

    // 以下方法 Task A6/A7 实现；先用 Unsupported 占位让其编译
    async fn query(&self, _sql: &str, _max_rows: u32) -> Result<QueryResult, DbError> {
        Err(DbError::Unsupported("query (A6)".into()))
    }
    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        Err(DbError::Unsupported("schema (A7)".into()))
    }
    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, DbError> {
        Err(DbError::Unsupported("schema (A7)".into()))
    }
    async fn table_structure(&self, _schema: &str, _table: &str) -> Result<TableStructure, DbError> {
        Err(DbError::Unsupported("structure (A7)".into()))
    }
    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        Err(DbError::Unsupported("er (A7)".into()))
    }
}
```
> **占位说明**：`query`/`list_*` 在 A6/A7 实现，这里返回 `Unsupported` 仅为让 trait 编译——A6/A7 会替换为真实实现，不是遗留 TODO。`self.profile` 字段在 A7 方言分支用到。

- [ ] **Step 2: 工厂派发 connect()**

Modify `src-tauri/src/db/driver.rs`：文件末尾加工厂函数：
```rust
use std::sync::Arc;

/// 按 db_type 建立驱动。后续每加一个引擎在此加一臂。
pub async fn connect(args: &ConnectArgs) -> Result<Arc<dyn Driver>, DbError> {
    match args.db_type {
        DatabaseType::Postgres =>
            Ok(Arc::new(crate::db::drivers::postgres::PostgresDriver::connect(args).await?)),
        other => Err(DbError::Unsupported(format!("{:?} (later phase)", other))),
    }
}
```

Modify `src-tauri/src/db/mod.rs`：加 `pub mod drivers;`。

- [ ] **Step 3: 集成测试（docker 门控）**

Create `src-tauri/tests/db_postgres.rs`:
```rust
use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// 用 CATIO_TEST_PG_URL 形如 "host:port:user:password:dbname" 配置；缺失则 skip。
fn pg_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_PG_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 { return None; }
    Some(ConnectArgs {
        db_type: DatabaseType::Postgres,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: None,
    })
}

#[tokio::test]
async fn pg_connect_and_test() {
    let Some(args) = pg_args() else {
        eprintln!("SKIP pg_connect_and_test: set CATIO_TEST_PG_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect");
    let version = driver.test().await.expect("test() ok");
    assert!(version.to_lowercase().contains("postgresql"), "got: {version}");
}

#[tokio::test]
async fn pg_wrong_password_is_auth_failed() {
    let Some(mut args) = pg_args() else { return; };
    args.secret = Some("definitely-wrong".into());
    let err = connect(&args).await.err().expect("should fail");
    assert!(matches!(err, catio_lib::db::DbError::AuthFailed));
}
```

- [ ] **Step 4: 跑测试**

先起一个本地 PG（若有 docker）：
```bash
docker run -d --rm --name catio-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
```
Run:
```bash
cd src-tauri
CATIO_TEST_PG_URL=127.0.0.1:55432:postgres:pw:postgres cargo test --test db_postgres
```
Expected: `pg_connect_and_test`、`pg_wrong_password_is_auth_failed` PASS。无 docker/无变量时两测试打印 SKIP 并 PASS。
> **TLS 备注**：本机测试 PG 用 NoTls。生产对需 TLS 的服务器，把 `NoTls` 换成 `tokio_postgres_rustls::MakeRustlsConnect`（参考 dbx `db/postgres.rs` 的 rustls 装配）；本任务不阻塞于此。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db src-tauri/tests/db_postgres.rs
git commit -m "feat(db): postgres driver connect + test() + factory dispatch (docker-gated IT)"
```

---

## Task A6: Postgres 驱动 — 执行 SQL → 通用结果

**Files:**
- Modify: `src-tauri/src/db/drivers/postgres.rs`
- Modify: `src-tauri/tests/db_postgres.rs`

- [ ] **Step 1: 实现 query()（PG 行 → serde_json::Value）**

参考 dbx `db/postgres.rs` `execute_query` L1410 的类型映射，替换 `PostgresDriver::query` 占位实现为：
```rust
async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
    use crate::db::result::{ColumnInfo, safe_i64_to_json, binary_to_json};
    use serde_json::Value;
    let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    let stmt = client.prepare(sql).await.map_err(|e| DbError::QueryFailed(e.to_string()))?;
    let cols: Vec<ColumnInfo> = stmt.columns().iter().map(|c| ColumnInfo {
        name: c.name().to_string(),
        type_name: c.type_().name().to_string(),
        pk: false,
    }).collect();
    let pg_rows = client.query(&stmt, &[]).await.map_err(|e| DbError::QueryFailed(e.to_string()))?;
    let mut rows = Vec::new();
    let mut truncated = false;
    for (i, row) in pg_rows.iter().enumerate() {
        if i as u32 >= max_rows { truncated = true; break; }
        let mut out = Vec::with_capacity(cols.len());
        for (idx, col) in stmt.columns().iter().enumerate() {
            // 按 PG 类型取值并转 Value；照搬 dbx execute_query 的逐类型分支。
            // 关键分支：int2/int4 -> Number；int8 -> safe_i64_to_json；float4/8 -> Number；
            // bool -> Bool；text/varchar/name/uuid/json/jsonb/timestamp -> String；bytea -> binary_to_json；
            // NULL -> Null。其余类型用 to_string() 兜底为 String。
            let v: Value = pg_value_to_json(row, idx, col.type_());
            out.push(v);
        }
        rows.push(out);
    }
    Ok(QueryResult { columns: cols, rows, rows_affected: None, truncated })
}
```
并在文件内加辅助函数 `pg_value_to_json(row, idx, ty) -> serde_json::Value`，逐类型分支照搬 dbx `db/postgres.rs` 的取值逻辑（int2/int4/int8/float4/float8/bool/text/varchar/uuid/json/jsonb/timestamp/date/bytea/numeric…），每个分支 `row.try_get::<_, Option<T>>(idx)`，`None` → `Value::Null`，i64 走 `safe_i64_to_json`，`&[u8]` 走 `binary_to_json`，无法识别的类型用 `try_get::<_, Option<String>>` 兜底。

> **写语句的 rows_affected（E2 依赖）**：`prepare` 后用 `stmt.columns().is_empty()` 判定是否返回行集——无列（UPDATE/INSERT/DELETE/DDL）时改调 `client.execute(&stmt, &[])`，把返回的受影响行数填进 `QueryResult.rows_affected`，`rows` 留空；有列才走上面的取行逻辑。这样 `db_apply_edits` 才能拿到真实计数。其余驱动的 `query` 同此约定（mysql_async 用 `conn.affected_rows()`，rusqlite 用 `execute` 返回值等）。

- [ ] **Step 2: 集成测试 — 通用结果**

Append to `src-tauri/tests/db_postgres.rs`:
```rust
#[tokio::test]
async fn pg_query_returns_generic_rows() {
    let Some(args) = pg_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT 1 AS n, 'hi' AS s, true AS b", 100).await.unwrap();
    assert_eq!(r.columns.len(), 3);
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.rows.len(), 1);
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("hi"));
    assert_eq!(r.rows[0][2], serde_json::json!(true));
}

#[tokio::test]
async fn pg_query_truncates_at_max_rows() {
    let Some(args) = pg_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let r = driver.query("SELECT * FROM generate_series(1, 50)", 10).await.unwrap();
    assert_eq!(r.rows.len(), 10);
    assert!(r.truncated);
}
```

- [ ] **Step 3: 跑测试**

Run: `cd src-tauri && CATIO_TEST_PG_URL=127.0.0.1:55432:postgres:pw:postgres cargo test --test db_postgres`
Expected: 新增两测试 PASS（无 PG 时 SKIP）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/drivers/postgres.rs src-tauri/tests/db_postgres.rs
git commit -m "feat(db): postgres query execution -> generic QueryResult"
```

---

## Task A7: Postgres 驱动 — schema/structure/ER 内省

**Files:**
- Modify: `src-tauri/src/db/drivers/postgres.rs`
- Modify: `src-tauri/tests/db_postgres.rs`

- [ ] **Step 1: 实现 list_schemas / list_tables / table_structure / er_relations**

替换四个占位方法，SQL 照搬 dbx `db/postgres.rs`（list_schemas L1248 / list_tables L1112 / get_columns L1375 / list_indexes L1619 / list_foreign_keys L1646）。要点：
```rust
async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
    let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    let rows = client.query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('pg_catalog','information_schema') \
         AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%' \
         ORDER BY schema_name", &[]).await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
    let client = self.pool.get().await.map_err(|e| DbError::ConnectFailed(e.to_string()))?;
    let rows = client.query(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = $1 ORDER BY table_name", &[&schema]).await
        .map_err(|e| DbError::QueryFailed(e.to_string()))?;
    Ok(rows.iter().map(|r| TableInfo {
        name: r.get::<_, String>(0),
        kind: if r.get::<_, String>(1) == "VIEW" { "view".into() } else { "table".into() },
        rows_estimate: None,
    }).collect())
}
```
`table_structure`：三段查询拼成 `TableStructure`——列（information_schema.columns + 主键判定）、索引（pg_indexes / pg_index）、FK（information_schema 的 referential_constraints + key_column_usage）。逐列 `key` 字段：主键填 `"PK"`、FK 列填 `"FK"`、唯一填 `"UNI"`，否则 `""`。
`er_relations`：查该 schema 所有 FK，输出 `ErRelation { from, from_col, to, to_col }`。
（具体 SQL 文本逐段从 dbx 对应函数拷入并注明 `// adapted from dbx ...`。）

- [ ] **Step 2: 集成测试 — 内省**

Append to `src-tauri/tests/db_postgres.rs`:
```rust
#[tokio::test]
async fn pg_introspects_schema_and_structure() {
    let Some(args) = pg_args() else { return; };
    let driver = connect(&args).await.unwrap();
    // 准备：建表
    driver.query("DROP TABLE IF EXISTS catio_it_child", 1).await.ok();
    driver.query("DROP TABLE IF EXISTS catio_it_parent", 1).await.ok();
    driver.query("CREATE TABLE catio_it_parent (id int PRIMARY KEY, name text)", 1).await.unwrap();
    driver.query("CREATE TABLE catio_it_child (id int PRIMARY KEY, \
                  parent_id int REFERENCES catio_it_parent(id))", 1).await.unwrap();

    let schemas = driver.list_schemas().await.unwrap();
    assert!(schemas.iter().any(|s| s == "public"));

    let tables = driver.list_tables("public").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "catio_it_parent"));

    let st = driver.table_structure("public", "catio_it_parent").await.unwrap();
    assert!(st.columns.iter().any(|c| c.name == "id" && c.key == "PK"));

    let rels = driver.er_relations("public").await.unwrap();
    assert!(rels.iter().any(|r| r.from == "catio_it_child" && r.to == "catio_it_parent"));

    driver.query("DROP TABLE catio_it_child", 1).await.ok();
    driver.query("DROP TABLE catio_it_parent", 1).await.ok();
}
```

- [ ] **Step 3: 跑测试**

Run: `cd src-tauri && CATIO_TEST_PG_URL=127.0.0.1:55432:postgres:pw:postgres cargo test --test db_postgres`
Expected: `pg_introspects_schema_and_structure` PASS（无 PG 时 SKIP）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/drivers/postgres.rs src-tauri/tests/db_postgres.rs
git commit -m "feat(db): postgres schema/structure/ER introspection"
```

---

## Task A8: Tauri commands + 注册

**Files:**
- Create: `src-tauri/src/db/commands.rs`
- Modify: `src-tauri/src/db/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: commands.rs**

Create `src-tauri/src/db/commands.rs`:
```rust
use crate::db::{DbError, ids::IdGen};
use crate::db::driver::{self, ConnectArgs, TableInfo, TableStructure, ErRelation};
use crate::db::manager::ConnManager;
use crate::db::result::QueryResult;
use crate::db::capabilities::Capabilities;
use serde::Serialize;

static CONN_IDS: IdGen = IdGen::new("conn");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub conn_id: String,
    pub version: String,
    pub capabilities: Capabilities,
}

#[tauri::command]
pub async fn db_connect(args: ConnectArgs, mgr: tauri::State<'_, ConnManager>)
    -> Result<ConnectResult, DbError> {
    let drv = driver::connect(&args).await?;
    let version = drv.test().await?;
    let caps = drv.capabilities();
    let id = CONN_IDS.next();
    mgr.insert(id.clone(), drv).await;
    Ok(ConnectResult { conn_id: id, version, capabilities: caps })
}

#[tauri::command]
pub async fn db_disconnect(conn_id: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<(), DbError> {
    if mgr.remove(&conn_id).await { Ok(()) } else { Err(DbError::NotFound(conn_id)) }
}

#[tauri::command]
pub async fn db_query(conn_id: String, sql: String, max_rows: Option<u32>,
    mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.query(&sql, max_rows.unwrap_or(1000)).await
}

#[tauri::command]
pub async fn db_schema(conn_id: String, mgr: tauri::State<'_, ConnManager>)
    -> Result<Vec<(String, Vec<TableInfo>)>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    let mut out = Vec::new();
    for s in drv.list_schemas().await? {
        let tables = drv.list_tables(&s).await?;
        out.push((s, tables));
    }
    Ok(out)
}

#[tauri::command]
pub async fn db_table_structure(conn_id: String, schema: String, table: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<TableStructure, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.table_structure(&schema, &table).await
}

#[tauri::command]
pub async fn db_er_model(conn_id: String, schema: String,
    mgr: tauri::State<'_, ConnManager>) -> Result<Vec<ErRelation>, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.er_relations(&schema).await
}
```

Modify `src-tauri/src/db/mod.rs`：加 `pub mod commands;`。

- [ ] **Step 2: 注册 state + commands**

Modify `src-tauri/src/lib.rs`：
```rust
use db::manager::ConnManager;
```
在 `.manage(SessionManager::default())` 下加 `.manage(ConnManager::default())`；在 `generate_handler!` 末尾（ssh 命令之后）加：
```rust
            ,
            db::commands::db_connect,
            db::commands::db_disconnect,
            db::commands::db_query,
            db::commands::db_schema,
            db::commands::db_table_structure,
            db::commands::db_er_model
```

- [ ] **Step 3: 编译**

Run: `cd src-tauri && cargo build`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/commands.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "feat(db): tauri commands (connect/query/schema/structure/er) + registration"
```

---

## Task A9: 前端 seam 泛化（QueryResult 通用行 + DataGrid 改读）

**Files:**
- Modify: `src/services/types.ts`
- Modify: `src/services/index.ts`
- Modify: `src/components/dbviews/DataGrid.tsx`
- Create: `src/components/dbviews/DataGrid.test.tsx`

- [ ] **Step 1: 先看现状**

Read `src/components/dbviews/DataGrid.tsx` 全文，记下它现在如何从 `columns: TableCol[]` + `rows: OrderRow[]` 取值渲染（按字段名访问 `row.status` 等）。目标：改为按列索引访问值数组，**渲染输出像素不变**。

- [ ] **Step 2: types.ts 泛化 QueryResult**

Modify `src/services/types.ts`：在 `TableCol` 之后加查询结果列类型，并新增通用 `QueryResult`（不要删 `OrderRow`/`TableCol`，schema 浏览仍用）：
```ts
// ---- 查询结果（通用行）----
export interface ResultColumn {
  name: string
  type: string
  pk?: boolean
  fk?: boolean
}
export interface QueryResult {
  columns: ResultColumn[]
  rows: unknown[][]
  rowsAffected?: number
  truncated?: boolean
}
```

- [ ] **Step 3: index.ts 改 QueryResult 来源 + 适配 mock**

Modify `src/services/index.ts`：删除本地 `export interface QueryResult {...}`，改从 types 导入；`runQuery` 暂仍回退 mock，但把 mock 适配成通用行：
```ts
import type { QueryResult, ResultColumn } from './types'

function mockQueryResult(): QueryResult {
  const columns: ResultColumn[] = DATA.ordersColumns.map(c => ({
    name: c.name, type: c.type, pk: c.pk, fk: c.fk,
  }))
  const keys = DATA.ordersColumns.map(c => c.name)
  const rows: unknown[][] = DATA.ordersRows.map(
    r => keys.map(k => (r as unknown as Record<string, unknown>)[k]),
  )
  return { columns, rows }
}

export async function runQuery(_connId: string, _sql: string): Promise<QueryResult> {
  return mockQueryResult()
}
export type { QueryResult } from './types'
```

- [ ] **Step 4: DataGrid 改读通用行（像素不变）**

Modify `src/components/dbviews/DataGrid.tsx`：props 从 `{ columns: TableCol[]; rows: OrderRow[] }` 改为 `{ columns: ResultColumn[]; rows: unknown[][] }`（+ 保留 `statusTones`/`density` 等现有 props）。单元格取值由 `row[colName]` 改为 `row[colIndex]`。渲染结构、className、内联样式**逐字不变**——只换数据访问方式。把原先按字段名特判（如 status 上色）改为按「列名匹配 + 列索引取值」实现，保持同样的视觉输出。

- [ ] **Step 5: DataGrid 测试（验证通用行渲染）**

Create `src/components/dbviews/DataGrid.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DataGrid } from './DataGrid'
import type { ResultColumn } from '../../services/types'

describe('DataGrid generic rows', () => {
  it('renders columns and indexed row values', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    render(<DataGrid columns={columns} rows={rows} statusTones={{}} density="cozy" />)
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('id')).toBeInTheDocument()
  })
})
```
> 若 `DataGrid` 的 props 名（`statusTones`/`density`）与现状不同，按 Step 1 记录的真实签名调整测试。

- [ ] **Step 6: 跑测试 + 类型检查 + 调用点修复**

Run: `npm test -- src/components/dbviews/DataGrid.test.tsx`
然后 `npx tsc --noEmit`，修复因 props 变化报错的调用点（`DbWorkbench.tsx` 传 `D.ordersColumns/D.ordersRows` 处——改为传 `mockQueryResult()` 风格的通用 `{columns, rows}`，或经 `runQuery` 取）。
Expected: 测试 PASS，`tsc` 无错。

- [ ] **Step 7: Commit**

```bash
git add src/services/types.ts src/services/index.ts src/components/dbviews/DataGrid.tsx src/components/dbviews/DataGrid.test.tsx
git commit -m "refactor(db): generalize QueryResult to generic rows; DataGrid reads indexed values (pixels unchanged)"
```

---

## Task A10: services/db.ts（包装 + mock 回退）

**Files:**
- Create: `src/services/db.ts`
- Create: `src/services/db.test.ts`
- Modify: `src/services/index.ts`

- [ ] **Step 1: 写失败测试（mock invoke）**

Create `src/services/db.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('services/db', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('dbConnect forwards args to invoke under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ connId: 'conn-1', version: 'PostgreSQL 16', capabilities: {} })
    const { dbConnect } = await import('./db')
    const r = await dbConnect({ dbType: 'postgres', host: 'h', port: 5432, user: 'u', secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('db_connect', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.connId).toBe('conn-1')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('runQuery falls back to mock outside Tauri', async () => {
    const { runQuery } = await import('./db')
    const r = await runQuery('any', 'SELECT 1')
    expect(r.columns.length).toBeGreaterThan(0)
    expect(Array.isArray(r.rows)).toBe(true)
  })
})
```

- [ ] **Step 2: 实现 db.ts**

Create `src/services/db.ts`:
```ts
import { DATA } from './mockData'
import type { QueryResult, ResultColumn, Schema } from './types'

const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export type DbType =
  | 'postgres' | 'mysql' | 'sqlite' | 'duckdb' | 'sqlserver'
  | 'clickhouse' | 'elasticsearch' | 'rqlite' | 'mongodb' | 'redis'

export interface DbConnectArgs {
  dbType: DbType; host: string; port: number; user: string
  database?: string; driverProfile?: string; secret?: string
}
export interface DbCapabilities {
  writable: boolean; transactions: boolean; schemas: boolean
  sqlConsole: boolean; er: boolean; structureEdit: boolean
}
export interface DbConnectResult { connId: string; version: string; capabilities: DbCapabilities }

export async function dbConnect(args: DbConnectArgs): Promise<DbConnectResult> {
  return invoke<DbConnectResult>('db_connect', { args })
}
export async function dbDisconnect(connId: string): Promise<void> {
  return invoke('db_disconnect', { connId })
}

function mockQueryResult(): QueryResult {
  const columns: ResultColumn[] = DATA.ordersColumns.map(c => ({
    name: c.name, type: c.type, pk: c.pk, fk: c.fk,
  }))
  const keys = DATA.ordersColumns.map(c => c.name)
  const rows: unknown[][] = DATA.ordersRows.map(
    r => keys.map(k => (r as unknown as Record<string, unknown>)[k]),
  )
  return { columns, rows }
}

export async function runQuery(connId: string, sql: string): Promise<QueryResult> {
  if (!isTauri()) return mockQueryResult()
  return invoke<QueryResult>('db_query', { connId, sql })
}

export async function getSchema(connId: string): Promise<Schema> {
  if (!isTauri()) return DATA.schema
  // 后端返回 [schemaName, tables][]；适配成前端 Schema 形状
  const raw = await invoke<Array<[string, Array<{ name: string; kind: string }>]>>('db_schema', { connId })
  return {
    db: connId,
    schemas: raw.map(([name, tables]) => ({
      name, open: false,
      tables: tables.filter(t => t.kind === 'table').map(t => ({ name: t.name, rows: '', cols: 0 })),
      views: tables.filter(t => t.kind === 'view').map(t => ({ name: t.name })),
      functions: [],
    })),
  }
}
```

- [ ] **Step 3: index.ts 转调**

Modify `src/services/index.ts`：把 `runQuery`/`getSchema` 改为 `export { runQuery, getSchema } from './db'`（删本地 mock 实现），保留其余 getters。导出 db 类型：`export { dbConnect, dbDisconnect } from './db'` + `export type { DbType, DbConnectArgs, DbConnectResult, DbCapabilities } from './db'`。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npm test -- src/services/db.test.ts && npx tsc --noEmit`
Expected: 2 测试 PASS，tsc 无错。

- [ ] **Step 5: Commit**

```bash
git add src/services/db.ts src/services/db.test.ts src/services/index.ts
git commit -m "feat(db): services/db.ts wrapper + mock fallback; index.ts delegates"
```

---

## Task A11: DB 连接档案（localStorage）+ 连接流程接线

提供从 UI 真正发起 `dbConnect` 的入口，并把非敏感档案存 localStorage（spec §7）。秘密仅连接时输入、仅内存。

**Files:**
- Create: `src/state/dbConnections.ts`
- Create: `src/state/dbConnections.test.ts`
- Modify: `src/components/modals/NewConnectionModal.tsx`（或新建 `DbConnectModal.tsx`，按现状决定）
- Modify: 连接列表的「连接」动作处（调 `dbConnect`）

- [ ] **Step 1: 看现状**

Read `src/components/modals/NewConnectionModal.tsx` 与连接列表组件（HomeView/Sidebar），记下现有「新建连接 / 连接」交互如何挂载。决定是扩展 `NewConnectionModal`（加 db_type + DB 字段分支）还是新建 `DbConnectModal`——**沿用现有组件的像素与 atoms**。

- [ ] **Step 2: dbConnections.ts（失败测试 + 实现）**

Create `src/state/dbConnections.test.ts`：测 `saveDbConnection`/`listDbConnections` 往返 localStorage（不含 secret 字段），key `catio-db-connections`。

Create `src/state/dbConnections.ts`:
```ts
import type { DbConnectArgs } from '../services/db'

const KEY = 'catio-db-connections'
/** 档案 = 连接参数去掉 secret（秘密永不持久化）。 */
export type DbProfile = Omit<DbConnectArgs, 'secret'> & { id: string; name: string }

export function listDbConnections(): DbProfile[] {
  if (typeof localStorage === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DbProfile[] } catch { return [] }
}
export function saveDbConnection(p: DbProfile): void {
  const all = listDbConnections().filter(x => x.id !== p.id)
  all.push(p)
  localStorage.setItem(KEY, JSON.stringify(all))
}
export function removeDbConnection(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(listDbConnections().filter(x => x.id !== id)))
}
```

- [ ] **Step 3: 连接弹框 + 连接动作**

在选定的 modal 里：db_type 下拉（10 种）+ host/port/user/database/driver_profile 字段 + 连接时密码输入（仅内存）。提交时：`saveDbConnection`（不含密码）+ 调 `dbConnect({...profile, secret})`，成功后把返回的 `connId`/`capabilities` 存进连接态（供 DbWorkbench 用，D3 消费）。`secret` 用完即弃，不写 localStorage、不入 state 持久层。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npm test -- src/state/dbConnections.test.ts && npx tsc --noEmit`
Expected: PASS，无类型错。

- [ ] **Step 5: Commit**

```bash
git add src/state/dbConnections.ts src/state/dbConnections.test.ts src/components/modals
git commit -m "feat(db): connection profiles in localStorage + connect flow (secret in-memory only)"
```

---

# 阶段 B：MySQL 族 + SQLite + DuckDB

每个驱动都实现 Task A4 的 `Driver` trait，方法体（连接、`query` 类型映射、内省 SQL）参考重写自 dbx 对应模块。嵌入式引擎（SQLite/DuckDB）的集成测试**无条件运行**（无需 docker）。

## Task B1: MySQL 族驱动（含 OceanBase）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/drivers/mysql.rs`
- Modify: `src-tauri/src/db/drivers/mod.rs`, `src-tauri/src/db/driver.rs`
- Create: `src-tauri/tests/db_mysql.rs`

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add mysql_async --no-default-features --features default-rustls,chrono,rust_decimal`
Expected: `Cargo.toml` 出现 `mysql_async`。

- [ ] **Step 2: 实现 MySQLDriver**

Create `src-tauri/src/db/drivers/mysql.rs`，结构镜像 `postgres.rs`，方法体参考 dbx `db/mysql.rs`（连接用 `mysql_async::Pool::from_url` 或 `OptsBuilder`；`query` 类型映射照搬 dbx；内省用 `information_schema`，注意 MySQL **无 schema 命名空间**——`list_schemas` 返回当前 database 名作单元素）。OceanBase-Oracle 模式（`driver_profile == "oceanbase-oracle"`）的内省 SQL 参考 dbx `db/ob_oracle.rs`（`ALL_USERS`/`ALL_TABLES` 等 Oracle 风格），在 `MySQLDriver` 内按 profile 分支。完整方法签名照抄 `postgres.rs` 的 trait 实现，逐方法替换为 MySQL 逻辑：
```rust
// adapted from dbx crates/dbx-core/src/db/mysql.rs (+ ob_oracle.rs for oceanbase-oracle), Apache-2.0
use async_trait::async_trait;
use mysql_async::{Pool, prelude::*};
use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ErRelation};
use crate::db::result::QueryResult;

pub struct MySqlDriver { pool: Pool, profile: Option<String> }

impl MySqlDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        let db = args.database.clone().unwrap_or_default();
        let url = format!("mysql://{}:{}@{}:{}/{}",
            args.user, args.secret.clone().unwrap_or_default(), args.host, args.port, db);
        let pool = Pool::from_url(&url).map_err(|e| DbError::ConnectFailed(e.to_string()))?;
        let mut conn = pool.get_conn().await.map_err(|e| {
            let s = e.to_string();
            if s.contains("Access denied") { DbError::AuthFailed } else { DbError::ConnectFailed(s) }
        })?;
        drop(conn);
        Ok(Self { pool, profile: args.driver_profile.clone() })
    }
}
// impl Driver for MySqlDriver { ... }  // db_type 返回 Mysql；其余方法体见 dbx db/mysql.rs
```
> `query` 行→Value：用 `row.get_opt::<T, _>(idx)` 逐列试 i64/f64/bool/String/Vec<u8>，照搬 dbx `db/mysql.rs` 与 `db/ob_oracle.rs` 的 `get_str/get_opt_*` 辅助。i64 走 `result::safe_i64_to_json`，二进制走 `binary_to_json`。

- [ ] **Step 3: 工厂加一臂**

Modify `src-tauri/src/db/driver.rs` 的 `connect()` match：加
```rust
        DatabaseType::Mysql =>
            Ok(Arc::new(crate::db::drivers::mysql::MySqlDriver::connect(args).await?)),
```
Modify `src-tauri/src/db/drivers/mod.rs`：加 `pub mod mysql;`。

- [ ] **Step 4: 集成测试（docker 门控，复用 A5 测试模板）**

Create `src-tauri/tests/db_mysql.rs`：结构同 `db_postgres.rs`，环境变量 `CATIO_TEST_MYSQL_URL`，`db_type: DatabaseType::Mysql`。测试用例：`mysql_connect_and_test`（version 含 "mysql"/"maria"）、`mysql_query_returns_generic_rows`（`SELECT 1 AS n, 'hi' AS s`）、`mysql_introspects_structure`（建表→断言 PK 列）。逐句复用 A5/A6/A7 的断言形状，仅换连接参数与 version 断言串。

- [ ] **Step 5: 跑测试**

```bash
docker run -d --rm --name catio-mysql -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=catio -p 53306:3306 mysql:8
cd src-tauri && CATIO_TEST_MYSQL_URL=127.0.0.1:53306:root:pw:catio cargo test --test db_mysql
```
Expected: PASS（无 docker 时 SKIP）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db src-tauri/tests/db_mysql.rs
git commit -m "feat(db): mysql-family driver (incl. oceanbase-oracle profile)"
```

---

## Task B2: SQLite 驱动（嵌入式，集成测试无条件运行）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/drivers/sqlite.rs`
- Modify: `src-tauri/src/db/drivers/mod.rs`, `src-tauri/src/db/driver.rs`
- Create: `src-tauri/tests/db_sqlite.rs`

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add rusqlite --features bundled,load_extension`
Expected: `rusqlite` 出现（bundled 自带 SQLite，无系统依赖）。

- [ ] **Step 2: 实现 SqliteDriver**

`rusqlite` 是同步 API——用 `tokio::task::spawn_blocking` 包裹，或在 `Driver` 实现里持 `Arc<Mutex<rusqlite::Connection>>` 并在 spawn_blocking 中操作。`ConnectArgs.host` 复用为数据库文件路径（`:memory:` 支持）。`query` 用 `stmt.query_map`，列类型从 `column_decltype`/`ValueRef` 推断 → Value。内省查 `sqlite_master` + `PRAGMA table_info`/`PRAGMA index_list`/`PRAGMA foreign_key_list`（参考 dbx `db/sqlite.rs`）。`list_schemas` 返回 `["main"]`。
```rust
// adapted from dbx crates/dbx-core/src/db/sqlite.rs, Apache-2.0
// 关键：rusqlite 同步，所有方法体放进 tokio::task::spawn_blocking。
```

- [ ] **Step 3: 工厂 + mod 加一臂**（`DatabaseType::Sqlite`、`pub mod sqlite;`，同 B1 Step 3）

- [ ] **Step 4: 集成测试（无门控，用 `:memory:`）**

Create `src-tauri/tests/db_sqlite.rs`:
```rust
use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

fn mem_args() -> ConnectArgs {
    ConnectArgs {
        db_type: DatabaseType::Sqlite,
        host: ":memory:".into(), port: 0, user: String::new(),
        database: None, driver_profile: None, secret: None,
    }
}

#[tokio::test]
async fn sqlite_roundtrip_and_introspect() {
    let drv = connect(&mem_args()).await.expect("connect");
    drv.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 1).await.unwrap();
    drv.query("INSERT INTO t (name) VALUES ('alice'), ('bob')", 1).await.unwrap();
    let r = drv.query("SELECT id, name FROM t ORDER BY id", 100).await.unwrap();
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][1], serde_json::json!("alice"));
    let st = drv.table_structure("main", "t").await.unwrap();
    assert!(st.columns.iter().any(|c| c.name == "id" && c.key == "PK"));
}
```
> **注意**：`:memory:` 库随连接消失——确保 `SqliteDriver` 全程持同一 `Connection`（不是每次 query 新开），否则建表与查询不在同一内存库。

- [ ] **Step 5: 跑测试**

Run: `cd src-tauri && cargo test --test db_sqlite`
Expected: `sqlite_roundtrip_and_introspect` PASS（无需 docker）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db src-tauri/tests/db_sqlite.rs
git commit -m "feat(db): sqlite driver (bundled, in-memory IT)"
```

---

## Task B3: DuckDB 驱动（嵌入式，集成测试无条件运行）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/drivers/duckdb.rs`
- Modify: `src-tauri/src/db/drivers/mod.rs`, `src-tauri/src/db/driver.rs`
- Create: `src-tauri/tests/db_duckdb.rs`

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add duckdb --features bundled`
Expected: `duckdb` 出现。
> **编译时长警告**：`duckdb` bundled 首次编译很慢（C++ 库）。这是预期的，不要中断。

- [ ] **Step 2: 实现 DuckDbDriver**

镜像 `sqlite.rs`（duckdb crate API 与 rusqlite 高度相似，也是同步 → spawn_blocking）。内省参考 dbx `schema.rs` 的 `duckdb_query_tables`/`duckdb_query_columns`/`duckdb_list_schemas`（DuckDB **有** schema 概念，`list_schemas` 查 `information_schema.schemata` 或 `duckdb_query_*`）。`host` 复用为文件路径，`:memory:` 支持。

- [ ] **Step 3: 工厂 + mod 加一臂**（`DatabaseType::Duckdb`、`pub mod duckdb;`）

- [ ] **Step 4: 集成测试（无门控，`:memory:`）**

Create `src-tauri/tests/db_duckdb.rs`：结构同 `db_sqlite.rs`，`db_type: DatabaseType::Duckdb`，断言 `SELECT 1 AS n` 通用结果 + 建表内省。

- [ ] **Step 5: 跑测试**

Run: `cd src-tauri && cargo test --test db_duckdb`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db src-tauri/tests/db_duckdb.rs
git commit -m "feat(db): duckdb driver (bundled, in-memory IT)"
```

---

# 阶段 C：SQL Server + HTTP 引擎

## Task C1: SQL Server 驱动（tiberius）

**Files:** Modify `Cargo.toml`；Create `src-tauri/src/db/drivers/sqlserver.rs`、`src-tauri/tests/db_sqlserver.rs`；Modify `drivers/mod.rs`、`driver.rs`。

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add tiberius --no-default-features --features tds73,chrono,rust_decimal,rustls`
Expected: `tiberius` 出现。

- [ ] **Step 2: 实现 SqlServerDriver**

tiberius 需配合 `tokio-util` 的 compat（`tokio::net::TcpStream` → `Compat`）。连接装配参考 dbx `db/sqlserver.rs`：`tiberius::Config`（host/port/auth=`AuthMethod::sql_server(user, pw)`、`trust_cert()`），`Client::connect(config, tcp.compat_write())`。`query` 用 `client.query(sql, &[])` → `into_first_result()`，逐列 `row.try_get` → Value（类型映射照搬 dbx）。内省查 `sys.schemas`/`INFORMATION_SCHEMA`/`sys.foreign_keys`。标识符引用 `dialect::quote_ident` 已支持 `[x]`。可能需 `cargo add tokio-util --features compat`（dev+main）。
```rust
// adapted from dbx crates/dbx-core/src/db/sqlserver.rs, Apache-2.0
```

- [ ] **Step 3: 工厂 + mod 加一臂**（`DatabaseType::Sqlserver`）

- [ ] **Step 4: 集成测试（docker 门控）**

Create `src-tauri/tests/db_sqlserver.rs`：env `CATIO_TEST_MSSQL_URL`，结构同 A5。

- [ ] **Step 5: 跑测试**

```bash
docker run -d --rm --name catio-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Catio_pw1 -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
cd src-tauri && CATIO_TEST_MSSQL_URL=127.0.0.1:51433:sa:Catio_pw1:master cargo test --test db_sqlserver
```
Expected: PASS（无 docker 时 SKIP）。

- [ ] **Step 6: Commit** — `feat(db): sql server driver (tiberius)`

---

## Task C2: HTTP 引擎 — ClickHouse / Elasticsearch / rqlite（reqwest）

三个引擎都走 HTTP，共用 `reqwest::Client`。每个一个驱动文件，但可共享一个 `http.rs` helper（POST JSON + 错误映射）。

**Files:** Modify `Cargo.toml`；Create `src-tauri/src/db/drivers/clickhouse.rs`、`elasticsearch.rs`、`rqlite.rs`、（可选）`src-tauri/src/db/drivers/http.rs`；Create 对应 `tests/db_clickhouse.rs`、`db_elasticsearch.rs`、`db_rqlite.rs`；Modify `drivers/mod.rs`、`driver.rs`。

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add reqwest --no-default-features --features json,stream,rustls-tls,socks`
Expected: `reqwest` 出现。

- [ ] **Step 2: ClickHouse 驱动**

参考 dbx `db/clickhouse_driver.rs`：`query` POST 到 `http://host:port/?default_format=JSONCompact`，body=SQL，解析 JSONCompact 的 `meta`（列名+类型）+ `data`（行数组）→ `QueryResult`。`list_schemas`/`list_tables` 查 `system.databases`/`system.tables`。能力位 `er=false`/`structure_edit=false`（A3 已设）。`test()` 跑 `SELECT version()`。

- [ ] **Step 3: Elasticsearch 驱动（伪表格）**

参考 dbx `db/elasticsearch_driver.rs`：`list_schemas` 返回 `["default"]`；`list_tables` GET `/_cat/indices?format=json` → 每个 index 作 table；`query`（无 SQL 控制台，但 DataGrid 取数据）GET `/{index}/_search` → `hits.hits._source` 字段并集作列、文档作行。`table_structure` 用 `/{index}/_mapping` 推列。`er_relations` 返回 `Err(Unsupported)`。

- [ ] **Step 4: rqlite 驱动**

参考 dbx `db/rqlite_driver.rs`：rqlite 是 SQLite-over-HTTP，`query` POST 到 `/db/query`（读）或 `/db/execute`（写）JSON，解析 `results[].columns`/`results[].values` → `QueryResult`。内省同 SQLite 思路但走 HTTP（查 `sqlite_master`）。

- [ ] **Step 5: 工厂 + mod 加三臂**（`Clickhouse`/`Elasticsearch`/`Rqlite`，`pub mod ...`）

- [ ] **Step 6: 集成测试（docker 门控）**

三个 `tests/db_*.rs`，env `CATIO_TEST_CLICKHOUSE_URL`/`CATIO_TEST_ES_URL`/`CATIO_TEST_RQLITE_URL`。ClickHouse/rqlite 测 `SELECT 1`；ES 测 `_cat/indices` 列出 + 一个预建 index 的 `_search`。docker 起法各引擎官方镜像。

- [ ] **Step 7: 跑测试 + Commit**

Run（示例）：`cd src-tauri && CATIO_TEST_RQLITE_URL=... cargo test --test db_rqlite`
逐引擎可独立 commit：`feat(db): clickhouse driver (http)` / `feat(db): elasticsearch driver (http, pseudo-tabular)` / `feat(db): rqlite driver (http)`。

---

# 阶段 D：非关系引擎（MongoDB / Redis 伪表格 + 前端能力位灰显）

## Task D1: MongoDB 驱动（伪表格映射）

**Files:** Modify `Cargo.toml`；Create `src-tauri/src/db/drivers/mongo.rs`、`src-tauri/tests/db_mongo.rs`；Modify `drivers/mod.rs`、`driver.rs`。

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add mongodb`
Expected: `mongodb` 出现。

- [ ] **Step 2: 实现 MongoDriver（参考 dbx db/mongo_driver.rs + mongo_ops.rs）**

映射（spec §4）：database→schema，collection→table，document→行。
- `connect`：`mongodb::Client::with_uri_str(mongodb://user:pw@host:port)`。
- `list_schemas`：`client.list_database_names()`。
- `list_tables(schema)`：`db.list_collection_names()`，全部 `kind:"table"`。
- `query`：**不接任意 SQL**——约定 `sql` 为 collection 名（或 `db.coll.find(...)` 形式，起步先支持「collection 名 → find 全部（限 max_rows）」）。采样文档字段并集作 `columns`，每文档按列序展平为行，值用 `serde_json` 序列化 BSON。
- `table_structure`：采样 N 个文档推断列（无 nullable/PK 概念，`key:""`），`indexes` 查 `coll.list_indexes()`，`fks` 空。
- `er_relations`：`Err(Unsupported)`。
```rust
// adapted from dbx crates/dbx-core/src/db/mongo_driver.rs + mongo_ops.rs, Apache-2.0
```

- [ ] **Step 3: 工厂 + mod 加一臂**（`DatabaseType::Mongodb`）

- [ ] **Step 4: 集成测试（docker 门控）**

Create `src-tauri/tests/db_mongo.rs`：env `CATIO_TEST_MONGO_URL`。测：连接 → `list_schemas` 含某库 → 预建 collection 的 `query`（collection 名）返回字段列 + 文档行。

- [ ] **Step 5: 跑测试 + Commit**

```bash
docker run -d --rm --name catio-mongo -p 57017:27017 mongo:7
cd src-tauri && CATIO_TEST_MONGO_URL=127.0.0.1:57017:::: cargo test --test db_mongo
git commit -am "feat(db): mongodb driver (pseudo-tabular)"
```

---

## Task D2: Redis 驱动（伪表格映射）

**Files:** Modify `Cargo.toml`；Create `src-tauri/src/db/drivers/redis.rs`、`src-tauri/tests/db_redis.rs`；Modify `drivers/mod.rs`、`driver.rs`。

- [ ] **Step 1: 加 crate**

Run: `cd src-tauri && cargo add redis --features tokio-comp,tls-rustls,tokio-rustls-comp,cluster-async`
Expected: `redis` 出现。

- [ ] **Step 2: 实现 RedisDriver（参考 dbx db/redis_driver.rs + redis_ops.rs）**

映射（spec §4）：逻辑 DB(0..15)→schema，key 命名空间→"表"，key/type/value/TTL→行。
- `connect`：`redis::Client::open(redis://:pw@host:port)` + `get_multiplexed_async_connection`。
- `list_schemas`：返回 `["db0".."db15"]`（或 `CONFIG GET databases` 决定数量）。
- `list_tables(schema)`：用 `SCAN` + 前缀（`:` 分隔的命名空间）聚合成"表"；起步可返回单表 `"keys"`。
- `query`：约定 `sql` 为 key glob 模式（默认 `*`）；`SCAN MATCH pattern` 列出 keys，对每 key 取 `TYPE`/`TTL`/`value`（string 用 GET，其余给摘要），列固定 `["key","type","ttl","value"]`。
- `table_structure`/`er_relations`：`Err(Unsupported)`（能力位已 `structure_edit=false`/`er=false`）。

- [ ] **Step 3: 工厂 + mod 加一臂**（`DatabaseType::Redis`）

- [ ] **Step 4: 集成测试（docker 门控）**

Create `src-tauri/tests/db_redis.rs`：env `CATIO_TEST_REDIS_URL`。测：连接 → `SET` 几个 key → `query("*")` 返回含这些 key 的行（列=key/type/ttl/value）。

- [ ] **Step 5: 跑测试 + Commit**

```bash
docker run -d --rm --name catio-redis -p 56379:6379 redis:7
cd src-tauri && CATIO_TEST_REDIS_URL=127.0.0.1:56379:::: cargo test --test db_redis
git commit -am "feat(db): redis driver (pseudo-tabular keyspace)"
```

---

## Task D3: 前端按能力位灰显（像素不变，仅 disabled 态）

**Files:**
- Modify: `src/components/workbench/DbWorkbench.tsx`
- Modify: `src/services/db.ts`（缓存能力位）
- Create: `src/components/workbench/DbWorkbench.test.tsx`

- [ ] **Step 1: 看现状**

Read `src/components/workbench/DbWorkbench.tsx`，记下 data/structure/ER/SQL console 几个 tab/Segmented 的渲染处。

- [ ] **Step 2: 把能力位传进来**

`dbConnect` 返回 `capabilities`；连接态存入 `state`（或 DataContext）。`DbWorkbench` 读当前连接的 `capabilities`，对 `structure`/ER/SQL console tab 在 `capabilities.structureEdit/er/sqlConsole` 为 false 时渲染为 **disabled**（加 `disabled` 属性 + 现有 disabled 样式 token，**不改布局/不移除元素**）。非 Tauri/无能力位时默认全开（关系引擎行为）。

- [ ] **Step 3: 测试（能力位 → disabled）**

Create `src/components/workbench/DbWorkbench.test.tsx`：渲染 DbWorkbench，传一个 `capabilities` 全 false 的 mock 连接，断言 ER/structure tab 带 `disabled`（用 `toBeDisabled()`）；传全 true 断言可用。
> 若 DbWorkbench 依赖 DataContext，用现有测试 provider 包裹（参考已有组件测试的 render helper）。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npm test -- src/components/workbench/DbWorkbench.test.tsx && npx tsc --noEmit`
Expected: PASS，无类型错。

- [ ] **Step 5: Commit** — `feat(db): gray out unsupported tabs by engine capabilities (pixels unchanged)`

---

# 阶段 E：可编辑数据网格 + history/snippets + 测试夹具

## Task E1: DML 生成（纯函数 TDD）

**Files:**
- Create: `src-tauri/src/db/dml.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 失败测试 + 实现**

Create `src-tauri/src/db/dml.rs`:
```rust
use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, quote_literal};
use serde_json::Value;

/// 一处单元格改动。
pub struct CellEdit {
    pub column: String,
    pub new_value: Value,
}

/// 值 → SQL 字面量（NULL/数字/布尔/字符串）。
pub fn value_to_sql(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_literal(s),
        other => quote_literal(&other.to_string()),
    }
}

/// 生成 UPDATE：按主键列定位行。
pub fn build_update(
    db: DatabaseType, schema: Option<&str>, table: &str,
    pk: &[(String, Value)], edits: &[CellEdit],
) -> String {
    let tbl = qualified(db, schema, table);
    let set = edits.iter()
        .map(|e| format!("{} = {}", quote_ident(db, &e.column), value_to_sql(&e.new_value)))
        .collect::<Vec<_>>().join(", ");
    let whr = pk.iter()
        .map(|(c, v)| format!("{} = {}", quote_ident(db, c), value_to_sql(v)))
        .collect::<Vec<_>>().join(" AND ");
    format!("UPDATE {tbl} SET {set} WHERE {whr}")
}

pub fn build_delete(db: DatabaseType, schema: Option<&str>, table: &str, pk: &[(String, Value)]) -> String {
    let tbl = qualified(db, schema, table);
    let whr = pk.iter()
        .map(|(c, v)| format!("{} = {}", quote_ident(db, c), value_to_sql(v)))
        .collect::<Vec<_>>().join(" AND ");
    format!("DELETE FROM {tbl} WHERE {whr}")
}

pub fn build_insert(db: DatabaseType, schema: Option<&str>, table: &str, cells: &[CellEdit]) -> String {
    let tbl = qualified(db, schema, table);
    let cols = cells.iter().map(|c| quote_ident(db, &c.column)).collect::<Vec<_>>().join(", ");
    let vals = cells.iter().map(|c| value_to_sql(&c.new_value)).collect::<Vec<_>>().join(", ");
    format!("INSERT INTO {tbl} ({cols}) VALUES ({vals})")
}

fn qualified(db: DatabaseType, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(db, s), quote_ident(db, table)),
        _ => quote_ident(db, table),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn update_pg() {
        let sql = build_update(DatabaseType::Postgres, Some("public"), "orders",
            &[("id".into(), json!(7))],
            &[CellEdit { column: "status".into(), new_value: json!("shipped") }]);
        assert_eq!(sql, r#"UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 7"#);
    }
    #[test]
    fn delete_mysql_no_schema() {
        let sql = build_delete(DatabaseType::Mysql, None, "t", &[("id".into(), json!(1))]);
        assert_eq!(sql, "DELETE FROM `t` WHERE `id` = 1");
    }
    #[test]
    fn insert_escapes_quotes() {
        let sql = build_insert(DatabaseType::Postgres, None, "t",
            &[CellEdit { column: "name".into(), new_value: json!("O'Brien") }]);
        assert_eq!(sql, r#"INSERT INTO "t" ("name") VALUES ('O''Brien')"#);
    }
    #[test]
    fn null_value() {
        assert_eq!(value_to_sql(&json!(null)), "NULL");
    }
}
```

Modify `src-tauri/src/db/mod.rs`：加 `pub mod dml;`。

- [ ] **Step 2: 跑测试**

Run: `cd src-tauri && cargo test --lib db::dml`
Expected: 4 测试 PASS。

- [ ] **Step 3: Commit** — `feat(db): DML generation for inline edits (pure, tested)`

---

## Task E2: 编辑 command + 分页（db_preview_dml / db_apply_edits / 分页 query）

**Files:**
- Modify: `src-tauri/src/db/commands.rs`, `src-tauri/src/db/driver.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/db_sqlite.rs`（用嵌入式引擎无门控测试编辑往返）

- [ ] **Step 1: driver 加分页 query + 编辑请求类型**

Modify `src-tauri/src/db/driver.rs`：加请求结构（前端传来）：
```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    pub schema: Option<String>,
    pub table: String,
    pub kind: String, // "update" | "insert" | "delete"
    pub pk: Vec<(String, serde_json::Value)>,
    pub cells: Vec<(String, serde_json::Value)>,
}
```
`Driver` trait 加默认方法 `paginated_query`（用 `dialect::paginate` 包 SQL 调 `query`）：
```rust
async fn paginated_query(&self, sql: &str, limit: u32, offset: u32) -> Result<QueryResult, DbError> {
    let paged = crate::db::dialect::paginate(self.db_type(), sql, limit, offset);
    self.query(&paged, limit).await
}
```

- [ ] **Step 2: commands — preview + apply + 分页**

Modify `src-tauri/src/db/commands.rs`：加
```rust
use crate::db::driver::EditRequest;
use crate::db::dml::{self, CellEdit};

fn build_sql(db: crate::db::DatabaseType, req: &EditRequest) -> Result<String, DbError> {
    let cells: Vec<CellEdit> = req.cells.iter()
        .map(|(c, v)| CellEdit { column: c.clone(), new_value: v.clone() }).collect();
    Ok(match req.kind.as_str() {
        "update" => dml::build_update(db, req.schema.as_deref(), &req.table, &req.pk, &cells),
        "insert" => dml::build_insert(db, req.schema.as_deref(), &req.table, &cells),
        "delete" => dml::build_delete(db, req.schema.as_deref(), &req.table, &req.pk),
        other => return Err(DbError::Unsupported(format!("edit kind {other}"))),
    })
}

#[tauri::command]
pub async fn db_preview_dml(conn_id: String, req: EditRequest, mgr: tauri::State<'_, ConnManager>)
    -> Result<String, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    if !drv.capabilities().writable { return Err(DbError::Unsupported("read-only engine".into())); }
    build_sql(drv.db_type(), &req)
}

#[tauri::command]
pub async fn db_apply_edits(conn_id: String, reqs: Vec<EditRequest>, mgr: tauri::State<'_, ConnManager>)
    -> Result<u64, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    if !drv.capabilities().writable { return Err(DbError::Unsupported("read-only engine".into())); }
    let mut affected = 0u64;
    for req in &reqs {
        let sql = build_sql(drv.db_type(), req)?;
        let r = drv.query(&sql, 0).await?;
        affected += r.rows_affected.unwrap_or(0);
    }
    Ok(affected)
}

#[tauri::command]
pub async fn db_query_page(conn_id: String, sql: String, limit: u32, offset: u32,
    mgr: tauri::State<'_, ConnManager>) -> Result<QueryResult, DbError> {
    let drv = mgr.get(&conn_id).await.ok_or(DbError::NotFound(conn_id))?;
    drv.paginated_query(&sql, limit, offset).await
}
```
在 `lib.rs` 的 `generate_handler!` 注册 `db_preview_dml`、`db_apply_edits`、`db_query_page`。

- [ ] **Step 3: 嵌入式引擎测编辑往返（无门控）**

Append to `src-tauri/tests/db_sqlite.rs`：
```rust
use catio_lib::db::dml::{build_update, CellEdit};
use catio_lib::db::DatabaseType;

#[tokio::test]
async fn sqlite_edit_roundtrip() {
    let drv = connect(&mem_args()).await.unwrap();
    drv.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 1).await.unwrap();
    drv.query("INSERT INTO t (id, name) VALUES (1, 'old')", 1).await.unwrap();
    let sql = build_update(DatabaseType::Sqlite, Some("main"), "t",
        &[("id".into(), serde_json::json!(1))],
        &[CellEdit { column: "name".into(), new_value: serde_json::json!("new") }]);
    drv.query(&sql, 0).await.unwrap();
    let r = drv.query("SELECT name FROM t WHERE id = 1", 1).await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!("new"));
}
```
> SQLite 的 `quote_ident` 用双引号 `"main"."t"`——验证 `qualified` 对 SQLite 走默认双引号分支正确。

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --test db_sqlite && cargo build`
Expected: `sqlite_edit_roundtrip` PASS，编译通过。

- [ ] **Step 5: Commit** — `feat(db): edit preview/apply commands + pagination`

---

## Task E3: 前端可编辑 DataGrid + 预览闸 + 分页

**Files:**
- Modify: `src/services/db.ts`（previewDml/applyEdits/queryPage）
- Modify: `src/components/dbviews/DataGrid.tsx`（内联编辑 + 预览弹层 + 分页控件）
- Modify: `src/services/db.test.ts`

- [ ] **Step 1: db.ts 加编辑/分页 API**

Modify `src/services/db.ts`：加
```ts
export interface EditRequest {
  schema?: string; table: string; kind: 'update' | 'insert' | 'delete'
  pk: [string, unknown][]; cells: [string, unknown][]
}
export async function previewDml(connId: string, req: EditRequest): Promise<string> {
  return invoke<string>('db_preview_dml', { connId, req })
}
export async function applyEdits(connId: string, reqs: EditRequest[]): Promise<number> {
  return invoke<number>('db_apply_edits', { connId, reqs })
}
export async function queryPage(connId: string, sql: string, limit: number, offset: number): Promise<QueryResult> {
  if (!isTauri()) return mockQueryResult()
  return invoke<QueryResult>('db_query_page', { connId, sql, limit, offset })
}
```

- [ ] **Step 2: DataGrid 内联编辑 + 预览闸 + 分页**

Modify `src/components/dbviews/DataGrid.tsx`：
- 单元格双击进入编辑（受 `capabilities.writable` 控制；只读时不可编辑）。
- 暂存改动 → 点「保存」先调 `previewDml` 展示将执行的 SQL（dbx 风格安全闸弹层）→ 确认后 `applyEdits` → 重新查询当前页。
- 底部分页控件（页码/每页行数）调 `queryPage`，`truncated` 提示。
- **像素纪律**：编辑态/分页控件复用现有设计 token 与 atoms（`Segmented` 等）；不引入新视觉语言。

- [ ] **Step 3: db.ts 测试补充**

Append to `src/services/db.test.ts`：测 `previewDml` 在 Tauri 下转 `db_preview_dml`（mock invoke 返回一段 SQL 字符串，断言调用名与参数）。

- [ ] **Step 4: 跑测试 + tsc**

Run: `npm test -- src/services/db.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: Commit** — `feat(db): editable DataGrid with DML preview gate + pagination`

---

## Task E4: history / snippets 接真

**Files:**
- Create: `src-tauri/src/db/history.rs`（执行历史落 app 数据目录 JSON；snippets 同）
- Modify: `src-tauri/src/db/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/db/mod.rs`
- Modify: `src/services/db.ts`, `src/services/index.ts`

- [ ] **Step 1: history.rs（参考 dbx history.rs / saved_sql.rs，简化版）**

执行历史与保存片段落 app 数据目录（`history.json` / `snippets.json`，结构对齐前端 `HistoryItem`/`Snippet` 类型）。纯文件读写 + 纯函数排序，可单测（追加/截断上限 N 条）。

- [ ] **Step 2: commands db_history / db_snippets / db_save_snippet**

`db_query` 成功后追加一条 history（target=connId、kind 由 SQL 首词判定、dur 计时）。`db_history(connId)` 读、`db_snippets()` 读、`db_save_snippet(snippet)` 写。`lib.rs` 注册。

- [ ] **Step 3: 前端转调**

`services/db.ts` 加 `getHistory`/`getSnippets`/`saveSnippet`，`index.ts` 把 `getHistory`/`getSnippets` 改为转调 `db.ts`（非 Tauri 回退 `DATA.history`/`DATA.snippets`）。

- [ ] **Step 4: 测试**

Rust：history 纯函数单测（追加/上限）。前端：`db.test.ts` 测非 Tauri 回退 mock。
Run: `cd src-tauri && cargo test --lib db::history && cd .. && npm test -- src/services/db.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit** — `feat(db): query history + saved snippets persistence`

---

## Task E5: docker-compose 测试夹具 + 文档

**Files:**
- Create: `deploy/test/docker-compose.yml`
- Create: `deploy/test/README.md`

- [ ] **Step 1: docker-compose 起全套服务器引擎**

Create `deploy/test/docker-compose.yml`：服务 postgres:16(55432)、mysql:8(53306)、mssql:2022(51433)、clickhouse(58123)、elasticsearch(59200)、rqlite(54001)、mongo:7(57017)、redis:7(56379)，端口与各 `tests/db_*.rs` 默认 env 对齐。

- [ ] **Step 2: README 写测试运行法**

Create `deploy/test/README.md`：列出 `docker compose -f deploy/test/docker-compose.yml up -d` 后导出各 `CATIO_TEST_*_URL` 环境变量、跑 `cargo test`（全引擎）；说明嵌入式（SQLite/DuckDB）+ 纯函数测试无需 docker。

- [ ] **Step 3: 全量跑一遍（有 docker 时）**

```bash
docker compose -f deploy/test/docker-compose.yml up -d
# 导出全部 CATIO_TEST_*_URL（见 README）
cd src-tauri && cargo test
```
Expected: 全引擎集成测试 + 纯函数 + 嵌入式 PASS。无 docker 时服务器引擎 SKIP、其余 PASS。

- [ ] **Step 4: Commit** — `test(db): docker-compose fixtures for server engines + run docs`

---

## 收尾校验

- [ ] `cd src-tauri && cargo build && cargo clippy` 无错。
- [ ] `npm test && npx tsc --noEmit && npm run build` 通过。
- [ ] 启动应用（Tauri dev），连一个本地 Postgres：执行 `SELECT`、看通用结果网格、浏览 schema/structure/ER、改一格→预览 SQL→保存→刷新生效。
- [ ] 非 Tauri（浏览器 `npm run dev`）下 mock 回退正常，像素与子项目 1 一致。

