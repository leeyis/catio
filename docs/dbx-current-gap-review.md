# Catio ↔ DBX 当前界面与功能差距复核

## 1. 本次比较口径

- 原始审查日期：2026-10-06；后续实施检查点更新于 2026-10-08（见第 3 节对应行及后续实施记录）。
- 原始审查的 Catio 源码：`37a7213`（当时报告之前的 HEAD，产品变更至 `9cc7a48`）。2026-10-07 本次继续实施的起点为 `6b895ea`，最新复核见后文。
- DBX：本轮通过 `git ls-remote --symref origin HEAD` 核对默认分支 main，并 fetch / checkout 为独立只读快照 `f9ee05fd7da74d4a3b8691b87e369597e97aadf8`，commit 时间 `2026-10-06T21:59:37+08:00`。
- 本轮参考目录 `.worktrees/dbx-review-f9ee05f`；上一实施快照 `8025519` 在 `.worktrees/dbx-latest-reference`，最早 `046ae4c` 在 `.worktrees/dbx-reference`，均保留。
- 本轮是**源码与流程差距审查**：读取代表性 UI、状态和执行接线，对照上游实现；没有运行 DBX、重跑逐引擎矩阵或完整 desktop GUI，也不以文件不存在 / 搜索无结果单独证明整个项目没有某项功能。
- 状态：**部分实现**＝有真实路径但深度 / 范围不足；**未见等价工作流**＝当前入口、组件和状态接线没有相应完整流程；**待核验**＝不能凭本轮材料判定；**扩展候选**＝超出当前五个方向，不自动扩入本轮实施。
- “UI 未对齐”不是要求复制 DBX 外壳。保留 Catio 主外框 / 保险库 / SSH / SFTP / MCP / 宿主 Agent；按 ACTION-MAP 保持一个动作一个主入口。

## 2. 不应再列成“没有实现”的部分

以下已有产品代码和分项历史证据，但并非全场景结单：

- 查询工作台：统一执行按钮、事务菜单、连接 / namespace 上下文、结果 / 执行记录 / 计划分层、上下 / 左右分栏。
- 对象操作：按需 Schema 树、跨 namespace 对象搜索、节点省略号 / 右键、临时预览 / 固定对象、字段树、结构速览。
- 编辑器：实际方言、CTE / 别名 / 子查询作用域、相关查询 / LATERAL / APPLY、裸列与函数参数、复合 FK JOIN、函数签名、有界语法 / 表引用诊断、当前语句 / 选区 / 整脚本执行。
- 网格：筛选 / 排序 / 分页、编辑 SQL 预览、记录侧栏 / 完整值、列与行同步刷新、BLOB 与同形文本 / 空值区分。
- 表对象：数据 / 列 / 索引 / 外键 / 触发器 / DDL 单层导航、结构筛选 / 重试、部分列变更及子对象删除确认。
- 文件：表导入和 SQL 导出分步确认 / 回执、Web 字节上传及下载；SQL 文件有界解码、预检暂存、独立会话、取消和终态接线。
- 数据对比、ER、Redis 基础键操作、SQL 历史 / 片段、AI 审批 / 上下文也已有真实部分，不是空白模块。

最后一次实施的 177 files / 1664 tests 属于上一轮验证证据，本轮不重新把它作为“所有缺口已验证”的证明。

## 3. 界面 / 工作流差距

| ID | 界面或场景 | 当前 Catio | 尚未对齐的部分 | 判断 |
|---|---|---|---|---|
| UI-01 | 编辑器设置与键盘工作流 | SQL 编辑器偏好、常见 DDL/DML 补全已有；新增基于完整列目录的未知字段 / 基础裸列歧义提示及独立开关，复用别名、关联子查询、LATERAL/APPLY 作用域 | CTE/派生输出完整性、复杂厂商 DDL/DML、类型推断、全部关键字字段与伪列、完整桌面快捷键矩阵仍不足 | 有证据的物理对象字段提示已接通；完整语义仍部分实现 |
| UI-02 | 宽表 / 结果导航 | 工作树已有独立可固定列查找侧栏并通过专项测试；新增查询结果分析入口，提供转置、列统计、标量频次图 | 分析限初次执行快照前 2,000 行 / 100 列，不含网格后续翻页、筛选或草稿；不是全查询 profile，仍缺多系列数值图和大结果分析 | 部分实现；采样边界明确 |
| UI-03 | 表结构编辑器 | 单层页签与列增改删、索引 / FK / 触发器查看及部分删除已有 | 约束 / 分区展示、索引 / FK 完整草稿编辑、多项变更统一预览、原始 DDL 编辑和保存仍不足；目前 DDL 是重建稿。DBX 的分区能力也按引擎区分，并非任意结构都可编辑 | 部分实现；完整结构专项需单独定范围 |
| UI-04 | 数据迁移 | 已复用文件工作流外框形成目标 → 映射 → 确认 → 回执；执行前重读源 / 目标结构，变更则拒绝派发；同步锁、失败不重放和明确目标确认已接通 | 仍缺多对象、真实结构 / 依赖 / SQL 计划、服务器端重验与并发 DDL 锁、操作身份进度、配置保存 / 持久作业树。前端重读不是服务端计划 | 单表数据向导已实测；完整迁移仍部分实现 |
| UI-05 | 数据对比 | 分页差异行、单元格值 / 类型差异、整行选择及 typed SQL；新增单对表自定义匹配键，无法证明唯一性时只读；执行前重读双方结构，变化则不派发写入 | 仍缺批量多表、结构化唯一索引证明、配置保存 / 复制 / 复用、大表全量一致性与原子并发冲突检查；仍是 5,000 行窗口。DBX 当前也是整行勾选，并非字段级写入选择 | 单表差异工作区部分实现；已纠正字段级选择的对齐口径 |
| UI-06 | Schema / 结构对比 | 当前 ComparePane 只比较数据行 | 未见等价的结构差异树、并排 DDL diff、依赖选择、部署预览 / 回滚完整性提示工作区 | 未见等价工作流；属于扩展范围候选 |
| UI-07 | 执行计划 | 已有树 / 摘要及源 SQL 定位；工作树已有 JSON 只读编辑器 / 回执复制、默认视图与 JSON / CSV / HTML / XLSX 导出，专项测试通过 | 仍缺可交互计划画布、SVG / PNG 导出和更多实际引擎计划能力；工作树原有改动保留，本轮不冒充全部重新实现或 GUI 全验 | 部分实现 |
| UI-08 | ER / 关系图 | 单 namespace 图、基本布局 / 缩放 / 跳表、错误和截断提示 | 缺多 Schema 对象选择与同图展示、大图虚拟化、布局保存及多格式图导出；当前跨 namespace 关系会提示遗漏而非完整绘制 | 部分实现 |
| UI-09 | 表导入 | 四阶段导入新增 UTF-8 CSV/TSV 分隔符、标题/无标题、起始记录、空白/空值处理、显式按位置映射；选项变化撤销旧预览，前后端冻结同一解析口径，写入前核对源字节及选项指纹 | 仍缺更多编码、Excel 工作表/范围、结束记录、更多冲突策略及批量来源；不是流式导入、目标结构锁或持久任务恢复 | CSV/TSV 解析与审阅已接通并实测；完整导入仍部分实现 |
| UI-10 | 导出 | 网格 / Schema SQL 导出已有；Schema SQL 导出增加有效选项记忆、稳定表排序、懒加载表清单及错误重试；原生保存真实回执后提供文件定位，Web 不伪造路径 | 仍缺统一“当前页 / 选中行 / 全查询 / 全表”范围选择、目录偏好 / 最近目录、跨出口的文件定位、流式进度 / 取消及分片；原生文件管理器交互待打包 GUI 验收 | 部分实现 |
| UI-11 | SQL 文件库 / 历史 | 宿主 HistoryPanel、SnippetsPanel 可保存 / 插入 / 执行；查询可另存文件 | 还不是 DBX 的 SQL 文件库：缺文件夹树、文件与连接 / catalog / schema 的绑定、批量文件导入、全文搜索与行匹配、排序 / 拖放整理等。保留现有宿主面板，不另造外壳 | 部分实现 |
| UI-12 | 数据作业与恢复 | 每个窗口显示当前进度 / 回执，关闭保护登记在内存 | 缺统一可保存的导入 / 导出 / 迁移配置与历史作业视图；进程重启 / 断网后的回执恢复不能靠保留一个 modal 实现。DBX 的配置库不自动等同于完整在途恢复 | 部分实现 / 既定可靠性目标 |
| UI-13 | 专用数据库工作区 | Mongo / ES 主要走通用命令编辑器和只读结果；Redis 有 keyspace 摘要、基础编辑表单；DuckDB 可连接文件并执行 SQL | 缺完整文档浏览编辑、专用索引 / 查询分析、Redis 键树与拖选 / Stream、大 key 分段编辑，以及 DuckDB 文件资源工作流 | 部分实现，差距较大 |
| UI-14 | 工作区偏好与恢复 | 切页签保留挂载、当前草稿保护、内存中的树宽和分栏 | 缺重启后的查询 / 草稿 / 布局恢复、更多数据库专属偏好；命令面板只过滤已传入命令，不等于跨库内容检索。已有跨 namespace 对象搜索不要误列缺失 | 部分实现 |

