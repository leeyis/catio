# Catio 数据库后端 — 设计文档（子项目 3 · 第一期）

- 子项目：3 / 4（数据库后端）
- 前置：子项目 1（UI 外壳）已完成，建立了 `src/services/` 数据接缝层；子项目 2（SSH 后端）进行中，确立了「Rust `src-tauri/src/<域>/` commands + 前端 `services/<域>.ts` 包装 + isTauri mock 回退」的模式。
- **参考实现 dbx**（github.com/t8y2/dbx）— Tauri v2 + Rust + pnpm 前端，**Apache-2.0**。Catio 的 `DbWorkbench`/`dbviews/`/「DBX Structure tab」UI 即按 dbx 建模。本子项目照搬其数据库后端架构与逐方言逻辑。

## 0. 范围决策（来自 brainstorming）

| 决策 | 选择 |
| --- | --- |
| 终点 | **照搬 dbx 全部逻辑 + 40+ 数据库**（分多期 spec 达成，终点不变） |
| 第一期切法 | **原生驱动全套一期**：驱动抽象 + 全部原生 Rust 驱动（经协议族覆盖 ~30 引擎）+ 填满 Catio seam |
| 功能深度 | **填满现有 seam + 可编辑数据网格**（内联编辑 + DML 预览 + 分页/虚拟滚动） |
| 复用方式 | **参考重写**，按 Catio `services/` 接缝套；dbx 作参考（Apache-2.0，逐段拷贝时保留出处与许可注明） |

### 默认子决策（brainstorming 中确认）

1. **凭据**：连接时提示密码，仅内存，不持久化（加密保险库留子项目 4）；与子项目 2 一致。
2. **连接档案持久化**：非敏感元信息（db_type/host/port/user/db/driver_profile）存 localStorage，key `catio-db-connections`；现有 mock `DATA.connections` 降级为示例种子。
3. **DB-over-SSH-隧道第一期不做**：标为与子项目 2 的集成点，子项目 2 落地后单独增量。
4. **通用结果行**：把 seam 的 `QueryResult` 从写死的 `OrderRow` 泛化为通用 `columns + rows: unknown[][]`（像素/组件树不变，仅数据管道泛化）。

## 1. 本子项目（第一期）目标与非目标

### 目标

1. dbx 式**驱动抽象**：`DatabaseType` 枚举 + `Driver` trait + `dialect` + `capabilities`，使后续加引擎为增量。
2. **全套原生 Rust 驱动**，经协议族覆盖 ~30 引擎（见 §5）。
3. 每引擎：连接 / 测连、执行任意 SQL（读 + 写）→ 通用结果、schema 浏览、表结构（列 / 索引 / FK）、ER。
4. **可编辑 DataGrid**：内联编辑 + DML 生成预览（INSERT/UPDATE/DELETE）+ 分页 / 虚拟滚动。
5. history / snippets 接真（执行历史落本地、片段保存）。
6. **不改动 UI 组件树的结构与像素呈现**；非关系引擎用能力位灰显不适用的 tab（仅 disabled 态，像素不变）。

### 非目标（后续 spec / 其他子项目）

- JDBC sidecar 与长尾引擎：Oracle-proper、H2、Snowflake、Trino、Hive、DB2、Informix、Neo4j、Cassandra、BigQuery、SAP HANA、Teradata、Vertica、Firebird、Exasol、Dameng、Yashandb 等（子项目 3 后续 spec）。
- 高级工具：schema diff、data compare、field lineage、explain plan、table import、database export、data transfer、database search（子项目 3 后续 spec）。
- AI SQL 助手 / MCP server（子项目 4）。
- DB-over-SSH / proxy 隧道（依赖子项目 2，落地后集成）。
- 加密保险库 / OS keychain（子项目 4）。

## 2. 总体架构

前端不改契约，后端把 `services/` 接缝层的 mock 换成 Tauri IPC，镜像子项目 2 的 `ssh/` 布局：

