//! Redis 查询控制台的命令解析、安全分级与结果映射(纯函数,便于单测)。
//!
//! catio 是统一 db_query(sql) → Driver::query() 架构:SqlConsole 的原文输入到达
//! redis.rs::query() 后由本模块解析为 argv,分级校验,执行后(在 redis.rs)用
//! `to_query_result` 把异构的 Redis 返回值映射成表格化 QueryResult。
//! `parse_command_argv` / 分级语义照搬 dbx crates/dbx-core/src/db/redis_driver.rs。

use ::redis::Value as RedisValue;
use serde_json::Value as Json;

use crate::db::result::{safe_i64_to_json, ColumnInfo, QueryResult};

/// 命令安全分级。dbx 用三档(Allowed/Confirm/Blocked)并在前端弹"确认"框;
/// catio 查询控制台没有确认 UI,故收敛为两档:破坏性/管理类命令直接拒绝,
/// 其余允许执行(写命令 SET/DEL 等与关系型直接执行写 SQL 的行为保持一致)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmdSafety {
    Allowed,
    Blocked,
}

/// 在控制台中禁用的破坏性/管理类命令。照 dbx 的保护意图收敛;因无确认 UI,
/// 破坏性的 FLUSHDB/FLUSHALL 也归入 Blocked 防误删整库。只读/常规写命令
/// (GET/SET/DEL/KEYS/SCAN/HGETALL/ZRANGE/TTL/TYPE…)一律 Allowed。
pub fn classify_command(cmd: &str) -> CmdSafety {
    match cmd.to_ascii_uppercase().as_str() {
        "FLUSHALL" | "FLUSHDB" | "SHUTDOWN" | "CONFIG" | "SAVE" | "BGSAVE" | "BGREWRITEAOF"
        | "SLAVEOF" | "REPLICAOF" | "MIGRATE" | "MODULE" | "SCRIPT" | "EVAL" | "EVALSHA"
        | "DEBUG" | "MONITOR" | "SWAPDB" | "FAILOVER" | "CLUSTER" | "ACL" => CmdSafety::Blocked,
        _ => CmdSafety::Allowed,
    }
}

/// 把一行命令文本拆成 argv,处理引号、转义与结尾分号(照搬 dbx parse_command_argv)。
pub fn parse_command_argv(command_text: &str) -> Result<Vec<String>, String> {
    // 去掉结尾分号,使 "HGETALL aaa;" 这类输入自然可用。
    let command_text = command_text.trim_end().trim_end_matches(';');
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut chars = command_text.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaping = false;

    while let Some(ch) = chars.next() {
        if escaping {
            current.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaping = false;
            continue;
        }
        if ch == '\\' {
            escaping = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                argv.push(std::mem::take(&mut current));
            }
            while matches!(chars.peek(), Some(next) if next.is_whitespace()) {
                chars.next();
            }
            continue;
        }
        current.push(ch);
    }

    if escaping {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Redis 命令存在未闭合的引号".to_string());
    }
    if !current.is_empty() {
        argv.push(current);
    }
    if argv.is_empty() {
        return Err("Redis 命令为空".to_string());
    }
    Ok(argv)
}

/// RedisValue → serde_json::Value(递归)。Map/Set 等高阶结构降级为数组/对象。
pub fn raw_to_json(value: &RedisValue) -> Json {
    match value {
        RedisValue::Nil => Json::Null,
        RedisValue::Int(n) => safe_i64_to_json(*n),
        RedisValue::BulkString(bytes) => Json::String(String::from_utf8_lossy(bytes).into_owned()),
        RedisValue::SimpleString(s) => Json::String(s.clone()),
        RedisValue::Okay => Json::String("OK".into()),
        RedisValue::Array(arr) | RedisValue::Set(arr) => {
            Json::Array(arr.iter().map(raw_to_json).collect())
        }
        RedisValue::Map(pairs) => Json::Array(
            pairs
                .iter()
                .map(|(k, v)| serde_json::json!({ "field": raw_to_json(k), "value": raw_to_json(v) }))
                .collect(),
        ),
        RedisValue::Double(d) => serde_json::json!(d),
        RedisValue::Boolean(b) => Json::Bool(*b),
        // 其余少见变体(VerbatimString/BigNumber/Attribute/Push/ServerError…)降级为调试串。
        other => Json::String(format!("{other:?}")),
    }
}