### 原始审查时最新 6 commits 的处理（历史记录）

| 上游增量 | 本轮判断 |
|---|---|
| `f9ee05f` JSON 计划只读编辑器 + 复制 | Catio 仍是 `<pre>` 原始展示，明确缺口（UI-07） |
| `45c23b1` 计划导出 | Catio 查看器未见等价导出接线，明确缺口（UI-07） |
| `53606ff` 可固定列查找侧栏 | Catio 现有列显隐与记录侧栏不同，明确缺口（UI-02） |
| `0503d3b` Redis 拖选键 | Catio 当前 keyspace / 编辑器不是键浏览器，明确缺口（UI-13） |
| `c615921` Mongo 嵌套操作符 / 选项建议 | Catio 有 mongoCompletion，不应说完全没有；需对照新增语义用例验证哪些已支持 |
| `f9680e4` 按方言嵌套块注释 | Catio 有多套 CST / 执行范围 / 风险 / 文件词法路径；需逐路径用例核验，不能仅因上游修复就认定 Catio 同样存在漏洞 |

## 4. 不能靠 UI 外观补齐的功能差距

### F-01 编辑器语义与设置

- 已新增 `unknownColumn` / `ambiguousColumn`，只用完整且身份匹配的列目录判断可解析物理表/视图引用；并非全部 SQL 列语义检查。CTE/派生输出、复杂表达式、全部非保留关键字字段、类型推断与服务器错误定位仍须继续补齐。
- 已补常见 INSERT 列列表、UPDATE SET 左侧、CREATE / ALTER / CAST 类型上下文；不等于完整厂商 DML / DDL、复杂 TVF / 前向 CTE 输出推导、动态函数重载。
- `formatSql()` 已接入大小写、逗号位置和缩进偏好，行首逗号仅移动 CST 中实际逗号 token，不改多行字面量或注释。大于 1,000,000 字符及不支持语法保留原草稿；这不是全过程 SQL 格式器。
- server version / SQL_MODE / 扩展等适配和过程批次 / 大脚本仍是原目标；不宣称 DBX 等于完整 SQL 编译器。

### F-02 查询分析深度

- 当前非执行式计划构建明确支持 PG / MySQL / SQLite / DuckDB / rqlite；SQL Server SHOWPLAN、Oracle 和其他商业引擎的等价路径未完整接通。
- 实际执行分析与非执行计划必须分开授权；不能为了补视图而把 ANALYZE 自动当成只读。
- 字段血缘、估算与实际行数对比、优化建议的真实依据、结果 profile 等仍缺。对 DBX 是否已完整覆盖所有这些能力，本轮未做全量证明。

### F-03 数据范围、类型和一致性

- Compare 当前 `ROW_LIMIT=5000`，窗口截断时抑制 DELETE；这是安全的有界对比，不是全量大表同步。
- 网格 CSV / JSON / SQL / Markdown / XLSX 仍基于当前页；Schema SQL 导出虽能分页取数，但在内存累计，不是流式输出或一致性快照。
- 类型侧车已解决若干标量二进制 / 文本 / NULL 问题，不代表嵌套 BSON、厂商 LOB、集合类型、时区等已全面保真。
- 完整结构迁移还需要真实后端计划、依赖排序、目标重验、版本 / 权限检查；不能在前端拼摘要冒充计划。

### F-04 文件与任务生命周期

