# Mongo/ES 查询补全 + `.pretty()` 兼容 + Agent 注入数据库类型 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mongo/ES 查询控制台获得智能补全(方法/集合名/REST 三模式),mongo shell 容忍 `.pretty()`/`.toArray()`,Agent 面板 SQL 模式注入数据库类型。

**Architecture:** 补全为两个纯函数 CompletionSource 模块(照 dbx 形式,候选对齐 catio 后端能力),经 SqlEditor 新 `completion` prop 挂入现有 compartment;`.pretty()` 在 Rust `parse_find_chain` 显式忽略;Agent prompt 抽纯函数 `buildAgentSystemPrompt`。

**Tech Stack:** Rust (mongo_shell.rs)、CodeMirror 6 `@codemirror/autocomplete`、React/TS、vitest、i18next。

**设计文档:** `docs/superpowers/specs/2026-06-10-mongo-es-completion-pretty-agent-context-design.md`

**环境注意:** 全量 `cargo test` 必须 `-j 2`(Windows 页面文件不足会崩),日常验证用 `cargo test --lib`。工作区预存在的 `src-tauri/Cargo.toml` 行尾差异与未跟踪日志文件(`.nezha/`、`*.log`)不要提交。前端测试 `npx vitest run`,类型检查 `npx tsc --noEmit`。

---

### Task 1: Rust — `parse_find_chain` 忽略 `.pretty()` / `.toArray()`

**Files:**
- Modify: `src-tauri/src/db/drivers/mongo_shell.rs`(`parse_find_chain` 在 ~L124-145;测试 mod 在文件尾)

- [ ] **Step 1: 写失败测试**(加到 `mod tests` 内,先看一眼现有测试避免重名):

```rust
#[test]
fn find_chain_ignores_pretty_and_to_array() {
    // pretty 是纯展示性方法 → no-op,不影响解析结果
    let cmd = parse(r#"db.users.find({}).pretty()"#).unwrap();
    match cmd {
        MongoCommand::Find { collection, sort, skip, limit, .. } => {
            assert_eq!(collection, "users");
            assert!(sort.is_none() && skip.is_none() && limit.is_none());
        }
        other => panic!("expected Find, got {other:?}"),
    }
    // 链中间夹 pretty 不影响前后链式方法
    let cmd = parse(r#"db.users.find().sort({a: 1}).pretty().limit(5)"#).unwrap();
    match cmd {
        MongoCommand::Find { sort, limit, .. } => {
            assert!(sort.is_some());
            assert_eq!(limit, Some(5));
        }
        other => panic!("expected Find, got {other:?}"),
    }
    // toArray 同样忽略;带参数的 pretty(true) 参数直接丢弃
    parse(r#"db.users.find().toArray()"#).unwrap();
    parse(r#"db.users.find().pretty(true)"#).unwrap();
}

#[test]
fn find_chain_still_rejects_semantic_methods() {
    // .count() 有语义(期望计数),静默忽略会误导 → 必须仍报错
    let err = parse(r#"db.users.find().count()"#).unwrap_err();
    assert!(err.contains("count"), "error should name the method: {err}");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib find_chain_ignores -- --nocapture`(在 `src-tauri/` 下)
Expected: FAIL —— 现实现对 `.pretty()` 返回 `Unsupported chained method` 错误。

- [ ] **Step 3: 最小实现** —— `parse_find_chain` 的 match 加一个忽略分支,并更新错误文案:

```rust
match name {
    "sort" => sort = Some(normalize_loose_json(&arg)?),
    "skip" => skip = Some(arg.trim().parse::<u64>().map_err(|_| hint())?),
    "limit" => limit = Some(arg.trim().parse::<i64>().map_err(|_| hint())?),
    // 纯展示性方法(mongosh 里只影响输出格式)→ no-op,参数直接丢弃。
    // 注意:.count() 这类有语义的方法不能进这里——静默吞掉会返回错误类型的结果。
    "pretty" | "toArray" => {}
    _ => return Err(format!(
        "Unsupported chained method `.{name}()` — only .sort() / .skip() / .limit() / .pretty() may follow find()"
    )),
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib mongo_shell`
Expected: 全部 PASS(现有 24 个 + 新增 2 个)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/drivers/mongo_shell.rs
git commit -m "fix(mongo): find() 链式忽略纯展示性 .pretty()/.toArray(),语义方法仍报错"
```

---

### Task 2: 前端 — `mongoCompletion.ts`(方法/集合名/snippet 三上下文)

**Files:**
- Create: `src/components/dbviews/mongoCompletion.ts`
- Create: `src/components/dbviews/mongoCompletion.test.ts`
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`(`dbviews` 节)

