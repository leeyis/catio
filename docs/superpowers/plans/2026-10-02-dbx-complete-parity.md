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
- 下一实施项：查询标签独立会话与显式事务状态/关闭回滚；同时继续细化完整引擎/操作矩阵。