- **SQL 文件执行**已有有界解码 / 预检 spool / 指纹 / 取消；**表数据文件导入**现有 UI 已携带源字节、格式及解析选项的指纹，后端对本次实际解析的字节重验。不是 spool/持久任务或目标锁；旧 RPC 省略选项及指纹时仍兼容默认解析，不能宣称所有调用都强制审阅。
- Web 当前仍有 8 MiB 上传边界；更大文件分块、其他编码、更多工作表、各驱动取消效果和掉线 / 重启后的结果核验待补。
- 迁移配置库、当前运行进度、持久运行回执、可安全恢复是四件事，不能合称“任务完成”。

### F-05 专用模型

- MongoDB：文档级编辑、Extended JSON / ObjectId / Date / 长数字 / 嵌套结构与标识保真，不能套 SQL 行编辑器。
- Redis：键目录、范围 / 拖拽选择、批量确认、Stream / 消费组、有界大 key 浏览与字段编辑；当前已有基础键编辑操作，不是空白，但未达到专用工作区。
- Elasticsearch：文档 / 索引管理、结构化查询和 profile、routing / seq_no / primary_term 等并发语义。
- DuckDB：Parquet / CSV / JSON 文件资源的打开 / 挂载 / 查询 / 输出流程；能手写 read_parquet SQL 不等于有文件工作区。

### F-06 AI 辅助闭环

已有目标上下文、审批入口和历史真实模型样例，不应列作“没有 AI”。仍需计划对象 / 影响预览、DDL 依赖、权限与目标重验、执行回执进入后续推理、结果读回及未知结果核验。自主维护 / 流中断恢复是原增强目标，**本轮没有证明 DBX 已全面实现它们，也不能拿来反推 Catio 的完成率**。

## 5. 原审查提出的可靠性风险（下列为原始记录；后续状态见实施检查点）

1. **迁移旧流程状态**：`runTransfer()` 只检查 ready，缺新导入向导的同步提交锁；progress 订阅载荷只见 transferred / total / done，未见按 operation identity 隔离。目标配置与未知结果后的再执行门禁应补一致性测试。不能因为已有 footer busy 禁用就称所有竞态已覆盖。
2. **对比关闭保护**：ComparePane 有 executing 状态，但未见接入统一 `useReportDatabaseWork` 的登记；应检查执行中关闭内部页签 / 连接 / 应用的真实行为，不能沿用 SQL 标签保护的验收结论。
3. **导出草稿语义不同**：CSV / JSON / SQL / Markdown 的 buildExport 会叠加 edits；XLSX 的两条路径直接取 pageRows.row。需明确是否导出未保存修改，并统一行为 / 提示。
4. **复制成功反馈**：HistoryPanel / SnippetsPanel 目前在 clipboard Promise 回执前就切“已复制”，失败被吞；应与结构 DDL 的真实复制回执规范统一。
5. **SQLite 命令计数**：此前确认的 DDL / 会话命令继承旧 changes，当前仅 UI 边界过滤；后端独立修复 / 回归仍未完成。本轮不将旧日志当成新复现。

这些是代码与历史证据指向的风险 / 待核验项，不是本轮已证实发生的数据损坏。

## 6. 验收差距单列

- UI 差距审查不是像素 diff，未启动 DBX GUI 同屏逐项走查。
- Web + SQLite / DuckDB 分项证据，不代替完整打包 Tauri 文件 GUI、快捷键 / 焦点 / IME / 隐藏切换 / 卸载 / 退出组合矩阵。
- 真实连接测试依赖引擎 / 版本 / 许可 / 实例；支持 profile 或 JDBC 模板不等于各品牌能力通过。
- 已知 SQL Server 真验为 2019，2022 在旧测试内核的限制保留；历史矩阵不代表本轮再运行。
- 三主题支持代码与部分视觉检查点，不等于每个功能在全部主题和尺寸组合通过。
- 依赖漏洞、Agent key 本地持久化等历史安全边界不因界面整理自动消失。

## 7. 建议推进顺序（不创建任务，不擅自取消旧目标）

先处理第 5 节可造成误导回执或丢失操作上下文的风险；产品主线仍是 **1 → 6 → 5 → 7 → 8**：

1. **编辑器 + 宽表可见体验**：列查找 / 定位侧栏，DDL / DML 上下文与编辑器设置，补全 / 诊断边界场景。
2. **查询分析**：计划 JSON 只读编辑器 / 复制 / 导出 / 画布，再补有真实驱动与权限依据的计划能力。
3. **迁移与对比**：先统一旧迁移状态 / 分步确认，接真实结构计划与执行重验，再扩大对比范围与差异选择；同时补导入解析选项、导出范围和配置保存。
4. **专用数据库**：Mongo / Redis / ES / DuckDB 分别做本模型工作区，不用一个通用表格替代全部。
5. **AI**：复用前面真实工具与回执形成维护闭环，而非另开没有后端能力支撑的 AI 面板。

完整 Schema 对比、工程建模 / 模型生成、备份管理、新引擎（含 CouchDB）、插件市场等是 DBX 的额外差异候选。保留在范围边界中，**本次梳理不自动承诺整套扩建**。不为“像 DBX”重做 Catio 外框、SSH / SFTP / MCP。

## 后续实施检查点：迁移提交与回执保护

本节为报告之后的增量记录，不改变上面源码审查时点的结论，也不表示 UI-04 完整迁移向导已经完成。

- 复核当前源码：ComparePane 已登记 `useReportDatabaseWork`，HistoryPanel / SnippetsPanel 已使用 `useCopyFeedback`；本轮不重复实现这两项。
- DataTransferDialog 增加同步提交锁；执行中冻结目标、映射与模式，成功或异常回执后本窗口均不能重放写入。
- 切换目标清理映射、Upsert 键和覆盖确认；目标列元数据未加载或失败、重复目标列、映射到未知列时禁止提交。
- 只有非负安全整数的实际行数回执才显示成功；失联或无效回执提示先核验目标，不宣称回滚。刷新回调失败保留已确认的迁移结果。
- 旧 `db://transfer-progress` 无 operation identity，本轮停止将全局事件的百分比/行数归属于当前请求，改为等待真实回执提示。带身份的后端进度、持久回执、分步确认、多对象和结构计划仍待实现。
- 验证：相关四文件第一轮 48 tests 通过；补充用例并修正测试异步等待后，迁移组件单独复跑 13 tests 通过、无 stderr；`npx tsc --noEmit` 通过。未运行全量前后端测试。
- 保留工作树已有列查找 / 计划工作区及 capabilities 改动，不将它们算作本轮成果。本轮为前端组件回归，不代表真实数据库迁移、断网恢复或打包 Tauri GUI 验收。