**上下文:** plain 模式查询控制台的补全 source。照 dbx 的静态候选形式(label + apply 模板 + detail),但候选对齐 catio 后端 `mongo_shell.rs` 实际支持的命令(**没有** `findOne`/`distinct`——后端不支持,补出来就是引导用户报错),并额外支持真实集合名(经 getter 惰性读取,调用方用 ref 持有最新 schema)。过滤/排序交给 CodeMirror autocomplete 自带的 fuzzy 匹配,source 只负责按光标上下文返回候选集。

- [ ] **Step 1: 先加 i18n key**(两个文件的 `dbviews` 节内,放现有 key 后面):

`src/i18n/zh.json`:
```json
"cmplFind": "查询文档",
"cmplCountDocuments": "统计匹配文档数",
"cmplCount": "统计(旧式别名)",
"cmplAggregate": "聚合管道",
"cmplGetIndexes": "列出索引",
"cmplInsertOne": "插入单条文档",
"cmplInsertMany": "批量插入文档",
"cmplUpdateOne": "更新单条文档",
"cmplUpdateMany": "批量更新文档",
"cmplDeleteOne": "删除单条文档",
"cmplDeleteMany": "批量删除文档",
"cmplSort": "结果排序",
"cmplSkip": "跳过条数",
"cmplLimit": "限制条数",
"cmplSnippet": "模板",
```

`src/i18n/en.json`:
```json
"cmplFind": "Query documents",
"cmplCountDocuments": "Count matching documents",
"cmplCount": "Count (legacy alias)",
"cmplAggregate": "Aggregation pipeline",
"cmplGetIndexes": "List indexes",
"cmplInsertOne": "Insert one document",
"cmplInsertMany": "Insert many documents",
"cmplUpdateOne": "Update one document",
"cmplUpdateMany": "Update many documents",
"cmplDeleteOne": "Delete one document",
"cmplDeleteMany": "Delete many documents",
"cmplSort": "Sort cursor",
"cmplSkip": "Skip documents",
"cmplLimit": "Limit documents",
"cmplSnippet": "Snippet",
```

- [ ] **Step 2: 写失败测试** `src/components/dbviews/mongoCompletion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import '../../i18n'
import { mongoCompletion } from './mongoCompletion'

const COLLS = [
  { name: 'users', db: 'fastgpt' },
  { name: 'system.keys', db: 'admin' },
]

/** 在 doc 末尾位置构造一个(非显式触发的)补全上下文并调用 source。 */
function complete(doc: string, colls = COLLS, explicit = false) {
  const state = EditorState.create({ doc })
  const ctx = new CompletionContext(state, doc.length, explicit)
  return mongoCompletion(() => colls)(ctx)
}
const labels = (r: ReturnType<typeof complete>) => (r ? r.options.map(o => o.label) : [])

describe('mongoCompletion context switching', () => {
  it('completes real collection names after `db.`', () => {
    const r = complete('db.')
    expect(labels(r)).toEqual(['users', 'system.keys'])
    // 含点的集合名 apply 为 getCollection 形式,避免与链式点号歧义
    const special = r!.options.find(o => o.label === 'system.keys')!
    expect(special.apply).toBe('getCollection("system.keys")')
    // detail 标注所属数据库
    expect(r!.options[0].detail).toBe('fastgpt')
  })

  it('completes collection names with a typed prefix (from excludes the prefix)', () => {
    const r = complete('db.us')
    expect(labels(r)).toContain('users')
    expect(r!.from).toBe('db.'.length)
  })

  it('falls back to nothing after `db.` when schema is unavailable', () => {
    expect(complete('db.', [])).toBeNull()
  })

  it('completes collection methods after `db.<coll>.` — catio-supported set only', () => {
    const r = complete('db.users.')
    const ls = labels(r)
    expect(ls).toContain('find')
    expect(ls).toContain('updateMany')
    expect(ls).toContain('getIndexes')
    // 后端不支持的 dbx 候选不能出现
    expect(ls).not.toContain('findOne')
    expect(ls).not.toContain('distinct')
    const find = r!.options.find(o => o.label === 'find')!
    expect(find.apply).toBe('find({})')
  })

  it('completes methods after getCollection("...") too', () => {
    expect(labels(complete('db.getCollection("system.keys").'))).toContain('find')
  })

  it('completes only chain methods after `).`', () => {
    const ls = labels(complete('db.users.find({}).'))
    expect(ls).toEqual(['sort', 'skip', 'limit'])
  })

  it('offers snippets + methods on a bare identifier prefix', () => {
    const ls = labels(complete('fi'))
    expect(ls).toContain('db.collection.find')
    expect(ls).toContain('find')
  })

  it('stays quiet with no prefix and no explicit request', () => {
    expect(complete('')).toBeNull()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/dbviews/mongoCompletion.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现** `src/components/dbviews/mongoCompletion.ts`:

```ts
/* Mongo shell 补全(plain 模式查询控制台)。照 dbx 的静态候选形式
 * (label + apply 模板 + detail),候选对齐 catio 后端 mongo_shell.rs
 * 实际支持的命令集(无 findOne/distinct——后端不支持),并额外补真实
 * 集合名。过滤与排序交给 CodeMirror autocomplete 自带的 fuzzy 匹配。 */
import { CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete'
import i18n from '../../i18n'

/** 集合候选:name 为集合名,db 为所属数据库(detail 展示用)。 */
export interface MongoCollectionEntry { name: string; db: string }

const METHODS: ReadonlyArray<{ label: string; apply: string; key: string }> = [
  { label: 'find', apply: 'find({})', key: 'cmplFind' },
  { label: 'countDocuments', apply: 'countDocuments({})', key: 'cmplCountDocuments' },
  { label: 'count', apply: 'count({})', key: 'cmplCount' },
  { label: 'aggregate', apply: 'aggregate([])', key: 'cmplAggregate' },
  { label: 'getIndexes', apply: 'getIndexes()', key: 'cmplGetIndexes' },
  { label: 'insertOne', apply: 'insertOne({})', key: 'cmplInsertOne' },
  { label: 'insertMany', apply: 'insertMany([{}])', key: 'cmplInsertMany' },
  { label: 'updateOne', apply: 'updateOne({}, { $set: {} })', key: 'cmplUpdateOne' },
  { label: 'updateMany', apply: 'updateMany({}, { $set: {} })', key: 'cmplUpdateMany' },
  { label: 'deleteOne', apply: 'deleteOne({})', key: 'cmplDeleteOne' },
  { label: 'deleteMany', apply: 'deleteMany({})', key: 'cmplDeleteMany' },
]
/** find() 之后的链式方法(与后端 parse_find_chain 支持集一致)。 */
const CHAIN: ReadonlyArray<{ label: string; apply: string; key: string }> = [
  { label: 'sort', apply: 'sort({ field: 1 })', key: 'cmplSort' },
  { label: 'skip', apply: 'skip(0)', key: 'cmplSkip' },
  { label: 'limit', apply: 'limit(100)', key: 'cmplLimit' },
]
const SNIPPETS: ReadonlyArray<{ label: string; apply: string }> = [
  { label: 'db.collection.find', apply: 'db.collection.find({})' },
  { label: 'db.collection.aggregate', apply: 'db.collection.aggregate([])' },
]

const methodOption = (m: { label: string; apply: string; key: string }): Completion =>
  ({ label: m.label, apply: m.apply, type: 'function', detail: i18n.t(`dbviews.${m.key}`) })

/** Mongo 控制台 CompletionSource 工厂。集合名经 getter 惰性读取,
 * 调用方(SqlConsole)用 ref 持有最新 schema,source 本身保持稳定。 */
export function mongoCompletion(getCollections: () => MongoCollectionEntry[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)

    // 1) `db.` 之后 → 真实集合名(detail 标注所属数据库)。
    let m = /(^|[^\w.])db\.(\w*)$/.exec(before)
    if (m) {
      const colls = getCollections()
      if (colls.length === 0) return null
      const options: Completion[] = colls.map(c => ({
        label: c.name,
        type: 'class',
        detail: c.db,
        // 含点等特殊字符的集合名 → getCollection("name"),避免与链式点号歧义。
        apply: /^[A-Za-z_]\w*$/.test(c.name) ? c.name : `getCollection("${c.name}")`,
      }))
      return { from: ctx.pos - m[2].length, options, validFor: /^[\w.$]*$/ }
    }

    // 2) `db.<coll>.` / `db.getCollection("...").` 之后 → 集合方法。
    m = /db\.(?:\w+|getCollection\((?:"[^"]*"|'[^']*')\))\.(\w*)$/.exec(before)
    if (m) {
      return { from: ctx.pos - m[1].length, options: METHODS.map(methodOption), validFor: /^\w*$/ }
    }

    // 3) `)` 之后的 `.` → 链式方法(sort/skip/limit)。
    m = /\)\s*\.(\w*)$/.exec(before)
    if (m) {
      return { from: ctx.pos - m[1].length, options: CHAIN.map(methodOption), validFor: /^\w*$/ }
    }

    // 4) 其余位置:有标识符前缀(或显式 Ctrl+Space)→ snippet + 方法。
    const word = ctx.matchBefore(/[\w.$]+/)
    if (!word && !ctx.explicit) return null
    return {
      from: word ? word.from : ctx.pos,
      options: [
        ...SNIPPETS.map(s => ({
          label: s.label, apply: s.apply, type: 'snippet' as const,
          detail: i18n.t('dbviews.cmplSnippet'), boost: -1,
        })),
        ...METHODS.map(methodOption),
      ],
      validFor: /^[\w.$]*$/,
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/dbviews/mongoCompletion.test.ts`
Expected: 8 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/dbviews/mongoCompletion.ts src/components/dbviews/mongoCompletion.test.ts src/i18n/zh.json src/i18n/en.json
git commit -m "feat(dbviews): mongo 查询控制台补全 source——方法/集合名/snippet 三上下文,候选对齐后端能力"
```

---

### Task 3: 前端 — `esCompletion.ts`(REST 动词 / 路径+索引名 / Query DSL 三模式)

**Files:**
- Create: `src/components/dbviews/esCompletion.ts`
- Create: `src/components/dbviews/esCompletion.test.ts`
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`(`dbviews` 节)

**上下文:** 照搬 dbx `elasticsearchCompletion.ts` 的三模式按光标位置分流。索引名同样经 getter 惰性读取。`SELECT`/`WITH` 开头的行不出 ES 候选(该行后端转发 `_sql`,plain 模式无 SQL 补全,返回 null)。

- [ ] **Step 1: 加 i18n key**(`dbviews` 节;`cmplSnippet` Task 2 已加):

`src/i18n/zh.json`:
```json
"cmplHttpMethod": "HTTP 方法",
"cmplEndpoint": "REST 端点",
"cmplDsl": "Query DSL 关键字",
"cmplEsIndex": "索引",
```

`src/i18n/en.json`:
```json
"cmplHttpMethod": "HTTP method",
"cmplEndpoint": "REST endpoint",
"cmplDsl": "Query DSL keyword",
"cmplEsIndex": "Index",
```

- [ ] **Step 2: 写失败测试** `src/components/dbviews/esCompletion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import '../../i18n'
import { esCompletion } from './esCompletion'

const INDICES = ['logs-2026', 'products']

/** pos 缺省为 doc 末尾。 */
function complete(doc: string, pos = doc.length, explicit = false) {
  const state = EditorState.create({ doc })
  const ctx = new CompletionContext(state, pos, explicit)
  return esCompletion(() => INDICES)(ctx)
}
const labels = (r: ReturnType<typeof complete>) => (r ? r.options.map(o => o.label) : [])

describe('esCompletion three modes', () => {
  it('completes REST verbs at line start', () => {
    const r = complete('GE')
    expect(labels(r)).toEqual(['GET', 'POST', 'PUT', 'DELETE'])
    expect(r!.options[0].apply).toBe('GET /')
  })

  it('stays quiet at empty line start unless explicit', () => {
    expect(complete('')).toBeNull()
    expect(complete('', 0, true)).not.toBeNull()
  })

  it('completes real index names + root endpoints in the first path segment', () => {
    const ls = labels(complete('GET /'))
    expect(ls).toContain('logs-2026')
    expect(ls).toContain('products')
    expect(ls).toContain('_search')
    expect(ls).toContain('_cat/indices')
  })

  it('completes index endpoints after an index segment', () => {
    const ls = labels(complete('GET /products/'))
    expect(ls).toContain('_search')
    expect(ls).toContain('_mapping')
    expect(ls).not.toContain('logs-2026')
    // _search 的 apply 带 match_all body 模板
    const search = complete('GET /products/')!.options.find(o => o.label === '_search')!
    expect(String(search.apply)).toContain('match_all')
  })

  it('completes Query DSL keywords + snippets inside the body', () => {
    const doc = 'GET /products/_search\n{\n  "qu'
    const ls = labels(complete(doc))
    expect(ls).toContain('query')
    expect(ls).toContain('bool')
    expect(ls).toContain('match_all')
  })

  it('keeps quiet on SELECT lines (SQL passthrough)', () => {
    expect(complete('SELECT * FROM products LIM')).toBeNull()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/dbviews/esCompletion.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现** `src/components/dbviews/esCompletion.ts`:

```ts
/* Elasticsearch 查询控制台补全(plain 模式)。照 dbx elasticsearchCompletion
 * 的三模式:行首 REST 动词 / 路径段(真实索引名 + endpoint)/ body 内
 * Query DSL 关键字 + snippet。SELECT/WITH 行走 SQL 转发,不出 ES 候选。 */
import { CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete'
import i18n from '../../i18n'

const VERBS = ['GET', 'POST', 'PUT', 'DELETE'] as const
const ROOT_ENDPOINTS = ['_search', '_cat/indices', '_cluster/health', '_aliases', '_count'] as const
const INDEX_ENDPOINTS: ReadonlyArray<{ label: string; apply?: string }> = [
  { label: '_search', apply: '_search\n{\n  "query": { "match_all": {} }\n}' },
  { label: '_mapping' },
  { label: '_settings' },
  { label: '_count' },
  { label: '_doc' },
  { label: '_refresh' },
]
const DSL_KEYWORDS = [
  'query', 'bool', 'must', 'should', 'must_not', 'filter', 'match', 'match_all',
  'term', 'terms', 'range', 'exists', 'sort', 'aggs', 'aggregations',
  'size', 'from', '_source', 'track_total_hits',
] as const
const DSL_SNIPPETS: ReadonlyArray<{ label: string; apply: string }> = [
  { label: 'match_all', apply: '"query": { "match_all": {} }' },
  { label: 'bool', apply: '"query": { "bool": { "must": [] } }' },
  { label: 'range', apply: '"range": { "field": { "gte": 0 } }' },
  { label: 'terms', apply: '"terms": { "field": [] }' },
]

/** ES 控制台 CompletionSource 工厂。索引名经 getter 惰性读取。 */
export function esCompletion(getIndices: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)

    // SELECT/WITH 行后端转发 _sql,不出 ES 候选。
    if (/^\s*(select|with)\b/i.test(line.text)) return null

    // 1) method 模式:行首单词 → REST 动词。
    let m = /^\s*([A-Za-z]*)$/.exec(before)
    if (m) {
      if (!m[1] && !ctx.explicit) return null
      const options: Completion[] = VERBS.map(v => ({
        label: v, apply: `${v} /`, type: 'keyword', detail: i18n.t('dbviews.cmplHttpMethod'),
      }))
      return { from: ctx.pos - m[1].length, options, validFor: /^[A-Za-z]*$/ }
    }

    // 2) path 模式:动词后的路径段。
    m = /^\s*(?:GET|POST|PUT|DELETE)\s+(\S*)$/i.exec(before)
    if (m) {
      const path = m[1]
      const seg = path.slice(path.lastIndexOf('/') + 1)
      const from = ctx.pos - seg.length
      // 去掉前导 '/' 后是否仍在第一段(没有更多 '/')→ 索引名 + 根 endpoint。
      const isFirstSegment = !path.slice(path.startsWith('/') ? 1 : 0).includes('/')
      const options: Completion[] = isFirstSegment
        ? [
            ...getIndices().map(ix => ({
              label: ix, type: 'class' as const, detail: i18n.t('dbviews.cmplEsIndex'),
            })),
            ...ROOT_ENDPOINTS.map(e => ({
              label: e, type: 'keyword' as const, detail: i18n.t('dbviews.cmplEndpoint'),
            })),
          ]
        : INDEX_ENDPOINTS.map(e => ({
            label: e.label, apply: e.apply, type: 'keyword' as const,
            detail: i18n.t('dbviews.cmplEndpoint'),
          }))
      return { from, options, validFor: /^[\w._/-]*$/ }
    }

    // 3) json 模式:首行是 REST 行且光标在后续行 → Query DSL 关键字 + snippet。
    const firstLine = ctx.state.doc.lineAt(0).text
    if (/^\s*(GET|POST|PUT|DELETE)\s/i.test(firstLine) && line.number > 1) {
      const word = ctx.matchBefore(/["\w_]+/)
      if (!word && !ctx.explicit) return null
      // 前缀以引号开头时,from 落在引号之后(候选 label 不含引号)。
      const from = word ? (word.text.startsWith('"') ? word.from + 1 : word.from) : ctx.pos
      return {
        from,
        options: [
          ...DSL_KEYWORDS.map(k => ({
            label: k, type: 'property' as const, detail: i18n.t('dbviews.cmplDsl'),
          })),
          ...DSL_SNIPPETS.map(s => ({
            label: s.label, apply: s.apply, type: 'snippet' as const,
            detail: i18n.t('dbviews.cmplSnippet'), boost: -1,
          })),
        ],
        validFor: /^[\w_]*$/,
      }
    }
    return null
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/dbviews/esCompletion.test.ts`
Expected: 6 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/dbviews/esCompletion.ts src/components/dbviews/esCompletion.test.ts src/i18n/zh.json src/i18n/en.json
git commit -m "feat(dbviews): es 查询控制台补全 source——REST 动词/路径索引名/Query DSL 三模式"
```

---

### Task 4: 前端 — SqlEditor 支持注入自定义 CompletionSource

**Files:**
- Modify: `src/components/dbviews/SqlEditor.tsx`

**上下文:** 现在 `autocompletion()` 挂在基础 extensions 里、`sql()` 在 compartment 里(plain 时 compartment 为 `[]`,所以 plain 完全无补全)。把 `autocompletion()` 移进 compartment,plain 时配 `override: [completion]`。无专属测试文件(组件无单测),验证靠 Task 2/3 的 source 单测 + tsc + 既有回归;行为接线在 Task 5 端到端覆盖。

- [ ] **Step 1: 加 prop 与 helper。** `SqlEditorProps` 增加(`plain` 之后):

```ts
  /** plain 模式下的自定义补全 source(mongo/es 控制台)。未设时 plain 无补全。 */
  completion?: CompletionSource
```

import 行改为(`@codemirror/autocomplete` 一行加 `type CompletionSource`):

```ts
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, type CompletionSource } from '@codemirror/autocomplete'
```

组件外(`dialectFor` 旁)加 helper——compartment 的统一内容构造:

```ts
/** Compartment 内容:非 plain → lang-sql + 默认补全;plain → 仅自定义 source
 *  (未提供 source 时 autocompletion 无源,不弹窗)。 */
function langAndCompletion(plain: boolean | undefined, completion: CompletionSource | undefined, schema?: SQLNamespace): Extension {
  if (!plain) return [sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }), autocompletion()]
  return autocompletion(completion ? { override: [completion] } : {})
}
```

- [ ] **Step 2: 改 mount extensions。** 基础 extensions 里删掉 `autocompletion(),` 一行;compartment 初值一行改为:

```ts
      sqlCompartment.current.of(langAndCompletion(plain, completion)),
```

组件参数解构加 `completion`。

- [ ] **Step 3: 改 reconfigure effect**(原 `[schema, plain]` 依赖的 effect):

```ts
  // Reconfigure lang/completion when schema, plain mode or custom source changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: sqlCompartment.current.reconfigure(langAndCompletion(plain, completion, schema)),
    })
  }, [schema, plain, completion])
```

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错;既有测试全绿(SQL 控制台补全行为不变:`autocompletion()` 仍随非 plain 分支挂载)。

- [ ] **Step 5: Commit**

```bash
git add src/components/dbviews/SqlEditor.tsx
git commit -m "feat(dbviews): SqlEditor 支持注入自定义补全 source,autocompletion 移入 compartment"
```

---

### Task 5: 前端 — SqlConsole 接线(plain 模式拉 schema + 按 engine 构造 source)

**Files:**
- Modify: `src/components/dbviews/SqlConsole.tsx`

**上下文:** plain 模式此前跳过 `getSchema`(L60-65)。集合/索引名补全需要表名,所以 plain 也拉 schema(只拉表名;列抓取 `schemaColumns` 的 effect 维持 plain 跳过不变)。schema 存 ref,source 经 getter 惰性读 → source 身份稳定(useMemo 只依赖 engine),不会因 schema 更新反复 reconfigure 编辑器。

- [ ] **Step 1: 改 schema fetch effect**(去掉 plain 条件):

```ts
  useEffect(() => {
    // plain(mongo/es)也拉 schema:集合名/索引名补全的数据源(只取表名,
    // 列抓取的 effect 仍然跳过 plain)。拉取失败 → 补全退化为纯静态候选。
    if (!connId) { setLiveSchema(null); return }
    let alive = true
    getSchema(connId).then(s => { if (alive) setLiveSchema(s) }).catch(() => {})
    return () => { alive = false }
  }, [connId])
```

(列抓取 effect 的 `if (!connId || plain || namespaceNames.length === 0)` **保持不变**。)

- [ ] **Step 2: 构造补全 source。** import 区加:

```ts
import { mongoCompletion } from './mongoCompletion'
import { esCompletion } from './esCompletion'
```

`editorRef` 声明之后加:

```ts
  // 补全 source 经 ref 惰性读最新 schema:source 身份稳定(只随 engine 变),
  // schema 更新不触发编辑器 reconfigure。
  const schemaRef = useRef<Schema | null>(null)
  schemaRef.current = liveSchema
  const completionSource = useMemo(() => {
    if (engine === 'mongodb') {
      return mongoCompletion(() =>
        (schemaRef.current?.schemas ?? []).flatMap(ns => ns.tables.map(tb => ({ name: tb.name, db: ns.name }))))
    }
    if (engine === 'elasticsearch') {
      return esCompletion(() =>
        (schemaRef.current?.schemas ?? []).flatMap(ns => ns.tables.map(tb => tb.name)))
    }
    return undefined
  }, [engine])
```

- [ ] **Step 3: 传给编辑器。** `<SqlEditor …>` 那行(~L217)加 `completion={completionSource}`。

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错;全部测试 PASS(非 plain 路径行为不变:liveSchema 现在 plain 也有值,但 `editorSchema` 仅非 plain 时被 SqlEditor 使用)。

- [ ] **Step 5: Commit**

```bash
git add src/components/dbviews/SqlConsole.tsx
git commit -m "feat(dbviews): mongo/es 控制台接入智能补全——plain 模式拉 schema 供集合/索引名"
```

---

### Task 6: 前端 — Agent 面板注入数据库类型(`buildAgentSystemPrompt`)

**Files:**
- Create: `src/services/agentPrompt.ts`
- Create: `src/services/agentPrompt.test.ts`
- Modify: `src/App.tsx`(`sendAgentMessage`,~L897-933)

**上下文:** `sendAgentMessage` 的 system prompt 目前永远是 "terminal/shell assistant"(L930-933),数据库 tab(`tab.kind !== 'terminal'`,与 L834 `aiMode` 判定一致)下 AI 不知道引擎类型。抽纯函数 + 单测;`Connection.engine?: string` 已存在(`services/types.ts:35`)。sysinfo/termBuffer 块依赖 `tab.sessionId`,数据库 tab 没有 session,自然为空串,拼接逻辑不用动。

- [ ] **Step 1: 写失败测试** `src/services/agentPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildAgentSystemPrompt } from './agentPrompt'

