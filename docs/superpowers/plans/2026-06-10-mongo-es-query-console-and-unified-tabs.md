# Mongo/ES 查询控制台 + 工作台统一 Tab 系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MongoDB/Elasticsearch 获得可用的查询控制台(mongo shell / REST+SQL 语法),刷新有视觉反馈;DbWorkbench 的表预览、对象预览、SQL 查询、ER 图统一进一条 tab strip,身份复用、互不覆盖。

**Architecture:** 语法行为照搬 dbx,解析位置适配 catio 的统一 `db_query(sql)` → `Driver::query()` 架构——Mongo shell 解析器和 ES 多语法分流都放 Rust 侧纯函数模块(可单测),driver 的 `query()` 做 IO。前端把 `DbWorkbench` 的互斥 `obj` 状态改为 tab 列表 + 身份复用,表/对象预览下沉为自管 fetch 的 `TablePane`/`ObjectPane` 组件,所有 pane 保持 mounted、display 切换。

**Tech Stack:** Rust (mongodb crate 3.x, reqwest, serde_json), Tauri v2, React + TypeScript, CodeMirror 6, vitest, cargo test。

**Spec:** `docs/superpowers/specs/2026-06-10-mongo-es-query-console-and-unified-tabs-design.md`

**约定:**
- 所有命令在仓库根目录 `I:\ai-projects\catio` 运行;Rust 测试 `cargo test --manifest-path src-tauri/Cargo.toml`,前端测试 `npx vitest run <file>`。
- 提交信息语义化前缀英文 + 中文正文(项目规范)。
- 新文件的注释风格与现有 driver 一致(中英混合,说明"为什么")。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/db/drivers/mongo_shell.rs` | 新建 | mongo shell 命令解析 + 宽松 JSON 归一化 + JSON→BSON(纯函数,无 IO) |
| `src-tauri/src/db/drivers/mongo.rs` | 修改 | `query()` 接入解析器执行全部命令 |
| `src-tauri/src/db/drivers/es_query.rs` | 新建 | ES REST/SELECT 解析 + 响应四级拍平(纯函数,无 IO) |
| `src-tauri/src/db/drivers/elasticsearch.rs` | 修改 | `query()` 多语法分流执行 |
| `src-tauri/src/db/drivers/mod.rs` | 修改 | 注册两个新模块 |
| `src-tauri/src/db/capabilities.rs` | 修改 | Mongodb/Elasticsearch 开启 sql_console |
| `src/components/workbench/TablePane.tsx` | 新建 | 表预览 pane(自管 fetch + data/structure 子切换) |
| `src/components/workbench/ObjectPane.tsx` | 新建 | 视图/函数/存储过程源码 pane(自管 fetch) |
| `src/components/workbench/DbWorkbench.tsx` | 修改 | 统一 tab 系统 + 刷新反馈 |
| `src/components/workbench/SchemaBrowser.tsx` | 修改 | 刷新按钮转圈 + testid |
| `src/components/dbviews/SqlEditor.tsx` | 修改 | placeholder + plain(非 SQL)模式 |
| `src/components/dbviews/SqlConsole.tsx` | 修改 | engine 感知(mongo/es 关 SQL 补全、placeholder、结果网格只读) |
| `src/i18n/zh.json` / `src/i18n/en.json` | 修改 | 新增文案 |
| `src/components/workbench/DbWorkbench.test.tsx` | 修改 | tab 行为测试 |

---

### Task 1: mongo_shell.rs — 解析基建(配对括号 / 顶层逗号切分 / 宽松 JSON 归一化)

**Files:**
- Create: `src-tauri/src/db/drivers/mongo_shell.rs`
- Modify: `src-tauri/src/db/drivers/mod.rs`(加 `pub mod mongo_shell;`)

- [ ] **Step 1: 注册模块并写失败的测试**

在 `src-tauri/src/db/drivers/mod.rs` 中现有 `pub mod` 列表里(按字母序)加入:

```rust
pub mod es_query;
pub mod mongo_shell;
```

(`es_query` Task 5 才创建文件,本步先只加 `mongo_shell`,`es_query` 留到 Task 5 加。)

创建 `src-tauri/src/db/drivers/mongo_shell.rs`,先只放测试骨架与函数签名(`todo!()` 实现):

```rust
// mongo shell 风格命令解析(语法行为照搬 dbx apps/desktop/src/lib/mongoShellCommand.ts)。
// catio 是统一 db_query(sql) → Driver::query() 架构,SqlConsole 的原文输入到达
// mongo.rs::query() 后由本模块解析为结构化 MongoCommand 再用 mongodb crate 执行。
// 本模块只有纯函数(无 IO),便于单测。
use serde_json::Value;

/// 从 `(` 开始提取配对括号内容(尊重字符串字面量与嵌套 ()/[]/{}),
/// 返回 (括号内内容, 右括号之后的剩余)。输入允许有前导空白。
pub fn extract_balanced(s: &str) -> Result<(String, &str), String> {
    todo!()
}

/// 在深度 0 处按逗号切分(尊重字符串与嵌套括号),trim 后去掉空段。
pub fn split_top_level(s: &str) -> Vec<String> {
    todo!()
}

