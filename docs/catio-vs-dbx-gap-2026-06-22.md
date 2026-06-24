# Catio vs DBX 数据库能力差距报告

> 生成日期: 2026-06-22 · 方法: 9 维度并行勘探两个本地代码库 (`catio` / `dbx-ref`) + 逐项逆向核验 (117 个 agent, 确认 98 项差距)

## 一、总体结论

Catio 当前是一款**可用的轻量级数据库客户端**:连接、浏览、行内编辑、基础 SQL 控制台、ER 图、AI 助手骨架,以及 ~54 种引擎的连接覆盖都已具备。从"能连上库、能看数据、能改单元格"的基线看,Catio 是完整的。

与 DBX 对比,差距集中在**"从客户端走向数据库工作台"的纵深能力**,呈现三条画像:

1. **架构型差距(最难补,最该早做)**:Catio 只有 10 个真原生驱动,其余全部压成"泛型 JDBC",缺少 DBX 的 **Agent Driver 框架**;连接层 `ConnectArgs` 只有 8 个字段,**完全没有 SSL/TLS、超时、Redis Sentinel/Cluster、Proxy/链式隧道**等企业级配置位。
2. **生产力工具型差距(用户最痛,ROI 最高)**:数据网格缺右键菜单/多选/批量编辑/列筛选/复制为 SQL;SQL 控制台缺格式化/诊断/EXPLAIN;对象管理缺重命名/删除/截断/源码编辑;整个**导入导出/迁移/SQL 文件执行/数据对比**体系基本为零。
3. **生态与智能型差距(战略层)**:无独立 CLI/MCP Server npm 包、无 Web 自托管;AI 助手缺 Skills 系统、SQL 风险分级执行、推理模式、动态 Schema 上下文。

**一句话**:Catio 在"读"上接近 DBX,在"写/管/迁/智能"上系统性落后。

---

## 二、数据库种类(引擎)覆盖专项对照

**结论:广度不输,深度差距大。** Catio 注册引擎数(~54)甚至多于 DBX 一级类型(~45),但 Catio 把绝大多数非主流引擎压成**泛型 JDBC**(`dbType='jdbc'`,靠 Java sidecar),而 DBX 给每个引擎一个**一级 `DatabaseType` + 方言/Agent 专化**。

| 层级 | Catio | DBX |
|---|---|---|
| **真原生 Rust 驱动** | 10 个:Postgres / MySQL / SQLite / DuckDB / SQLServer / ClickHouse / Elasticsearch / rqlite / MongoDB / Redis | 同上 + 更多 |
| **一级 `DatabaseType`** | 11 个(上述 10 + 泛型 Jdbc) | **~45 个**:在原生基础上把 Oracle/Doris/StarRocks/Databend/Redshift/Dameng/Kingbase/Highgo/Vastbase/Goldendb/Gaussdb/Kwdb/Yashandb/Databricks/SapHana/Teradata/Vertica/Firebird/Exasol/OpenGauss/OceanBase/Gbase/Access/Snowflake/Trino/Hive/Informix/Cassandra/Bigquery/Kylin/Sundb/TDengine/Xugu/IoTDB/Iris 全部设为一级类型 |
| **方言专化策略** | mysql/postgres 协议族靠 `driverProfile` 区分(Doris/StarRocks/TiDB/OceanBase/Redshift/Kingbase/openGauss 等共享 MySQL/PG 原生驱动,体验尚可);其余走泛型 JDBC | 每个一级类型有独立 data_grid SQL 生成、连接参数、Agent 驱动 |

### Catio "没支持到位"的库(走泛型 JDBC,DBX 有原生/Agent 专化)

这些引擎 Catio 能连、能跑通用 SQL,但拿不到方言感知的 DML 生成、专属网格编辑、云/图/时序特性:

- **关系/云数仓**:Oracle、IBM Db2、Snowflake、Google BigQuery、Databricks、SAP HANA、Teradata、Vertica、Exasol、Firebird、Informix、InterSystems IRIS
- **分布式/大数据**:Trino、Apache Hive、Apache Kylin
- **图 / 时序 / 宽表**:Neo4j(图,DBX 生成 Cypher;Catio 只发标准 SQL)、Cassandra(CQL/分片键/一致性级别)、TDengine、Apache IoTDB(时序父子表/tag 列)
- **国产库**:达梦 DM、YashanDB(崖山)、GBase 8s、虚谷 XuguDB、SUNDB
- **文件型**:MS Access(DBX 有 accdb/mdb 文件选择器;Catio 须手填路径)

> 典型案例:**Neo4j** 在 DBX 由 `data_grid_neo4j_sql.rs` 生成 Cypher 实现网格内图节点编辑;Catio 走泛型 JDBC + `dml.rs` 标准 SQL,无法图编辑。**Snowflake/BigQuery/Databricks** 在 DBX 有云原生 OAuth/服务账户/warehouse-role 参数;Catio 仅 JDBC 用户名密码。

