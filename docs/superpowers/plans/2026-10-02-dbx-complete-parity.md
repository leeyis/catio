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

### 第四增量验收检查点（已提交，不是总目标完成）

- 已实现 namespace catalog/按 namespace 加载/跨 namespace 对象搜索/取消及 Web 所有权检查；缓存仅在内存，刷新、DDL 和事务结束时失效，旧响应不得覆盖新数据。
- 列补全限定当前和 SQL 引用的 namespace；PG/MySQL/SQL Server/DuckDB 走批量列目录查询，SQLite/rqlite 用列 PRAGMA，JDBC 用轻量列 RPC。达到预算、权限失败需明示，不伪装完整或空库。
- PG、SQL Server、JDBC/H2 的代表性长度、数值精度/scale 和时间精度已回归；不代表所有厂商类型、生成列或全部 DDL 已完成。
- 真实浏览器发现组件级默认 schema 修复仍被 DbWorkbench 的首项默认覆盖；追加上层 red/green 测试并修复后，H2 新查询下拉及实际 `SELECT CURRENT_SCHEMA` 均为 PUBLIC。未展开 HIDDEN namespace 的对象搜索及结构精度显示也已验证。
- 数据对比已实现二进制标记重排、区分 BLOB 与同形文本键、目标主键检查、无键/NULL/重复键拒绝、方言分页与安全字面量、过期响应防护。先前原生确认阻塞浏览器验收；2026-10-03 改用既有应用内 ConfirmModal，并补充取消不写入、明确目标、过期确认失效的 red/green 回归。
- 真实浏览器完成 SQLite 对比 → 预览两条 INSERT/两条 UPDATE/一条 DELETE → 确认实际目标 → 执行影响 5 行 → 再对比零差异。额外查询 typeof(id)/typeof(payload) 及 binaryCells，确认同形文本/BLOB、空 BLOB、NULL、中文均保真。证据 `metadata-compare-browser-accepted.json`、`compare-typed-complete.png`。仍为 5,000 行窗口，不代表大表完整同步。
- 当前证据：后端未再变化，`metadata-matrix.log/.exit` 为 537 library + 27 targets / 132 integration，退出码 0；最新 `metadata-ui-accepted.log/.exit` 为 137 files / 1,130 tests，退出码 0；`compare-confirm-build.log/.exit` 的 TypeScript 与生产构建通过。仍有既有大 chunk 和 test-only warning；不把 Web 验收当作打包 Tauri GUI 验收。
- 第四增量提交：`13c99d2`（Rust/Java/重建 JAR 与元数据矩阵）、`692cd66`（前端按需加载、默认 schema、错误可见及 typed compare）。用户 capabilities.json 原始 SHA-256、暂存凭据/私钥及 whitespace 审计通过。

## 用户补充的体验验收口径

- 对齐范围明确为**数据库功能和数据库操作体验**。服务器连接、SSH、SFTP、隧道、MCP/Agent 等保留 Catio 本地已有功能和工作方式，不为仿照 DBX 而替换或削减。
- 数据库编辑器与智能提示提升为重点：不仅有功能入口，还要检查触发时机、上下文正确性、键盘操作、响应速度、错误和空状态。
- 对照固定 DBX 源码逐项评估：当前语句与选区执行、多结果和查询标签、快捷键、格式化/诊断、撤销与未保存保护；表别名、CTE、子查询、跨 schema、限定符和引号标识符的补全；列/函数/参数/JOIN 建议及方言差异。
- 提示接受、取消与光标位置不能互相干扰；不能仅凭“出现了补全弹窗”验收。建立小型 SQL 场景库，在真实数据库和可见浏览器中核验；大 schema 还要检查延迟、重复请求、失效和刷新后的正确性。
- 对象树、搜索、结果网格、编辑保存、导入导出及错误恢复的常用操作参考 DBX，保留 Catio 的主题和现有优势；不以视觉仿制代替可靠的数据语义。

### 用户再次明确的界面与功能边界