```
React UI（dbviews 组件树 / 像素不动）
   │  services/db.ts —— 包装 Tauri invoke；非 Tauri 环境回退 mock
   │                    （沿用 services/models.ts 的 isTauri 探测模式）
   ▼  Tauri IPC（commands + events）
Rust src-tauri/src/db/
   ├── mod.rs          DbError（thiserror，serde 标签联合）+ 导出 + DatabaseType 枚举
   ├── manager.rs      ConnManager: State<Mutex<HashMap<ConnId, Box<dyn Driver>>>>（连接池句柄 + 元信息）
   ├── driver.rs       Driver trait（async_trait）：connect/test/query/list_databases/
   │                   list_schemas/list_tables/columns/indexes/fks/er/object_source
   ├── dialect.rs      每族 introspection SQL + 标识符引用 + 类型映射
   │                   （照搬 dbx crates/dbx-core/src/schema.rs + sql_dialect.rs 的逐方言逻辑）
   ├── capabilities.rs 每引擎能力位（可写 / 事务 / 有无 schema 概念 / 单连接池 / 是否 SQL 控制台 / 有无 ER）
   ├── result.rs       通用结果：ColumnInfo + rows: Vec<Vec<serde_json::Value>>；JS 安全整数处理
   ├── dml.rs          内联编辑 → INSERT/UPDATE/DELETE 生成（纯函数，可单测）
   ├── ids.rs          单调 ID 生成器（conn-N / query-N），可复用子项目 2 的 IdGen 模式
   └── drivers/
        ├── postgres.rs      tokio-postgres + deadpool（PG 族）
        ├── mysql.rs         mysql_async（MySQL 族，含 OceanBase 两模式）
        ├── sqlite.rs        rusqlite（bundled）
        ├── duckdb.rs        duckdb（bundled）
        ├── sqlserver.rs     tiberius
        ├── clickhouse.rs    reqwest（HTTP）
        ├── elasticsearch.rs reqwest（HTTP，伪表格映射）
        ├── rqlite.rs        reqwest（HTTP）
        ├── mongo.rs         mongodb（伪表格映射）
        └── redis.rs         redis（伪表格映射）
```

`Driver` trait 是抽象核心：每个引擎实现 trait，`manager` 只持 `Box<dyn Driver>`。新增引擎 = 新增一个 trait 实现 + 在 `DatabaseType`/`dialect`/`capabilities` 登记，不动 command 层。

## 3. 接缝映射与通用结果行（**需改前端类型**）

dbx 结果是**通用** `columns + rows: Value[][]`（见 dbx `data_grid_sql.rs`：`columns: Vec<String>` / `rows: Vec<Vec<Value>>`）。而 Catio 现有 seam：

```ts
// src/services/index.ts（现状）
export interface QueryResult { columns: TableCol[]; rows: OrderRow[] }
```

`OrderRow` 是写死的 orders 形状，无法承载任意查询。**第一期必须把 seam 泛化为通用行**：

```ts
// 泛化后
export interface ColumnInfo { name: string; type: string; pk?: boolean; fk?: boolean }
export interface QueryResult {
  columns: ColumnInfo[]
  rows: unknown[][]          // 行=有序值数组，与 columns 对齐
  rowsAffected?: number      // 写语句
  truncated?: boolean        // 触达分页上限
}
```

- DataGrid 改为读「列定义 + 值数组行」渲染；**像素、列样式、状态色、density 等呈现不变**，仅渲染数据来源从固定 `OrderRow` 字段访问改为按列索引访问值数组。
- `getSchema` / 表结构 / ER 直接复用现有 `Schema` / `TableStructure` / `ErModel` 类型（已是 dbx 形状，无需改）。
- mock 回退：把现有 `DATA.ordersColumns/ordersRows` 适配成通用 `{columns, rows}` 形状供非 Tauri 与测试用。

### seam 命令清单（services/db.ts）

| 前端函数 | Tauri command | 说明 |
| --- | --- | --- |
| `dbConnect(args)` | `db_connect` | 建池 + 测连，返回 connId + 引擎能力位 |
| `dbDisconnect(connId)` | `db_disconnect` | 关池 |
| `runQuery(connId, sql, page?)` | `db_query` | 执行任意 SQL → 通用结果（带分页） |
| `getSchema(connId)` | `db_schema` | 库 / schema / 表 / 视图 / 函数树 |
| `getTableStructure(connId, table)` | `db_table_structure` | 列 / 索引 / FK |
| `getErModel(connId, schema)` | `db_er_model` | 表 + 关系 |
| `applyEdits(connId, edits)` | `db_apply_edits` | 内联编辑提交（先 `previewDml` 预览） |
| `previewDml(connId, edits)` | `db_preview_dml` | 生成将执行的 DML（不执行） |
| `getHistory(connId)` / `getSnippets()` | `db_history` / `db_snippets` | 执行历史 / 保存片段 |

