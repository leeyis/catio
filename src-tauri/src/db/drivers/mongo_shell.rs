// mongo shell 风格命令解析(语法行为照搬 dbx apps/desktop/src/lib/mongoShellCommand.ts)。
// catio 是统一 db_query(sql) → Driver::query() 架构,SqlConsole 的原文输入到达
// mongo.rs::query() 后由本模块解析为结构化 MongoCommand 再用 mongodb crate 执行。
// 本模块只有纯函数(无 IO),便于单测。
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::Value;

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

/// 从 `(` 开始提取配对括号内容(尊重字符串字面量与嵌套 ()/[]/{}),
/// 返回 (括号内内容, 右括号之后的剩余)。输入允许有前导空白。
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

/// 在深度 0 处按逗号切分(尊重字符串与嵌套括号),trim 后去掉空段。
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

/// 宽松 JSON 归一化:`ObjectId("..")` → `{"$oid":".."}`、单引号字符串 → 双引号、
/// 未加引号的 key → 加引号(含 $ 开头的操作符 key),然后 serde_json 解析。
/// 空输入归一化为空对象 {}。
/// 已知边界:字符串字面量内出现的 "ObjectId(" 也会被改写(dbx 的 regex 方案同此行为)。
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
