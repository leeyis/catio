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
- JDBC 同 JVM 多 connection、并发 request-ID 路由与 H2 取消正在追加门禁，不据此宣称所有厂商 JDBC 都通过。

详细过程与日志索引见 `docs/superpowers/plans/2026-10-02-dbx-complete-parity.md`。此清单用于持续实现，不代表已完成用户要求的全面对齐。
