use serde::Serialize;
use serde_json::Value;

/// 查询结果列（区别于前端 schema 浏览的 TableCol）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub pk: bool,
}

/// 通用查询结果：行=与 columns 对齐的有序值数组。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// 超出 JS 安全整数范围的 i64 转成字符串，避免前端精度丢失（照搬 dbx db/mod.rs）。
pub fn safe_i64_to_json(v: i64) -> Value {
    if (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&v) {
        Value::Number(v.into())
    } else {
        Value::String(v.to_string())
    }
}

/// 二进制 → "0x..." 十六进制字符串。
pub fn binary_to_json(bytes: &[u8]) -> Value {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    Value::String(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_i64_becomes_string() {
        assert_eq!(safe_i64_to_json(42), Value::Number(42.into()));
        assert_eq!(safe_i64_to_json(i64::MAX), Value::String(i64::MAX.to_string()));
    }
    #[test]
    fn binary_is_hex() {
        assert_eq!(binary_to_json(&[0xde, 0xad]), Value::String("0xdead".into()));
    }
}