### 根因与建议

引擎专化的根因是 Catio 缺少 DBX 的 **Agent Driver 框架**(`agent_catalog.rs` + `agent_driver.rs`)。这是 P2 战略项,但建议**先在 `DatabaseType` 枚举为 Neo4j/Cassandra/Snowflake/Oracle 等高价值引擎预留一级类型**,避免泛型 JDBC 路径固化后再大规模重构。

---

## 三、差距总览表(98 项核验后,节选高影响)

| 功能 | 维度 | Catio 现状 | 影响 | 优先级 |
|---|---|---|---|---|
| SSL/TLS 证书支持 | 连接管理 | 完全缺失(ConnectArgs 无 ssl/ca_cert,PG 用 NoTls) | 高 | **P0** |
| 数据网格右键菜单 | 数据浏览 | 完全缺失(仅工具栏硬编码按钮) | 高 | **P0** |
| 多选/批量编辑/多格式复制 | 数据浏览 | 完全缺失(仅单元格单选) | 高 | **P0** |
| 列筛选与结构化条件构建器 | 数据浏览 | 完全缺失(仅全局文本搜索) | 高 | **P0** |
| 复制为 SQL INSERT/UPDATE | 数据浏览 | 完全缺失(后端 DML 已有,前端未暴露) | 高 | **P0** |
| 对象删除(表/视图/过程/函数) | DDL | 完全缺失 | 高 | **P0** |
| 对象重命名 | DDL | 完全缺失(仅支持列重命名) | 高 | **P0** |
| 对象源码编辑保存 | DDL | 完全缺失(只读) | 高 | **P0** |
| SQL 格式化 | SQL 控制台 | 完全缺失(按钮无 onClick) | 高 | **P0** |
| SQL 诊断/错误定位 | SQL 控制台 | 完全缺失(仅 Redis 有) | 高 | **P0** |
| EXPLAIN 执行计划可视化 | SQL 控制台 | 完全缺失 | 高 | **P1** |
| SQL INSERT 导出 / 整库导出备份 | 导入导出 | 完全缺失 | 高 | **P1** |
| 表数据导入(CSV/Excel/JSON) | 导入导出 | 完全缺失(设计文档列为后续 spec) | 高 | **P1** |
| 跨库数据迁移 | 导入导出 | 完全缺失(后续 spec) | 高 | **P1** |
| SQL 文件批量执行 | 导入导出 | 完全缺失 | 高 | **P1** |
| Redis Cluster & Sentinel | NoSQL/连接 | 完全缺失(仅单机直连) | 高 | **P1** |
| Redis 数据类型原生编辑 UI | NoSQL | 完全缺失(只读摘要) | 高 | **P1** |
| AI Skills 系统 | AI 助手 | 完全缺失 | 高 | **P1** |
| AI SQL 风险分级执行策略 | AI 助手 | 完全缺失(直通执行) | 高 | **P1** |
| 表截断/复制结构、子对象删除 | DDL | 缺失/部分 | 中 | **P1** |
| 列可见性控制 | 数据浏览 | 完全缺失 | 中 | **P1** |
| 独立 CLI / MCP Server npm 包 | 集成部署 | 完全缺失 | 高 | **P2** |
| Web 自托管(Docker) | 集成部署 | 完全缺失(纯 Tauri) | 高 | **P2** |
| Agent Driver 框架(引擎专化) | 引擎驱动 | 架构缺失(泛型 JDBC) | 高 | **P2** |
| Schema diff / 数据对比 / 字段血缘 | 集成 | 完全缺失(后续 spec) | 中 | **P2** |
| 推理模式 / 动态 Schema 上下文 | AI 助手 | 完全缺失 | 中 | **P2** |
| XLSX/Markdown 导出、高级补全、WHERE/ORDER BY 输入 | 多维度 | 缺失/部分 | 中 | **P2** |
| Proxy/链式隧道/细粒度超时、DBeaver/Navicat 导入 | 连接/导入 | 完全缺失 | 低-中 | **P2** |

---

## 四、按维度详述(要点)

### 维度 2 · 连接管理
`ConnectArgs`(`src-tauri/src/db/driver.rs` L8-23)仅 8 字段。缺:**SSL/TLS**(DBX `connection.rs` L34-36,Catio PG 明确 `NoTls`,虽已引入 `tokio-postgres-rustls` 但未激活)、**Redis Sentinel/Cluster**(DBX `redis_driver.rs` L106-164)、**Proxy/链式隧道**(DBX `proxy_tunnel.rs`/`transport_layer_tunnel.rs`,Catio 仅单跳 SSH)、**细粒度超时**、**Oracle SYSDBA**(Java 插件已支持但 Rust/前端断链)。

