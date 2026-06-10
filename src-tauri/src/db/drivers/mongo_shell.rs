// mongo shell 风格命令解析(语法行为照搬 dbx apps/desktop/src/lib/mongoShellCommand.ts)。
// catio 是统一 db_query(sql) → Driver::query() 架构,SqlConsole 的原文输入到达
// mongo.rs::query() 后由本模块解析为结构化 MongoCommand 再用 mongodb crate 执行。
// 本模块只有纯函数(无 IO),便于单测。
use serde_json::Value;

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
