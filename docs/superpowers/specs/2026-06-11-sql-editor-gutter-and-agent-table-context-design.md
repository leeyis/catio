# SQL 编辑器行号/状态栏 + Agent @ 选表注入 DDL 上下文 — 设计文档

日期:2026-06-11
状态:待 review

## 背景

两条新需求:

1. **美化 SQL 代码编辑框**:当前 `SqlEditor.tsx`(CodeMirror 6)刻意隐藏了
   行号 gutter(`.cm-gutters { display: none }`),且没有任何统计/状态信息,
   编辑体验偏裸。需要加行号 + 底部状态栏。
2. **Agent 面板 @ 选表提问**:SQL 模式下,Agent 输入框支持输入 `@` 触发表名
   下拉,选中一个或多个表;发送时把所选表的 DDL/结构信息作为上下文一并传给
   LLM,让 AI 基于真实表结构回答。

参考项目:数据库相关需求优先照搬 dbx(t8y2/dbx)。

## 关键事实(决定方案)

`tableStructure(connId, schema, table)`(`src/services/db.ts:244`)**已经对所有
引擎做了统一抽象**,后端按引擎各自完成最重的活并归一成同一个
`{ columns, indexes, fks, comment }` 结构:

- 关系库(pg/mysql/sqlite/sqlserver…)→ 真实列/索引/外键元数据;
- **MongoDB**(`src-tauri/src/db/drivers/mongo.rs:385`)→ 采样最多 50 篇文档
  推断字段顺序与类型,`_id` 为主键,索引来自 getIndexes;
- **Elasticsearch**(`src-tauri/src/db/drivers/elasticsearch.rs:218`)→ 读
  `/{index}/_mapping`,字段 + 映射类型,`_id` 恒在。

因此 DDL 上下文**无需新增后端**:后端已归一,前端只需把统一结构按引擎渲染成
上下文文本即可。新增后端「整表 DDL」命令反而要为每引擎写一套字符串格式化,且
mongo/es 本无 DDL 概念,属重复且不必要的工作。结论与「简单优先 / 外科手术式
改动」一致。

## 用户决策

- 状态栏统计项:**行数 / 字符数 / 光标位置(行:列)**(不含选区统计、不含
  方言标识);
- DDL 来源:**前端用 `tableStructure()` 统一结构按引擎渲染**(覆盖关系库 +
  mongo/es);
- @ 列表范围:**当前连接所有 schema 的表 + 视图**(mongo/es 下即集合/索引);
- 上下文作用域:**仅本次提问一次性**(发送后清空,类比现有 attachment)。

---

## A. SQL 编辑器:行号 + 状态栏

### A1. 行号 gutter(`src/components/dbviews/SqlEditor.tsx`)

- 基础 extensions 增加 `lineNumbers()`(来自 `@codemirror/view`);可选
  `highlightActiveLineGutter()` 增强当前行可读性。
- `catioTheme` 中删除 `.cm-gutters { display: none }`,改为按主题色 token 上色:
  - `.cm-gutters`:`background: transparent`、`border: none`、
    `color: var(--text-faint)`;
  - `.cm-lineNumbers .cm-gutterElement`:`padding: 0 8px`、`fontSize: 12px`、
    右对齐;
  - `.cm-activeLineGutter`:`background: transparent`、
    `color: var(--text-secondary)`(高亮当前行号但不抢眼)。
- 字号/字体沿用现有 `'Geist Mono'`,与正文 13px/1.6 行高对齐,避免行号与代码
  行错位。

### A2. 底部状态栏

- `SqlEditor` 根容器由「单块编辑宿主」改为 **column 布局**:编辑器宿主
  `flex: 1, minHeight: 0`;状态栏为固定高度(约 24px)的 footer。`minHeight`
  prop 语义不变(作用于整体根容器)。