describe('buildAgentSystemPrompt', () => {
  it('keeps the shell assistant wording for terminal tabs', () => {
    const p = buildAgentSystemPrompt('shell', 'prod-web')
    expect(p).toContain('terminal/shell assistant')
    expect(p).toContain('"prod-web"')
  })

  it('switches to a database assistant with the engine injected for db tabs', () => {
    const p = buildAgentSystemPrompt('sql', '253-Copilot', 'mongodb')
    expect(p).toContain('database assistant')
    expect(p).toContain('mongodb')
    expect(p).toContain('"253-Copilot"')
    expect(p).not.toContain('terminal/shell')
  })

  it('falls back to unknown when the engine is absent', () => {
    expect(buildAgentSystemPrompt('sql', 'pg-local')).toContain('unknown')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/agentPrompt.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现** `src/services/agentPrompt.ts`:

```ts
/** Agent 面板 system prompt 构造:按 tab 类型区分 shell 助手与数据库助手。
 *  纯函数,便于单测(App.tsx 的 sendAgentMessage 调用)。 */
export function buildAgentSystemPrompt(mode: 'sql' | 'shell', hostName: string, engine?: string): string {
  if (mode === 'sql') {
    return (
      `You are a database assistant for the connection "${hostName}" (database engine: ${engine ?? 'unknown'}). ` +
      'Answer with the query syntax native to this engine — mongo shell commands for mongodb, ' +
      'REST + Query DSL for elasticsearch, or the appropriate SQL dialect for relational databases. ' +
      'When you suggest a query or command, put it in a fenced code block.'
    )
  }
  return `You are a terminal/shell assistant for host "${hostName}". When you suggest a shell command, put it in a fenced code block.`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/agentPrompt.test.ts`
Expected: 3 PASS。

- [ ] **Step 5: 接线 App.tsx。** import 区加:

```ts
import { buildAgentSystemPrompt } from './services/agentPrompt'
```

`sendAgentMessage` 内,system 构造(原 L930-933)改为:

```ts
    // 数据库 tab → 数据库助手角色 + 注入引擎类型;terminal tab → 维持 shell 助手。
    // (判定与 aiMode 一致:kind === 'terminal' ? shell : sql。)
    const promptMode = tab.kind === 'terminal' ? 'shell' : 'sql'
    const system: ChatMsg = {
      role: 'system',
      content: `${buildAgentSystemPrompt(promptMode, hostName, tabConn?.engine)}${sysinfoBlock}${termBlock}`,
    }
```

- [ ] **Step 6: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错,全部测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/services/agentPrompt.ts src/services/agentPrompt.test.ts src/App.tsx
git commit -m "feat(agent): 数据库 tab 的 Agent system prompt 切换为数据库助手并注入引擎类型"
```

---

### Task 7: 全量回归 + 手工验收清单

**Files:** 无新改动(验证任务)。

- [ ] **Step 1: Rust 全量**(在 `src-tauri/` 下)

Run: `cargo test --lib`
Expected: 全 PASS(118 + 新增 2)。

- [ ] **Step 2: 前端全量**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错;全部测试 PASS(242 + 新增 17)。

- [ ] **Step 3: 手工验收清单**(需真实 Mongo/ES 实例,交给用户):

- Mongo 控制台:输入 `db.` 弹出真实集合名(detail 显示所属库);`db.users.` 弹方法列表(无 findOne/distinct);`db.users.find({}).` 只弹 sort/skip/limit;`db.users.find({}).pretty()` 正常返回结果;`db.users.find().count()` 仍报错且错误信息提到 count。
- ES 控制台:行首敲 `G` 弹 GET/POST/PUT/DELETE;`GET /` 弹真实索引名 + `_search`/`_cat/indices` 等;`GET /idx/` 弹 `_search`(选中带 match_all body)/`_mapping` 等;body 内敲 `"qu` 弹 query 等 DSL 关键字;`SELECT` 行不弹 ES 候选。
- Agent 面板:连 Mongo 库开 SQL 模式问"你知道我的数据库吗"→ 回答直接点名 mongodb,不再反问数据库类型;SSH 终端 tab 的 shell 助手行为不变。
- 语言切换 zh/en 后补全 detail 文案跟随。
