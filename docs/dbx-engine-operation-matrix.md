# DBX 数据库引擎与操作覆盖：逐项门禁

参考固定版本 `046ae4cfb4a3a4675886b721ccad0b05c77d1ec1` 的 `plugins/connection-types/*.yaml`、`profiles/catalog.yaml` 及实际驱动实现。这里不是“名称对齐即完成”的目录扩充清单。

## 基线核对

- DBX profile catalog：108 个条目；Catio 当前目录：57 个条目。
- 直接按 id 比较有 52 个未重合项，但其中有别名、旧版本、通用模板及非数据库服务，不能说成“缺少 52 种数据库”。
- `dm` 与现有 `dameng`、`gbase8a` 与现有 `gbase` 是需要处理的别名/配置迁入兼容，不是假装新增引擎。
- `custom_mysql` / `custom_postgres` 属于通用连接模板，现有原生协议可以连接，但模板迁入、默认参数和兼容显示仍要验证。
- MQ/Kafka/RocketMQ/RabbitMQ/MQTT/Zookeeper/Nacos 不纳入数据库类型数量；etcd/Consul 的 KV 数据操作仍单独列为待核验范围。

## 剩余引擎域（不是完成声明）

| 域 | 尚需处理的 DBX 条目 | 验收要求 |
|---|---|---|
| PG/MySQL 兼容族 | Cloudberry、OpenTenBase、UXDB、Dolt、QuestDB、Manticore Search | 不只新增 profile；默认用户/库、SSL/高级参数、元数据、读写、分页、结构差异都要检查 |
| 云 SQLite | Turso、Cloudflare D1 | 正确的认证/URL、请求协议、参数绑定、元数据、事务或批次语义、权限隔离；需要实例或可用的本地模拟/开源服务 |
| 文档/搜索 | DynamoDB、Easysearch、Solr、Meilisearch、HBase、MongoDB legacy | 原生数据模型、分页、精确类型、读写/批量操作、鉴权；旧版 Mongo 不能由新版驱动的名称别名冒充 |
| 向量/图 | Qdrant、Milvus、Weaviate、ChromaDB、Nebula | 集合/类/索引、主键、向量与 payload CRUD、过滤、搜索、分页与结果类型；本地服务实测 |
| JDBC/分析 | PrestoSQL、Kyuubi、Transwarp Inceptor、ArgoDB、Impala、Spark、Dremio、Ignite、Ignite 3、Oscar、通用 JDBC/JDBCX | URL/参数、驱动依赖与版本管理、真实连通、元数据、方言、数据操作；不能仅填 driver class |
| 版本/厂商扩展 | H2 legacy、InterSystems Caché；Oracle legacy/OCI 等 DBX descriptor profiles | 类加载隔离、版本兼容、文件/协议差异、许可与运行时；不能用已内置 H2 版本代替旧文件兼容 |
| 时序 | InfluxDB、InfluxDB 3、VictoriaMetrics | 数据模型与查询语言、时间精度、标签/度量、写入、范围查询、服务端过滤/分页 |
| KV | etcd v3/v2、Consul KV | 前缀、版本/CAS、TTL/租约、删除确认、ACL/TLS；控制面能力不计为数据库数量优势 |
| 云/企业 | Spanner、Salesforce，以及已列目录但尚未实测的 BigQuery/Snowflake/Oracle/DB2/国产厂商等 | 真实实例、认证与驱动许可；明确区分本地夹具覆盖和真正云产品验收 |

## 每个引擎的共同操作门禁

每项只能标记“实测通过 / 已实现待实测 / 不适用且说明原因 / 外部条件阻塞”，不能以单次 SELECT 1 代替全部能力。

1. 连接：默认参数、凭据特殊字符、TLS/CA、隧道/代理、断开/重连与 secret 不落盘。
2. 元数据：库/Schema/集合/键、懒加载和错误可见、列精度/长度/默认值/生成列、索引/复合约束/外键/触发器、对象源。
3. 查询：语言正确、脚本切分/多结果、默认命名空间、临时表、独立会话、事务状态、取消、超时、错误后可恢复。
4. 数据：准确分页、稳定行身份、NULL/空串/空字节、精确数值、二进制/复杂类型、单行与批量 CRUD、原子性、并发保护。
5. 工具：导入/导出/迁移/比较、类型保真、截断或规模限制明示、执行计划、字段血缘、对象搜索、ER/schema diff。
6. 管理：按实际支持范围验证数据库/索引/用户角色权限/会话锁等管理；不把 capability 开关当作实现。
7. 入口：桌面/Web/MCP 的能力、权限边界、失败行为和资源清理一致。

## 当前已形成的实测增量