/// 宽松 JSON 归一化:`ObjectId("..")` → `{"$oid":".."}`、单引号字符串 → 双引号、
/// 未加引号的 key → 加引号(含 $ 开头的操作符 key),然后 serde_json 解析。
/// 空输入归一化为空对象 {}。
/// 已知边界:字符串字面量内出现的 "ObjectId(" 也会被改写(dbx 的 regex 方案同此行为)。
pub fn normalize_loose_json(input: &str) -> Result<Value, String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_balanced_parens_with_nesting_and_strings() {
        let (inner, rest) = extract_balanced(r#"({a: "x)y", b: [1, (2)]}).limit(5)"#).unwrap();
        assert_eq!(inner, r#"{a: "x)y", b: [1, (2)]}"#);
        assert_eq!(rest, ".limit(5)");
    }

    #[test]
    fn extract_balanced_rejects_unclosed() {
        assert!(extract_balanced("({a: 1}").is_err());
        assert!(extract_balanced("no_paren").is_err());
    }

    #[test]
    fn splits_top_level_commas_only() {
        let parts = split_top_level(r#"{a: 1, b: [1,2]}, {"$set": {x: ","}}"#);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], r#"{a: 1, b: [1,2]}"#);
        assert_eq!(parts[1], r#"{"$set": {x: ","}}"#);
    }

    #[test]
    fn normalizes_unquoted_keys_and_single_quotes() {
        let v = normalize_loose_json(r#"{age: {$gt: 18}, name: 'a"b'}"#).unwrap();
        assert_eq!(v, json!({"age": {"$gt": 18}, "name": "a\"b"}));
    }

    #[test]
    fn normalizes_object_id_to_extended_json() {
        let v = normalize_loose_json(r#"{_id: ObjectId("65f1c0ffee65f1c0ffee65f1")}"#).unwrap();
        assert_eq!(v, json!({"_id": {"$oid": "65f1c0ffee65f1c0ffee65f1"}}));
    }

    #[test]
    fn empty_input_is_empty_object() {
        assert_eq!(normalize_loose_json("  ").unwrap(), json!({}));
    }

    #[test]
    fn true_false_null_values_pass_through() {
        let v = normalize_loose_json("{active: true, gone: null}").unwrap();
        assert_eq!(v, json!({"active": true, "gone": null}));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: 编译通过但所有测试 panic(`todo!()`)或编译期 unreachable 警告;若 `todo!()` 导致测试失败即为预期 FAIL。

- [ ] **Step 3: 实现三个基建函数**

```rust
pub fn extract_balanced(s: &str) -> Result<(String, &str), String> {
    let s = s.trim_start();
    if !s.starts_with('(') {
        return Err("expected `(`".to_string());
    }
    let mut depth: usize = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if let Some(q) = quote {
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == q { quote = None; }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth = depth.checked_sub(1).ok_or_else(|| "unbalanced brackets".to_string())?;
                if depth == 0 {
                    if c != ')' { return Err("unbalanced brackets".to_string()); }
                    return Ok((s[1..i].to_string(), &s[i + 1..]));
                }
            }
            _ => {}
        }
    }
    Err("unclosed `(`".to_string())
}

pub fn split_top_level(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut depth: usize = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, c) in s.char_indices() {
        if let Some(q) = quote {
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == q { quote = None; }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(s[start..i].to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(s[start..].to_string());
    parts.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

pub fn normalize_loose_json(input: &str) -> Result<Value, String> {
    let s = input.trim();
    if s.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    let s = rewrite_object_id(s);
    let s = requote(&s);
    serde_json::from_str(&s).map_err(|e| format!("Invalid JSON argument: {e}"))
}

/// `ObjectId("hex")` / `ObjectId('hex')` → `{"$oid":"hex"}`(预处理 pass)。
fn rewrite_object_id(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find("ObjectId") {
        let prev_is_ident = pos > 0
            && rest[..pos].chars().last()
                .map(|c| c.is_alphanumeric() || c == '_' || c == '"' || c == '\'')
                .unwrap_or(false);
        let after = &rest[pos + "ObjectId".len()..];
        if !prev_is_ident {
            if let Ok((inner, tail)) = extract_balanced(after) {
                let hex = inner.trim().trim_matches(|c| c == '"' || c == '\'');
                out.push_str(&rest[..pos]);
                out.push_str(&format!("{{\"$oid\":\"{hex}\"}}"));
                rest = tail;
                continue;
            }
        }
        out.push_str(&rest[..pos + "ObjectId".len()]);
        rest = &rest[pos + "ObjectId".len()..];
    }
    out.push_str(rest);
    out
}

/// 单引号字符串 → 双引号(转义内部 ");裸标识符作 key(后随 `:`)时加引号。
/// true/false/null 作为值保持字面量。
fn requote(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                out.push('"');
                i += 1;
                while i < chars.len() {
                    let d = chars[i];
                    if d == '\\' && i + 1 < chars.len() {
                        out.push('\\');
                        out.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if d == '\'' { break; }
                    if d == '"' { out.push('\\'); }
                    out.push(d);
                    i += 1;
                }
                out.push('"');
                i += 1; // 跳过收尾单引号
            }
            '"' => {
                out.push('"');
                i += 1;
                while i < chars.len() {
                    let d = chars[i];
                    out.push(d);
                    i += 1;
                    if d == '\\' && i < chars.len() {
                        out.push(chars[i]);
                        i += 1;
                    } else if d == '"' {
                        break;
                    }
                }
            }
            _ if c.is_alphabetic() || c == '_' || c == '$' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$' || chars[i] == '.')
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() { j += 1; }
                let is_key = j < chars.len() && chars[j] == ':';
                let is_literal = matches!(word.as_str(), "true" | "false" | "null");
                if is_key && !is_literal {
                    out.push('"');
                    out.push_str(&word);
                    out.push('"');
                } else {
                    out.push_str(&word);
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: 7 个测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/drivers/mongo_shell.rs src-tauri/src/db/drivers/mod.rs
git commit -m "feat(db): mongo shell 解析基建——配对括号提取、顶层逗号切分、宽松 JSON 归一化"
```

---

### Task 2: mongo_shell.rs — 命令解析 parse()

**Files:**
- Modify: `src-tauri/src/db/drivers/mongo_shell.rs`

- [ ] **Step 1: 写失败的测试**

在 `mongo_shell.rs` 的 `mod tests` 中追加:

```rust
    #[test]
    fn parses_find_with_chain() {
        let cmd = parse(r#"db.users.find({age: {$gt: 18}}).sort({name: 1}).skip(10).limit(20)"#).unwrap();
        match cmd {
            MongoCommand::Find { collection, filter, sort, skip, limit } => {
                assert_eq!(collection, "users");
                assert_eq!(filter, json!({"age": {"$gt": 18}}));
                assert_eq!(sort, Some(json!({"name": 1})));
                assert_eq!(skip, Some(10));
                assert_eq!(limit, Some(20));
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn parses_get_collection_form_and_empty_find() {
        let cmd = parse(r#"db.getCollection("order-items").find()"#).unwrap();
        match cmd {
            MongoCommand::Find { collection, filter, sort, skip, limit } => {
                assert_eq!(collection, "order-items");
                assert_eq!(filter, json!({}));
                assert!(sort.is_none() && skip.is_none() && limit.is_none());
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn parses_count_aggregate_indexes() {
        assert!(matches!(parse("db.users.countDocuments({active: true})").unwrap(),
            MongoCommand::Count { .. }));
        let agg = parse(r#"db.orders.aggregate([{$match: {status: 'paid'}}, {$group: {_id: "$uid"}}])"#).unwrap();
        match agg {
            MongoCommand::Aggregate { collection, pipeline } => {
                assert_eq!(collection, "orders");
                assert_eq!(pipeline.as_array().unwrap().len(), 2);
            }
            other => panic!("expected Aggregate, got {other:?}"),
        }
        assert!(matches!(parse("db.users.getIndexes()").unwrap(),
            MongoCommand::GetIndexes { .. }));
    }

    #[test]
    fn parses_write_commands() {
        assert!(matches!(parse(r#"db.users.insertOne({name: "n"})"#).unwrap(),
            MongoCommand::InsertOne { .. }));
        let im = parse(r#"db.users.insertMany([{a: 1}, {a: 2}])"#).unwrap();
        match im {
            MongoCommand::InsertMany { docs, .. } => assert_eq!(docs.as_array().unwrap().len(), 2),
            other => panic!("expected InsertMany, got {other:?}"),
        }
        let up = parse(r#"db.users.updateMany({a: 1}, {$set: {b: 2}})"#).unwrap();
        match up {
            MongoCommand::UpdateMany { filter, update, .. } => {
                assert_eq!(filter, json!({"a": 1}));
                assert_eq!(update, json!({"$set": {"b": 2}}));
            }
            other => panic!("expected UpdateMany, got {other:?}"),
        }
        assert!(matches!(parse("db.users.deleteOne({a: 1})").unwrap(),
            MongoCommand::DeleteOne { .. }));
    }

    #[test]
    fn rejects_invalid_input_with_hint() {
        assert!(parse("SELECT * FROM users").unwrap_err().contains("db.users.find"));
        assert!(parse("db.users.dropDatabase()").is_err());
        assert!(parse("db.users.find({a: 1}).explain()").unwrap_err().contains("sort"));
        assert!(parse("db.users.updateOne({a: 1})").is_err()); // 缺 update 参数
        assert!(parse("").is_err());
    }

    #[test]
    fn trailing_semicolon_is_tolerated() {
        assert!(matches!(parse("db.users.find();").unwrap(), MongoCommand::Find { .. }));
    }

    #[test]
    fn rejects_zero_arg_delete_and_insert() {
        // mongosh 对缺 filter 的 delete / 缺 doc 的 insert 直接报错;
        // 默认空 filter 会让手滑变成全集合删除,必须拒绝。
        assert!(parse("db.users.deleteMany()").is_err());
        assert!(parse("db.users.deleteOne()").is_err());
        assert!(parse("db.users.insertOne()").is_err());
        // 空 filter 的查询仍合法
        assert!(parse("db.users.find()").is_ok());
        assert!(parse("db.users.countDocuments()").is_ok());
    }

    #[test]
    fn rejects_find_projection_argument() {
        let err = parse(r#"db.users.find({}, {name: 1})"#).unwrap_err();
        assert!(err.contains("projection"));
    }

    #[test]
    fn parses_get_collection_single_quote_form() {
        assert!(matches!(parse(r#"db.getCollection('users').find()"#).unwrap(),
            MongoCommand::Find { .. }));
    }
```

- [ ] **Step 2: 跑测试确认编译失败(MongoCommand/parse 未定义)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: FAIL — `cannot find type MongoCommand` / `cannot find function parse`。

- [ ] **Step 3: 实现 MongoCommand 与 parse()**

在 `mongo_shell.rs` 顶部(use 之后)加:

```rust
/// 解析后的 mongo shell 命令。参数保留为 serde_json::Value,
/// BSON 转换在执行时做(见 json_to_bson / json_filter_to_doc)。
#[derive(Debug, Clone, PartialEq)]
pub enum MongoCommand {
    Find { collection: String, filter: Value, sort: Option<Value>, skip: Option<u64>, limit: Option<i64> },
    Count { collection: String, filter: Value },
    Aggregate { collection: String, pipeline: Value },
    GetIndexes { collection: String },
    InsertOne { collection: String, doc: Value },
    InsertMany { collection: String, docs: Value },
    UpdateOne { collection: String, filter: Value, update: Value },
    UpdateMany { collection: String, filter: Value, update: Value },
    DeleteOne { collection: String, filter: Value },
    DeleteMany { collection: String, filter: Value },
}

pub const SYNTAX_HINT: &str = "Unsupported MongoDB command. Expected mongo shell syntax, e.g. \
db.users.find({age: {$gt: 18}}).sort({_id: -1}).limit(20). Supported: find / countDocuments / \
aggregate / getIndexes / insertOne / insertMany / updateOne / updateMany / deleteOne / deleteMany";

fn hint() -> String { SYNTAX_HINT.to_string() }

pub fn parse(input: &str) -> Result<MongoCommand, String> {
    let s = input.trim().trim_end_matches(';').trim();
    let rest = s.strip_prefix("db.").ok_or_else(hint)?;
    let (collection, rest) = parse_collection(rest)?;
    let paren = rest.find('(').ok_or_else(hint)?;
    let method = rest[..paren].trim().to_string();
    let (args_raw, chain) = extract_balanced(&rest[paren..]).map_err(|_| hint())?;
    let args = split_top_level(&args_raw);
    // 第 i 个参数,缺省为空对象 {}
    let arg = |i: usize| -> Result<Value, String> {
        match args.get(i) {
            Some(a) => normalize_loose_json(a),
            None => Ok(Value::Object(Default::default())),
        }
    };
    // find 之外的方法不允许链式调用
    if method != "find" && !chain.trim().is_empty() {
        return Err(hint());
    }
    match method.as_str() {
        "find" => {
            if args.len() > 1 {
                return Err("find() projection (second argument) is not supported yet — use db.coll.find(filter) and select columns from the result".to_string());
            }
            let (sort, skip, limit) = parse_find_chain(chain)?;
            Ok(MongoCommand::Find { collection, filter: arg(0)?, sort, skip, limit })
        }
        "countDocuments" | "count" => Ok(MongoCommand::Count { collection, filter: arg(0)? }),
        "aggregate" => {
            let trimmed = args_raw.trim();
            let pipeline = if trimmed.starts_with('[') {
                normalize_loose_json(trimmed)?
            } else {
                Value::Array(args.iter().map(|a| normalize_loose_json(a)).collect::<Result<Vec<_>, _>>()?)
            };
            if !pipeline.is_array() { return Err(hint()); }
            Ok(MongoCommand::Aggregate { collection, pipeline })
        }
        "getIndexes" => Ok(MongoCommand::GetIndexes { collection }),
        "insertOne" => {
            if args.is_empty() { return Err(hint()); }
            Ok(MongoCommand::InsertOne { collection, doc: arg(0)? })
        }
        "insertMany" => {
            let trimmed = args_raw.trim();
            let docs = if trimmed.starts_with('[') {
                normalize_loose_json(trimmed)?
            } else {
                Value::Array(args.iter().map(|a| normalize_loose_json(a)).collect::<Result<Vec<_>, _>>()?)
            };
            if !docs.is_array() { return Err(hint()); }
            Ok(MongoCommand::InsertMany { collection, docs })
        }
        "updateOne" | "updateMany" => {
            if args.len() < 2 { return Err(hint()); }
            let filter = arg(0)?;
            let update = arg(1)?;
            if method == "updateOne" {
                Ok(MongoCommand::UpdateOne { collection, filter, update })
            } else {
                Ok(MongoCommand::UpdateMany { collection, filter, update })
            }
        }
        "deleteOne" => {
            if args.is_empty() { return Err(hint()); }
            Ok(MongoCommand::DeleteOne { collection, filter: arg(0)? })
        }
        "deleteMany" => {
            if args.is_empty() { return Err(hint()); }
            Ok(MongoCommand::DeleteMany { collection, filter: arg(0)? })
        }
        _ => Err(hint()),
    }
}

/// 集合名:`getCollection("x")` 或裸标识符(直到下一个 `.`)。
fn parse_collection(rest: &str) -> Result<(String, &str), String> {
    if let Some(r) = rest.strip_prefix("getCollection") {
        let (inner, after) = extract_balanced(r).map_err(|_| hint())?;
        let name = inner.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if name.is_empty() { return Err(hint()); }
        let after = after.trim_start().strip_prefix('.').ok_or_else(hint)?;
        Ok((name, after))
    } else {
        let dot = rest.find('.').ok_or_else(hint)?;
        let name = &rest[..dot];
        let valid = !name.is_empty()
            && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-');
        if !valid { return Err(hint()); }
        Ok((name.to_string(), &rest[dot + 1..]))
    }
}

/// find 之后的链式调用:仅允许 .sort({..}) / .skip(n) / .limit(n)。
fn parse_find_chain(mut chain: &str) -> Result<(Option<Value>, Option<u64>, Option<i64>), String> {
    let (mut sort, mut skip, mut limit) = (None, None, None);
    loop {
        chain = chain.trim_start();
        if chain.is_empty() {
            return Ok((sort, skip, limit));
        }
        let rest = chain.strip_prefix('.').ok_or_else(hint)?;
        let paren = rest.find('(').ok_or_else(hint)?;
        let name = rest[..paren].trim();
        let (arg, tail) = extract_balanced(&rest[paren..]).map_err(|_| hint())?;
        match name {
            "sort" => sort = Some(normalize_loose_json(&arg)?),
            "skip" => skip = Some(arg.trim().parse::<u64>().map_err(|_| hint())?),
            "limit" => limit = Some(arg.trim().parse::<i64>().map_err(|_| hint())?),
            _ => return Err(format!(
                "Unsupported chained method `.{name}()` — only .sort() / .skip() / .limit() may follow find()"
            )),
        }
        chain = tail;
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: Task 1 + Task 2 全部测试 PASS(13 个)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/drivers/mongo_shell.rs
git commit -m "feat(db): mongo shell 命令解析——find 链式/getCollection/聚合/读写全套,非法输入带语法提示"
```

---

### Task 3: mongo_shell.rs — JSON→BSON(扩展 JSON $oid + _id 双变体)

**Files:**
- Modify: `src-tauri/src/db/drivers/mongo_shell.rs`

- [ ] **Step 1: 写失败的测试**

`mod tests` 追加:

```rust
    use mongodb::bson::{doc, oid::ObjectId, Bson};

    #[test]
    fn json_to_bson_converts_oid_and_scalars() {
        let v = json!({"_id": {"$oid": "65f1c0ffee65f1c0ffee65f1"}, "n": 3, "f": 1.5, "s": "x", "b": true, "z": null, "arr": [1]});
        let b = json_to_bson(&v);
        let d = match b { Bson::Document(d) => d, other => panic!("expected doc, got {other:?}") };
        assert_eq!(d.get("_id"), Some(&Bson::ObjectId(ObjectId::parse_str("65f1c0ffee65f1c0ffee65f1").unwrap())));
        assert_eq!(d.get("n"), Some(&Bson::Int64(3)));
        assert_eq!(d.get("b"), Some(&Bson::Boolean(true)));
    }

    #[test]
    fn id_filter_expands_hex24_to_dual_variants() {
        // _id: "hex24" → {_id: {$in: [ObjectId, "hex24"]}}(dbx 的 _id 类型痛点解法)
        let d = json_filter_to_doc(&json!({"_id": "65f1c0ffee65f1c0ffee65f1"})).unwrap();
        let id = d.get_document("_id").unwrap();
        let arr = id.get_array("$in").unwrap();
        assert_eq!(arr.len(), 2);
        assert!(matches!(arr[0], Bson::ObjectId(_)));
        assert!(matches!(arr[1], Bson::String(_)));
    }

    #[test]
    fn id_filter_expands_eq_ne_operators() {
        let d = json_filter_to_doc(&json!({"_id": {"$eq": "65f1c0ffee65f1c0ffee65f1"}})).unwrap();
        assert!(d.get_document("_id").unwrap().contains_key("$in"));
        let d = json_filter_to_doc(&json!({"_id": {"$ne": "65f1c0ffee65f1c0ffee65f1"}})).unwrap();
        assert!(d.get_document("_id").unwrap().contains_key("$nin"));
    }

    #[test]
    fn non_hex_id_and_other_fields_convert_plainly() {
        let d = json_filter_to_doc(&json!({"_id": "plain-key", "age": {"$gt": 18}})).unwrap();
        // 非 24-hex 的 _id 不展开,保持等值匹配
        assert_eq!(d.get("_id"), Some(&Bson::String("plain-key".into())));
        assert_eq!(d.get_document("age").unwrap().get("$gt"), Some(&Bson::Int64(18)));
    }
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: FAIL — `cannot find function json_to_bson / json_filter_to_doc`。

- [ ] **Step 3: 实现转换函数**

`mongo_shell.rs` 顶部 use 改为:

```rust
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::Value;
```

追加实现:

```rust
/// JSON → BSON。识别扩展 JSON `{"$oid": "..."}` → ObjectId;整数走 Int64。
pub fn json_to_bson(v: &Value) -> Bson {
    match v {
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(Value::String(hex)) = map.get("$oid") {
                    if let Ok(oid) = ObjectId::parse_str(hex) {
                        return Bson::ObjectId(oid);
                    }
                }
            }
            let mut d = Document::new();
            for (k, val) in map {
                d.insert(k.clone(), json_to_bson(val));
            }
            Bson::Document(d)
        }
        Value::Array(arr) => Bson::Array(arr.iter().map(json_to_bson).collect()),
        Value::String(s) => Bson::String(s.clone()),
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Null => Bson::Null,
        Value::Number(n) => match n.as_i64() {
            Some(i) => Bson::Int64(i),
            None => Bson::Double(n.as_f64().unwrap_or(0.0)),
        },
    }
}

/// JSON 对象 → BSON Document(非对象报错)。用于 update 文档、aggregate stage、sort。
pub fn json_to_doc(v: &Value) -> Result<Document, String> {
    match json_to_bson(v) {
        Bson::Document(d) => Ok(d),
        _ => Err("expected a JSON object".to_string()),
    }
}

/// filter JSON → BSON Document。`_id` 做 ObjectId/String 双变体展开(照 dbx):
/// 24 位 hex 字符串 → `{$in: [ObjectId(hex), "hex"]}`;`$eq` → `$in`、`$ne` → `$nin` 同样展开。
pub fn json_filter_to_doc(v: &Value) -> Result<Document, String> {
    let map = v.as_object().ok_or_else(|| "filter must be a JSON object".to_string())?;
    let mut d = Document::new();
    for (k, val) in map {
        if k == "_id" {
            d.insert("_id", id_filter_bson(val));
        } else {
            d.insert(k.clone(), json_to_bson(val));
        }
    }
    Ok(d)
}

fn hex24(s: &str) -> Option<ObjectId> {
    if s.len() == 24 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        ObjectId::parse_str(s).ok()
    } else {
        None
    }
}

fn id_variants(s: &str) -> Bson {
    match hex24(s) {
        Some(oid) => Bson::Array(vec![Bson::ObjectId(oid), Bson::String(s.to_string())]),
        None => Bson::Array(vec![Bson::String(s.to_string())]),
    }
}

fn id_filter_bson(v: &Value) -> Bson {
    match v {
        Value::String(s) if hex24(s).is_some() => Bson::Document(doc! { "$in": id_variants(s) }),
        Value::Object(map) => {
            // 已是 $oid 扩展 JSON → 直接转 ObjectId(json_to_bson 处理)
            if map.len() == 1 && map.contains_key("$oid") {
                return json_to_bson(v);
            }
            let mut out = Document::new();
            for (op, ov) in map {
                match (op.as_str(), ov) {
                    ("$eq", Value::String(s)) => { out.insert("$in", id_variants(s)); }
                    ("$ne", Value::String(s)) => { out.insert("$nin", id_variants(s)); }
                    _ => { out.insert(op.clone(), json_to_bson(ov)); }
                }
            }
            Bson::Document(out)
        }
        other => json_to_bson(other),
    }
}
```

注意:测试里的 `use mongodb::bson::{doc, oid::ObjectId, Bson};` 与模块顶部重复,把 tests 里那行删掉(顶部已 use,`super::*` 带入)。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml mongo_shell`
Expected: 全部 PASS(17 个)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/drivers/mongo_shell.rs
git commit -m "feat(db): JSON→BSON 转换——$oid 扩展 JSON 与 _id ObjectId/String 双变体匹配"
```

---

### Task 4: mongo.rs — query() 执行全部命令

**Files:**
- Modify: `src-tauri/src/db/drivers/mongo.rs:241-271`(替换 `query()`)

- [ ] **Step 1: 替换 query() 实现**

把 `mongo.rs` 现有的 `async fn query`(把输入当集合名全量 find 的版本,241-271 行)整体替换为:

```rust
    /// mongo shell 风格查询控制台(语法行为照 dbx):输入由 mongo_shell::parse
    /// 解析为结构化命令后用 mongodb crate 执行。database 取连接配置的 default_db。
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use futures_util::TryStreamExt;
        use crate::db::drivers::mongo_shell::{self, MongoCommand};

        let cmd = mongo_shell::parse(sql).map_err(DbError::QueryFailed)?;
        let db = self.client.database(&self.default_db);
        let map_err = |e: mongodb::error::Error| DbError::QueryFailed(e.to_string());

        /// 写命令的统一回执:空表格 + rows_affected。
        fn affected(n: u64) -> QueryResult {
            QueryResult { columns: vec![], rows: vec![], rows_affected: Some(n), truncated: false }
        }

        match cmd {
            MongoCommand::Find { collection, filter, sort, skip, limit } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let filter = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                // 多取 1 条用于 truncated 检测;用户 limit 更小时以用户为准。
                let cap = (max_rows as i64) + 1;
                let fetch = limit.map(|l| l.min(cap)).unwrap_or(cap);
                let mut find = coll.find(filter).limit(fetch);
                if let Some(s) = &sort {
                    find = find.sort(mongo_shell::json_to_doc(s).map_err(DbError::QueryFailed)?);
                }
                if let Some(sk) = skip {
                    find = find.skip(sk);
                }
                let mut cursor = find.await.map_err(map_err)?;
                let mut docs: Vec<Document> = Vec::new();
                while let Some(d) = cursor.try_next().await.map_err(map_err)? {
                    docs.push(d);
                }
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::Count { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let filter = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let n = coll.count_documents(filter).await.map_err(map_err)?;
                Ok(QueryResult {
                    columns: vec![ColumnInfo { name: "count".into(), type_name: "int64".into(), pk: false }],
                    rows: vec![vec![safe_i64_to_json(n as i64)]],
                    rows_affected: None,
                    truncated: false,
                })
            }
            MongoCommand::Aggregate { collection, pipeline } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let stages: Vec<Document> = pipeline
                    .as_array()
                    .map(|arr| arr.iter().map(mongo_shell::json_to_doc).collect::<Result<Vec<_>, _>>())
                    .unwrap_or_else(|| Ok(vec![]))
                    .map_err(DbError::QueryFailed)?;
                let mut cursor = coll.aggregate(stages).await.map_err(map_err)?;
                let mut docs: Vec<Document> = Vec::new();
                while let Some(d) = cursor.try_next().await.map_err(map_err)? {
                    docs.push(d);
                    if docs.len() > max_rows as usize { break; }
                }
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::GetIndexes { collection } => {
                // 走 listIndexes 命令取 firstBatch,避免 IndexModel 的手工展开。
                let res = db.run_command(doc! { "listIndexes": &collection }).await.map_err(map_err)?;
                let docs: Vec<Document> = res
                    .get_document("cursor").ok()
                    .and_then(|c| c.get_array("firstBatch").ok())
                    .map(|arr| arr.iter().filter_map(|b| b.as_document().cloned()).collect())
                    .unwrap_or_default();
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::InsertOne { collection, doc: d } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let bd = mongo_shell::json_to_doc(&d).map_err(DbError::QueryFailed)?;
                coll.insert_one(bd).await.map_err(map_err)?;
                Ok(affected(1))
            }
            MongoCommand::InsertMany { collection, docs } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let bds: Vec<Document> = docs
                    .as_array()
                    .map(|arr| arr.iter().map(mongo_shell::json_to_doc).collect::<Result<Vec<_>, _>>())
                    .unwrap_or_else(|| Ok(vec![]))
                    .map_err(DbError::QueryFailed)?;
                let n = bds.len() as u64;
                coll.insert_many(bds).await.map_err(map_err)?;
                Ok(affected(n))
            }
            MongoCommand::UpdateOne { collection, filter, update } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let u = mongo_shell::json_to_doc(&update).map_err(DbError::QueryFailed)?;
                let r = coll.update_one(f, u).await.map_err(map_err)?;
                Ok(affected(r.modified_count))
            }
            MongoCommand::UpdateMany { collection, filter, update } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let u = mongo_shell::json_to_doc(&update).map_err(DbError::QueryFailed)?;
                let r = coll.update_many(f, u).await.map_err(map_err)?;
                Ok(affected(r.modified_count))
            }
            MongoCommand::DeleteOne { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let r = coll.delete_one(f).await.map_err(map_err)?;
                Ok(affected(r.deleted_count))
            }
            MongoCommand::DeleteMany { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let r = coll.delete_many(f).await.map_err(map_err)?;
                Ok(affected(r.deleted_count))
            }
        }
    }
```

注意:旧实现"输入当集合名"的约定被移除——数据网格预览早已走 `table_data`(`db_table_preview` 命令),不依赖 `query()`。

- [ ] **Step 2: 编译 + 全量 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过,全部测试 PASS(`query()` 的 IO 行为靠 Task 11 手工验收;解析层已被 mongo_shell 单测覆盖)。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/drivers/mongo.rs
git commit -m "feat(db): MongoDB query() 执行 mongo shell 全套命令——find/count/aggregate/getIndexes/读写"
```

---

### Task 5: ES 多语法分流 + 响应四级拍平

**Files:**
- Create: `src-tauri/src/db/drivers/es_query.rs`
- Modify: `src-tauri/src/db/drivers/mod.rs`(加 `pub mod es_query;`)
- Modify: `src-tauri/src/db/drivers/elasticsearch.rs:77-145`(替换 `query()`)

- [ ] **Step 1: 写失败的测试(es_query.rs 含测试骨架)**

创建 `src-tauri/src/db/drivers/es_query.rs`:

```rust
// Elasticsearch 查询控制台的纯函数层(无 IO):多语法解析 + 响应拍平。
// 语法行为照 dbx crates/dbx-core/src/db/elasticsearch_driver.rs 的 execute_rest_query:
// REST(GET /index/_search + JSON body)/ 简单 SELECT * / 其余 SELECT 转发 _sql。
use serde_json::Value;
use crate::db::result::{ColumnInfo, QueryResult};

pub const ES_SYNTAX_HINT: &str = "Unsupported Elasticsearch query. Use REST syntax \
(e.g. GET /index/_search with an optional JSON body on the following lines) \
or SQL (SELECT ... FROM index)";

pub struct RestRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}

/// `METHOD /path [\n {json body}]` → RestRequest。
/// 返回 None 表示输入不是 REST 形状(交给下一级解析);Some(Err) 表示是 REST 但格式错误。
pub fn parse_rest(input: &str) -> Option<Result<RestRequest, String>> {
    todo!()
}

/// 简单 `SELECT * FROM idx [LIMIT n]`(大小写不敏感,无其他子句)→ (index, limit)。
pub fn parse_select_star(input: &str) -> Option<(String, Option<u32>)> {
    todo!()
}

/// 是否 SELECT 开头(交给 ES 原生 _sql endpoint)。
pub fn is_select(input: &str) -> bool {
    input.trim_start().get(..6).map(|s| s.eq_ignore_ascii_case("select")).unwrap_or(false)
}

/// ES 响应 → QueryResult,四级 fallback(照 dbx parse_elasticsearch_response):
/// 1) _sql 响应(columns+rows) 2) hits.hits 3) aggregations 4) 任意 JSON → status|response。
pub fn parse_es_response(body: Value, max_rows: u32) -> QueryResult {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rest_with_body() {
        let r = parse_rest("GET /idx/_search\n{ \"query\": { \"match_all\": {} } }").unwrap().unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/idx/_search");
        assert_eq!(r.body, Some(json!({"query": {"match_all": {}}})));
    }

    #[test]
    fn parses_rest_without_body_and_rejects_bad_path() {
        let r = parse_rest("get /_cat/indices?format=json").unwrap().unwrap();
        assert_eq!(r.method, "GET");
        assert!(r.body.is_none());
        assert!(parse_rest("POST no-slash").unwrap().is_err());
        assert!(parse_rest("SELECT * FROM x").is_none()); // 不是 REST 形状
    }

    #[test]
    fn parses_simple_select_star() {
        assert_eq!(parse_select_star("SELECT * FROM logs"), Some(("logs".into(), None)));
        assert_eq!(parse_select_star("select * from logs limit 50;"), Some(("logs".into(), Some(50))));
        assert_eq!(parse_select_star("SELECT * FROM logs WHERE a=1"), None); // 带 WHERE → 走 _sql
        assert_eq!(parse_select_star("SELECT a FROM logs"), None);
    }

    #[test]
    fn flattens_hits_with_key_union() {
        let body = json!({"hits": {"hits": [
            {"_id": "1", "_source": {"a": 1, "nested": {"x": 1}}},
            {"_id": "2", "_source": {"b": "y"}}
        ]}});
        let r = parse_es_response(body, 100);
        let names: Vec<_> = r.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["_id", "a", "nested", "b"]);
        // 嵌套对象字符串化、缺失字段为 null
        assert_eq!(r.rows[0][2], json!("{\"x\":1}"));
        assert_eq!(r.rows[1][1], serde_json::Value::Null);
        assert!(!r.truncated);
    }

    #[test]
    fn parses_sql_response_shape() {
        let body = json!({"columns": [{"name": "a", "type": "long"}], "rows": [[1], [2]]});
        let r = parse_es_response(body, 100);
        assert_eq!(r.columns[0].name, "a");
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn parses_bucket_aggregations() {
        let body = json!({"aggregations": {"by_status": {"buckets": [
            {"key": "paid", "doc_count": 7, "total": {"value": 99.5}}
        ]}}});
        let r = parse_es_response(body, 100);
        let names: Vec<_> = r.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["key", "doc_count", "total"]);
        assert_eq!(r.rows[0][2], json!(99.5));
    }

    #[test]
    fn arbitrary_json_falls_back_to_status_response() {
        let r = parse_es_response(json!({"acknowledged": true}), 100);
        assert_eq!(r.columns.len(), 2);
        assert_eq!(r.columns[0].name, "status");
        assert!(r.rows[0][1].as_str().unwrap().contains("acknowledged"));
    }

    #[test]
    fn truncates_hits_to_max_rows() {
        let hits: Vec<_> = (0..5).map(|i| json!({"_id": i.to_string(), "_source": {"a": i}})).collect();
        let r = parse_es_response(json!({"hits": {"hits": hits}}), 3);
        assert_eq!(r.rows.len(), 3);
        assert!(r.truncated);
    }
}
```

`src-tauri/src/db/drivers/mod.rs` 加上 `pub mod es_query;`(与 Task 1 的 `pub mod mongo_shell;` 同列)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml es_query`
Expected: FAIL(`todo!()` panic)。

- [ ] **Step 3: 实现解析与拍平**

替换 `es_query.rs` 中的 `todo!()`:

```rust
pub fn parse_rest(input: &str) -> Option<Result<RestRequest, String>> {
    let trimmed = input.trim();
    let (first, rest) = trimmed.split_once(char::is_whitespace)?;
    let method = first.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return None;
    }
    let rest = rest.trim_start();
    let (path, body_str) = match rest.find(char::is_whitespace) {
        Some(i) => (&rest[..i], rest[i..].trim()),
        None => (rest, ""),
    };
    if !path.starts_with('/') {
        return Some(Err(ES_SYNTAX_HINT.to_string()));
    }
    let body = if body_str.is_empty() {
        None
    } else {
        match serde_json::from_str::<Value>(body_str) {
            Ok(v) => Some(v),
            Err(e) => return Some(Err(format!("Invalid JSON body: {e}"))),
        }
    };
    Some(Ok(RestRequest { method, path: path.to_string(), body }))
}

pub fn parse_select_star(input: &str) -> Option<(String, Option<u32>)> {
    let mut toks = input.trim().trim_end_matches(';').split_whitespace();
    if !toks.next()?.eq_ignore_ascii_case("select") { return None; }
    if toks.next()? != "*" { return None; }
    if !toks.next()?.eq_ignore_ascii_case("from") { return None; }
    let index = toks.next()?.trim_matches('"').trim_matches('`').to_string();
    match toks.next() {
        None => Some((index, None)),
        Some(k) if k.eq_ignore_ascii_case("limit") => {
            let n = toks.next()?.parse::<u32>().ok()?;
            if toks.next().is_some() { return None; }
            Some((index, Some(n)))
        }
        Some(_) => None,
    }
}

pub fn parse_es_response(body: Value, max_rows: u32) -> QueryResult {
    // 1) _sql 响应:columns + rows
    if let (Some(cols), Some(rows)) = (
        body.get("columns").and_then(|v| v.as_array()),
        body.get("rows").and_then(|v| v.as_array()),
    ) {
        let columns: Vec<ColumnInfo> = cols.iter().map(|c| ColumnInfo {
            name: c.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            type_name: c.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            pk: false,
        }).collect();
        let mut out: Vec<Vec<Value>> = rows.iter().filter_map(|r| r.as_array().cloned()).collect();
        let truncated = out.len() > max_rows as usize;
        out.truncate(max_rows as usize);
        return QueryResult { columns, rows: out, rows_affected: None, truncated };
    }
    // 2) hits.hits
    if let Some(hits) = body.pointer("/hits/hits").and_then(|v| v.as_array()) {
        return flatten_hits(hits, max_rows);
    }
    // 3) aggregations
    if let Some(aggs) = body.get("aggregations").or_else(|| body.get("aggs")) {
        if let Some(qr) = parse_aggregations(aggs) {
            return qr;
        }
    }
    // 4) 任意 JSON(_cat 文本已被包成 Value::String)→ status | response
    QueryResult {
        columns: vec![
            ColumnInfo { name: "status".into(), type_name: String::new(), pk: false },
            ColumnInfo { name: "response".into(), type_name: String::new(), pk: false },
        ],
        rows: vec![vec![
            Value::String("ok".into()),
            Value::String(match &body {
                Value::String(s) => s.clone(),
                other => serde_json::to_string_pretty(other).unwrap_or_default(),
            }),
        ]],
        rows_affected: None,
        truncated: false,
    }
}

/// hits → 表格:列 = `_id` + 各文档 _source 顶层 key 的有序并集;
/// 嵌套对象/数组字符串化(不递归展开);缺失字段为 Null。
fn flatten_hits(hits: &[Value], max_rows: u32) -> QueryResult {
    let truncated = hits.len() > max_rows as usize;
    let hits = &hits[..hits.len().min(max_rows as usize)];
    let mut keys: Vec<String> = vec!["_id".into()];
    let docs: Vec<serde_json::Map<String, Value>> = hits.iter().map(|hit| {
        let mut doc = serde_json::Map::new();
        doc.insert("_id".into(), hit.get("_id").cloned().unwrap_or(Value::Null));
        if let Some(src) = hit.get("_source").and_then(|s| s.as_object()) {
            for (k, v) in src {
                if !keys.contains(k) { keys.push(k.clone()); }
                doc.insert(k.clone(), v.clone());
            }
        }
        doc
    }).collect();
    let columns: Vec<ColumnInfo> = keys.iter().map(|k| ColumnInfo {
        name: k.clone(), type_name: String::new(), pk: k == "_id",
    }).collect();
    let rows: Vec<Vec<Value>> = docs.iter().map(|d| keys.iter().map(|k| match d.get(k) {
        Some(v @ (Value::Object(_) | Value::Array(_))) => Value::String(v.to_string()),
        Some(v) => v.clone(),
        None => Value::Null,
    }).collect()).collect();
    QueryResult { columns, rows, rows_affected: None, truncated }
}

/// 聚合响应:bucket 聚合每桶一行(子对象取 .value);metric 聚合一行多列。
fn parse_aggregations(aggs: &Value) -> Option<QueryResult> {
    let map = aggs.as_object()?;
    for sub in map.values() {
        let Some(buckets) = sub.get("buckets").and_then(|b| b.as_array()) else { continue };
        let mut keys: Vec<String> = Vec::new();
        let rows_maps: Vec<serde_json::Map<String, Value>> = buckets.iter()
            .filter_map(|b| b.as_object())
            .map(|b| {
                let mut row = serde_json::Map::new();
                for (k, v) in b {
                    let cell = match v {
                        Value::Object(o) => o.get("value").cloned()
                            .unwrap_or_else(|| Value::String(v.to_string())),
                        other => other.clone(),
                    };
                    if !keys.contains(k) { keys.push(k.clone()); }
                    row.insert(k.clone(), cell);
                }
                row
            })
            .collect();
        let columns = keys.iter().map(|k| ColumnInfo {
            name: k.clone(), type_name: String::new(), pk: false,
        }).collect();
        let rows = rows_maps.iter().map(|r| keys.iter()
            .map(|k| r.get(k).cloned().unwrap_or(Value::Null)).collect()).collect();
        return Some(QueryResult { columns, rows, rows_affected: None, truncated: false });
    }
    let mut columns = Vec::new();
    let mut row = Vec::new();
    for (name, sub) in map {
        columns.push(ColumnInfo { name: name.clone(), type_name: String::new(), pk: false });
        row.push(sub.get("value").cloned().unwrap_or_else(|| Value::String(sub.to_string())));
    }
    if columns.is_empty() { return None; }
    Some(QueryResult { columns, rows: vec![row], rows_affected: None, truncated: false })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml es_query`
Expected: 8 个测试全部 PASS。

- [ ] **Step 5: elasticsearch.rs 的 query() 接入分流**

把 `elasticsearch.rs` 现有 `async fn query`(77-145 行,"输入当索引名"版本)整体替换为:

```rust
    /// 查询控制台多语法入口(照 dbx execute_rest_query 的分流):
    /// 1) REST `GET/POST/PUT/DELETE /path [+ JSON body]`
    /// 2) 简单 `SELECT * FROM idx [LIMIT n]` → 直转 _search
    /// 3) 其他 SELECT → 转发 ES 原生 _sql endpoint
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use crate::db::drivers::es_query::{self, RestRequest};
        let input = sql.trim();
        if input.is_empty() {
            return Err(DbError::QueryFailed(es_query::ES_SYNTAX_HINT.into()));
        }
        let send_err = |e: reqwest::Error| DbError::QueryFailed(format!("Elasticsearch request failed: {e}"));

        if let Some(parsed) = es_query::parse_rest(input) {
            let RestRequest { method, path, body } = parsed.map_err(DbError::QueryFailed)?;
            let req = match method.as_str() {
                "GET" => self.http.get(&path),
                "POST" => self.http.post(&path),
                "PUT" => self.http.put(&path),
                _ => self.http.delete(&path),
            };
            let req = match body { Some(b) => req.json(&b), None => req };
            let resp = req.send().await.map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            // _cat 端点默认返回纯文本:先按 JSON 解析,失败则包成字符串走 status|response。
            let text = resp.text().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            let body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or(serde_json::Value::String(text));
            return Ok(es_query::parse_es_response(body, max_rows));
        }

        if let Some((index, limit)) = es_query::parse_select_star(input) {
            let size = (limit.unwrap_or(max_rows).min(max_rows) as u64) + 1;
            let body = serde_json::json!({ "from": 0, "size": size, "sort": ["_doc"] });
            let resp = self.http.post(&format!("/{}/_search", index)).json(&body).send().await
                .map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            let body: serde_json::Value = resp.json().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            return Ok(es_query::parse_es_response(body, max_rows));
        }

        if es_query::is_select(input) {
            let body = serde_json::json!({
                "query": input.trim_end_matches(';'),
                "fetch_size": max_rows,
            });
            let resp = self.http.post("/_sql?format=json").json(&body).send().await
                .map_err(send_err)?;
            let resp = check_response_query(resp).await?;
            let body: serde_json::Value = resp.json().await
                .map_err(|e| DbError::QueryFailed(format!("Elasticsearch parse error: {e}")))?;
            return Ok(es_query::parse_es_response(body, max_rows));
        }

        Err(DbError::QueryFailed(es_query::ES_SYNTAX_HINT.into()))
    }
```

同时删除 `elasticsearch.rs` 顶部不再使用的 `SearchResponse/SearchHits/SearchHit` 反序列化结构?**不删** —— `table_data()` 仍在用它们,保持不动。文件头注释第 12 行 `sql_console = false` 改为 `sql_console = true(REST / SELECT,见 query())`。

- [ ] **Step 6: 编译 + 全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/drivers/es_query.rs src-tauri/src/db/drivers/elasticsearch.rs src-tauri/src/db/drivers/mod.rs
git commit -m "feat(db): Elasticsearch 查询控制台——REST/SELECT 多语法分流与响应四级拍平"
```

---

### Task 6: capabilities 开启 sql_console

**Files:**
- Modify: `src-tauri/src/db/capabilities.rs:32-35`

- [ ] **Step 1: 写失败的测试**

`capabilities.rs` 的 `mod tests` 追加:

```rust
    #[test]
    fn mongodb_and_es_have_sql_console() {
        assert!(capabilities_for(DatabaseType::Mongodb).sql_console);
        assert!(capabilities_for(DatabaseType::Elasticsearch).sql_console);
    }
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml capabilities`
Expected: FAIL — `mongodb_and_es_have_sql_console` 断言失败。

- [ ] **Step 2: 修改 capabilities**

`capabilities.rs:32-35` 的 `Elasticsearch | Mongodb` 分支改为:

```rust
        // Mongo 用 mongo shell 语法、ES 用 REST/SELECT(见各 driver 的 query()),
        // 控制台可用 → sql_console = true。
        Elasticsearch | Mongodb => Capabilities {
            writable: true, transactions: false, schemas: db == Mongodb,
            sql_console: true, er: false, structure_edit: false,
        },
```

- [ ] **Step 3: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml capabilities`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/capabilities.rs
git commit -m "feat(db): MongoDB/Elasticsearch 开启 sql_console 能力,新建查询可用"
```

---

### Task 7: 前端刷新反馈(转圈 + 错误提示)

**Files:**
- Modify: `src/components/workbench/DbWorkbench.tsx`(refreshSchema、SchemaBrowser 传参、错误 toast)
- Modify: `src/components/workbench/SchemaBrowser.tsx`(刷新按钮转圈 + testid)
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`

- [ ] **Step 1: DbWorkbench 增加 refreshing/refreshErr 状态**

`DbWorkbench.tsx` 中 `refreshSchema`(95-101 行)替换为:

```tsx
  // Re-introspect the live schema on demand (schema "刷新" action). No-op on the mock path.
  // refreshing 驱动刷新按钮转圈;失败不再吞错,refreshErr 以 toast 显示。
  const [refreshing, setRefreshing] = useState(false)
  const [refreshErr, setRefreshErr] = useState<string | null>(null)
  function refreshSchema() {
    if (!connId || refreshing) return
    setRefreshing(true)
    setRefreshErr(null)
    getSchema(connId)
      .then(sc => setLiveSchema(sc))
      .catch(e => setRefreshErr(dbErrMsg(e)))
      .finally(() => setRefreshing(false))
  }
```

SchemaBrowser 调用处(256-260 行)加 `refreshing={refreshing}`。

在 `createErr` toast(378-384 行)旁边追加 refreshErr toast(同样式,放其后):

```tsx
        {refreshErr && (
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 80, maxWidth: 420, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
            <span>{t('workbench.refreshFailed', { message: refreshErr })}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => setRefreshErr(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
```

- [ ] **Step 2: SchemaBrowser 刷新按钮转圈**

`SchemaBrowserProps` 加 `refreshing?: boolean`;组件签名解构加 `refreshing`。header 的刷新按钮(60 行)改为:

```tsx
          <button className="icon-btn bare" data-testid="wb-refresh" style={{ width: 26, height: 26 }} title={t('workbench.refresh')} onClick={onRefresh} disabled={refreshing}>
            <Icon name="refresh-cw" size={13} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
          </button>
```

同时给"新建查询" + 按钮(59 行)加 `data-testid="wb-new-query"`(Task 9 测试用)。

- [ ] **Step 3: i18n**

`zh.json` 的 `workbench` 段加:

```json
    "refreshFailed": "刷新失败：{{message}}",
```

`en.json` 对应位置加:

```json
    "refreshFailed": "Refresh failed: {{message}}",
```

- [ ] **Step 4: 验证编译与现有测试**

Run: `npx tsc --noEmit && npx vitest run src/components/workbench/DbWorkbench.test.tsx`
Expected: 类型检查通过,现有测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/DbWorkbench.tsx src/components/workbench/SchemaBrowser.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "fix(workbench): 刷新按钮加载转圈与失败提示——不再静默无反馈"
```

---

### Task 8: TablePane / ObjectPane 组件抽取(行为不变)

**Files:**
- Create: `src/components/workbench/TablePane.tsx`
- Create: `src/components/workbench/ObjectPane.tsx`

本任务只新建组件(从 DbWorkbench 平移逻辑),DbWorkbench 在 Task 9 才切换使用——保持每次提交可编译可测。

- [ ] **Step 1: 创建 TablePane.tsx**

内容 = DbWorkbench 中表预览的 fetch(149-197 行)+ header/grid JSX(262-294 行)平移,自管 `tableTab` 子切换:

```tsx
/* 表预览 pane:统一 tab 系统中的 kind:'table' 内容。自管数据 fetch +
   data/structure 子切换,保持 mounted 时切回状态原样(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView } from '../dbviews'
import { useData } from '../../state/DataContext'
import { tablePreview, tableStructure, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, ResultColumn } from '../../services/types'

/** Initial page size for the live table preview (matches DataGrid's default). */
const PREVIEW_PAGE = 100

export interface TablePaneProps {
  conn: Connection
  connId: string | null
  caps: DbCapabilities
  schema?: string
  table: string
  density?: 'comfortable' | 'compact'
}

export function TablePane({ conn, connId, caps, schema, table, density }: TablePaneProps) {
  const { t } = useTranslation()
  const D = useData()
  // data | structure. Structure is VIEWABLE for every engine; editing gated by caps.structureEdit inside StructureView.
  const [tableTab, setTableTab] = useState('data')

  // mock 路径的行/列标签(live 路径用真实 fetch 计数)
  const mockTbl = useMemo(
    () => D.schema.schemas.find(n => n.name === schema)?.tables.find(x => x.name === table),
    [D.schema, schema, table],
  )

  // ---- Live table-data fetch(平移自 DbWorkbench,语义不变)----
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][] } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)
  const [rowKeys, setRowKeys] = useState<string[] | null>(null)

  useEffect(() => {
    if (!connId) { setLive(null); setLiveErr(null); setRowKeys(null); return }
    let cancelled = false
    setLiveErr(null)
    Promise.all([
      tablePreview(connId, schema, table, PREVIEW_PAGE, 0),
      tableStructure(connId, schema ?? '', table).catch(() => null),
    ])
      .then(([res, struct]) => {
        if (cancelled) return
        const pkNames = new Set((struct?.columns ?? []).filter(c => c.key === 'PK').map(c => c.name))
        const ctidIdx = res.columns.findIndex(c => c.name === '__ctid')
        let cols = res.columns
        let rws = res.rows
        let keys: string[] | null = null
        if (ctidIdx >= 0) {
          if (pkNames.size === 0) keys = res.rows.map(r => String(r[ctidIdx]))
          cols = res.columns.filter((_, i) => i !== ctidIdx)
          rws = res.rows.map(r => r.filter((_, i) => i !== ctidIdx))
        }
        const columns: ResultColumn[] = pkNames.size
          ? cols.map(c => (pkNames.has(c.name) ? { ...c, pk: true } : c))
          : cols
        setLive({ columns, rows: rws })
        setRowKeys(keys)
      })
      .catch(e => { if (!cancelled) { setLiveErr(dbErrMsg(e)); setRowKeys(null) } })
    return () => { cancelled = true }
  }, [connId, schema, table])

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
        <div className="row gap7" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="table-2" size={15} /></div>
          <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
            <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{connId ? (schema ? `${schema}.${table}` : table) : `public.${table}`}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{connId
              ? `${live?.rows?.length ?? 0} ${t('workbench.rowsLabel')} · ${live?.columns?.length ?? 0} ${t('workbench.colsLabel')}`
              : mockTbl ? `${mockTbl.rows} ${t('workbench.rowsLabel')} · ${mockTbl.cols} ${t('workbench.colsLabel')}` : ''}</span>
          </div>
        </div>
        <Segmented value={tableTab} onChange={setTableTab} options={[
          { value: 'data', label: t('workbench.tabData'), icon: 'table-2' },
          { value: 'structure', label: t('workbench.tabStructure'), icon: 'columns', testId: 'seg-structure' },
        ]} />
      </div>
      <div className="grow" style={{ minHeight: 0 }}>
        {tableTab === 'data' && (connId
          ? <DataGrid
              columns={(live?.columns ?? [])}
              rows={(live?.rows ?? [])}
              statusTones={D.statusTones} density={density} key={`${schema ?? ''}.${table}`}
              writable={caps.writable} connId={connId} table={table} schema={schema}
              rowKeys={rowKeys ?? undefined} keyColumn={rowKeys ? 'ctid' : undefined}
              livePreview loadError={liveErr ?? undefined} />
          : <DataGrid
              columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
              rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
              statusTones={D.statusTones} density={density} key={table} />)}
        {tableTab === 'structure' && <StructureView table={table} schema={schema} connId={connId ?? undefined} engine={conn.engine} canEdit={caps.structureEdit} key={`${schema ?? ''}.${table}`} />}
      </div>
    </>
  )
}
```

- [ ] **Step 2: 创建 ObjectPane.tsx**

内容 = DbWorkbench 的对象源码 fetch(201-219 行)+ JSX(296-323 行)平移:

```tsx
/* 对象(视图/函数/存储过程)源码预览 pane:统一 tab 系统中的 kind:'object' 内容。
   自管 objectSource fetch(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { SqlEditor } from '../dbviews/SqlEditor'
import { objectSource, dbErrMsg } from '../../services/db'

export interface ObjectPaneProps {
  connId: string | null
  schema: string
  name: string
  objKind: 'view' | 'function' | 'procedure'
}

export function ObjectPane({ connId, schema, name, objKind }: ObjectPaneProps) {
  const { t } = useTranslation()
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!connId) { setSrc(''); setErr(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setErr(null)
    setSrc('')
    objectSource(connId, schema, name, objKind)
      .then(s => { if (!cancelled) setSrc(s) })
      .catch(e => { if (!cancelled) setErr(dbErrMsg(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema, name, objKind])

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
        <div className="row gap7" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
            <Icon name={objKind === 'view' ? 'eye' : 'function-square'} size={15} />
          </div>
          <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
            <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{`${schema}.${name}`}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('dbviews.objectDefinition')}</span>
          </div>
        </div>
        <span className="mono" style={{ flex: 'none', alignSelf: 'center', height: 22, lineHeight: '22px', padding: '0 9px', borderRadius: 7, fontSize: 11, fontWeight: 600,
          color: 'var(--accent-primary)', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)' }}>
          {objKind === 'view' ? t('dbviews.objViewKind') : objKind === 'function' ? t('dbviews.objFunctionKind') : t('dbviews.objProcedureKind')}
        </span>
      </div>
      <div className="grow" style={{ minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {loading
          ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.objLoading')}</div>
          : err
            ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--signal-red)', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('dbviews.loadError', { message: err })}</div>
            : src
              ? <SqlEditor code={src} onChange={() => {}} />
              : <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.noDefinition')}</div>}
      </div>
    </>
  )
}
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit`
Expected: 通过(组件尚未被引用,允许 unused 导出)。

- [ ] **Step 4: Commit**

```bash
git add src/components/workbench/TablePane.tsx src/components/workbench/ObjectPane.tsx
git commit -m "refactor(workbench): 表预览与对象源码预览抽取为自管 fetch 的 TablePane/ObjectPane"
```

---

### Task 9: DbWorkbench 统一 tab 系统

**Files:**
- Modify: `src/components/workbench/DbWorkbench.tsx`(核心重构)
- Modify: `src/components/workbench/DbWorkbench.test.tsx`(新增 tab 行为测试)
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`(空状态文案)

- [ ] **Step 1: 写失败的测试**

`DbWorkbench.test.tsx`:顶部 mock 增补 `objectSource`,引入 `fireEvent`:

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
```

`vi.hoisted` 块加 `objectSource: vi.fn()`;services/db 的 mock 返回里加 `objectSource: h.objectSource`。两个 `beforeEach` 里加 `h.objectSource.mockReset()` 与 `h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() ...')`。

文件末尾追加:

```tsx
describe('DbWorkbench unified tabs', () => {
  const LIVE_CONN = {
    connId: 'conn-live', profileId: 'd-orders', dbType: 'postgres', name: 'prod-orders',
    capabilities: {
      writable: true, transactions: true, schemas: true,
      sqlConsole: true, er: true, structureEdit: true,
    },
  }
  const SCHEMA_WITH_FN = {
    db: 'conn',
    schemas: [{
      name: 'public', open: false,
      tables: [{ name: 'orders', rows: '', cols: 0 }],
      views: [], functions: [{ name: 'calc_total' }],
    }],
  }

  beforeEach(() => {
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([LIVE_CONN])
    h.getSchema.mockResolvedValue(SCHEMA_WITH_FN)
    h.tablePreview.mockResolvedValue({
      columns: [{ name: 'id', type: 'int', pk: true }],
      rows: [[101]],
    })
    h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() RETURNS int ...')
  })

  it('新建查询与表预览 tab 共存,切回表预览数据仍在', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    // live schema 加载后自动打开第一张表的 tab
    const tableChip = await screen.findByTestId('wbtab-table:public.orders')
    expect(await screen.findByText('101')).toBeInTheDocument()
    // 新建查询 → sql tab 出现,表 tab 仍在
    fireEvent.click(screen.getByTestId('wb-new-query'))
    expect(await screen.findByTestId('wbtab-sql:1')).toBeInTheDocument()
    expect(screen.getByTestId('wbtab-table:public.orders')).toBeInTheDocument()
    // 切回表 tab → 数据仍然渲染(pane 保持 mounted)
    fireEvent.click(tableChip)
    expect(screen.getByText('101')).toBeVisible()
  })

  it('再次单击同一表复用已开 tab,不重复新开', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
    // 侧边栏树里的表名按钮(SchemaBrowser 渲染 'orders')
    const treeItems = await screen.findAllByText('orders')
    fireEvent.click(treeItems[treeItems.length - 1])
    fireEvent.click(treeItems[treeItems.length - 1])
    expect(screen.getAllByTestId('wbtab-table:public.orders')).toHaveLength(1)
  })

  it('函数源码 tab 与查询 tab 并存', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    // 展开 Functions 分组(默认折叠)并点函数
    fireEvent.click(screen.getByText(/函数|Functions/))
    fireEvent.click(await screen.findByText('calc_total()'))
    expect(await screen.findByTestId('wbtab-object:function:public.calc_total')).toBeInTheDocument()
    expect(screen.getByTestId('wbtab-sql:1')).toBeInTheDocument()
    // 函数源码已加载
    expect(await screen.findByText(/CREATE FUNCTION calc_total/)).toBeInTheDocument()
  })

  it('关闭当前 tab 后激活相邻 tab', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const tableChip = await screen.findByTestId('wbtab-table:public.orders')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()
    expect(tableChip).toBeInTheDocument()
  })
})
```

Run: `npx vitest run src/components/workbench/DbWorkbench.test.tsx`
Expected: 新增 4 个测试 FAIL(testid 不存在)。

- [ ] **Step 2: 重构 DbWorkbench**

`DbWorkbench.tsx` 全量改写状态与渲染。关键变更(完整代码):

**(a) 移除** `obj`、`tableTab/effectiveTableTab`、`openQueries`、表数据 fetch 块(149-197 行)、对象源码 fetch 块(201-219 行)、`selectedTable/selectedSchema/tbl`,以及 `obj.type === 'table' / 'object'` 两段 JSX(由 TablePane/ObjectPane 取代)。imports 改为:

```tsx
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { SqlConsole, ERDiagram } from '../dbviews'
import { CreateObjectModal } from '../dbviews/CreateObjectModal'
import { SchemaBrowser } from './SchemaBrowser'
import { TablePane } from './TablePane'
import { ObjectPane } from './ObjectPane'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections } from '../../state/dbConnections'
import { getSchema, runQuery, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, Schema, SchemaNamespace } from '../../services/types'
```

**(b) tab 模型与状态**(替换原 obj/openQueries 状态块):

```tsx
/** 统一 tab:表预览 / 对象源码 / SQL 查询 / ER 图(照 dbx 的 QueryTab.mode 思路)。
 *  id 即身份键 → 单击侧边栏时同身份 tab 直接激活复用(findTabByIdentity)。 */
export type WorkbenchTab =
  | { id: string; kind: 'table'; schema: string; table: string }
  | { id: string; kind: 'object'; schema: string; name: string; objKind: 'view' | 'function' | 'procedure' }
  | { id: string; kind: 'sql'; qid: number }
  | { id: string; kind: 'er'; schema: string }

const tabIdOf = {
  table: (schema: string, table: string) => `table:${schema}.${table}`,
  object: (kind: string, schema: string, name: string) => `object:${kind}:${schema}.${name}`,
  sql: (qid: number) => `sql:${qid}`,
  er: (schema: string) => `er:${schema}`,
}
```

组件内(mock/demo 路径初始即一张 public.orders 表 tab,保持像素不变):

```tsx
  const [tabs, setTabs] = useState<WorkbenchTab[]>([
    { id: tabIdOf.table('public', 'orders'), kind: 'table', schema: 'public', table: 'orders' },
  ])
  const [activeId, setActiveId] = useState<string | null>(tabIdOf.table('public', 'orders'))
  const [queryN, setQueryN] = useState(0)
  const [queryInitialCode, setQueryInitialCode] = useState<Record<number, string>>({})
  const active_tab = tabs.find(tb => tb.id === activeId) ?? null
```

**(c) tab 操作**(替换 pickTable/pickObject/newQuery/closeQuery/openER):

```tsx
  /** 同身份 tab 已开 → 激活复用;否则追加并激活。 */
  function openTab(tab: WorkbenchTab) {
    setTabs(prev => (prev.some(x => x.id === tab.id) ? prev : [...prev, tab]))
    setActiveId(tab.id)
  }
  function pickTable(schema: string, name: string) {
    openTab({ id: tabIdOf.table(schema, name), kind: 'table', schema, table: name })
  }
  function pickObject(schema: string, name: string, kind: 'view' | 'function' | 'procedure') {
    openTab({ id: tabIdOf.object(kind, schema, name), kind: 'object', schema, name, objKind: kind })
  }
  function newQuery(seed?: string) {
    if (!caps.sqlConsole) return
    const id = queryN + 1
    setQueryN(id)
    if (seed != null) setQueryInitialCode(m => ({ ...m, [id]: seed }))
    openTab({ id: tabIdOf.sql(id), kind: 'sql', qid: id })
  }
  function openER(schema?: string) {
    if (!caps.er) return
    const s = schema ?? namespace.name
    openTab({ id: tabIdOf.er(s), kind: 'er', schema: s })
  }
  /** 关闭 tab;若关的是当前 tab,激活右侧相邻(无则左侧),全关后为空状态。 */
  function closeTab(id: string) {
    const idx = tabs.findIndex(x => x.id === id)
    const next = tabs.filter(x => x.id !== id)
    setTabs(next)
    if (activeId === id) setActiveId(next.length ? next[Math.min(idx, next.length - 1)].id : null)
  }
```

**(d) live schema 自动开首表**(替换原 auto-select effect,115-127 行):

```tsx
  // Live schema 加载后:剔除不存在的表 tab;若没有任何表 tab,自动打开第一张表
  // (防止 mock 默认的 public.orders 在真实库上触发"加载数据失败")。
  useEffect(() => {
    if (!connId || !liveSchema || !liveSchema.schemas.length) return
    const exists = (s: string, tname: string) => liveSchema.schemas.some(
      n => n.name === s && (n.tables.some(x => x.name === tname) || n.views.some(v => v.name === tname)),
    )
    const first = liveSchema.schemas.find(n => n.tables.length) ?? liveSchema.schemas[0]
    const firstTable = first.tables[0]
    setTabs(prev => {
      const kept = prev.filter(tb => tb.kind !== 'table' || exists(tb.schema, tb.table))
      if (kept.some(tb => tb.kind === 'table') || !firstTable) return kept
      return [...kept, { id: tabIdOf.table(first.name, firstTable.name), kind: 'table' as const, schema: first.name, table: firstTable.name }]
    })
  }, [connId, liveSchema])

  // activeId 失效(指向已被剔除的 tab)时回落到最后一个 tab。
  useEffect(() => {
    if (activeId && tabs.some(tb => tb.id === activeId)) return
    setActiveId(tabs.length ? tabs[tabs.length - 1].id : null)
  }, [tabs, activeId])
```

`namespace` 的查找(130-133 行)改用当前 active table tab:

```tsx
  const namespace: SchemaNamespace = useMemo(() => {
    const at = active_tab
    return namespaces.find(n => n.name === (at?.kind === 'table' ? at.schema : ''))
      ?? namespaces[0]
  }, [namespaces, active_tab])
```

**(e) 渲染**:SchemaBrowser 传参改为(active/sqlActive/erActive 从 active_tab 推导):

```tsx
      <SchemaBrowser onPick={pickTable} onPickObject={pickObject}
        active={active_tab?.kind === 'table' ? { schema: active_tab.schema, table: active_tab.table } : null}
        onNewQuery={() => newQuery()} onOpenER={openER} onNewObjectTemplate={onNewObjectTemplate} onRefresh={refreshSchema}
        refreshing={refreshing}
        erActive={active_tab?.kind === 'er'} sqlActive={active_tab?.kind === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er}
        schemas={connId ? namespaces : undefined} conn={connId ? conn : undefined} live={!!connId} />
```

主区(替换原 obj 分支渲染 + SQL tab strip,262-358 行)——统一 strip + 全 mounted panes:

```tsx
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {/* 统一 tab strip:表 / 对象 / 查询 / ER 平级,身份复用,全部保持 mounted。 */}
        {tabs.length > 0 && (
          <div className="row" style={{ gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', width: '100%', minWidth: 0, alignItems: 'center' }}>
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollLeft')} onClick={() => scrollTabs(-160)}><Icon name="chevron-left" size={14} /></button>
            <div ref={tabStripRef} className="row" style={{ gap: 6, flex: 1, minWidth: 0, overflowX: 'auto' }}>
              {tabs.map(tb => {
                const isActive = tb.id === activeId
                const icon = tb.kind === 'table' ? 'table-2'
                  : tb.kind === 'sql' ? 'file-code'
                  : tb.kind === 'er' ? 'network'
                  : tb.objKind === 'view' ? 'eye' : 'function-square'
                const label = tb.kind === 'table' ? tb.table
                  : tb.kind === 'sql' ? `query-${tb.qid}.sql`
                  : tb.kind === 'er' ? `ER · ${tb.schema}`
                  : tb.name
                return (
                  <div key={tb.id} data-testid={`wbtab-${tb.id}`} onClick={() => setActiveId(tb.id)} className="row gap6" title={label}
                    style={{ flex: 'none', alignItems: 'center', height: 26, padding: '0 6px 0 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                      background: isActive ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                    <Icon name={icon} size={12} /> <span className="ell mono" style={{ maxWidth: 140 }}>{label}</span>
                    <button className="icon-btn bare" data-testid={`wbtab-close-${tb.id}`} style={{ width: 18, height: 18 }} title={t('shell.close')} onClick={e => { e.stopPropagation(); closeTab(tb.id) }}><Icon name="x" size={11} /></button>
                  </div>
                )
              })}
            </div>
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollRight')} onClick={() => scrollTabs(160)}><Icon name="chevron-right" size={14} /></button>
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.newQuery')} onClick={() => newQuery()} disabled={!caps.sqlConsole}><Icon name="plus" size={14} /></button>
          </div>
        )}
        {/* panes — 全部 mounted,display 切换,切回状态原样(与原 SQL console 同款机制)。 */}
        <div className="grow" style={{ minHeight: 0, minWidth: 0, position: 'relative' }}>
          {tabs.map(tb => (
            <div key={tb.id} className="col" style={{ height: '100%', width: '100%', minHeight: 0, minWidth: 0, display: tb.id === activeId ? 'flex' : 'none' }}>
              {tb.kind === 'table' && (
                <TablePane conn={conn} connId={connId} caps={caps} schema={connId ? tb.schema : undefined} table={tb.table} density={density} />
              )}
              {tb.kind === 'object' && (
                <ObjectPane connId={connId} schema={tb.schema} name={tb.name} objKind={tb.objKind} />
              )}
              {tb.kind === 'sql' && (
                <SqlConsole density={density} fresh queryN={tb.qid} writable={caps.writable} connId={connId ?? undefined}
                  initialCode={queryInitialCode[tb.qid]} active={shown && tb.id === activeId} engine={conn.engine} />
              )}
              {tb.kind === 'er' && (
                <ERDiagram connId={connId ?? undefined} schema={tb.schema} onOpenTable={tname => pickTable(tb.schema, tname)} />
              )}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-faint)' }}>
              <Icon name="table-2" size={28} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('workbench.noTabs')}</span>
              <span style={{ fontSize: 11.5 }}>{t('workbench.noTabsHint')}</span>
            </div>
          )}
        </div>
        {/* CreateObjectModal 与 createErr/refreshErr toast 原样保留 */}
        ...
      </div>
```

注意:
- TablePane 的 `schema` 在 mock 路径传 `undefined`(原逻辑 `selectedSchema` 仅 live 用;TablePane mock 标签分支自己处理 `public.` 前缀)。但 mock tab 的 `tb.schema` 是 'public',mockTbl 查找需要 schema —— 传 `connId ? tb.schema : tb.schema` 均可,直接传 `tb.schema`,TablePane 内部 `tablePreview` 只在 connId 存在时调用,行为等价。**简化:`schema={tb.schema}`**,并让 TablePane 的 mock 标签分支用 `public.${table}` 字面(已平移)。
- `SqlConsole` 新增 `engine` prop 在 Task 10 实现;本任务先在 `SqlConsoleProps` 加可选 `engine?: string`(透传不用),保证编译。
- `WorkbenchTabs.tsx` 是 App 级 SSH tab 条,与本 strip 无关,不动。

- [ ] **Step 3: i18n 空状态文案**

`zh.json` `workbench` 段:

```json
    "noTabs": "没有打开的标签",
    "noTabsHint": "从左侧选择表、视图或函数，或新建查询",
```

`en.json`:

```json
    "noTabs": "No open tabs",
    "noTabsHint": "Pick a table, view or function from the sidebar, or open a new query",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc --noEmit && npx vitest run src/components/workbench/DbWorkbench.test.tsx`
Expected: 原有 6 个 + 新增 4 个测试全部 PASS。

- [ ] **Step 5: 全前端测试回归**

Run: `npx vitest run`
Expected: 全部 PASS(若其他测试引用了 DbWorkbench 删除的导出则按编译错误修复引用)。

- [ ] **Step 6: Commit**

```bash
git add src/components/workbench/DbWorkbench.tsx src/components/workbench/DbWorkbench.test.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(workbench): 统一 tab 系统——表/对象/查询/ER 平级共存,身份复用互不覆盖"
```

---

### Task 10: SQL 编辑器 mongo/es 适配(placeholder + 关 SQL 补全 + 结果只读)

**Files:**
- Modify: `src/components/dbviews/SqlEditor.tsx`(placeholder + plain 模式)
- Modify: `src/components/dbviews/SqlConsole.tsx`(engine 感知)
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`

- [ ] **Step 1: SqlEditor 增加 placeholder / plain props**

`SqlEditorProps` 加:

```tsx
  /** 空文档占位提示(mongo/es 控制台展示各自语法示例)。 */
  placeholder?: string
  /** true → 非 SQL 模式:不挂 lang-sql(无 SQL 补全/高亮),用于 mongo/es 控制台。 */
  plain?: boolean
```

组件签名解构加 `placeholder, plain`。import 行加 `placeholder as cmPlaceholder`:

```tsx
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
```

mount effect 中(`extensions` 数组构建处):

```tsx
    const extensions: Extension[] = [
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      autocompletion(),
      syntaxHighlighting(catioHighlight),
      catioTheme,
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      keymap.of([ /* 原样 */ ]),
      sqlCompartment.current.of(plain ? [] : sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
      EditorView.updateListener.of(/* 原样 */),
    ]
```

schema 重配置 effect(193-201 行)改为尊重 plain:

```tsx
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: sqlCompartment.current.reconfigure(
        plain ? [] : sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }),
      ),
    })
  }, [schema, plain])