## 后续实施检查点：编辑器、结果分析、迁移与差异工作区

本检查点覆盖实际代码和有界验证，不是“全面对齐”结单。

### 已实现与行为边界

- **UI-01 / F-01**：SQL 控制台「更多操作 → SQL 编辑器偏好」。仅持久化非敏感配置；本地存储不可用会明确提示仅当前会话有效。CodeMirror 使用 compartment 重配，不重建文档、选区或撤销栈；plain 模式仍保留自身补全。补全只识别有证据的常见 CST 槽位，复杂语法不冒充完整编译器。
- **UI-02**：查询结果新增「结果分析」，可切换列统计、转置和标量频次。最多分析 2,000 行 / 100 列的初次执行快照；不强转精确小数或大整数文本，不混淆空二进制 / 空文本 / NULL，不触发新查询或持久化结果。旧列查找侧栏的 7 项专项测试通过，未覆盖其三主题像素矩阵。
- **UI-04**：单表数据迁移复用 `DatabaseFileFlow` 四阶段；原子提交门禁、目标元数据错误与重载、自复制阻断、精确表名覆盖确认、执行前结构重读和迟到回执隔离。结构过期或重验失败时没有发出写入；已发出写入后不允许重放。本地 SQLite 覆盖迁移实测成功，不代表跨品牌迁移矩阵通过。
- **UI-05**：差异行按 50 项分页、每行可看全部列的目标原值 / 源值与变化标记，整行选择驱动同步 SQL；筛选二进制旁路元数据时同步重定位。截断窗口的 DELETE 无法通过选择重新启用；未知回执后禁止通过改选重放；未选择不能被显示成“表一致”。单元格选择和并发更新冲突检测仍未完成。
- **可靠性**：SQLite 在 prepare 阶段使用引擎 authorizer 观察顶层操作，区分 DML 与 DDL/会话/虚表命令；结合总变更计数门禁，返回直接受影响行数而非触发器副作用总数。prepare 出错同样清理临时 hook。包括 FTS5 的影子表变更和 WITH INSERT，不靠 SQL 首词猜测。

### 本地真实浏览器行为验收

- 服务为 `http://127.0.0.1:18878/`，仅使用新建的 SQLite `:memory:` 测试连接 `DBX-parity-QA-1007`；没有连接或部署生产数据库。该测试连接与浏览器页保留供复核，原有连接未改动。
- 常量查询返回两行：BLOB / 同形 hex 文本 / 空文本 / NULL / 超过 JS 安全整数范围的文本。列统计返回 payload 二进制 2、empty_value 的 NULL 1 和空文本 1；长整数不计为数值。
- 在实际设置面板选择小写关键字和行首逗号，格式化输出符合选择；测试后恢复默认。
- 临时 `qa_src` / `qa_dst` 对比得到 INSERT 1 / UPDATE 1；取消勾选 INSERT 后只执行 UPDATE，回执影响 1 行，再对比仅剩 INSERT。
- 四阶段迁移中覆盖按钮在输入精确目标名之前禁用；确认目标后返回「已迁移 2 行」。随后真实查询 `typeof(payload)` / `hex(payload)` / `note IS NULL`：两行均为 blob，分别为 `00FF` / 空字节，NULL 状态为 0 / 1。
- 嵌入浏览器 DOM 观察与输入一度超时，恢复后完成上述交互；截图捕获仍超时。故不将这些证据称为像素验收、全主题验收或打包 Tauri GUI 验收。

### 回归与未结范围

代码提交：`6755c5f`（编辑器 / 结果分析）、`230b3b7`（迁移向导）、`fe02e7c`（差异工作区）、`15f873f`（SQLite 实际影响行数）。

- 前端全量最终复跑：**185 files / 1,726 tests 通过**。首轮发现迁移旧接线测试和两个冷解析时间预算问题；更新向导契约，并仅在语义测试 fixture 中预热解析，生产短预算和 fail-closed 行为不放宽。仍存在部分既有 React act warning。
- `npm run build` 已通过（TypeScript + Vite）；保留现有大 chunk 构建提醒。
- Rust 第一次 desktop library 构建等待既有进程的编译锁后超时，没有终止其他人的构建；改用 `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib`，最终 **553 tests 通过**，包含普通命令计数、触发器副作用及 FTS5 / WITH INSERT 的 3 项新增回归。该结果不替代外部引擎集成矩阵。
- 列查找 / 计划工作区及 capabilities 原有工作树改动继续保留，不混入本增量提交。
- **仍未结**：完整结构编辑与结构迁移、批量/单元格对比、计划画布与图像导出、多 Schema ER、导入解析选项、全范围流式导出、SQL 文件库、持久作业与安全恢复、专用 Mongo/Redis/ES/DuckDB 工作区、完整 AI 维护闭环与逐引擎验收。不能把本检查点合称“从界面到功能已全面对齐”。

## 最新上游复核与实施：DBX `d69faca`

### 本次基线与口径修正

- `git ls-remote --symref origin HEAD` 确认默认分支 main，本次抓取时最新为 **`d69facab23ab1c6c6690b27546adfd0c78f894cf`**（commit 时间 2026-10-07 19:59:12 +08:00），较旧基线 `f9ee05f` 增加 22 个提交。fetch 后建立独立只读参考 `.worktrees/dbx-review-d69faca`，未覆盖旧快照。
- Catio 本轮从 `6b895ea` 出发；原有 DataGrid / ExplainPlanViewer / capabilities 与相关未跟踪文件保留。不是重新声称旧功能都不存在，也不把未提交工作冒充本轮新增。
- **修正 UI-05**：实际读取上游 `components/diff/DataCompareDialog.vue` 的 `toggleRowSelection`、`setDiffSelection` 和同步计划接线，证据支持的是整行选择与单元格差异查看。旧报告把“单元格级选择写入”列作必须对齐项，口径过宽；改列增强候选，不计作已证明的 DBX 必备差距。批量与每表自定义匹配键则有明确实现。

### 新增提交的实际差距