- 七种路径的顶层 BLOB 读写、键定位、迁移和 SQL/类型化 JSON 往返：SQLite、DuckDB、PostgreSQL、MySQL、SQL Server、JDBC/H2、rqlite。
- 五种原生物理查询会话、事务状态和关闭回滚：SQLite、DuckDB、PostgreSQL、MySQL、SQL Server。
- JDBC 同 JVM 多 connection、并发 request-ID 路由与 H2 取消已实测；其他 JDBC 厂商继续实例门禁，不据此宣称全部通过。
- 分层 namespace catalog、按需对象加载、跨未展开 namespace 搜索与轻量列目录已实现并通过现有矩阵；代表性 PG/SQL Server/H2 类型修饰符已回归。H2 新查询实际默认 PUBLIC、未展开对象搜索和精度展示通过 Web 验收，不代表所有结构变更/约束类型已完成。
- 类型化数据对比已通过 SQLite Web 执行闭环，包含同形文本/BLOB 键、空字节、NULL 和中文；仍受 5,000 行窗口限制，不能声明完整大表同步。
- 数据库体验对齐优先编辑器、智能提示、元数据展示与导入导出；保留 Catio 整体框架和非数据库能力。编辑器上下文、AI 数据库维护与剩余结构操作继续单独验收。
- 编辑器已经接入真实方言/profile 和默认 schema，补充 CTE/派生表的限定列与嵌套别名作用域，保留文档/光标/undo，Tab 接受和 IME 执行保护通过回归。SQLite/H2 的候选 → 接受 → 实际执行通过 Web 验收；不代表各厂商全部语法已覆盖。
- 元数据加载已排除注释/字符串假引用，恢复 SQL Server 无 schema 选择器时的目录加载；静态函数候选和 CAST/EXTRACT 等模板已按方言收紧。版本、扩展、会话 SQL_MODE 和更多复杂查询上下文继续设门禁。
- 函数活动参数提示、Escape/快捷键恢复已实现，SQLite Web 实际 SUBSTR 输入与执行通过；补全在缓存 CST 未就绪时做有界解析，超出预算不猜测。参数模板不代表所有服务器版本/重载已验证。
- AI 上下文准备失败保留草稿和选择，不发送不完整结构；每轮启动前等待服务端订阅回执，取消/卸载/用户隔离及旧连接迟到关闭有回归。Web 使用本地确定性模型夹具验证完整回复和空闲 WebSocket 重连后的第二轮回复，不代表真实模型质量，也不代表流中途断线事件重放。
- SQLite Web 断网恢复后自动读取原查询会话状态；事务仍 active，连接局部临时表再次查询返回 17，随后明确回滚到 idle。不得推广为全部驱动断网场景通过。
- 最新上述检查点为 143 files / 1,280 tests、TypeScript/build 通过，Rust 537 library + 30 项相关 Web 集成通过；这不是全部外部驱动矩阵重跑。真实模型生成质量、完整结构维护和自动运维闭环仍未验收，不能用测试数抵消这些门禁。

- 后续 ER 消费轻量列目录，错误/截断可见且可重试，不再将失败伪装为空库或为真实连接展示演示表；FK 目标不猜成 PK。SQLite Web 离线刷新→错误→恢复重试通过。此后检查点为 **144 files / 1,293 tests** 与 TypeScript/build 通过；跨 namespace/复合约束、大图性能、完整键类型元数据和 PNG 导出仍未据此验收。

## 已选工作流的后续检查点（不是全量完成）

- 选择顺序为 **编辑器 → 查询分析 → 导入导出 → 专用工作区 → AI 维护**，具体实施标准见 `docs/dbx-selected-workstreams.md`。
- 七条真实路径（SQLite/DuckDB/PG/MySQL/SQL Server2019/H2/rqlite）的 FK metadata 保留 namespace、约束身份、列序与完整宽度；前端复合 JOIN、别名、作用域与替换区间已回归，SQLite 候选接受后实际返回正确两行。函数模板 Tab/Shift+Tab 字段跳转与实际执行通过；复杂诊断、版本/SQL_MODE 和更多作用域仍未完整。
- SQLite/rqlite QUERY PLAN 与 DuckDB JSON 已补齐；EXPLAIN 拒绝脚本、写 CTE、SELECT INTO 等，不使用 ANALYZE。原物理查询会话/事务保留，未知/截断/超预算计划可见。SQL Server/Oracle 等更多计划与字段血缘仍待实施。
- 此检查点前端 **148 files / 1,348 tests** 和 TypeScript/build 通过；Rust **543 library + 9 targets / 63 integration tests** 通过。Java 11 tests/JAR 重建通过。只对应这些变更，不抵消其他门禁。
- 已用真实 DeepSeek（deepseek-flash，3 次 / 2,158 tokens）验证手动生成复合读查询、写入确认→一行回执→读回、缺失 metadata 不编造三场景；key 仅在临时进程内存，未写配置或 Git。这不是完整自主维护、全面模型质量或权限安全验收。
- 大型 SQL 的流式 splitter 边界修复已完成并经 SQLite/PG 实际执行验证；最终 Rust 检查点 **546 library + 10 targets / 65 integration tests**。仅 splitter 的文本 chunk 契约完成；完整 Web 大文件任务、流式导入导出/迁移、复杂类型、专用 Mongo/Redis/ES/DuckDB 工作区和完整 AI 闭环仍未完成。不会将只读代码审查、单元回归或这三次模型调用算作这些方向完成。

详细过程与日志索引见 `docs/superpowers/plans/2026-10-02-dbx-complete-parity.md`。此清单用于持续实现，不代表已完成用户要求的全面对齐。