非 Tauri 环境，`services/db.ts` 回退到 `mockData` 的 `DATA`（与 `services/ssh.ts` 同模式）。

## 4. 非关系引擎映射到关系形状的 seam

Catio seam 是 SQL / 关系形状（SqlConsole、tables/views/functions、列 / 索引 / FK、ER）。照搬 dbx 的 `mongo_ops.rs` / `redis_ops.rs` / `data_grid_*` 思路做伪表格映射：

| 引擎 | schema | 表 | 行 / 列 | 不支持 |
| --- | --- | --- | --- | --- |
| MongoDB | database | collection | document→行，列=采样字段并集 | FK / ER / 结构编辑 |
| Redis | 逻辑 DB(0..N) | key 命名空间 | key/type/value/TTL→行 | SQL 控制台 / FK / ER |
| Elasticsearch | （单）| index | `_source` 字段→列，文档→行 | FK / ER / 结构编辑 |

`capabilities.rs` 为这些引擎标注能力位（`sql_console=false`、`er=false`、`structure_edit=false`、`writable` 视情况）。前端按 `db_connect` 返回的能力位**灰显**对应 tab/按钮（disabled 态，**布局像素不变**）。关系引擎能力位全开。

## 5. 引擎 / 驱动 / 协议族（第一期原生全套）

| 驱动文件 | crate | 覆盖引擎（协议族 / driver_profile） |
| --- | --- | --- |
| `postgres.rs` | `tokio-postgres` 0.7 + `deadpool-postgres` 0.14 + `tokio-postgres-rustls` | Postgres, CockroachDB, Redshift, openGauss, GaussDB, KingBase, Vastbase, Highgo, KWDB |
| `mysql.rs` | `mysql_async` 0.36 | MySQL, MariaDB, TiDB, Doris, StarRocks, SelectDB, Databend, GoldenDB, GBase, OceanBase(MySQL+Oracle 模式) |
| `sqlite.rs` | `rusqlite` 0.32（bundled, load_extension） | SQLite |
| `duckdb.rs` | `duckdb` 1.3（bundled） | DuckDB |
| `sqlserver.rs` | `tiberius` 0.12（tds73, rustls） | SQL Server |
| `clickhouse.rs` | `reqwest` 0.12（HTTP） | ClickHouse |
| `elasticsearch.rs` | `reqwest`（HTTP） | Elasticsearch |
| `rqlite.rs` | `reqwest`（HTTP） | rqlite |
| `mongo.rs` | `mongodb` 3.2 | MongoDB |
| `redis.rs` | `redis` 0.32（tokio-comp, tls-rustls, cluster-async） | Redis |

- 协议族内的差异（默认库名、系统表过滤、标识符引用、Oracle 模式 SQL）由 `driver_profile: Option<String>` + `dialect.rs` 分支处理——照搬 dbx `models/connection.rs` 的 `driver_profile` 与 `schema.rs` 逐方言 SQL。
- **OceanBase-Oracle 走 MySQL wire**（dbx `db/ob_oracle.rs` 用 `mysql_async` 跑 Oracle 风格 SQL），属本期 MySQL 族；**真 Oracle-proper 留 JDBC 期**。
- crypto/TLS 统一 **rustls**（与子项目 2 锁定 ring 后端一致，避免 NASM/aws-lc 依赖；`duckdb`/`rusqlite` 用 bundled，避免系统库依赖）。版本以 `cargo add` 实测为准，签名漂移按编译器与 docs.rs 修正（沿用子项目 2 漂移说明的工程纪律）。

## 6. 可编辑 DataGrid

- `dml.rs` 纯函数：输入「表 + 主键列 + 行主键值 + 改动字段」，输出方言正确的 `UPDATE` / `INSERT` / `DELETE`（标识符引用、值转义、NULL 处理按 `dialect.rs`）。
- 前端流程：内联编辑 → `previewDml` 显示**将执行的 SQL**（dbx 风格安全闸）→ 用户确认 → `applyEdits` 执行。
- 分页 / 虚拟滚动：`db_query` 接 `page {limit, offset}`，结果带 `truncated`；大结果集用现有 DataGrid 虚拟滚动渲染。
- 能力位 `writable=false` 的引擎（多数 ClickHouse 场景、只读连接）禁用编辑入口。

## 7. 凭据 / 连接档案 / 隧道（对齐子项目 2）