- 统计数据来源:在已有的 `EditorView.updateListener` 内,除现有逻辑外,读取并
  存入 React state:
  - 行数 = `state.doc.lines`;
  - 字符数 = `state.doc.length`;
  - 光标行列 = 由 `state.selection.main.head` 经 `state.doc.lineAt(head)`
    求 `line.number` 与 `head - line.from + 1`(列从 1 起)。
  - 监听条件:`docChanged || selectionSet` 时更新(光标移动也要刷新行列)。
- 渲染:footer 一行,右对齐,样式走主题色(`--text-faint`/`--surface-subtle`
  顶边),文案走 i18n,例如 `行 3,列 12 · 28 行 · 540 字符`。
- **作用范围**:行号 + 状态栏对**所有引擎**生效(含 plain 模式的 mongo/es
  控制台),因为这三项统计与引擎无关。selection toolbar 等既有逻辑不动。

### A3. 测试

- `SqlEditor` 既有渲染/插入测试回归;
- 新增轻量断言:挂载后状态栏出现,初始 doc 的行数/字符数正确(可借
  组件测试或对纯计算函数抽取后单测——若行列计算抽成纯函数 `cursorStats(state)`
  则优先纯函数单测)。

---

## B. Agent 面板:@ 选表注入 DDL 上下文

### B1. 上下文渲染纯函数(`src/components/dbviews/tableContext.ts`,新文件)

导出 `buildTableContext(engine: string | undefined, schema: string, table: string,
struct: TableStructure): string`,按引擎族渲染:

- **关系库**(默认):`CREATE TABLE`,复用 `structureDdl.ts` 的 `dialectFor` /
  `quoteIdent` / `qualifiedTable`:
  ```sql
  CREATE TABLE "schema"."t" (
    "id" bigint NOT NULL,
    "name" varchar(255),
    ...,
    PRIMARY KEY ("id")
  );
  -- INDEX idx_name (cols) [UNIQUE]
  -- FOREIGN KEY (col) REFERENCES ref
  ```
  列的 NOT NULL / DEFAULT 由 `ColumnDef.nullable` / `default` 决定;主键来自
  `key === 'PK'` 列聚合;索引、外键以注释行附在末尾(避免方言差异导致的
  可执行性问题——这是**上下文文本**,不要求可直接执行)。
- **MongoDB**(engine 含 `mongo`):
  ```
  // MongoDB collection "t" (schema inferred from sampled documents)
  // fields:
  //   _id: objectId (primary key)
  //   name: string
  //   ...
  // indexes: idx_name (cols) [unique]
  ```
- **Elasticsearch**(engine 含 `elastic`/`es`):
  ```
  // Elasticsearch index "t" mapping
  // fields:
  //   _id: keyword
  //   name: text
  //   ...
  ```
- engine 判定复用/对齐现有 `dialectFor` 与项目既有 engine 归类习惯;无法识别的
  引擎走关系库 `CREATE TABLE` 兜底。
- 纯函数,输入 `(engine, schema, table, struct)` → 字符串,**易单测**。

### B2. AIPanel 接线(`src/components/panels/AIPanel.tsx`)

新增 props:

- `connId?: string` —— 调 `getSchema` / `tableStructure` 所需;
- `engine?: string` —— 决定 @ 列表文案(表/集合/索引)与 B1 渲染方式。

仅 **SQL 模式**(`isSql`)启用 @ 选表;shell 模式完全不变。

**@ 触发与下拉**:

- 在 composer 的 textarea `onChange` 中检测光标前文是否匹配
  `/(^|\s)@(\S*)$/`,命中则打开下拉并以捕获的 `\S*` 作为过滤词;否则关闭。
- 下拉数据:挂载/connId 变化时 `getSchema(connId)` 拉一次,展开成
  `{ schema, name, kind: 'table'|'view' }[]`,按 schema 分组、按过滤词
  (大小写不敏感子串)过滤。拉取失败 → 下拉显示空态,不报错。
- 下拉锚定在 composer **上方**(不做跟随光标的行内浮层,规避 textarea 光标
  定位的复杂度);支持鼠标点选(键盘上下/回车选择为可选增强,先做鼠标)。