- **保留外部框架，只优化数据库内部工作区。** 不重做应用外层布局、全局导航、连接组织和主机管理页面，不把 Catio 整体换成 DBX 的界面。数据库内页仍沿用现有主题、组件和操作风格，避免与 SSH/服务器/SFTP 等页面割裂。
- 核心优先级是：编辑器输入区与智能提示 → 元数据加载和展示 → 导入导出。数据库已有功能不得因体验改造而被无故删除；剩余数据库操作门禁继续保留，不因调整优先级而消失。
- 优先在 DbWorkbench、SqlConsole、数据库网格、结构视图与导入导出流程内改进。公共组件、App 接线或通用状态确需修改时，只做向后兼容扩展，并回归验证主机连接及文件管理等非数据库模块。
- 数据库 AI/Agent 辅助沿用 Catio 现有 Agent/MCP 入口，不新增一套割裂的外层界面。目标包括理解当前连接和引擎、生成与解释操作代码、排错与优化，以及数据库/表/字段/索引约束/数据的查询和变更辅助。
- 按不同数据库的实际模型和方言实现：SQL、文档、KV、搜索等不能套用同一种 SQL，也不能把不存在的能力显示为可用。
- 结构与写入操作明确目标连接和对象、展示语句及影响；破坏性操作需明确确认，执行后核验。按真实引擎能力处理事务，不承诺所有 DDL 均可回滚。AI 上下文只包含授权范围内的必要元数据，不包含连接 secret，也不默认发送整库内容。
- 参考事实：固定 DBX 版本 README 的 AI SQL Assistant 段落已有自然语言生成、解释、优化、错误修复和执行前安全检查的说明；不能以“DBX 没有 AI”为前提。具体实现深度仍须核验，Catio 可以在保持现有框架的前提下继续深化数据库智能维护能力。

## 第五增量：编辑器真实方言与查询作用域补全

### 已实施的设计与验收

- 修复 `dialectFor` 存在但实际 SqlEditor 始终挂 PostgreSQL 的断线；沿用现有 CodeMirror/主题/输入区结构，从 DbWorkbench 到 SqlConsole/ObjectPane 传入实际 engine profile，仅编辑器语法使用该 profile，连接、事务和 DDL 仍使用协议 family。
- 编辑器补全不再将各 schema 同名表拍平成“目录中的第一张”。保留 namespace 身份，并用当前实际 defaultSchema 解析未限定表；点号、引号、`__proto__` 等名称通过安全映射保留。
- 基于现有增量 CST 补充查询作用域，而不是引入另一套编辑器或在整个 SQL 上拼正则：CTE 显式列列表、投影 AS 别名、星号、可解析的递归显式列、链式 CTE、派生表、嵌套同名别名与语句间隔离。只推断可证明的列，不给未知表达式编造列名。
- 显式 Ctrl+Space 也不在字符串、美元字符串或注释中弹出表/函数；限定列处不混入函数候选。Tab 接受当前候选，未有候选时保留缩进；IME 组合输入的确认键不得触发执行；重配置方言/schema 保留文档、光标和 undo history。
- 补充 PostgreSQL/H2 未引用标识符大小写折叠回归，避免自动添加引号后指向另一列；未知 JDBC 不擅自套用 PG 折叠规则。
- TDD 证据：`editor-context-red.log`（15 项失败）、`editor-scope-red.log`（6 项失败）、`editor-case-red.log`（5 项失败）；`editor-scope-final.log` 为定向回归，`editor-build.log` 为 TypeScript/build，最终全量见 `editor-ui-full.log`。
- 真实 SQLite Web 验证：从当前库元数据构造 CTE，Ctrl+Space 在 `r.` 处只列出 `note` / `public_id`；ArrowDown + Tab 插入候选，Alt+Enter 执行并返回真实 `public_id = 1`。截图 `editor-cte-completion.png`。
- 最终大小写修复后的 H2 Web 验证：实际默认 PUBLIC；`WITH r AS (SELECT 1 AS PublicID)` 的限定列候选为 `PUBLICID`，Tab 插入 `r."PUBLICID"`，Alt+Enter 实际返回 1。截图 `editor-h2-case-fold.png`。这不代表所有引擎/全部 SQL 语法均已 GUI 实测。
- 提交 `a74a275`。本检查点前端 138 files / 1,165 tests 及 TypeScript/build 通过；后续附加修复有单独记录，不能混淆检查点。

### 明确保留的下一轮门禁

- 当前作用域分析有 200,000 字符、4,000 个遍历节点和 12 层递归预算；这不是完整 SQL 编译器。尚需补充更多相关子查询、LATERAL/APPLY、函数返回表与厂商扩展、裸列上下文和大脚本性能实测。
- 静态函数库已在后续提交按方言收紧，但服务器版本/扩展/SQL_MODE 尚未动态同步，函数参数提示基础交互已在下述第六增量完成，但不代表全部重载/版本已验证；FK JOIN 建议仍需核验跨 schema、别名和已输入 JOIN 的替换范围。不能把本增量称为“智能提示全部对齐”。
- `metadataReferences` 已在后续提交排除注释/字符串；仍需处理与 namespace 同名的别名及大脚本解析性能。旧 SQL diagnostics 仍需统一作用域、方言和国际化，避免新增补全与诊断相互矛盾。
- ERDiagram 的跨 schema/复合关系展示、流式导入导出/大 SQL 文件、所有结构变更与 SQLite 重建、数据库 AI 维护的预览/授权/执行闭环仍需继续推进。桌面打包 GUI、商业/云实例门禁不变。

