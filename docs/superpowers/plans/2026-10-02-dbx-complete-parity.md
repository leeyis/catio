# DBX 完整数据库对齐：持续实施与验收

本计划延续 `feat/dbx-database-parity`，不是将第一轮可靠性修复视为总目标完成。总目标仍为：保留 SSH/SFTP/MCP/Agent，数据库类型及数据库操作逐项对齐固定 DBX 基线，并增加有证据的优势。未验收项目不计完成；真实外部依赖不可用时列出明确阻塞，不把它们从矩阵删除。

## 执行顺序

1. **类型保真闭环**：查询 → 网格/键定位 → 写入 → 导出 → 导入/跨库迁移。先完成原生 SQL 与 JDBC/H2 的二进制，继而复杂类型、精度和长尾方言。对照 DBX `data/database_export.rs` 与 `data/transfer.rs`。
2. **连接与事务治理**：每个查询标签独立会话、事务工具栏及可见状态、关闭回滚、并发标签隔离；扩展取消能力与长任务进度。
3. **元数据/结构**：懒加载、逐 namespace 错误、复合索引/外键、类型长度精度、生成列、SQLite 安全重建、结构 diff 与更多执行计划。
4. **专用数据工具**：MongoDB Extended JSON 文档 CRUD、Redis Stream/批量管理、Elasticsearch 文档与索引管理、DuckDB 文件工作流。
5. **大数据量**：虚拟化、服务端筛选/排序、跨页流式导出、稳定键分页/迁移、Web 大 SQL 文件任务与取消。
6. **引擎覆盖**：按 DBX 实际数据库目录审计，不计中间件插件；逐协议族/独立方言覆盖数据库操作。可在沙箱安装的引擎实测，商业/云引擎记录驱动许可和实例门禁。
7. **高级运维与最终验证**：备份恢复/调度；桌面/Web/MCP 等入口一致性；对齐矩阵逐条验收而非一次测试数量替代功能完成。

## 第一项设计：无歧义二进制协议

### 方案选择

- 不按 `0x…` 的内容猜类型：文本可能恰好与 BLOB 的显示字符串相同。
- 不把用户 JSON 包装形状当二进制标签：会与真实 JSON 文档冲突。
- 采用结果 DTO 的旁路元数据 `binaryCells: [rowIndex, columnIndex][]`，保留现有 rows 的显示/兼容形态；SQLite 按每个值的实际 storage class 标记，其他驱动按原生类型标记。分页/隐藏 ctid/导出选行都必须重定位坐标。
- 编辑请求携带显式二进制键/值列名，生成经过验证的引擎原生字节字面量。旧协议的歧义键继续 fail closed；新协议可明确表示 `0x…` 是文本。
- 迁移与 SQL 导出保留标记，用同一个 typed literal 实现；空字节串、NULL、文本 hex、Unicode/引号均独立验证。复杂嵌套二进制未完成前不能冒充已支持。

### 验收

- SQLite 同列中保存 BLOB `X'00ff'` 与文本 `'0x00ff'`，查询标记、PK 定位、编辑、导出恢复和迁移不能混淆。
- 空 BLOB 与 NULL 不同；格式错误/奇数 hex 必须在写入前拒绝。
- PG BYTEA、MySQL BLOB/VARBINARY、SQL Server VARBINARY、DuckDB BLOB、JDBC/H2 BINARY 真实 roundtrip。
- JSON 包含类似类型标记的对象不得改变含义。
- 网格在三主题/中英文可编辑二进制；复制 SQL、翻页、过滤、ctid 列剥离后元数据仍对应正确单元格。
- 每一逻辑增量 targeted tests → 类型检查 → 相关真实服务矩阵 → commit。保留原有用户文件，不部署生产。

## 工作记录