### 维度 3 · SQL 控制台
缺 **SQL 格式化**(`SqlConsole.tsx` L402 按钮无 onClick)、**语义诊断**(DBX `sqlSemanticDiagnostics.ts`)、**EXPLAIN 可视化**(DBX `ExplainPlanViewer.vue`)、**高级补全**(函数签名/外键 JOIN,DBX `sqlCompletion.ts`)。

### 维度 4 · 数据浏览(最痛区)
`DataGrid.tsx` 仅 `sel:{r,c}` 单选 + 客户端文本过滤 + CSV/JSON 导出。缺右键菜单(DBX `CustomContextMenu.vue` 20+ 操作)、多选/批量编辑、结构化筛选(`StructuredFilterRule` 8 操作符)、复制为 SQL、列可见性、服务端 WHERE/ORDER BY、二进制下载。

### 维度 5 · DDL 对象管理
支持列增删改 + DDL 展示 + ER 图,但**对象级操作几乎全缺**:删除/重命名/截断/复制结构/源码编辑保存(DBX `db_admin_sql.rs` + `object_source_sql.rs`)。`ObjectPane.tsx` L77 `onChange={() => {}}` 只读。

### 维度 6 · 导入导出
仅当前页 CSV/JSON。缺 INSERT 导出、整库备份、表导入、跨库迁移、SQL 文件执行——多数已被 Catio 设计文档 `docs/.../catio-db-backend-design.md` 标为"子项目 3 后续 spec"(已规划未实现)。

### 维度 7 · NoSQL
Redis 仅 4 列只读摘要(须手写 HSET/SADD)、Stream 仅显 `<stream>`、二进制 `from_utf8_lossy` 丢信息;Mongo 平坦表格、索引只读;ES `capabilities.rs` L42-45 `structure_edit=false`(无文档增删改/索引管理)。

### 维度 8 · AI 助手
缺 **Skills 系统**(DBX 6 技能 vs Catio 2 模式)、**SQL 风险分级执行**(DBX `classifyAiSqlExecution` vs Catio AIPanel 直通执行无拦截)、推理模式流式、动态 Schema 上下文构建。

### 维度 9 · 集成部署
纯 Tauri 桌面单体。缺独立 CLI(`@dbx-app/cli`)、独立 MCP Server(`@dbx-app/mcp-server`)、Web 自托管(`crates/dbx-web` + `deploy/Dockerfile`)。

---

## 五、补齐路线图

### P0 — 立即(高频 + 安全 + 后端已有半成品)
| 功能 | 参考 DBX 路径 |
|---|---|
| 网格右键菜单 + 多选 + 批量编辑 | `apps/desktop/src/components/grid/DataGrid.vue`、`composables/useDataGridSelection.ts` |
| 列筛选构建器 | `DataGrid.vue` L506-549 `StructuredFilterRule` |
| 复制为 SQL(Catio `dml.rs` 已有 build_insert/update) | `apps/desktop/src/lib/exportFormats.ts` |
| 对象删除/重命名/截断 | `crates/dbx-core/src/db_admin_sql.rs` L147-356 |
| 对象源码编辑保存 | `crates/dbx-core/src/object_source_sql.rs` |
| SQL 格式化(Catio 已有空按钮) | `apps/desktop/src/lib/sqlFormatter.ts` |
| SQL 诊断 | `apps/desktop/src/lib/sqlSemanticDiagnostics.ts` |
| SSL/TLS(Cargo 已引入 rustls) | `crates/dbx-core/src/models/connection.rs` L34-36、`db/postgres.rs` |

### P1 — 数据库工作台主干
EXPLAIN(`ExplainPlanViewer.vue`)、INSERT/整库导出(`database_export.rs`)、表导入(`table_import.rs`)、跨库迁移(`transfer.rs`)、SQL 文件执行(`sql_file_import.rs`)、子对象删除(`db_admin_sql.rs` L159-228)、Redis Cluster/Sentinel + 字段编辑(`db/redis_driver.rs`)、AI Skills + 风险分级(`aiSkills.ts`/`aiSqlExecutionPolicy.ts`)。

### P2 — 生态/战略/长尾
Agent Driver 框架(`agent_catalog.rs`/`agent_driver.rs`)、CLI(`packages/cli/`)、MCP Server(`packages/mcp-server/`)、Web 自托管(`crates/dbx-web`+`deploy/Dockerfile`)、Schema diff/数据对比/字段血缘(`schema_diff.rs` 等)、XLSX/Markdown 导出、高级补全、DBeaver/Navicat 导入、Proxy/链式隧道。

**实施备注**:P0 中复制为 SQL、对象删除/重命名、SSL 三项 Catio 后端已有半成品(`dml.rs` build_* / Java 插件 SYSDBA / Cargo rustls),补齐成本最低,应优先排。