### 后续附加修复

- `67c553e`：按实际方言剥离注释/字符串中的 namespace 假引用，包括美元字符串、Oracle q-quotes、MySQL # 注释与默认反斜杠转义；修复 SQL Server 因无默认 schema 选择器而跳过整个补全 catalog 的问题。保留 Redis/ES 原有非 SQL 加载边界。`metadata-lexical-red.log`、`metadata-sqlserver-default-red.log` → `metadata-lexical-green.log`；全量 `metadata-lexical-full.log` 为 138 files / 1,178 tests，build 通过。MySQL 会话修改 SQL_MODE 后的动态解析同步尚待实现。
- `368874d`：对照 DBX 方言函数测试收紧静态候选；不再跨方言广播 MySQL DATE_FORMAT/IFNULL、PG ARRAY_AGG/JSONB、SQL Server LEN 等专有函数。修正 CAST/EXTRACT/SQL Server DATEDIFF 等模板；JDBC 以具体 profile 提供候选，未知 JDBC 使用保守标准集。`editor-functions-red.log` 33 项先失败，随后 58 项函数定向回归通过。没有据此声称厂商版本/扩展全部实测。
- `5171211`：网络错误可能丢失提交回执，不能直接声称“已回滚”；同步异常后保留 SQL 预览但禁止原批次再次执行，必须重新对比；已收到写入回执而刷新失败时仍显示已确认的影响行数。`compare-outcome-red.log` 两项失败后修复。`ux-final-full.log` 为 139 files / 1,218 tests，TypeScript/build 通过。
- `b5a9af9`：SQL 选择上下文不再使用虚构的 prod-orders，查询页/对象页提供真实连接名；数据库 AI 系统提示使用实际 JDBC profile，数据库标签按 JSON 数据编码；明确元数据/注释/结果不可信、缺失事实不得编造、尊重授权、凭执行回执判定结果及不盲目重试。Shell 提示分支和执行授权机制保持原样。这是上下文与提示约束修复，不是完整自主数据库 Agent 的交付，也不是提示词足以替代工具权限边界的声明。
- `database-ai-context-red.log` 7 项先失败；随后数据库提示/元数据/原 App Agent 流程 45 项定向回归通过。最新 `database-ai-full.log/.exit` 为 **139 files / 1,224 tests，退出码 0**；`database-ai-build.log/.exit` TypeScript/build 通过。未调用真实 LLM 评测生成质量，不把 mock 传输测试当作模型实测。
- 所选表结构失败被跳过、异步发送时连接/选择切换等问题已在下述第六增量修复；当前 schema/版本/权限上下文、结构变更预览、审批、执行及结果核验仍需完善。现有 Agent/MCP 入口不另起新外壳。
- 非数据库模块未重做；前端全量包含已有 App/终端/文件管理组件回归。当前未重新执行所有真实 SSH/SFTP 后端矩阵，不把单元回归冒充全部主机 GUI 验收。
- 本地可见浏览器验收证据见 `editor-browser-accepted.json`；测试连接已显式断开，临时 loopback QA 服务和本任务页面已关闭。未操作生产部署，未合并 main/推送远端/发布安装包。隔离沙箱夹具状态未在本轮另作清理声明。

## 第六增量：输入交互、上下文准备与断网恢复

