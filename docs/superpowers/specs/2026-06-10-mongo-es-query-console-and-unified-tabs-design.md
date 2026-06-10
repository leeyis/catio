# Mongo/ES 查询控制台 + 工作台统一 Tab 系统 — 设计文档

日期:2026-06-10
状态:已批准
来源:测试反馈两条 —— ① MongoDB 等非结构化引擎"新建查询/刷新"无效;② 数据/结构预览与查询控制台界面互相覆盖,函数/存储过程预览无法与 SQL 编辑器共存。

参考项目:[dbx](https://github.com/t8y2/dbx)(CLAUDE.md 规定数据库需求优先参考)。两份调研结论:dbx 的 Mongo 控制台使用 mongo shell 语法(前端解析 + 结构化命令);ES 控制台前端零解析、后端 `execute_rest_query` 按前缀多语法分流;tab 系统是统一 `QueryTab.mode` + `findTabByIdentity` 身份复用。

## 问题定位

1. **新建查询无效**:`capabilities.rs` 中 Mongodb/Elasticsearch 为 `sql_console: false`,前端 `DbWorkbench.newQuery()` 首行 `if (!caps.sqlConsole) return` 静默返回。后端 `mongo.rs::query()` / `elasticsearch.rs::query()` 目前只把输入当作集合/索引名做全量拉取,没有真正的查询语法。
2. **刷新"点了完全没反应"**:`refreshSchema → getSchema → db_schema` 链路实际可用,但无任何 loading/成功/失败反馈(`catch(() => {})` 吞错),用户无法感知。
3. **界面覆盖**:`DbWorkbench` 的 `obj` 是互斥单选状态(table/object/sql/er),表预览、对象预览只有一个"槽位";SQL 查询已有自己的 tab strip 且保持 mounted,但表/对象不在这套体系内,切换即覆盖。

## 设计

### 1. Mongo 查询控制台(语法照 dbx,解析在 Rust)

catio 是统一 `db_query(sql)` → `Driver::query()` 架构,与 dbx 的 per-engine 命令层不同。因此**语法行为完全照 dbx,解析位置放在 `src-tauri/src/db/drivers/mongo.rs` 的 `query()`**,前端 SqlConsole 零改动,查询历史/loading/结果网格天然继承。

支持的命令(读写全套):

```js
db.users.find({age: {$gt: 18}}).sort({name: 1}).skip(0).limit(100)
db.getCollection("users").find(...)        // 两种集合写法都支持
db.users.countDocuments({...})
db.users.aggregate([{...}, ...])
db.users.getIndexes()
db.users.insertOne({...}) / insertMany([...])
db.users.updateOne({filter}, {update}) / updateMany(...)
db.users.deleteOne({filter}) / deleteMany(...)
```

解析要点(照搬 dbx `mongoShellCommand.ts` 的逻辑,Rust 实现):

- 手写解析器:`db.` 前缀 → 集合名(`.coll` 或 `getCollection("coll")`)→ 方法名 → 配对括号取参数 → 链式 `.sort()/.skip()/.limit()`(仅 find 后)。
- 宽松 JSON 归一化:单引号字符串 → 双引号;未加引号的 key 补引号;`ObjectId("...")` → 扩展 JSON `{"$oid":"..."}`。归一化后用 `serde_json` 解析。
- JSON → BSON:识别 `{"$oid":...}` 转 `Bson::ObjectId`;`_id` 字段值为 24 位 hex 字符串时同时生成 ObjectId 与 String 双变体,`$eq`→`$in`、`$ne`→`$nin` 展开匹配(dbx 的 `_id` 类型痛点解法)。
- 解析失败 → 返回带语法示例的 `DbError::QueryFailed`,不静默。
- 结果:文档数组经现有 `docs_to_result` 拍平(列 = key 并集,`_id` 在前);写命令返回 `rows_affected`;`getIndexes` 拍平为表格。
- 默认 database 取连接配置(现有 `self.default_db`)。

### 2. ES 查询控制台(照 dbx 后端多语法分流)

`src-tauri/src/db/drivers/elasticsearch.rs` 的 `query()` 改为多语法入口,按前缀分流:

1. `GET/POST/PUT/DELETE /path` + 换行后 JSON body → REST 直发(主力语法);
2. 简单 `SELECT * FROM idx [LIMIT n]` → 直转 `POST /{idx}/_search`;
3. 其他 `SELECT ...` → 转发 ES 原生 `POST /_sql {"query": ...}`;
4. dbx 的 sqlparser SQL→DSL 翻译器(344 行)第一期不做(YAGNI)。

结果拍平四级 fallback(照 dbx `parse_elasticsearch_response`):

1. `_sql` 响应(`columns`+`rows`)→ 直接映射;
2. `hits.hits` → `_id` + `_source` 顶层 key 并集为列,嵌套对象/数组字符串化,不递归展开;
3. 聚合响应(`aggregations`)→ buckets 每桶一行,metric 聚合一行多列;
4. 其他任意 JSON(`_cat`、`_cluster/health`、写操作回执)→ `status | response` 两列,response pretty-printed。

### 3. capabilities 与刷新反馈

- `capabilities.rs`:`Elasticsearch | Mongodb` 分支 `sql_console: true`(Redis 仍为 false)。
- 刷新反馈(所有引擎统一受益):`DbWorkbench.refreshSchema` 增加 loading 状态,传入 SchemaBrowser 让刷新按钮转圈(`refresh-cw` + spin);失败时显示错误提示(不再吞错);成功后树重渲染。
- SQL 编辑器:对 mongo/es 引擎关闭 SQL 相关补全语义,空编辑器 placeholder 提示对应语法(mongo:`db.collection.find({...})`;es:`GET /index/_search`)。完整的 mongo/ES 专属自动补全(dbx 的 `MONGO_COMPLETIONS` / `elasticsearchCompletion.ts`)作为后续优化,不在本期。

### 4. 统一 Tab 系统(照 dbx mode + 身份复用)

`DbWorkbench` 的互斥 `obj` 状态改为 tab 列表:

```ts
type TabItem =
  | { id: string; kind: 'table';  schema: string; table: string }
  | { id: string; kind: 'object'; schema: string; name: string; objKind: 'view' | 'function' | 'procedure' }
  | { id: string; kind: 'sql';    qid: number }
  | { id: string; kind: 'er';     schema: string }
// state: tabs: TabItem[]; activeId: string | null
```

- **身份复用**:单击侧边栏表/视图/函数/ER → 按 (kind + 身份字段) 查找已开 tab,存在则激活,否则追加新 tab 并激活(dbx `findTabByIdentity` 策略)。新建查询永远追加新 tab。
- **统一 tab strip**:现有查询 tab strip 扩展承载全部类型,图标区分(table-2 / eye / function-square / file-code / network),保留左右滚动 chevron 与 "+" 新建查询按钮;tab 可关闭,关闭当前 tab 激活相邻 tab(优先右侧,无则左侧);全部关闭后显示空状态(引导从侧边栏选表)。
- **组件下沉**:表预览(header + DataGrid/StructureView + 数据 fetch + data/structure 子切换 + PK/ctid 逻辑)从 DbWorkbench 顶层抽成 `TablePane` 组件;对象源码预览抽成 `ObjectPane`。每个 pane 自管 fetch 与状态。
- **保持 mounted**:所有 tab 的 pane 与现有 SQL console 同款机制 —— mounted + display 切换,切回时数据/滚动位置/编辑器内容原样保留。
- 现有行为保留:`queryInitialCode` 种子(新建表/视图模板)、`catio-insert`/`catio-run` 事件仅 active SQL tab 消费、关闭查询 tab 的回退逻辑并入统一关闭逻辑。
- 不做(YAGNI):open tabs 持久化 localStorage、tab 拖拽排序、固定 tab、VS Code 式 preview tab。

### 5. i18n 与主题

新增文案(空状态、语法 placeholder、刷新失败提示等)同步 `zh.json` / `en.json`;tab strip 样式全部使用现有 CSS 变量,主题切换自动适配。

## 测试与验证标准

- **Rust 单测**:mongo shell 解析器(find 链式/getCollection/宽松 JSON/ObjectId 归一化/`_id` 双变体/各写命令/非法输入报错);ES 分流(REST 解析/SELECT * 转 _search/_sql 转发判定)与四级拍平。`cargo test` 全绿。
- **前端测试**:DbWorkbench tab 行为(身份复用、关闭回退、表→查询→切回状态保留)更新/新增到 `DbWorkbench.test.tsx`。
- **手工验收**:
  - Mongo:新建查询可打开;`find/aggregate/countDocuments/insertOne/updateMany/deleteOne` 各跑通;刷新按钮转圈且失败可见。
  - ES:`GET /index/_search` + body、`SELECT * FROM idx`、`GET /_cat/indices` 返回可读结果。
  - Tab:表预览 → 新建查询 → 切回表预览数据仍在;函数源码 tab 与查询 tab 并存;再次单击同一表激活原 tab 不新开。
