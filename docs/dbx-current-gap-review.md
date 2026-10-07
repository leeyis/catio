# Catio ↔ DBX 当前界面与功能差距复核

## 1. 本次比较口径

- 审查日期：2026-10-06。
- Catio 源码：`37a7213`（本报告之前的 HEAD，产品变更至 `9cc7a48`）。
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
| UI-01 | 编辑器设置与键盘工作流 | 基本编辑、补全、查找替换、执行范围已接通 | 缺统一的数据库编辑器偏好面板：格式化逗号位置 / 大小写、函数参数示例开关、补全触发键、折叠等可发现入口；DDL 类型上下文体验需补齐 | 部分实现 |
| UI-02 | 宽表 / 结果导航 | 列显隐、筛选、当前行记录侧栏、完整值已有 | 尚无 DBX 新的可固定列查找侧栏；列名 / 注释搜索后跳到网格列、转置视图、结果图表与 profile 等工作流未形成等价组合。不能把行记录侧栏当列查找侧栏 | 部分实现 |
| UI-03 | 表结构编辑器 | 单层页签与列增改删、索引 / FK / 触发器查看及部分删除已有 | 约束 / 分区展示、索引 / FK 完整草稿编辑、多项变更统一预览、原始 DDL 编辑和保存仍不足；目前 DDL 是重建稿。DBX 的分区能力也按引擎区分，并非任意结构都可编辑 | 部分实现；完整结构专项需单独定范围 |
| UI-04 | 数据迁移 | 源 / 目标 / 映射 / 模式在旧式单弹窗中 | 未跟进新文件向导的分步确认和收尾规范；缺多对象选择、结构 / 数据策略、依赖与 SQL 计划摘要、执行时重验、保存配置 / 任务树。现有单表数据复制不等于结构迁移 | 部分实现，明显缺口 |
| UI-05 | 数据对比 | 单对表、差异计数、同步 SQL 和执行确认 | 缺批量多表、逐行 / 逐单元格差异查看与选择、每表匹配键配置、配置保存 / 复制 / 复用；不能把 SQL 文本预览当成完整差异工作区 | 部分实现 |
| UI-06 | Schema / 结构对比 | 当前 ComparePane 只比较数据行 | 未见等价的结构差异树、并排 DDL diff、依赖选择、部署预览 / 回滚完整性提示工作区 | 未见等价工作流；属于扩展范围候选 |
| UI-07 | 执行计划 | 已有树 / 摘要 / JSON 及源 SQL 定位 | 缺可交互计划画布、默认视图设置、原始 JSON 的只读编辑器与独立复制、计划导出。DBX 本轮新增 SVG / PNG / HTML / CSV / XLSX 导出 | 部分实现，明显缺口 |
| UI-08 | ER / 关系图 | 单 namespace 图、基本布局 / 缩放 / 跳表、错误和截断提示 | 缺多 Schema 对象选择与同图展示、大图虚拟化、布局保存及多格式图导出；当前跨 namespace 关系会提示遗漏而非完整绘制 | 部分实现 |
| UI-09 | 表导入 | 四阶段真实导入、类型预览、映射、替换确认和回执已有 | 缺无表头 / 标题行设置、按位置映射、分隔符 / 编码 / 工作表 / 范围选择、更多冲突策略和批量来源流程。当前不应显示无实现开关 | 部分实现，不需重做已完成外框 |
| UI-10 | 导出 | 当前网格导出与 Schema SQL 导出已有 | 缺统一“当前页 / 选中行 / 全查询 / 全表”范围选择；目录偏好 / 最近目录 / 打开文件位置、流式任务进度 / 取消、分片输出等仍缺。Web 下载已修，不能继续列成未做 | 部分实现 |
| UI-11 | SQL 文件库 / 历史 | 宿主 HistoryPanel、SnippetsPanel 可保存 / 插入 / 执行；查询可另存文件 | 还不是 DBX 的 SQL 文件库：缺文件夹树、文件与连接 / catalog / schema 的绑定、批量文件导入、全文搜索与行匹配、排序 / 拖放整理等。保留现有宿主面板，不另造外壳 | 部分实现 |
| UI-12 | 数据作业与恢复 | 每个窗口显示当前进度 / 回执，关闭保护登记在内存 | 缺统一可保存的导入 / 导出 / 迁移配置与历史作业视图；进程重启 / 断网后的回执恢复不能靠保留一个 modal 实现。DBX 的配置库不自动等同于完整在途恢复 | 部分实现 / 既定可靠性目标 |
| UI-13 | 专用数据库工作区 | Mongo / ES 主要走通用命令编辑器和只读结果；Redis 有 keyspace 摘要、基础编辑表单；DuckDB 可连接文件并执行 SQL | 缺完整文档浏览编辑、专用索引 / 查询分析、Redis 键树与拖选 / Stream、大 key 分段编辑，以及 DuckDB 文件资源工作流 | 部分实现，差距较大 |
| UI-14 | 工作区偏好与恢复 | 切页签保留挂载、当前草稿保护、内存中的树宽和分栏 | 缺重启后的查询 / 草稿 / 布局恢复、更多数据库专属偏好；命令面板只过滤已传入命令，不等于跨库内容检索。已有跨 namespace 对象搜索不要误列缺失 | 部分实现 |

### 本轮最新 6 commits 的处理

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

- 当前 `SqlDiagnosticCode` 主要是未闭合结构、未知表、未检查 / 跳过，没有形成未知列 / 列歧义 / 类型推断的完整诊断。
- 已有查询块补全不能代替完整 INSERT 列列表、UPDATE SET / DDL 类型上下文、复杂 TVF / 前向 CTE 输出推导、动态厂商函数重载。
- `formatSql()` 当前固定 keywordCase=upper，函数接口无用户格式设置。最新上游的类型上下文 / 函数示例 / 关键字替换 / 格式设置需逐项对照。
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

- **SQL 文件执行**已有有界解码 / 预检 spool / 指纹 / 取消；**表数据文件导入**本地路径在执行时重读，不能把 SQL 文件的指纹保护套称为所有导入已有。
- Web 当前仍有 8 MiB 上传边界；更大文件分块、其他编码、更多工作表、各驱动取消效果和掉线 / 重启后的结果核验待补。
- 迁移配置库、当前运行进度、持久运行回执、可安全恢复是四件事，不能合称“任务完成”。

### F-05 专用模型

- MongoDB：文档级编辑、Extended JSON / ObjectId / Date / 长数字 / 嵌套结构与标识保真，不能套 SQL 行编辑器。
- Redis：键目录、范围 / 拖拽选择、批量确认、Stream / 消费组、有界大 key 浏览与字段编辑；当前已有基础键编辑操作，不是空白，但未达到专用工作区。
- Elasticsearch：文档 / 索引管理、结构化查询和 profile、routing / seq_no / primary_term 等并发语义。
- DuckDB：Parquet / CSV / JSON 文件资源的打开 / 挂载 / 查询 / 输出流程；能手写 read_parquet SQL 不等于有文件工作区。

### F-06 AI 辅助闭环

已有目标上下文、审批入口和历史真实模型样例，不应列作“没有 AI”。仍需计划对象 / 影响预览、DDL 依赖、权限与目标重验、执行回执进入后续推理、结果读回及未知结果核验。自主维护 / 流中断恢复是原增强目标，**本轮没有证明 DBX 已全面实现它们，也不能拿来反推 Catio 的完成率**。

## 5. 应优先复现的可靠性风险（本轮没有执行写入复现）

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