**选中与 chips**:

- 选中一项 → 加入本地 `selectedTables: { schema, table, kind }[]`(去重),并把
  draft 里那段 `@token` 抹除;可继续 `@` 选多张。
- 已选表在 composer 上方渲染为可移除 chip(复用现有 attachment 视觉:
  `--accent-soft-alt` 背景 + `x` 移除按钮),文案随 engine 切换
  (表/集合/索引)。

**发送时注入**:

- `send()` 中,在拼 `userContent` 时:对每个 `selectedTables` 调
  `tableStructure(connId, schema, table)` → `buildTableContext(...)`,把各块以
  `\n\n---\n` 分隔追加到消息末尾(与现有 attachment 拼接同形)。
- 调用 `tableStructure` 是异步:`send()` 改为 `async`,发送期间可禁用发送按钮;
  单表结构拉取失败 → 跳过该表并继续(best-effort),不阻断发送。
- 发送后 `setSelectedTables([])`(**一次性**),与现有 `onClearAttachment()`
  行为并列。

### B3. App.tsx 接线

`activePanel === 'ai'` 处的 `<AIPanel .../>`(`src/App.tsx:1079`)补两个 prop:

- `connId={cur?.connId}`;
- `engine={curConn?.engine}`。

`sendAgentMessage` 不改——DDL 上下文已在 AIPanel 内拼进 `text`,沿用现有的
「user 消息追加」通道(system prompt 仍只注入引擎类型,与
2026-06-10 设计一致)。

### B4. 测试

- `buildTableContext` 纯函数单测:给定关系库/mongo/es 的 `TableStructure`,
  断言渲染文本含预期字段/主键/索引、引擎分支正确、未知引擎兜底 CREATE TABLE;
- `AIPanel` 组件测试(`AIPanel.test.tsx` 既有):
  - SQL 模式输入 `@` 弹下拉、过滤生效;选中加 chip 并抹 token;移除 chip;
  - 发送时 `tableStructure` 被调用、消息含上下文、发送后 chip 清空;
  - shell 模式无 @ 行为(回归)。
  - `getSchema`/`tableStructure` 以 mock 注入(非 Tauri 环境本就走 mock)。

---

## i18n 与主题

- 新增文案(`src/i18n/zh.json`/`en.json`)同步双语:
  - `dbviews.editorStats`(行/列/行数/字符数模板,如
    `行 {{line}},列 {{col}} · {{lines}} 行 · {{chars}} 字符`);
  - `panels.mentionTablePlaceholder` / `panels.mentionNoTables` /
    `panels.selectedTables`(chip 区标题,按 engine 复数:表/集合/索引)等。
- 所有新增 UI 仅用主题色 CSS 变量,不写死颜色,保证主题切换正常。

## 验证

- `tsc` 零错;
- 前端:`buildTableContext` / `cursorStats`(如抽取)纯函数单测 + `AIPanel`、
  `SqlEditor` 组件测试,既有测试全绿;
- 手工:
  - SQL/mongo/es 控制台均显示行号与底部状态栏,光标移动行列实时更新;
  - Agent SQL 模式 `@` 弹表名、可多选成 chip、发送后 AI 能引用真实表结构作答;
  - mongo 连接下 @ 列集合、ES 下列索引,注入文本为对应字段/映射结构;
  - shell 模式 Agent 无 @ 行为。

## 错误处理

- `getSchema` 失败 → @ 下拉空态,不报错;
- 单表 `tableStructure` 失败 → 跳过该表,其余照常注入;
- 未识别引擎 → DDL 渲染兜底 `CREATE TABLE`;
- 空集合/空 mapping(mongo/es 无字段)→ 渲染表名 + 「无可推断字段」提示行,
  不产生空 DDL。

## 范围外(YAGNI)

- 不做整表 DDL 的后端命令;
- 不做 @ 选列、@ 选 schema/函数;
- 不做上下文跨会话持续(仅本次一次性);
- 状态栏不做选区统计、不做方言标识(用户已排除)。