| 上游 | 当前判断 |
|---|---|
| `7f60b43` / `0fce8f4` 导出选项记忆、稳定排序、保存后定位 | 本轮接入 **Schema SQL 导出**。不照搬尚无后端的拆分、方言、对象导出开关，也不自动打开文件。其他导出入口尚未统一 |
| `124093e` 旧 JDBC `getSchemas` 的 AbstractMethodError 回退 | Catio 同类缺口已复现并修复；同时覆盖 case-insensitive Schema 名称解析。旧驱动行为用代理夹具验证，不能声称 jTDS/SQL Server 2000 实例已实测 |
| `4f229a8` / `658a7a4` gutter 执行后的光标 / 视口策略 | Catio 有当前语句执行与源 SQL 定位，SqlEditor 保留行号 / 折叠栏、诊断改为正文波浪线；仍未形成等价 gutter 执行及偏好 |
| `03b50e1` WHERE 语法建议 | 已对齐表格条件输入的有界字段/操作符/值/连接词建议、BETWEEN/IS 子上下文、方言引用及键盘接受；值和字面量不误补列名。复杂表达式/子查询内部、服务器版本/SQL_MODE 和历史建议仍未覆盖 |
| `09c47b1` 隐藏相同值列 | Catio 有列显隐与列查找，尚未接通该样本分析动作；不能用手动隐藏替代 |
| `3d9e590` 剪贴板粘贴为新增行 | 当前网格没有等价批量粘贴草稿流程；后续必须保留预览、类型和写入门禁，不能直接提交剪贴板内容 |
| `ca1ef94` Alt + 滚轮横向滚动 | 当前工作树已有 Alt / Shift + wheel 处理，是原有未提交工作，本轮不重复实现或混入提交 |
| `9ca4ab8` Oracle q-quote 切分 | 前端方言 / 元数据扫描已有相关处理；Rust 流式 `sql_file.rs` 当前没有对应 q-quote 状态，仍需结合 JDBC profile 明确方言配置并补跨 chunk 验证。没有执行真实 Oracle 写入复现，不能拿前端词法测试替代文件执行验证 |
| `4e11122` 全局前进 / 后退 | 上游扩展到全局导航；当前目标仍保留 Catio 外框，数据库内导航可单独适配，不直接重做宿主导航 |
| `7e324bd` 结构复选框标签 / `8875581` DDL 共用渲染 | 前者待结构编辑器专项体验复核，后者是内部复用，不按文件数量视为独立功能；完整结构变更仍未交付 |
| `0f59ecd` / `d69faca` 网格顶部导出入口新增又撤回 | 按最终快照处理，不再添加重复主入口 |
| 发布、贡献文档与插件 contribution / dynamic-import 修复 | 不冒充数据库功能增量；并非要求 Catio 复制 DBX 插件架构 |

### 本轮实现的真实边界

1. **Schema SQL 导出**：只在进入确认页时保存有效的结构 / 数据、批大小和每表行上限；不保存 SQL、表选择、连接标识、namespace 或文件路径。存储失败可见且不阻断当前导出。表名稳定排序，但确认后的显式清单不会被后续目录变化扩张。
2. **懒加载入口修复**：浏览器发现未展开 Schema 的导出曾把未加载目录当成空表清单；现在按需加载选中 namespace，显示加载 / 错误并可重试，仅首次完整目录就绪时初始化选择。确认按钮不会在目录不可用时放行。
3. **导出文件定位**：仅原生 `saved` 回执显示定位按钮，等待 `revealItemInDir` 结果；同步锁防重复调用，失败不会抹掉成功保存回执或重新导出。只增加 reveal 权限，没有放开任意文件的 `openPath`；Web 下载没有本机路径，不显示该动作。
4. **自定义匹配键**：可选共有字段及组合键，按选择顺序进行有界查询与类型保真对比；未知字段、NULL、重复键仍拒绝。非主键业务列可以只读比较，但当前索引 DTO 仅有不可逆显示字符串，不能证明完整 / 非部分唯一约束。只有键包含双方完整主键时才允许生成 SQL / 同步，不把当前窗口无重复当作全表唯一。
5. **同步前结构检查**：真实重读双方 columns / indexes / fks，对比确认时的结构指纹；变化或读取失败则不发送写入，要求重新对比。已派发后仍保持未知回执不重放。这不是数据库锁、行版本检查或一致性快照，并发数据冲突仍是缺口。
6. **JDBC**：仅能力缺失异常走重载 / 默认 Schema 回退，不捕获任意 Throwable；普通分支的权限 SQLException 与非能力运行时错误继续上报。Java 变更后运行全部单元测试并按脚本重建 vendored JAR；没有修改用户 driver JAR。

### 本轮验证与提交

