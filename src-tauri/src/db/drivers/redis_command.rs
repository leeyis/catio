//! Redis 查询控制台的命令解析、安全分级与结果映射(纯函数,便于单测)。
//!
//! catio 是统一 db_query(sql) → Driver::query() 架构:SqlConsole 的原文输入到达
//! redis.rs::query() 后由本模块解析为 argv,分级校验,执行后(在 redis.rs)用
//! `to_query_result` 把异构的 Redis 返回值映射成表格化 QueryResult。
//! `parse_command_argv` / 分级语义照搬 dbx crates/dbx-core/src/db/redis_driver.rs。

use ::redis::Value as RedisValue;
use serde::Deserialize;
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

// ── 数据类型原生编辑:把一次编辑动作翻译成 Redis 命令 argv(纯函数,便于单测)──────
//
// 照搬 dbx redis_driver.rs 的字段操作语义(hash_set=HSET / list_push=RPUSH /
// list_set=LSET / set_add=SADD / zadd=ZADD score member / set_ttl=EXPIRE|PERSIST 等),
// 但收敛为「构建 argv 的纯函数」,真实执行复用 redis.rs::query()。这样增删改逻辑可
// 被完整单测,I/O 不进测试。

/// 一次 KV 编辑动作。前端按 key 类型发起;后端翻译成命令 argv 后执行。
/// 含 f64(zset score)故不派生 Eq。serde 以 `kind` 字段做 tag、camelCase,
/// 与前端 redisEdit.ts 的 discriminated union 对齐。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RedisEdit {
    /// string:SET key value
    SetString { key: String, value: String },
    /// hash 设置/新增字段:HSET key field value
    HashSet { key: String, field: String, value: String },
    /// hash 删除字段:HDEL key field
    HashDel { key: String, field: String },
    /// list 末尾追加:RPUSH key value
    ListPush { key: String, value: String },
    /// list 按下标改值:LSET key index value
    ListSet { key: String, index: i64, value: String },
    /// set 增加成员:SADD key member
    SetAdd { key: String, member: String },
    /// set 删除成员:SREM key member
    SetRem { key: String, member: String },
    /// zset 增加/更新成员:ZADD key score member
    #[serde(rename = "zadd")]
    ZAdd { key: String, member: String, score: f64 },
    /// zset 删除成员:ZREM key member
    #[serde(rename = "zrem")]
    ZRem { key: String, member: String },
    /// 删除整个 key:DEL key
    DelKey { key: String },
    /// 设置/清除 TTL:ttl>0 → EXPIRE key ttl;ttl<=0 → PERSIST key
    SetTtl { key: String, ttl: i64 },
}

/// 带「不可逆操作确认」的 argv 构建:DEL 整个 key 不可恢复,照 dbx 的 Confirm 档保护
/// 意图,要求调用方显式传入 confirmed=true 才放行,否则拒绝;其余编辑不受影响。
/// db_redis_edit 命令据此做后端侧确认门禁(前端再叠加确认弹窗)。
pub fn build_confirmed_edit_argv(edit: &RedisEdit, confirmed: bool) -> Result<Vec<String>, String> {
    if matches!(edit, RedisEdit::DelKey { .. }) && !confirmed {
        return Err("删除整个 key 不可恢复,需要确认后才能执行".to_string());
    }
    build_edit_argv(edit)
}