```

(placeholder/plain 由 engine 决定,console 生命周期内不变 —— mount 时读取即可,无需响应式。)

- [ ] **Step 2: SqlConsole 增加 engine 感知**

`SqlConsoleProps` 加(Task 9 已加占位,这里实装):

```tsx
  /** 连接引擎(conn.engine = dbType)。mongodb/elasticsearch → plain 模式。 */
  engine?: string
```

组件内:

```tsx
  const plain = engine === 'mongodb' || engine === 'elasticsearch'
  const editorPlaceholder = engine === 'mongodb' ? t('dbviews.mongoPlaceholder')
    : engine === 'elasticsearch' ? t('dbviews.esPlaceholder')
    : undefined
```

三处接线:
1. live schema fetch effect(51-56 行)与 schemaColumns effect(69-84 行)开头条件加 plain:`if (!connId || plain) { ... return }`(mongo/es 不需要 SQL 表/列补全数据)。
2. `<SqlEditor ...>` 调用(208 行)加 `placeholder={editorPlaceholder} plain={plain}`。
3. 结果 DataGrid(220-226 行)的 `writable` 改为 `writable={writable && !plain}` —— mongo 的 `_id` 列带 pk 标记,会让结果网格误开 SQL DML 编辑(对 mongo 必然失败),plain 模式下结果只读。

- [ ] **Step 3: i18n**

`zh.json` `dbviews` 段加:

```json
    "mongoPlaceholder": "db.collection.find({ ... })  —  支持 find / countDocuments / aggregate / getIndexes / insertOne·Many / updateOne·Many / deleteOne·Many",
    "esPlaceholder": "GET /index/_search\n{ \"query\": { \"match_all\": {} } }  —  也支持 SELECT * FROM index",
