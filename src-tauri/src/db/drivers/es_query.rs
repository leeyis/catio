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

/// 简单 `SELECT * FROM idx [LIMIT n]`(大小写不敏感,无其他子句)→ (index, limit)。
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

/// 是否 SELECT 开头(交给 ES 原生 _sql endpoint)。
pub fn is_select(input: &str) -> bool {
    input.trim_start().get(..6).map(|s| s.eq_ignore_ascii_case("select")).unwrap_or(false)
}

/// ES 响应 → QueryResult,四级 fallback(照 dbx parse_elasticsearch_response):
/// 1) _sql 响应(columns+rows) 2) hits.hits 3) aggregations 4) 任意 JSON → status|response。
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