- 已重新核对分支与工作树：HEAD `421f8d3`；用户原有 capabilities.json 改动保留。
- 规范指向的 `docs/db-engines-integration-PLAN.md` 当前不存在，使用现有 JDBC README、DB backend spec、第一轮 GAP 与 DBX 固定源码作为核验来源。
- 第一增量已实现顶层二进制：独立 `binaryCells` 元数据；二进制键/值 DML；按位置传播分页/ctid/排序选择；SQL 导出恢复；`catio-table-v1` 带类型 JSON 导入导出；逐值真实 storage class 迁移。
- TDD 证据：`typed-values-red.log` 4 项失败 → `typed-values-core.log` 通过；`typed-grid-red.log` 7 项失败 → `typed-grid-green.log` 通过；`typed-json-red.log` 复现缺少类型导入，随后完整链路通过。
- `typed-engine-matrix-3.log`：529 library tests + 28 集成 tests 通过。SQLite、DuckDB、PostgreSQL、MySQL、SQL Server、JDBC/H2、rqlite 七种真实路径均执行二进制键/空 BLOB/NULL/文本 hex/迁移/SQL 恢复验收，不依赖跳过门禁。
- 实测额外发现 SQL Server RPC `sp_executesql` 无法承载跨调用 BEGIN/COMMIT（266 错误）及临时表作用域问题，已按 DBX 传输选择思路改用 session-preserving SQL batch；显式事务、回滚、临时表及失败批处理回归通过。
- rqlite 依据 v8.36.6 官方 API 的 `blob_array` / `transaction` 参数增加逐值 BLOB 解码及单 HTTP 请求原子事务；8 MiB 批次预算在发送前校验，失败回滚验证通过。不将 HTTP 原子批次等同于跨请求手动事务。
- 前端全量 127 files / 1,092 tests，TypeScript 与生产 build 通过。真实浏览器通过 BLOB 主键编辑 → 类型化 JSON 下载 → 另表上传恢复；BLOB 与同形文本未串行，空字节和 NULL 分离；Dawn/Grove 截图保存在忽略日志目录。
- 此增量没有修改 Java 源码，故没有无理由重建 JAR。嵌套二进制/完整复杂类型和长尾 JDBC 方言仍须继续，不能把这项当作整个目标完成。
- 沙箱测试服务已重新启动，继续供后续验收；生产服务未触碰。本地本次浏览器 QA 进程已停止以便继续构建。
- 第一增量代码提交：`c345074`（后端）与 `8c6f3ac`（前端）。这只是完整目标中的一个增量，不停止后续工作。
- 当前实施项：查询标签独立会话与显式事务状态/关闭回滚；同时继续细化完整引擎/操作矩阵。

## 第二项设计：独立 SQL 会话

- 不选择“所有标签共享一个连接 + 本地 boolean 模拟事务”；每标签拥有独立物理会话。元数据/网格写入保留原连接自己的工作通道，事务工具栏明确只控制当前查询标签。
- PG/MySQL 会话复用已验证的 pinned-console 执行器，但各标签持有不同 client；SQLite 内存库使用随机名称的共享内存数据库和独立 connection；DuckDB 使用 `try_clone` 共享数据库而不共享事务；SQL Server 独立连接。
- 事务状态来自实际引擎/协议：SQLite autocommit、MySQL 最终 OK 状态、SQL Server XACT_STATE、PG 自己后端的状态；DuckDB 使用锁内连续两次真实 transaction ID 判定。实测发现 duckdb-rs 1.10503.1 的 `is_autocommit()` 恒返回 true，不能采用该占位实现。不以 SQL 字面串猜测 COMMIT 是否成功。
- 所有 RPC 带 `connId` 与 `querySessionId`（避免与 SSH sessionId 混用），必须同时验证父连接归属和会话所属连接。分页也使用同一物理会话，临时表/未提交数据不能跨页失效。
- 有界会话数、创建/断开竞态防护、关闭先取消再回滚/释放、失联租约回收。凭据只在已有驱动的内存配置中使用，不写 profile，不回传前端。
- UI 自动为每个 SQL 标签建立会话，显示实际事务状态与 BEGIN/COMMIT/ROLLBACK 操作；未提交事务关闭需确认，关闭多个标签同样保护。正常停止不清空其他标签状态。
- JDBC 需同 JVM 多 connection 和独立请求/取消协议，防止 H2 内存数据库被错误拆成多个 JVM 数据库；不能用“开另一个 sidecar”冒充这种情况下的会话隔离。
- 验收：临时表互不可见、普通表共享、A 标签的 BEGIN/写入/ROLLBACK 不影响 B 标签、失败事务状态可见、父连接关闭与失联回收不留锁/连接、越权会话 ID 拒绝、真实引擎和浏览器均测试。

### 第二增量：原生会话已验收，JDBC 继续实施