/// 把一次编辑动作翻译成 Redis 命令 argv。key 不可为空(空 key 无意义且会误操作)。
/// ZADD 的 score 用 Rust 默认浮点格式化(redis-rs 内部同样按文本传参)。
pub fn build_edit_argv(edit: &RedisEdit) -> Result<Vec<String>, String> {
    let key = match edit {
        RedisEdit::SetString { key, .. }
        | RedisEdit::HashSet { key, .. }
        | RedisEdit::HashDel { key, .. }
        | RedisEdit::ListPush { key, .. }
        | RedisEdit::ListSet { key, .. }
        | RedisEdit::SetAdd { key, .. }
        | RedisEdit::SetRem { key, .. }
        | RedisEdit::ZAdd { key, .. }
        | RedisEdit::ZRem { key, .. }
        | RedisEdit::DelKey { key }
        | RedisEdit::SetTtl { key, .. } => key,
    };
    if key.is_empty() {
        return Err("Redis 编辑操作的 key 不能为空".to_string());
    }

    Ok(match edit {
        RedisEdit::SetString { key, value } => vec!["SET".into(), key.clone(), value.clone()],
        RedisEdit::HashSet { key, field, value } => vec!["HSET".into(), key.clone(), field.clone(), value.clone()],
        RedisEdit::HashDel { key, field } => vec!["HDEL".into(), key.clone(), field.clone()],
        RedisEdit::ListPush { key, value } => vec!["RPUSH".into(), key.clone(), value.clone()],
        RedisEdit::ListSet { key, index, value } => {
            vec!["LSET".into(), key.clone(), index.to_string(), value.clone()]
        }
        RedisEdit::SetAdd { key, member } => vec!["SADD".into(), key.clone(), member.clone()],
        RedisEdit::SetRem { key, member } => vec!["SREM".into(), key.clone(), member.clone()],
        // dbx: ZADD key score member(score 在前)。
        RedisEdit::ZAdd { key, member, score } => {
            vec!["ZADD".into(), key.clone(), format_score(*score), member.clone()]
        }
        RedisEdit::ZRem { key, member } => vec!["ZREM".into(), key.clone(), member.clone()],
        RedisEdit::DelKey { key } => vec!["DEL".into(), key.clone()],
        // dbx set_ttl:正值设过期,非正值改为 PERSIST(去掉过期)。
        RedisEdit::SetTtl { key, ttl } => {
            if *ttl > 0 {
                vec!["EXPIRE".into(), key.clone(), ttl.to_string()]
            } else {
                vec!["PERSIST".into(), key.clone()]
            }
        }
    })
}