fn col(name: &str) -> ColumnInfo {
    ColumnInfo { name: name.into(), type_name: "string".into(), pk: false }
}

/// 把命令返回值映射成表格 QueryResult:
/// - 标量(GET/TTL/TYPE…) → 单列 `result`,一行;
/// - field-value 对数组(HGETALL/CONFIG GET 在 RESP3 的 Map) → 两列 `field`/`value`;
/// - 普通数组(MGET/LRANGE/SMEMBERS/SCAN…) → 单列 `value`,每元素一行。
/// `max_rows` 截断大数组。
pub fn to_query_result(value: RedisValue, max_rows: usize) -> QueryResult {
    let json = raw_to_json(&value);
    match json {
        Json::Array(items) => {
            // 全是 {field,value} 对象 → 两列展示(更易读)。
            let all_pairs = !items.is_empty()
                && items.iter().all(|v| {
                    v.as_object().is_some_and(|o| o.contains_key("field") && o.contains_key("value"))
                });
            let truncated = items.len() > max_rows;
            if all_pairs {
                let rows: Vec<Vec<Json>> = items
                    .into_iter()
                    .take(max_rows)
                    .map(|v| {
                        let o = v.as_object().expect("checked above");
                        vec![o["field"].clone(), o["value"].clone()]
                    })
                    .collect();
                QueryResult { columns: vec![col("field"), col("value")], rows, rows_affected: None, truncated }
            } else {
                let rows: Vec<Vec<Json>> = items.into_iter().take(max_rows).map(|v| vec![v]).collect();
                QueryResult { columns: vec![col("value")], rows, rows_affected: None, truncated }
            }
        }
        other => QueryResult { columns: vec![col("result")], rows: vec![vec![other]], rows_affected: None, truncated: false },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_command() {
        assert_eq!(parse_command_argv("GET my_key").unwrap(), vec!["GET", "my_key"]);
    }

    #[test]
    fn parses_quotes_escapes_and_trailing_semicolon() {
        assert_eq!(
            parse_command_argv(r#"SET "a b" 'c\td';"#).unwrap(),
            vec!["SET".to_string(), "a b".to_string(), "c\td".to_string()],
        );
    }

    #[test]
    fn rejects_empty_and_unterminated_quote() {
        assert!(parse_command_argv("   ").is_err());
        assert!(parse_command_argv(r#"GET "abc"#).is_err());
    }

    #[test]
    fn classifies_blocked_and_allowed() {
        assert_eq!(classify_command("get"), CmdSafety::Allowed);
        assert_eq!(classify_command("SET"), CmdSafety::Allowed);
        assert_eq!(classify_command("keys"), CmdSafety::Allowed);
        assert_eq!(classify_command("FLUSHALL"), CmdSafety::Blocked);
        assert_eq!(classify_command("flushdb"), CmdSafety::Blocked);
        assert_eq!(classify_command("Config"), CmdSafety::Blocked);
        assert_eq!(classify_command("eval"), CmdSafety::Blocked);
    }

    #[test]
    fn scalar_maps_to_single_result_cell() {
        let r = to_query_result(RedisValue::BulkString(b"hello".to_vec()), 100);
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.columns[0].name, "result");
        assert_eq!(r.rows, vec![vec![Json::String("hello".into())]]);
    }

    #[test]
    fn array_maps_to_one_row_per_element_and_truncates() {
        let arr = RedisValue::Array(vec![
            RedisValue::BulkString(b"a".to_vec()),
            RedisValue::BulkString(b"b".to_vec()),
            RedisValue::BulkString(b"c".to_vec()),
        ]);
        let r = to_query_result(arr, 2);
        assert_eq!(r.columns[0].name, "value");
        assert_eq!(r.rows.len(), 2);
        assert!(r.truncated);
    }

    #[test]
    fn map_maps_to_field_value_columns() {
        let m = RedisValue::Map(vec![
            (RedisValue::BulkString(b"name".to_vec()), RedisValue::BulkString(b"eason".to_vec())),
        ]);
        let r = to_query_result(m, 100);
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["field", "value"]);
        assert_eq!(r.rows, vec![vec![Json::String("name".into()), Json::String("eason".into())]]);
    }

    #[test]
    fn nil_becomes_null_cell() {
        let r = to_query_result(RedisValue::Nil, 100);
        assert_eq!(r.rows, vec![vec![Json::Null]]);
    }
}
