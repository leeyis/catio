# Mongo/ES 查询补全 + `.pretty()` 兼容 + Agent 注入数据库类型 — 设计文档

日期:2026-06-10
状态:已批准

## 背景

上一轮交付的 Mongo/ES 查询控制台收到三条测试反馈:

1. Mongo 查询编辑器是 plain 模式,完全没有智能代码提示;
2. `db.users.find({}).pretty()` 报错 ``Unsupported chained method `.pretty()` ``;
3. Agent 面板 SQL 模式下 AI 不知道当前数据库类型——`App.tsx` 的
   `sendAgentMessage` 中 system prompt 永远是 "terminal/shell assistant",
   数据库 tab 下既没切换角色也没注入任何连接信息(面板副标题"读取 xx
   schema"名不副实)。

参考项目:dbx(t8y2/dbx,CLAUDE.md 规定数据库需求优先照搬)。调研结论:

- dbx 用 CodeMirror 6 `autocompletion({ override })`;Mongo 补全是 13 项
  静态方法/snippet 候选(带 `apply` 模板),fuzzy 前缀打分,**不补集合名、
  不补 `$` 操作符**;SQL 关键字对 Mongo 显式屏蔽。
- dbx 的 ES 补全(`elasticsearchCompletion.ts`)按光标位置分三模式:
  行首补 REST 动词;路径段补**真实索引名**(动态拉取)+ 静态 endpoint;
  body 内补 Query DSL 关键字 + snippet。`SELECT`/`WITH` 开头的行走 SQL
  补全双轨。
- dbx 的 mongo shell 解析对 find() 后的未知链式方法**静默忽略**
  (pretty 为 no-op)。

## 用户决策

- 补全范围:dbx 静态方法列表为基底 + **集合名补全**(catio 已有 schema
  数据,顺手增强);
- **ES 一起做**(照搬 dbx 三模式);
- `.pretty()`:**只忽略无害方法**(`.pretty()`/`.toArray()`),其他未知
  链式方法仍报错——比 dbx 更安全,`.count()` 这类有语义的调用不静默吞;
- Agent 上下文:**只注入数据库类型**(engine + 连接名),不拉 schema 表名。

## A. Mongo/ES 查询控制台智能补全

### `src/components/dbviews/mongoCompletion.ts`(新文件)

导出 CompletionSource 工厂 `mongoCompletion(getCollections: () => CollectionEntry[])`,
集合名经 getter 惰性读取(SqlConsole 用 ref 持有最新 schema,避免每次
schema 变化重建编辑器扩展)。

候选按光标前文(当前行)轻量正则分三种上下文:

1. **集合名**:前文匹配 `/(^|[^\w.])db\.(\w*)$/` → 补真实集合名
   (来自 getSchema 的全部 database 集合并集,detail 标注所属库),
   含点/特殊字符的集合名 apply 为 `getCollection("name")` 形式;
2. **方法**:前文匹配 `db.<coll>.` 尾段或 `)` 后的 `.` 链 → 补方法候选,
   **对齐 catio 后端实际支持的命令集**(不照抄 dbx 的 `findOne`/`distinct`,
   后端不支持,补出来就是引导用户报错):
   - 集合方法:`find`、`countDocuments`、`count`、`aggregate`、`getIndexes`、
     `insertOne`、`insertMany`、`updateOne`、`updateMany`、`deleteOne`、
     `deleteMany`,带 dbx 式 apply 模板(`find({})`、
     `updateOne({}, { $set: {} })`、`aggregate([])` 等);
   - 链式方法(`)` 后):`sort({ field: 1 })`、`skip(0)`、`limit(100)`;
3. **snippet + 方法**(其余位置):`db.collection.find({})`、
   `db.collection.aggregate([])` snippet + 全部方法候选。

打分照 dbx:精确 > 前缀 > 子串(fuzzy),snippet boost 低于方法。

### `src/components/dbviews/esCompletion.ts`(新文件)

照搬 dbx 三模式,`esCompletion(getIndices: () => string[])`:

1. **method 模式**(行首单词):`GET/POST/PUT/DELETE`,apply 带 `"GET /"`;
2. **path 模式**(method 后的路径段):第一段补真实索引名(getSchema)+
   ROOT endpoint(`/_search`、`/_cat/indices`、`/_cluster/health`、
   `/_aliases`、`/_count`);索引后段补 INDEX endpoint(`_search`(带
   match_all body 模板)、`_mapping`、`_settings`、`_count`、`_doc`、
   `_refresh`);
3. **json 模式**(body 内):Query DSL 关键字(`query/bool/must/should/
   must_not/filter/match/match_all/term/terms/range/exists/sort/aggs/
   aggregations/size/from/_source/track_total_hits`)+ snippet
   (`match_all`、`bool`、`range`、`terms`)。

`SELECT`/`WITH` 开头的行不出 ES 候选(该行走 SQL 语义,但 plain 模式无
SQL 补全,直接返回 null 即可)。

### 接线

- **SqlEditor**:`autocompletion()` 从基础 extensions 移入现有 sql
  compartment——非 plain 维持 `[sql(...), autocompletion()]`,plain 时
  `[autocompletion({ override: [source] })]`(source 为空时仅
  `autocompletion()` 等价无源,不弹窗)。新 prop
  `completion?: CompletionSource`。
- **SqlConsole**:plain 模式也调一次 `getSchema(connId)`(只取表名,
  不调 schemaColumns),存 ref;按 engine 构造 mongo/es source 传给
  SqlEditor。schema 拉取失败 → 候选退化为纯静态列表,不报错。
- 候选 detail 文案走 i18n(zh/en 各加一组 `dbviews.cmpl*` key)。

## B. `.pretty()` 兼容(Rust)

`src-tauri/src/db/drivers/mongo_shell.rs` 的 `parse_find_chain`:
match 分支增加 `"pretty" | "toArray" => {}`(纯展示性 no-op,静默忽略;
括号内参数不解析直接丢弃),其他未知链式方法维持现有报错,错误文案更新为
`only .sort() / .skip() / .limit() / .pretty() may follow find()`。
TDD:先加失败测试(`find({}).pretty()`、`find().sort().pretty().limit()`、
`find().toArray()`、未知方法 `.count()` 仍报错)再实现。

## C. Agent 面板注入数据库类型

`App.tsx` `sendAgentMessage`:抽纯函数
`buildAgentSystemPrompt(mode: 'sql' | 'shell', hostName: string, engine?: string): string`
(放 `src/services/agentPrompt.ts`,便于单测):

- `shell` → 维持现有 "terminal/shell assistant for host …" 文案;
- `sql` → 数据库助手角色:注入连接名与 engine,指示 AI 用该引擎的实际
  查询语法回答(mongodb → mongo shell 语法、elasticsearch → REST/Query
  DSL,关系库 → 对应 SQL 方言),建议代码放 fenced code block。

`sendAgentMessage` 按 `tab.kind === 'db'` 选 mode;sysinfo/termBuffer
块仅 shell 模式拼接(数据库 tab 无 liveSessionId,现状已天然跳过,保持)。

## 测试与验证

- Rust:`cargo test --lib`(新增 pretty/toArray/未知链仍报错用例);
- 前端:mongoCompletion/esCompletion 纯函数单测(给定 doc+光标断言
  候选内容与上下文分流)、`buildAgentSystemPrompt` 单测、`tsc` 零错、
  既有测试回归全绿;
- 手工:Mongo 控制台输入 `db.` 弹集合名、`db.users.` 弹方法、
  `find({}).pretty()` 正常出结果;ES 控制台行首/路径/body 三模式;
  Agent 面板 SQL 模式问"我的数据库是什么类型"能直接答对。

## 错误处理

- schema 拉取失败:补全静默退化为静态候选;
- plain 模式 source 为 null(未知引擎):不弹补全;
- `.pretty()` 带参数(如 `.pretty(true)`):参数直接丢弃,行为同无参。