- **凭据**：连接时弹密码/密钥框，秘密仅内存，不落盘、不回前端（复用子项目 2 的 `ConnectSecretPrompt` 模式）。
- **连接档案**：非敏感元信息存 localStorage（`catio-db-connections`），`state/dbConnections.ts` 读写；mock `DATA.connections` 中的 `kind:'db'` 项降级为种子。明文 localStorage 与子项目 1 的 AI key 同等临时方案；真正加密保险库是子项目 4。
- **隧道**：第一期不做。`Driver::connect` 预留 transport 参数位（dbx `db/ssh_tunnel.rs`/`proxy_tunnel.rs`/`transport_layer_tunnel.rs` 的形状），子项目 2 落地后在此接入，不在本期实现。

## 8. 错误处理

`DbError`（thiserror + 自定义 Serialize 成 `{ kind, message }` 标签联合，照搬子项目 2 `SshError` 写法）：`ConnectFailed`、`AuthFailed`、`NotFound(connId)`、`QueryFailed{ sqlstate?, message }`、`Unsupported(feature)`（能力位不支持时）、`Io`。前端按 `kind` 区分提示。

## 9. 测试策略（TDD，对齐子项目 2）

- **纯函数全覆盖（`cargo test`，无需服务器）**：`dialect.rs` 的 SQL 构造、类型映射、`dml.rs` 的 DML 生成、`result.rs` 的 JS 安全整数 / 二进制序列化、`capabilities.rs` 能力位、`ids.rs`。
- **嵌入式引擎（SQLite / DuckDB）**：进程内真实集成测试——建表 → 查 → 改 → 断言通用结果 + 结构 introspection + DML 往返。
- **服务器引擎（PG / MySQL / SQLServer / ClickHouse / Mongo / Redis / ES）**：集成测试经 `src-tauri/tests/` + 环境变量门控（如 `CATIO_TEST_PG_URL`），配套 `deploy/test/docker-compose.yml` 起测试库；**docker / 环境变量不可用时 `skip`**（CI / 本地无 docker 仍过单测 + 嵌入式集成测试）。
- **前端 `services/db.ts`**：Vitest mock `@tauri-apps/api/core` 的 invoke + 非 Tauri mock 回退（沿用子项目 2 `ssh.test.ts` 模式）。
- 每阶段结束应得到可运行、可测的软件。

## 10. 与后续 spec / 子项目的关系

- **子项目 3 后续 spec**：① JDBC sidecar（Java/Maven 旁路进程，照搬 dbx `plugins/jdbc` + `db/agent_driver.rs` + `jdbc.rs`，运行时需 JDK、不打包）+ Oracle-proper + 长尾引擎；② 高级工具（schema diff / data compare / lineage / explain plan / import / export / data transfer）。
- **子项目 2（SSH）**：DB-over-SSH/proxy 隧道在子项目 2 落地后，经 `Driver::connect` 的 transport 参数位接入。
- **子项目 4（Agent / 保险库）**：AI SQL 助手、MCP server、加密保险库 / OS keychain 接管凭据门禁。
- 各子项目经各自 `services/` 接缝接入，互不强耦合。

## 11. 实现计划分阶段（写 plan 时据此排任务，均在本 spec/plan 内）

1. **阶段 A 抽象 + 首个关系族**：`db/` 骨架 + `DbError` + `DatabaseType` + `Driver` trait + `dialect`/`capabilities`/`result` + ConnManager；落地 **Postgres 族**（连接/查询/schema/structure/ER）+ seam 泛化（前端 `QueryResult` 通用行 + DataGrid 改读）+ `services/db.ts`。
2. **阶段 B MySQL 族 + SQLite + DuckDB**：补三个驱动（含 OceanBase 两模式、嵌入式两引擎的进程内集成测试）。
3. **阶段 C SQL Server + HTTP 引擎**：tiberius + ClickHouse/Elasticsearch/rqlite（reqwest）。
4. **阶段 D 非关系引擎**：MongoDB / Redis 伪表格映射 + 能力位灰显前端接线。
5. **阶段 E 可编辑数据网格 + history/snippets**：`dml.rs` + 预览/提交流程 + 分页 + 历史/片段接真。

每阶段结束得到可运行、可测的软件；阶段 A 完成即可跑通「连 Postgres → 执行 SQL → 看通用结果网格 + schema/ER」。