- 提交：`b23bedf`（旧 JDBC 元数据兼容）、`9160782`（自定义匹配键 / 同步前检查）、`dfdbec8`（导出偏好 / 懒加载 / 文件定位）。每项中英文同步，原有列查找与计划工作区改动未混入。收尾逐项比较开始时的 diff：两组件与语言文件原有改动保留；生成的 capabilities 在原内容上仅新增本轮 reveal 权限声明，未提交该生成物。
- TDD：导出新增路径先有 5 项失败、匹配键 / 预检先有 4 项失败、JDBC 旧驱动先有 3 项错误；修复后相应回归通过。懒加载问题在真实浏览器复现后补充组件及工作台集成用例。
- 最终前端全量 **188 files / 1,756 tests 通过**；`npm run build`（TypeScript + Vite）通过。首轮全量暴露导出测试未清理新增持久化偏好的串扰，已补 `localStorage` 隔离；新增目录桩件曾破坏旧测试的 Promise 契约，已修复测试适配，不降低产品错误门禁。仍有既有 act / SSR 测试提醒和大 chunk 构建提醒。
- Java 全量 **16 tests 通过**（其中 5 项新增旧驱动场景）；已运行 `scripts/build-jdbc-plugin.ps1` 更新 JAR。SHA-256：`d3427a4bc406d6faf7fa640e495344026aeb3b46595f3fcc29b3b3aaf57f77e9`。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --test db_jdbc_h2`：**553 library + 4 H2 integration tests 通过**。明确设置 `CATIO_TEST_JDBC=1`，并指向本轮重建的 resources JAR，没有用跳过门禁冒充真实桥接验证；没有重跑全部外部引擎矩阵。
- 浏览器继续使用本地 `18878` 的 SQLite `:memory:` QA profile，在新会话中创建独立夹具。仅选 `code` 能查看差异但无同步 SQL、执行按钮禁用；选 `code + id` 后实际 UPDATE 的 WHERE 含两个字段，BLOB 保留 `X'00ff'`，真实回执影响 1 行，重比零差异。
- 最终构建 `index-BJl7r6WE.js`：Schema 未展开时直接导出自动加载两表；`Alpha_export` 排在 `zebra_export` 前，批大小 80 / 行上限 2 在再次打开后恢复，存储仅含四个非敏感选项。已恢复测试前的偏好状态。
- 真实 Web 下载 `main.sql` 完成，562 bytes；读回含两张表各一行，空 BLOB 为 `X''`、另一行为 `X'00ff'`，顺序与确认页一致。下载夹具仅保存在本地忽略目录，不进入 Git。Web 界面明确“已发起下载”，未出现本机文件定位按钮。
- 本轮截图捕获在重新选择页面 / 调整 viewport 后恢复可用，完成 **1440×900、当前浅色主题的导出回执布局检查**；不扩展为三主题像素矩阵。原生 `Show in folder` 完成接口、错误回执、权限与重复点击测试，仍待打包 Tauri / 系统文件管理器 GUI 实测。
- 没有生产部署、生产写入或数据卷操作。本轮没有把整体数据库对齐标为完成；上表的 gutter、网格新能力、Oracle 文件词法、完整结构 / 多对象任务等仍保持未结。

### 编辑器体验修复：间距与可操作诊断

- 用户截图在实际页面复现：语句末尾是全角 `；`，原检查仅报 `referenceSkipped`，把提示标在文档开头。方块是 CodeMirror 默认 info marker，并非图片资源加载失败。
- 对照 `d69faca` 的 `components/editor/queryEditorSqlExtensions.ts`，DBX 在具体错误范围绘制波浪线 / 悬停说明，而不是常驻独立诊断栏；`useQueryEditorDiagnostics.ts` 和 `lib/sql/semantic/diagnostics.ts` 进一步结合解析器与已加载元数据定位未知表 / 列。
- Catio 移除 **SQL 模式** 的独立 lint gutter，正文左内边距 14 → 4 CSS px；保留行号和折叠，plain 模式与共享远程文件编辑器不变。页面实测行号字形至代码的间距 **48 → 19.8 CSS px**。
- 解析未就绪 / 能力不支持等状态仍保留在分析 API 中，但不再把用户第一个字符当作错误，不弹无操作价值的悬浮提示；空诊断没有被包装成“SQL 校验通过”。
- 新增常见全角标点的定位与显式替换建议，只处理 CST 错误节点里的独立符号，不改字符串、注释或引用标识符。补齐 SQLite/rqlite 方括号标识符解析，避免合法列名误报。修复按钮应用前重新核对当前范围和语法，支持撤销、拒绝只读文档，不执行 SQL。
- 沿用主题 tokens 设置浮层、波浪线及修复按钮，支持 F8 / Ctrl-Shift-M 定位或查看本地提示；浏览器检查了三主题的标记 / 问题面板，发现并补修了深色主题面板焦点的系统蓝色与关闭按钮可见性。
- 回归：全量 **189 files / 1,781 tests 通过**；最后焦点样式补修后 **11 files / 166 targeted tests** 与 TypeScript/Vite 构建再次通过。浏览器实际点击后 `SELECT 1；` 变为 `SELECT 1;`、警告消失，Ctrl-Z 恢复；结果区保持未执行。浏览器验收在独立 QA 页进行，未刷新用户原页面或改动原 SQL 草稿，主题已恢复。
- 本增量没有补齐 DBX 的完整列级推断、所有方言解析或服务器执行错误定位，不将局部诊断体验修复等同于完整 SQL 语义检查。

### 继续实施：有依据的字段诊断与设置

本增量从 `4de0d4a` 继续，对照固定 `d69faca` 的 `useQueryEditorDiagnostics.ts` / `semantic/diagnostics.ts`；不将它等同于 DBX 全部 SQL 编译/语义能力。

- `sqlScopeCompletion` 增加只读的作用域身份观察入口：提供可见别名、原物理对象与局部/外层身份，诊断不从空补全候选推断字段不存在。`sqlColumnDiagnostics` 用独立的完整列目录核对字段；物理字段的限定引用、常见 SELECT/WHERE/ON 裸列及已证明的局部歧义可准确定位。
- 处理 namespace 身份、引用大小写、别名遮蔽、关联子查询、LATERAL/APPLY、跨语句/UNION 隔离；已知伪列、函数名、CAST/日期部分/排序规则等不当作普通字段。CTE/派生/表函数输出、显式重命名列、无法可靠合并的转义引用、JOIN USING/NATURAL 的裸列合并及复杂投影别名按保守边界跳过。
- 列快照绑定 connection、namespace 集合及 metadata revision；失效事件先撤销旧快照，再做去抖加载。请求 generation 防止旧响应在刷新后重新成为证据。失败/截断响应仍用于已有的部分补全和错误展示，但不用于证明字段缺失；跨连接也不会借用旧列。
- 新增「SQL 编辑器偏好 → 表与字段提示」开关，只持久化布尔偏好，不保存 SQL/列目录/连接信息。关闭表/字段提示不关闭中文标点、引号、括号等本地语法提示，检查不会执行编辑器里的 SQL。
- 复用增量 CST 和既有短解析预算；字段检查增加候选/数量/时间上限。不为语义测试放宽生产预算，语义 fixture 固定时钟、时间耗尽分支单独测试。作用域身份分析不物化无关的补全目录。
- 浏览器使用独立的 SQLite `:memory:` 会话和构建 `index-D7xzU7M_.js`：`o.ammount` 只标出字段拼写，双方都有 `id` 时提示 `o, c` 两个来源；生成列 `calculated` 没有误报。关闭开关后标记消失、重新打开后恢复，SQL 文本不变。
- 在测试会话另一查询页实际执行 `ALTER TABLE ... ADD COLUMN ammount` 后，原查询页无需改字即可撤销旧警告；该诊断查询页仍处于未执行状态，再输入 `still_missing` 仍会产生新警告，排除刷新后检查被永久关闭的假通过。列目录实际走 `metadata.rs` 的 `table_xinfo`，没有误用不含生成列的结构编辑 DTO。只操作本轮内存夹具，没有修改原连接数据或生产。
- 已检查浅色主题的字段悬浮提示与设置面板截图；沿用已有主题组件，没有声称完成全部主题/尺寸或打包桌面验收。原页面不刷新，测试偏好已恢复。最后另有不构建无关目录的性能收紧，最终构建为 `index-D1XtxZ85.js`；没有把前面的浏览器快照冒充最终二进制的完整 GUI 矩阵。
- 验证：新增字段场景先有 **15 项失败**、元数据接线先有 **2 项失败**；相关回归 **14 files / 269 tests** 通过，字段语义专项 **49 tests** 通过；最终全量 **190 files / 1,835 tests** 通过，TypeScript/Vite 构建通过。仍有既有 act / chunk 提醒。后端未变更，不重跑或冒称完成新的外部引擎矩阵。
- 收尾对比开始时的 diff：原有 DataGrid / ExplainPlanViewer / capabilities 和语言文件改动均保留，未混入本增量提交；没有生产部署。

### 继续实施：CSV/TSV 解析选项、位置映射与源文件重验

本增量起点 `3e6e2b1`；参考固定 `d69faca` 的 `TableImportDialog.vue` 中 `taskParseOptions`、`importParseOptions`、`preparedImportSource`。仍复用 Catio 的四阶段工作流，没有重做宿主框架。

- **界面与解析同时接通**：CSV/TSV 可选择逗号、制表符、分号、竖线；标题记录 0 表示无标题，可设置数据起始记录、去除值两端空白及保留空字符串。只支持 UTF-8（含 BOM），不显示尚未实现的编码/Excel 选项。JSON/Excel 沿用已有解析。
- 记录是 CSV 逻辑记录，不把引号内换行拆成两条；空行不计数。无标题时由首条数据建立 `column_N`；缺字段补 NULL，多字段及重复/归一化后冲突表头报错，不悄悄丢数据。预览上限之后仍会验证全部记录，字符串数值不自动转浮点数。
- 修改选项立即撤销旧预览、映射和确认，必须手动更新预览后才可继续；解析失败保留已选路径/浏览器字节，能够直接纠正配置重试。准备期间禁止改选项；换目标/卸载拒绝迟到回调。显式「按位置映射」可覆盖当前映射，但必须审阅，不自动写入；修复原型名称在映射初始化时的问题。
- 预览回传 canonical `parseOptions` 和 SHA-256 `sourceFingerprint`，指纹绑定源字节、文件格式和解析选项。新 UI 拒绝缺失或不匹配的回执；native/Web 共用解析与写入函数，实际导入前核对同一份读入字节，文件或选项变化则在任何目标写入前拒绝。
- 新增解析选项的 RPC 必须带预览指纹；为兼容旧调用，不带选项和指纹的旧 RPC 仍可按默认规则导入。指纹不绑定目标结构、不是身份凭据，也不是持久作业或断线恢复机制。Web 8 MiB/native 200 MiB 边界及既有事务/明确替换确认/未知回执不重放保持不变。
- **测试**：新增 Rust 选项场景先有 4 项失败、前端工作流先有 5 项失败；最后相关 **6 files / 37 tests** 通过，前端全量 **193 files / 1,846 tests** 与 TypeScript/Vite 构建通过。Rust **559 library tests + 1 embedded import test + 8 HTTP workflow tests** 通过；embedded 用例实际覆盖 SQLite 与 DuckDB，含 native 文件重读变化、按审阅选项落库、第二批主键冲突时替换回滚；HTTP 用例覆盖字节/选项变化、缺失或非法指纹、未知选项及越权连接拒绝。未重跑外部商业/云引擎矩阵，Java 未变更。
- **浏览器**：另启仅 loopback 的 `18880` 和独立 QA 数据目录，没有重启已有 `18877/18878`。使用 `index-CR5_nDpf.js`，上传含分号、中文、引号内换行、空字段、缺字段的无标题 CSV；改变选项后旧预览消失且下一步禁用，更新预览后得到 3 行，按位置映射为 id/name，确认页明确显示解析口径。
- 实际追加导入回执为 3 行；读回 4 行（含原始 id=9）：id=1 的文本长度 8、换行位置 4，id=2 的空字符串长度 0 且非 NULL，id=3 为 NULL，原始行保留。回执后没有重复提交入口；1440×900 浅色确认页截图完成，不冒称全主题/尺寸或打包 Tauri 文件对话框全验。GUI 发现 Web 来源说明仍写着必须有表头，随后同步修正中英文并补断言复跑专项/构建。
- 本轮临时 QA 页、服务、example 源码及独立数据目录已清理；原页面与 SQL 草稿未刷新、未改写。已有 DataGrid/ExplainPlanViewer、语言及 capabilities 的未提交工作保留，未部署生产。

### 继续实施：调试模式复核与表格条件补全

本增量起点 `727d246`。对照固定 `d69faca` 中 `03b50e1` 的 `useDataGridConditionEditor.ts` / 测试，范围是 **表格 WHERE/ORDER BY 输入框**，不把它混称为完整 SQL 编辑器语义分析。

- **运行版本核验**：本机 1420 为其他项目，另有已安装的 Catio 进程；均未停止/替换。以独立应用标识及 1428 启动 Tauri dev，编译成功并运行 `K:/cargo/debug/catio.exe`。浏览器真实交互使用 1430 的 Vite 热更新源码 + 18880 的独立 loopback Rust QA API，数据目录隔离；不是旧 dist，也不是 mock 查询。不据此反推之前截图必然来自哪个二进制。
- **旧修复仍有效**：当前源码实测 SQL 行号字形到正文为 **19.8 CSS px**，独立 lint 栏 0 列。`SELECT 1；` 只标记全角分号，问题面板有具体解释和「替换为 ;」。点击后变为 `SELECT 1;`、提示消失，Ctrl-Z 可恢复；没有执行 SQL。1440×900 下检查 Dawn/Amber/Grove 的诊断显示，本轮没有重复改动 SqlEditor、SQL theme 或诊断逻辑。
- **上下文补全**：替代原本只过滤单词前缀的条件候选。只在字段位置推荐列名；运算符位置支持 BETWEEN/NOT BETWEEN、LIKE/NOT LIKE、IN/NOT IN、IS NULL/IS NOT NULL，已完成条件位置只推荐连接词；IS/IS NOT、BETWEEN 两个值之间及 ORDER BY 方向单独处理。不在值、字符串、注释和 IN 值列表中误补字段。ILIKE/REGEXP/RLIKE/GLOB 按已知方言收紧。
- **引用与替换**：列名按方言引用并转义，SQL Server 默认用方括号；中文、空格、引号及同形关键字名称不直接裸拼。补全替换完整当前 token（包括光标右侧后缀），不吞后续条件；旧菜单与当前草稿/光标不匹配时拒绝替换。
- **键盘与可访问性**：抽出 `SqlClauseInput`，支持 ↑/↓、Enter/Tab 接受、Escape 关闭、鼠标选择及 combobox/listbox 状态。接受候选只改输入草稿，不发查询；菜单关闭后再次明确回车才提交，忙碌门禁及 IME 229/组合输入保护保留。修复选择事件重置活动候选的问题。元数据/方言变化会清除旧候选，不保存输入或目录。
- **有界且保守**：16,384 字符、2,048 token、32 层、最多检查前 10,000 列并返回 50 个候选；空前缀不弹窗。复杂 cast/CASE/子查询内部等无法确定的位置不猜测。不是服务器 SQL 校验器或执行授权门禁；动态 SQL_MODE、完整厂商语法、历史/远程建议仍待继续。
- **真实 SQLite 验收**：独立内存表 `debug_conditions` 三行，分数 12/25/40。`score betw` → Enter 接受 BETWEEN 后未查询，接着通过 Tab 接受 AND；完整提交 `score BETWEEN 15 AND 30` 后只返回 id=2/score=25。`status is` → IS NULL 首次回车未查询，再次回车才返回 id=3/NULL。`ord` 补成带引用的 `order value`，完整条件实际返回 B；字符串内无候选，方向键能选第二个字段并保持正确选择；ORDER BY 补全 DESC 后明确提交，实际返回 40/25/12 的降序记录。已检查三个主题的条件候选外观，不声称完整尺寸/引擎/原生 IME 矩阵完成。
- **测试与构建**：新语义场景先有 25 项失败；最终相关 **10 files / 131 tests**、TypeScript/Vite 构建及前端全量 **195 files / 1,882 tests** 通过。首轮全量期间仍修改了 SQL Server 引用策略和断言，出现对应失败；该次不作为稳定代码快照的结论，随后冻结源文件重跑全套通过，没有放宽生产预算。最终生产 bundle `index-CJsn2uJ1.js`，GUI 证据来自相同源码的 Vite dev，而非将截图冒称生产 bundle 验收。
- 本轮没有后端功能修改/Java JAR 变更，不冒称新 Rust 测试或外部引擎矩阵。临时 Rust example 源码已移除；按本次启动调试界面的请求保留当前调试实例/页面与隔离 QA 数据，原有服务和页面不强刷。DataGrid 仅部分暂存本次条件组件接线，已有列查找/计划及语言/capabilities 工作继续保留；没有生产部署。

### 用户测试反馈：运行按钮与对象栏入口

起点 `25c2a97`（已合入 main）。修复运行下拉箭头 hover 被通用图标按钮背景覆盖的问题；新建查询独占一行且图标/文字居中。按用户确认，删除“工具”入口，将数据对比移入 Schema 右键/省略号菜单，ER 保留原入口，数据库快捷操作移至对象栏标题右侧并沿用原快捷键。仅修改数据库局部样式和入口接线，不改变查询/同步逻辑。

当前 `1430` 页面已验证三主题真实 hover、居中几何、Schema 对比入口及命令面板；专项 **95 tests**、类型/构建及全量 **196 files / 1,891 tests** 通过。动作归属和验收边界见 `docs/design/database-workspace-v0/ACTION-MAP.md`；未扩张为全尺寸、打包 GUI 或全部引擎验收。

## 8. 主要源码定位

以下 DBX 相对路径均位于 `.worktrees/dbx-review-f9ee05f/apps/desktop/src/`；Catio 路径为仓库相对路径。

| 主题 | Catio Source | DBX Source |
|---|---|---|
| 工作台 / 网格 | `src/components/workbench/DbWorkbench.tsx`、`src/components/dbviews/SqlConsole.tsx`、`src/components/dbviews/DataGrid.tsx` | `components/layout/QueryResultViewSwitcher.vue`、`components/grid/DataGrid.vue`（goToColumnPanelPinned / lookup） |
| 编辑器 | `src/components/dbviews/SqlEditor.tsx`、`sqlScopeCompletion.ts`（clause=other 保留旧路径）、`sqlDiagnosticAnalysis.ts`、`sqlFormatter.ts` | `lib/sql/sqlCompletion.ts`（dataTypeContext / functionCompletionIncludeParams） |
| 表结构 | `src/components/dbviews/StructureView.tsx`、`structureDdl.ts` | `components/structure/TableStructureEditor.vue` |
| 计划 | `src/components/dbviews/ExplainPlanViewer.tsx`、`src-tauri/src/db/query_explain_sql.rs` | `components/explain/ExplainPlanViewer.vue`、`lib/export/explainPlanExport.ts` |
| 迁移 | `src/components/dbviews/DataTransferDialog.tsx`、`src-tauri/src/db/write_ops.rs` | `components/transfer/DataTransferDialog.vue`、`structurePlanSummary.ts`、`stores/transferTaskStore.ts` |
| 数据 / 结构对比 | `src/components/workbench/ComparePane.tsx`、`compareTables.ts` | `components/diff/DataCompareDialog.vue`、`SchemaDiffDialog.vue` |
| ER | `src/components/dbviews/ERDiagram.tsx` | `components/diagram/SchemaDiagramDialog.vue` |
| 文件 | `src/components/dbviews/TableImportDialog.tsx`、`DatabaseExportDialog.tsx`、`SqlFileDialog.tsx`、`src-tauri/src/db/commands.rs`（export_database_core） | `components/import/TableImportDialog.vue`、`components/export/DatabaseExportDialog.vue` |
| 历史 / SQL 库 | `src/components/panels/HistoryPanel.tsx`、`SnippetsPanel.tsx` | `components/layout/SqlLibraryPanel.vue`、`components/editor/QueryHistory.vue` |
| 文档 / Redis | `src/components/dbviews/SqlConsole.tsx`、`RedisKeyspaceView.tsx`、`mongoCompletion.ts` | `components/document/DocumentBrowser.vue`、`components/redis/RedisKeyBrowser.vue` |
| AI | `src/components/panels/AIPanel.tsx`、`src/services/agentRuntime.ts`、历史分项验收 | 本轮未对 DBX AI 全链路作行为审计，F-06 按 Catio 原目标列缺口，不作对方已完成的断言 |

本清单是当前范围内的可追踪差距，不是完整 DBX 项目每一个菜单 / 驱动 / 插件的穷尽审计，也不提供无依据的“完成百分比”。