/// 把 argv 拼回一行可被 `parse_command_argv` 无损还原的命令字符串:每个参数用双引号
/// 包裹,内部的 `\` 与 `"` 转义。这样含空格/引号/换行的值也能安全地经由统一的
/// `query(sql)` 执行路径(避免新增一条绕过解析的执行通道)。
pub fn argv_to_command_string(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            let escaped = a.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 把 zset score 格式化成 Redis 可接受的字面量:整数值省略小数点(避免 "5.0"),
/// 其余按最短往返格式。
fn format_score(score: f64) -> String {
    if score.fract() == 0.0 && score.is_finite() {
        format!("{}", score as i64)
    } else {
        format!("{}", score)
    }
}

/// 从一次写命令的 QueryResult 里尽力提取「受影响计数」:许多 Redis 写命令
/// (HSET/SADD/SREM/ZADD/ZREM/HDEL/DEL/EXPIRE…)返回整数计数,经 to_query_result
/// 映射为单元格标量 `result`。这里把该标量解析回 u64(负数/非整数/OK 等无计数语义
/// 的返回值返回 None),修正 query() 路径下 rows_affected 恒为 None 的问题。
pub fn rows_affected_from_result(result: &QueryResult) -> Option<u64> {
    // 仅当结果是「单行单列的整数标量」时才视为受影响计数。
    if result.rows.len() == 1 && result.rows[0].len() == 1 {
        if let Json::Number(n) = &result.rows[0][0] {
            return n.as_u64();
        }
    }
    None
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    #[test]
    fn set_string_builds_set() {
        let argv = build_edit_argv(&RedisEdit::SetString { key: "k".into(), value: "v".into() }).unwrap();
        assert_eq!(argv, vec!["SET", "k", "v"]);
    }

    #[test]
    fn hash_set_and_del() {
        assert_eq!(
            build_edit_argv(&RedisEdit::HashSet { key: "h".into(), field: "f".into(), value: "v".into() }).unwrap(),
            vec!["HSET", "h", "f", "v"]
        );
        assert_eq!(
            build_edit_argv(&RedisEdit::HashDel { key: "h".into(), field: "f".into() }).unwrap(),
            vec!["HDEL", "h", "f"]
        );
    }

    #[test]
    fn list_push_and_set() {
        assert_eq!(
            build_edit_argv(&RedisEdit::ListPush { key: "l".into(), value: "v".into() }).unwrap(),
            vec!["RPUSH", "l", "v"]
        );
        assert_eq!(
            build_edit_argv(&RedisEdit::ListSet { key: "l".into(), index: 2, value: "v".into() }).unwrap(),
            vec!["LSET", "l", "2", "v"]
        );
    }

    #[test]
    fn set_add_and_rem() {
        assert_eq!(
            build_edit_argv(&RedisEdit::SetAdd { key: "s".into(), member: "m".into() }).unwrap(),
            vec!["SADD", "s", "m"]
        );
        assert_eq!(
            build_edit_argv(&RedisEdit::SetRem { key: "s".into(), member: "m".into() }).unwrap(),
            vec!["SREM", "s", "m"]
        );
    }

    #[test]
    fn zadd_puts_score_before_member_and_zrem() {
        // dbx 语义:ZADD key score member。
        assert_eq!(
            build_edit_argv(&RedisEdit::ZAdd { key: "z".into(), member: "m".into(), score: 1.5 }).unwrap(),
            vec!["ZADD", "z", "1.5", "m"]
        );
        // 整数分值不带小数点。
        assert_eq!(
            build_edit_argv(&RedisEdit::ZAdd { key: "z".into(), member: "m".into(), score: 3.0 }).unwrap(),
            vec!["ZADD", "z", "3", "m"]
        );
        assert_eq!(
            build_edit_argv(&RedisEdit::ZRem { key: "z".into(), member: "m".into() }).unwrap(),
            vec!["ZREM", "z", "m"]
        );
    }

    #[test]
    fn del_key() {
        assert_eq!(build_edit_argv(&RedisEdit::DelKey { key: "k".into() }).unwrap(), vec!["DEL", "k"]);
    }

    #[test]
    fn set_ttl_expire_vs_persist() {
        assert_eq!(
            build_edit_argv(&RedisEdit::SetTtl { key: "k".into(), ttl: 60 }).unwrap(),
            vec!["EXPIRE", "k", "60"]
        );
        // 非正值 → 去掉过期。
        assert_eq!(
            build_edit_argv(&RedisEdit::SetTtl { key: "k".into(), ttl: 0 }).unwrap(),
            vec!["PERSIST", "k"]
        );
        assert_eq!(
            build_edit_argv(&RedisEdit::SetTtl { key: "k".into(), ttl: -1 }).unwrap(),
            vec!["PERSIST", "k"]
        );
    }

    #[test]
    fn empty_key_rejected() {
        assert!(build_edit_argv(&RedisEdit::SetString { key: "".into(), value: "v".into() }).is_err());
        assert!(build_edit_argv(&RedisEdit::DelKey { key: "".into() }).is_err());
    }

    #[test]
    fn rows_affected_parses_integer_scalar() {
        // HSET/SADD/DEL 等返回整数计数 → to_query_result 映射成单元格 result 标量。
        let r = to_query_result(RedisValue::Int(2), 100);
        assert_eq!(rows_affected_from_result(&r), Some(2));
        let r0 = to_query_result(RedisValue::Int(0), 100);
        assert_eq!(rows_affected_from_result(&r0), Some(0));
    }

    #[test]
    fn rows_affected_none_for_non_integer_results() {
        // OK(SET)、字符串(GET)、数组(LRANGE)等无计数语义 → None。
        assert_eq!(rows_affected_from_result(&to_query_result(RedisValue::Okay, 100)), None);
        assert_eq!(
            rows_affected_from_result(&to_query_result(RedisValue::BulkString(b"v".to_vec()), 100)),
            None
        );
        let arr = RedisValue::Array(vec![RedisValue::Int(1), RedisValue::Int(2)]);
        assert_eq!(rows_affected_from_result(&to_query_result(arr, 100)), None);
        // 负数(无受影响计数语义)→ None。
        assert_eq!(rows_affected_from_result(&to_query_result(RedisValue::Int(-1), 100)), None);
    }

    #[test]
    fn del_key_requires_confirmation() {
        // DEL 不可逆 —— 未确认时构建 argv 拒绝,确认后放行。
        assert!(build_confirmed_edit_argv(&RedisEdit::DelKey { key: "k".into() }, false).is_err());
        assert_eq!(
            build_confirmed_edit_argv(&RedisEdit::DelKey { key: "k".into() }, true).unwrap(),
            vec!["DEL", "k"]
        );
    }

    #[test]
    fn non_destructive_edits_ignore_confirmation_flag() {
        // 非 DEL 操作不受 confirm 影响(confirm=false 也能构建)。
        assert_eq!(
            build_confirmed_edit_argv(&RedisEdit::SetString { key: "k".into(), value: "v".into() }, false).unwrap(),
            vec!["SET", "k", "v"]
        );
    }

    #[test]
    fn argv_command_string_round_trips_special_chars() {
        // 含空格/引号/反斜杠/换行的值,拼成命令串后必须能被 parse_command_argv 无损还原。
        let argv = vec![
            "SET".to_string(),
            "key with space".to_string(),
            "a\"b\\c\nd".to_string(),
        ];
        let cmd = argv_to_command_string(&argv);
        let parsed = parse_command_argv(&cmd).unwrap();
        assert_eq!(parsed, argv);
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