```

`en.json`:

```json
    "mongoPlaceholder": "db.collection.find({ ... })  —  supports find / countDocuments / aggregate / getIndexes / insertOne·Many / updateOne·Many / deleteOne·Many",
    "esPlaceholder": "GET /index/_search\n{ \"query\": { \"match_all\": {} } }  —  SELECT * FROM index also works",
```

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/dbviews/SqlEditor.tsx src/components/dbviews/SqlConsole.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(dbviews): mongo/es 查询控制台编辑器适配——语法占位提示、关闭 SQL 补全、结果网格只读"
```

---

### Task 11: 全量验证 + 手工验收

**Files:** 无新改动(只验证;发现问题按 systematic-debugging 流程修)

- [ ] **Step 1: 全量自动化测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
npx vitest run
```

Expected: 全部 PASS。

- [ ] **Step 2: 构建应用**

Run: `npm run tauri dev`(或项目惯用的 dev 命令,见 package.json scripts)
Expected: 编译启动无错误。

- [ ] **Step 3: 手工验收清单(对照 spec 验证标准)**

MongoDB(连一个真实/容器 mongo):
1. 侧边栏 header 与 schema 菜单的"新建查询"可点,打开查询 tab,编辑器显示 mongo 语法 placeholder;
2. `db.<某集合>.find({}).limit(5)` → 表格结果;`.sort({_id: -1})` 生效;
3. `db.<集合>.countDocuments({})` → 单行 count;
4. `db.<集合>.aggregate([{$group: {_id: null, n: {$sum: 1}}}])` → 聚合结果;
5. `db.<集合>.getIndexes()` → 索引表格;
6. `db.<集合>.insertOne({t: 1})` → 受影响 1 行;`updateMany` / `deleteMany` 同理;
7. `db.<集合>.find({_id: "<复制的24位hex>"})` → 能按 ObjectId 命中;
8. 非法输入(如 `SELECT 1`)→ 错误信息含语法示例;
9. 点"刷新" → 按钮转圈;新建集合后刷新 → 树更新;断网刷新 → 失败 toast。

Elasticsearch(连一个真实/容器 ES):
1. `GET /<index>/_search` + body `{"query":{"match_all":{}}}` → 文档表格(嵌套字段字符串化);
2. `SELECT * FROM <index> LIMIT 10` → 同上;
3. `SELECT <字段> FROM <index>`(走 _sql)→ 列名正确;
4. `GET /_cat/indices?format=json` → 可读结果;`GET /_cluster/health` → status|response 两列。

统一 tab(任意引擎):
1. 表预览 → 新建查询 → 切回表 tab:数据/滚动位置仍在;
2. 同一表再次单击 → 激活原 tab 不新开;
3. 函数/存储过程 tab 与查询 tab 并存切换;
4. ER tab 与其他 tab 并存;关闭当前 tab 激活相邻;全关后显示空状态;
5. 浅色/深色主题下 tab strip 与空状态样式正常;中英文切换文案正常。

- [ ] **Step 4: 按 CLAUDE.md 规范确认所有提交已落盘**

```bash
git log --oneline -10
git status
```

Expected: 工作区干净,提交序列与各 Task 对应。

---

## Self-Review 结论

- **Spec 覆盖**:Mongo 全套命令(Task 1-4)、ES 三语法+四级拍平(Task 5)、capabilities+刷新反馈(Task 6-7)、统一 tab+身份复用+mounted(Task 8-9)、编辑器适配+i18n(Task 10)、验证标准(各 Task Step + Task 11)——无缺口。
- **占位符**:无 TBD/TODO;所有代码步骤含完整代码。
- **类型一致性**:`MongoCommand`/`json_filter_to_doc`/`json_to_doc`(Task 2/3 定义,Task 4 使用)、`RestRequest`/`parse_es_response`(Task 5 内自洽)、`WorkbenchTab`/`tabIdOf`(Task 9 内自洽)、`SqlConsoleProps.engine`(Task 9 占位、Task 10 实装)——已核对一致。