- 已落地 PostgreSQL/MySQL/SQL Server/SQLite/DuckDB 五种原生独立会话，实际事务状态、会话内分页/EXPLAIN、关闭回滚、父连接清理。
- 注册表：每连接最多 16、总计最多 128，30 分钟失联租约；创建与断开竞态、过期回滚、关闭 HTTP 请求被丢弃后仍持续的有界清理均有实现/测试。
- 前端：当前查询标签事务工具栏；嵌套查询标签、整个数据库工作台、断开/删除连接的确认保护；Web beforeunload 与 Tauri close-request 接线。打包后的原生窗口关闭交互仍需桌面 GUI 复验。
- `query-sessions-complete.log`：532 library tests + 31 项相关集成全部通过。包括七种二进制路径回归、五种原生会话隔离、PG aborted 状态、DuckDB namespace 下失败事务可回滚、跨用户 HTTP 会话拒绝、租约/限额/取消清理。
- `query-session-frontend-full.log`：130 files / 1,099 tests 通过；TypeScript、生产前端构建和 QA example 构建通过。
- 可见浏览器：标签 2 无法读取标签 1 的临时表；标签 1 活动事务不改变标签 2 的 Idle 状态；外层关闭可取消；确认关闭标签 1 后标签 2 COUNT=0；标签 2 单独提交后只读到新记录 7。证据为 `query-session-browser.json` 与 `query-session-ui.png`。
- 原生增量提交 `849cfee`（后端）和 `31ec11a`（前端）；不把原生五种通过扩展成所有品牌通过。

### 第三增量：JDBC 同 JVM 会话与并发

- Java 侧按 session ID 持有独立 connection，以有界工作/控制线程池执行请求；取消按 request ID 绑定到 Statement，保留早到取消和关闭 ID 防止迟到请求重建连接。
- Rust 侧改为响应 ID 多路复用，stdin/stdout 不再由一个阻塞锁串住全部标签。每会话保留自己的操作锁，事务批处理不与同会话其他操作交错；取消、断开和未完成请求清理独立。
- H2 实测：同 JVM 共享库但不共享事务/临时表；慢查询不阻塞另一会话；取消只影响目标请求；关闭一个子会话不杀兄弟；会话内分页、早到取消、Tokio 外 Drop 回滚均通过。
- JDBC 显示“手动提交模式”，不冒充所有厂商都能精确报告物理事务；不支持事务的引擎禁用事务操作。仅 H2 声明已验证的原生 Statement 取消，其他厂商继续实例门禁。
- Java 9 tests 通过；JAR 按脚本重建，SHA-256 `0CEA6D3BCF49DCB280EFDC52C5D2E253B6822A692D1D65CD786A3A00CC9DA74A`。
- `jdbc-session-matrix-2.log`：532 library + 18 项集成通过；先前 `jdbc-session-matrix.log` 的七种二进制/五种原生会话等 27 项集成亦通过。
- 前端 131 files / 1,101 tests、TypeScript/build 通过。真实浏览器验证 H2 手动提交模式、两标签数据隔离、长聚合取消、关闭回滚后兄弟仍可查询。证据 `jdbc-session-browser.json`、`jdbc-session-ui.png`。
- UI 实测发现 H2 新查询默认选中 INFORMATION_SCHEMA，不应当成普通用户的默认工作 schema；下一元数据增量必须修复。
- 第三增量提交：`2f3ebee`，包括 Java 源码、测试与重建的 JAR，Rust 协议/生命周期和前端状态说明。
- 下一能力域：命名空间/对象懒加载与错误可见、默认 schema、完整类型与约束/DDL；完整引擎门禁见 `docs/dbx-engine-operation-matrix.md`。继续推进，不把本阶段当作总目标完成。

## 第四项设计：元数据与结构操作

- 当前已复现：H2 默认选择 INFORMATION_SCHEMA；整库 eager 枚举所有 namespace 的表/函数；列补全对所有 namespace 逐表取结构；PG full_type 未保留类型修饰参数。
- 增加传输无关的 namespace catalog / namespace objects / object search 接口，桌面与 Web 复用。catalog 只取 namespace 名称和实际默认 schema，不枚举表；展开时加载对象，错误按 namespace 可见并可重试。
- 全局对象搜索不能因为懒加载而退化成只搜索已展开部分；提供有界、可取消/可重试的跨 namespace 搜索结果及截断/失败范围提示。
- 共享仅内存的元数据请求缓存，连接/刷新/DDL 变更时失效，旧响应不能覆盖新连接；不把错误伪装成空库，不回退 demo。
- 编辑器只加载当前或被引用 namespace 的补全元数据，并避免为拿列名去全量获取索引/外键；显示截断/不可用边界。
- 结构扩展保持类型长度精度、生成列/identity、复合索引/FK 的顺序和原始名称。旧显示字符串不是可逆结构，不依赖逗号/点号拆分生成 DDL。
- 随后实现/验证多方言结构变更及 SQLite 原子重建，避免仅开启 structureEdit 开关。