- `2176560`：明确打开 @ 才加载对象；元数据失败保留草稿、表选择和代码附件，不发送缺失结构的请求；准备锁、取消、超时、跨连接/标签/对话失效及卸载保护；SQL 上下文限制 12 表/64 KiB UTF-8。取消只阻止发送并作废迟到结果，不冒称底层元数据 RPC 已被物理取消。
- `776cd74`：基于 CodeMirror 增量 CST 的方言函数参数提示，活动参数高亮、CAST AS/EXTRACT FROM、嵌套括号/数组、Escape 关闭与 Ctrl/Cmd+Shift+Space 恢复；当前语句解析有字符和节点预算。SQLite Web 实际输入 SUBSTR、观察 start/length 切换并执行 `SELECT SUBSTR('中文abc', 2, 3) AS sample;` 返回 `文ab`。参数来自本地模板，服务器版本/扩展/全部重载仍未验收。
- `c326b36`：全量压力下发现派生表补全偶发读取未就绪的缓存树；改用有界 ensureSyntaxTree，超出预算不猜测；字符串/注释排除同样以就绪树为准。独立回归模拟 Tree.empty 和预算耗尽，不靠重复运行测试掩盖问题。
- `13e38f0`：前台 AI 断网恢复实测暴露首批事件丢失。每次 turn 在 HTTP start 前等待服务端真正注册订阅的带 ID 回执；服务端重新验证认证/主题权限。取消、迟到 start、卸载和跨用户消息有隔离；旧 WebSocket 的迟到关闭只清理其自己的请求，不破坏新连接回执。提示约束不是执行授权边界。
- `548bb0c`：SQL 会话心跳不重叠；断网显示 unknown，恢复后读取原物理会话状态，不自动重开或回滚。SQLite Web 创建连接局部临时表并插入 17，断网后观察 unknown，恢复后自动回到 active，再次执行 SELECT 仍返回 17，最后明确点击回滚并确认 idle。
- Web 证据：`ux-recovery-browser.json`、`agent-subscription-browser-complete.png`、`query-session-recovered-active.png`。后续使用当前构建 `index-MxMCM1gQ.js`，主动关闭空闲 WebSocket，观察旧连接 CLOSED/新连接 OPEN，并收到第二次完整回复；截图 `agent-reconnect-two-turns.png`。临时浏览器 WebSocket 观测包装已恢复。此项不证明流中途断线具备事件重放。
- 浏览器始终请求前台。工具曾报告 hidden/0×0 viewport，用户确认页面可见，显式调整到 1500×900 后输入恢复；不把工具截图代替用户可见性的确认。
- 模型为隔离 loopback 的确定性 Ollama 协议夹具：只验证请求上下文与传输，不执行 SQL，不代表真实 LLM 生成质量、自动维护或生产安全验收。上下文观测仅记录布尔和计数，不记录 secret。
- `subscription-rust-final.log/.exit`：537 library + server_agent/server_auth/server_isolation/server_mcp/server_ws 共 30 项集成通过，QA example 重建通过。本轮未重新执行全部真实数据库及 SSH/SFTP 矩阵，Java 未变更，不重建 JAR。
- `recovery-current-build.log/.exit` TypeScript/build 通过；`recovery-current-full.log/.exit` **143 files / 1,280 tests，退出码 0**。保留用户 capabilities.json 原有改动；提交前逐次运行暂存区密码/私钥/whitespace 审计。
- 补充修复数据库 AI 的协议族判定：具体 profile 只细化 SQL 方言，不把文档/KV/搜索连接误判为 SQL。三项合成 profile 回归先失败后通过；`ai-model-family-green.log/.exit` 52 项定向测试与 `ai-model-family-tsc.log/.exit` 通过。这是提示分支契约测试，不是新增品牌或外部实例验收。
- 下一主线仍是跨 namespace/复合外键身份契约与 JOIN 作用域，再继续元数据、导入导出、大结果与真实 AI 维护闭环。ErRelation 当前缺少 schema/constraint/ordinal，不能按裸表名拼接并宣称 JOIN 完整对齐。桌面 GUI、商业/云实例及 SQL Server 2022 门禁保持未完成。

## 第七增量：ER 元数据状态不再伪装为空库

- ERDiagram 迁入轻量列目录，保留 partial errors/truncated；列与关系独立接收成功/失败，关系失败不丢弃已取得的表。错误明确可见并可重试；只有完整成功的空结果才能显示空库文案。
- 结果绑定连接、namespace 和失效 revision；换目标不展示旧图，尚未确定 schema 的真实连接不回退演示表。监听已有元数据失效事件，并复用目录/关系缓存。
- 不把 FK 引用目标推断为 PRIMARY KEY（也可能是 UNIQUE）；轻量列目录未提供 PK 身份时不编造标记。缺失列不再将关系误连到第一列，含点号的表/列身份使用二元组区分。
- `er-metadata-red.log` 先有 8 项失败；缺失列连线的独立 red 另行复现。最终 ER 定向 10 项通过，`er-final-full.log/.exit` **144 files / 1,293 tests，退出码 0**；`er-final-build.log/.exit` TypeScript/build 通过。
- 前台 Web 使用构建 `index-DicYKt1H.js`：SQLite 创建 er_parent（id 为 PK、code 为 UNIQUE）与引用 code 的 er_child；真实显示两表一关系，code 不冒充 PK。离线刷新明确显示错误且不出现空库文案；恢复网络后点击重试恢复两表一关系。截图 `er-offline-visible-error.png`、`er-retry-restored.png`，网络模拟已恢复。
- 这不是完整 ER 能力交付：实际 PK/type 的轻量元数据补全、跨 namespace/复合约束身份、大图性能与 PNG 导出仍需单独实现或验收；不会用本轮状态修复代替这些门禁。
