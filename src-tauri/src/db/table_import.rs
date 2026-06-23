//! 表数据导入纯函数（文件 → 解析 → 列映射 → 批量 INSERT 语句）。
//!
//! 对齐 dbx crates/dbx-core/src/table_import.rs 的解析 + 列映射 + 语句生成语义,但
//! 复用 Catio 既有方言助手 `dialect::{quote_ident, qualified_table}` 与 `dml::value_to_sql`,
//! 与 export.rs 的 `build_insert_statements` 保持一致的标识符引用 + 字面量转义。
//!
//! 真实文件读取 / 执行由 commands.rs 接线（参考 export_file / db_export_database）。
//! 解析覆盖 CSV/TSV/JSON 与 Excel（.xlsx/.xlsm/.xls，经 calamine 走 bytes 路径）。

use std::collections::HashSet;
use std::io::Cursor;

use calamine::{open_workbook_auto_from_rs, Data, Reader};

use crate::db::DatabaseType;
use crate::db::dialect::{quote_ident, qualified_table};
use crate::db::dml::value_to_sql;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 预览默认行数上限（与 dbx DEFAULT_PREVIEW_LIMIT 一致）。
pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
/// 导入时单条多值 INSERT 的默认行数（与 dbx DEFAULT_BATCH_SIZE 一致）。
pub const DEFAULT_BATCH_SIZE: usize = 500;
/// 导入文件大小上限（200 MiB）。CSV/TSV 走流式逐行解析，JSON 需整体反序列化为
/// serde_json::Value（无法逐 item 流式），二者都会把整文件读入内存,因此在读盘前
/// 用此上限拦截过大的文件,避免「原始字节 + 展开后的行」同时驻留堆造成 OOM。
pub const MAX_IMPORT_BYTES: usize = 200 * 1024 * 1024;

/// 在读盘前校验文件大小,超过 MAX_IMPORT_BYTES 直接报错（防 OOM）。
pub fn check_import_size(len: usize) -> Result<(), String> {
    if len > MAX_IMPORT_BYTES {
        let cap_mb = MAX_IMPORT_BYTES / (1024 * 1024);
        let got_mb = len / (1024 * 1024);
        Err(format!(
            "导入文件过大（{got_mb} MB），超过上限 {cap_mb} MB；请拆分文件或先分批导入"
        ))
    } else {
        Ok(())
    }
}

/// 该引擎在 truncate 模式下能否用事务保证「清表 + 全部 INSERT」原子化。
/// 复用 capabilities 的 transactions 判定,避免与能力表脱节。
pub fn import_supports_transaction(db: DatabaseType) -> bool {
    crate::db::capabilities::capabilities_for(db).transactions
}

/// 该引擎的事务控制关键字 (BEGIN, COMMIT, ROLLBACK)。SQLServer 用 `BEGIN TRANSACTION`。
/// 仅对 import_supports_transaction == true 的引擎有意义。
pub fn transaction_keywords(db: DatabaseType) -> (&'static str, &'static str, &'static str) {
    match db {
        DatabaseType::Sqlserver => ("BEGIN TRANSACTION", "COMMIT", "ROLLBACK"),
        _ => ("BEGIN", "COMMIT", "ROLLBACK"),
    }
}

/// truncate 模式下,若引擎不支持事务则返回一条「清表后逐批 INSERT 无法回滚」的告警,
/// 供 commands 层在执行前提示用户;支持事务的引擎返回 None（会被事务包裹,无此风险）。
pub fn truncate_no_rollback_warning(db: DatabaseType) -> Option<String> {
    if import_supports_transaction(db) {
        None
    } else {
        Some(format!(
            "{db:?} 不支持事务：truncate 模式会先清空目标表再逐批 INSERT,若中途失败将无法回滚"
        ))
    }
}

/// 解析后的导入文件：列名 + 行（受 preview_limit 截断）+ 文件总行数。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub total_rows: usize,
}

/// 一批 INSERT 语句及其覆盖的行数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

/// 源列 → 目标列的映射（目标为空字符串表示跳过该列，不写入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
}

/// 导入文件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFileKind {
    Csv,
    Tsv,
    Json,
    Xlsx,
}

impl ImportFileKind {
    pub fn label(self) -> &'static str {
        match self {
            ImportFileKind::Csv => "csv",
            ImportFileKind::Tsv => "tsv",
            ImportFileKind::Json => "json",
            ImportFileKind::Xlsx => "xlsx",
        }
    }
}

/// 按扩展名识别文件类型。.xlsx/.xlsm/.xls 走 calamine 解析（open_workbook_auto_from_rs
/// 自动探测格式,xls/xlsx 共用一条路径）。
pub fn import_file_kind(path: &str) -> Result<ImportFileKind, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        Ok(ImportFileKind::Csv)
    } else if lower.ends_with(".tsv") {
        Ok(ImportFileKind::Tsv)
    } else if lower.ends_with(".json") {
        Ok(ImportFileKind::Json)
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") {
        Ok(ImportFileKind::Xlsx)
    } else {
        Err("不支持的导入文件类型".to_string())
    }
}

/// 空表头回落为 column_N（1 起），保留其余表头原样（去首尾空白）。
pub fn normalize_header(value: &str, index: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        format!("column_{}", index + 1)
    } else {
        trimmed.to_string()
    }
}

/// 单个 CSV 单元格 → JSON 值：空串视为 NULL，其余按字符串原样保留（类型转换在
/// 生成 INSERT 时由 value_to_sql 处理，导入只忠实搬运文本）。
pub fn csv_value(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_string())
    }
}

/// 解析带分隔符的文本（CSV/TSV 共用）。flexible 容忍行列数不齐。
pub fn parse_delimited_bytes(bytes: &[u8], delimiter: u8, preview_limit: usize) -> Result<ParsedImportFile, String> {
    let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).flexible(true).from_reader(bytes);
    let columns = reader
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .enumerate()
        .map(|(index, header)| normalize_header(header, index))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("导入文件没有列".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(record.get(index).map(csv_value).unwrap_or(Value::Null));
        }
        rows.push(row);
    }

    Ok(ParsedImportFile { columns, rows, total_rows })
}

pub fn parse_csv_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_delimited_bytes(bytes, b',', preview_limit)
}

/// 解析 JSON：对象数组（按并集取列）或二维数组（列名 column_N）。单个对象视为单行。
pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let items = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => return Err("JSON 导入必须是对象或数组".to_string()),
    };
    if items.is_empty() {
        return Err("导入文件没有数据行".to_string());
    }

    if items.iter().all(|item| item.is_object()) {
        let mut columns = Vec::new();
        for item in &items {
            if let Some(obj) = item.as_object() {
                for key in obj.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            return Err("导入文件没有列".to_string());
        }
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let obj = item.as_object().expect("checked object JSON row");
                columns.iter().map(|column| obj.get(column).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    if items.iter().all(|item| item.is_array()) {
        let max_cols = items.iter().filter_map(|item| item.as_array().map(|row| row.len())).max().unwrap_or(0);
        if max_cols == 0 {
            return Err("导入文件没有列".to_string());
        }
        let columns = (0..max_cols).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let arr = item.as_array().expect("checked array JSON row");
                (0..max_cols).map(|index| arr.get(index).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    Err("JSON 行必须全为对象或全为数组".to_string())
}

/// Excel 单元格 → JSON 值：空单元格视为 NULL；字符串复用 csv_value（空串亦为 NULL）;
/// 数字/布尔保留为对应 JSON 类型；日期/时长按字符串忠实搬运（类型转换交给下游
/// value_to_sql，与 CSV/JSON 路径一致）。
pub fn xlsx_cell_value(cell: &Data) -> Value {
    match cell {
        Data::Empty => Value::Null,
        Data::String(s) => csv_value(s),
        Data::Float(n) => serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null),
        Data::Int(n) => Value::Number((*n).into()),
        Data::Bool(v) => Value::Bool(*v),
        Data::DateTime(v) => Value::String(v.to_string()),
        Data::DateTimeIso(v) => Value::String(v.clone()),
        Data::DurationIso(v) => Value::String(v.clone()),
        Data::Error(v) => Value::String(v.to_string()),
    }
}

/// Excel 表头单元格 → 文本标签（供 normalize_header 处理空表头回落）。
pub fn xlsx_cell_label(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => n.to_string(),
        Data::Int(n) => n.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v.to_string(),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => v.to_string(),
    }
}

/// 解析 Excel 字节（.xlsx/.xlsm/.xls）：取首个工作表,首行为表头,其余为数据行。
/// 用 Cursor 包裹字节走 open_workbook_auto_from_rs（自动探测格式,无需落盘）,与
/// CSV/JSON 的 bytes 解析风格一致。列映射 + 批量 INSERT 由下游共用路径处理。
pub fn parse_xlsx_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    // Cursor<&[u8]> 已满足 open_workbook_auto_from_rs 的 Read + Seek + Clone 约束,
    // 直接借用切片,避免 .to_vec() 把整文件再拷一份(否则峰值内存翻倍,削弱 check_import_size 的体积闸门)。
    let cursor = Cursor::new(bytes);
    let mut workbook = open_workbook_auto_from_rs(cursor).map_err(|e| e.to_string())?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "工作簿没有工作表".to_string())?;
    let range = workbook.worksheet_range(&sheet_name).map_err(|e| e.to_string())?;
    let mut rows_iter = range.rows();
    let header = rows_iter.next().ok_or_else(|| "导入文件没有数据行".to_string())?;
    let columns = header
        .iter()
        .enumerate()
        .map(|(index, cell)| normalize_header(&xlsx_cell_label(cell), index))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("导入文件没有列".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for source_row in rows_iter {
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(source_row.get(index).map(xlsx_cell_value).unwrap_or(Value::Null));
        }
        rows.push(row);
    }

    Ok(ParsedImportFile { columns, rows, total_rows })
}

/// 按文件类型解析字节（CSV/TSV/JSON/Xlsx）。文件读取在 commands.rs 接线。
pub fn parse_import_bytes(kind: ImportFileKind, bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    match kind {
        ImportFileKind::Csv => parse_csv_bytes(bytes, preview_limit),
        ImportFileKind::Tsv => parse_delimited_bytes(bytes, b'\t', preview_limit),
        ImportFileKind::Json => parse_json_bytes(bytes, preview_limit),
        ImportFileKind::Xlsx => parse_xlsx_bytes(bytes, preview_limit),
    }
}

/// 校验并解析列映射 → (源列下标, 目标列名) 列表。
///
/// - 目标列为空串的映射视为「跳过」，直接忽略（对齐 dbx 前端 IMPORT_SKIP_TARGET）。
/// - 源列必须存在于解析结果中,否则报错。
/// - 同一目标列被映射多次报错。
/// - 全部跳过（无有效映射）报错。
pub fn mapping_indexes(
    data: &ParsedImportFile,
    mappings: &[ImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        if mapping.target_column.trim().is_empty() {
            continue; // 跳过未映射的源列
        }
        let source_index = data
            .columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("源列不存在: {}", mapping.source_column))?;
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!("目标列被重复映射: {}", mapping.target_column));
        }
        mapped.push((source_index, mapping.target_column.clone()));
    }
    if mapped.is_empty() {
        return Err("没有可导入的列映射".to_string());
    }
    Ok(mapped)
}

/// 由解析结果 + 列映射生成批量 INSERT 语句。
///
/// 复用 export::build_insert_statements 的拼装风格（quote_ident + value_to_sql +
/// qualified_table），按 batch_size 分批，每批一条多值 VALUES,语句以分号结尾。
#[allow(clippy::too_many_arguments)]
pub fn build_import_insert_batches(
    db: DatabaseType,
    has_schemas: bool,
    schema: Option<&str>,
    table: &str,
    data: &ParsedImportFile,
    mappings: &[ImportColumnMapping],
    batch_size: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    let mapped = mapping_indexes(data, mappings)?;
    let columns = mapped.iter().map(|(_, target)| target.clone()).collect::<Vec<_>>();
    let tbl = qualified_table(db, has_schemas, schema, table);
    let cols = columns.iter().map(|c| quote_ident(db, c)).collect::<Vec<_>>().join(", ");
    let batch = batch_size.max(1);

    let batches = data
        .rows
        .chunks(batch)
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|row| {
                    let cells = mapped
                        .iter()
                        .map(|(source_index, _)| {
                            value_to_sql(row.get(*source_index).unwrap_or(&Value::Null))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({cells})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            ImportSqlBatch {
                sql: format!("INSERT INTO {tbl} ({cols}) VALUES {values};"),
                row_count: chunk.len(),
            }
        })
        .collect::<Vec<_>>();

    Ok(batches)
}

/// 清空目标表的语句（Truncate 模式预先执行）。SQLite 无 TRUNCATE，用 DELETE。
pub fn truncate_sql(db: DatabaseType, has_schemas: bool, schema: Option<&str>, table: &str) -> String {
    let tbl = qualified_table(db, has_schemas, schema, table);
    match db {
        DatabaseType::Sqlite => format!("DELETE FROM {tbl}"),
        _ => format!("TRUNCATE TABLE {tbl}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_file_kind_by_extension() {
        assert_eq!(import_file_kind("a/b/data.csv").unwrap(), ImportFileKind::Csv);
        assert_eq!(import_file_kind("DATA.TSV").unwrap(), ImportFileKind::Tsv);
        assert_eq!(import_file_kind("x.json").unwrap(), ImportFileKind::Json);
        assert_eq!(import_file_kind("x.xlsx").unwrap(), ImportFileKind::Xlsx);
        assert!(import_file_kind("x.txt").is_err());
    }

    /// base64 编码的最小 xlsx（openpyxl 生成）：Sheet1，首行表头 id/name/score/active，
    /// 两条数据行覆盖 int/string/float/bool 与空单元格,用于驱动真实 calamine 解析路径。
    const SAMPLE_XLSX_B64: &str = concat!(
        "UEsDBBQAAAAIAChh11xGx01IlQAAAM0AAAAQAAAAZG9jUHJvcHMvYXBwLnhtbE3PTQvCMAwG4L9SdreZih6kDkQ9ip68zy51hbYp",
        "bYT67+0EP255ecgboi6JIia2mEXxLuRtMzLHDUDWI/o+y8qhiqHke64x3YGMsRoPpB8eA8OibdeAhTEMOMzit7Dp1C5GZ3XPlkJ3",
        "sjpRJsPiWDQ6sScfq9wcChDneiU+ixNLOZcrBf+LU8sVU57mym/8ZAW/B7oXUEsDBBQAAAAIAChh11zLBmzB7gAAACsCAAARAAAA",
        "ZG9jUHJvcHMvY29yZS54bWzNks9KxDAQh19Fcm8nbaVg6Oay4klBcEHxFpLZ3WDzh2Sk3be3rbtdRB/AY2Z++eYbmE5HoUPC5xQi",
        "JrKYb0bX+yx03LAjURQAWR/RqVxOCT819yE5RdMzHSAq/aEOCDXnLTgkZRQpmIFFXIlMdkYLnVBRSGe80Ss+fqZ+gRkN2KNDTxmq",
        "sgIm54nxNPYdXAEzjDC5/F1AsxKX6p/YpQPsnByzXVPDMJRDs+SmHSp4e3p8WdYtrM+kvMbpV7aCThE37DL5tdne7x6YrHndFrwt",
        "6mbHbwW/E1X7Prv+8LsKu2Ds3v5j44ug7ODXXcgvUEsDBBQAAAAIAChh11yZXJwjEAYAAJwnAAATAAAAeGwvdGhlbWUvdGhlbWUx",
        "LnhtbO1aW3PaOBR+76/QeGf2bQvGNoG2tBNzaXbbtJmE7U4fhRFYjWx5ZJGEf79HNhDLlg3tkk26mzwELOn7zkVH5+g4efPuLmLo",
        "hoiU8nhg2S/b1ru3L97gVzIkEUEwGaev8MAKpUxetVppAMM4fckTEsPcgosIS3gUy9Zc4FsaLyPW6rTb3VaEaWyhGEdkYH1eLGhA",
        "0FRRWm9fILTlHzP4FctUjWWjARNXQSa5iLTy+WzF/NrePmXP6TodMoFuMBtYIH/Ob6fkTlqI4VTCxMBqZz9Wa8fR0kiAgsl9lAW6",
        "Sfaj0xUIMg07Op1YznZ89sTtn4zK2nQ0bRrg4/F4OLbL0otwHATgUbuewp30bL+kQQm0o2nQZNj22q6RpqqNU0/T933f65tonAqN",
        "W0/Ta3fd046Jxq3QeA2+8U+Hw66JxqvQdOtpJif9rmuk6RZoQkbj63oSFbXlQNMgAFhwdtbM0gOWXin6dZQa2R273UFc8FjuOYkR",
        "/sbFBNZp0hmWNEZynZAFDgA3xNFMUHyvQbaK4MKS0lyQ1s8ptVAaCJrIgfVHgiHF3K/99Ze7yaQzep19Os5rlH9pqwGn7bubz5P8",
        "c+jkn6eT101CznC8LAnx+yNbYYcnbjsTcjocZ0J8z/b2kaUlMs/v+QrrTjxnH1aWsF3Pz+SejHIju932WH32T0duI9epwLMi15RG",
        "JEWfyC265BE4tUkNMhM/CJ2GmGpQHAKkCTGWoYb4tMasEeATfbe+CMjfjYj3q2+aPVehWEnahPgQRhrinHPmc9Fs+welRtH2Vbzc",
        "o5dYFQGXGN80qjUsxdZ4lcDxrZw8HRMSzZQLBkGGlyQmEqk5fk1IE/4rpdr+nNNA8JQvJPpKkY9psyOndCbN6DMawUavG3WHaNI8",
        "ev4F+Zw1ChyRGx0CZxuzRiGEabvwHq8kjpqtwhErQj5iGTYacrUWgbZxqYRgWhLG0XhO0rQR/FmsNZM+YMjszZF1ztaRDhGSXjdC",
        "PmLOi5ARvx6GOEqa7aJxWAT9nl7DScHogstm/bh+htUzbCyO90fUF0rkDyanP+kyNAejmlkJvYRWap+qhzQ+qB4yCgXxuR4+5Xp4",
        "CjeWxrxQroJ7Af/R2jfCq/iCwDl/Ln3Ppe+59D2h0rc3I31nwdOLW95GblvE+64x2tc0LihjV3LNyMdUr5Mp2DmfwOz9aD6e8e36",
        "2SSEr5pZLSMWkEuBs0EkuPyLyvAqxAnoZFslCctU02U3ihKeQhtu6VP1SpXX5a+5KLg8W+Tpr6F0PizP+Txf57TNCzNDt3JL6raU",
        "vrUmOEr0scxwTh7LDDtnPJIdtnegHTX79l125COlMFOXQ7gaQr4Dbbqd3Do4npiRuQrTUpBvw/npxXga4jnZBLl9mFdt59jR0fvn",
        "wVGwo+88lh3HiPKiIe6hhpjPw0OHeXtfmGeVxlA0FG1srCQsRrdguNfxLBTgZGAtoAeDr1EC8lJVYDFbxgMrkKJ8TIxF6HDnl1xf",
        "49GS49umZbVuryl3GW0iUjnCaZgTZ6vK3mWxwVUdz1Vb8rC+aj20FU7P/lmtyJ8MEU4WCxJIY5QXpkqi8xlTvucrScRVOL9FM7YS",
        "lxi84+bHcU5TuBJ2tg8CMrm7Oal6ZTFnpvLfLQwJLFuIWRLiTV3t1eebnK56Inb6l3fBYPL9cMlHD+U751/0XUOufvbd4/pukztI",
        "TJx5xREBdEUCI5UcBhYXMuRQ7pKQBhMBzZTJRPACgmSmHICY+gu98gy5KRXOrT45f0Usg4ZOXtIlEhSKsAwFIRdy4+/vk2p3jNf6",
        "LIFthFQyZNUXykOJwT0zckPYVCXzrtomC4Xb4lTNuxq+JmBLw3punS0n/9te1D20Fz1G86OZ4B6zh3OberjCRaz/WNYe+TLfOXDb",
        "Ot4DXuYTLEOkfsF9ioqAEativrqvT/klnDu0e/GBIJv81tuk9t3gDHzUq1qlZCsRP0sHfB+SBmOMW/Q0X48UYq2msa3G2jEMeYBY",
        "8wyhZjjfh0WaGjPVi6w5jQpvQdVA5T/b1A1o9g00HJEFXjGZtjaj5E4KPNz+7w2wwsSO4e2LvwFQSwMEFAAAAAgAKGHXXIiejuqR",
        "AQAAmQMAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWx1U9uOmzAQ/RXkD4gJKNt2BUi7iar2oVK0q7bPDgzBWttD7Ulo/74e",
        "kiASJU/M5cw5c2xTDOg/QgdAyV9rXChFR9Q/SxnqDqwKC+zBxU6L3iqKqd/L0HtQzThkjczS9ElapZ2oirG29VWBBzLawdYn4WCt",
        "8v9eweBQiqW4FN70viMuyKro1R7egX72Wx8zObE02oILGl3ioS3Fy/J5kzN+BPzSMIRZnLCTHeIHJ9+bUqS8EBioiRlU/BxhDcYw",
        "UVzjz5lTTJI8OI8v7F9H79HLTgVYo/mtG+pK8VkkDbTqYOgNh29w9rOaFtwoUlXhcUg8+6yKmgPWjjjt+Hzeyce6jkJU6aaQFOU5",
        "k/UZ/foI7ZSFO/j1I3yo0d8b2DwaOJ3X9YSMZiZH2eQoGyn4/o/VspDH+f7ZA/qXRt1bf071ZbG6Jtucursboaut8mmrfEaVXROt",
        "5738RiSfiaQ3InJ2sfxofyi/1y4kBto4ky4+rUTiTw/hlBD246PfIRHaMezivwOeAbHfItIl4Xc4/Y3Vf1BLAwQUAAAACAAoYddc",
        "fPOj3FECAAD2CQAADQAAAHhsL3N0eWxlcy54bWzdVtuK2zAQ/RXhD6iTmDVxSfJQQ2ChLQu7D31VYjkR6OLK8pL06zsjOXazq1ko",
        "fatN8MwcnbkbZ9P7qxLPZyE8u2hl+m129r77nOf98Sw07z/ZThhAWus096C6U953TvCmR5JW+WqxKHPNpcl2GzPovfY9O9rB+G22",
        "yPLdprVmtiyzaICjXAv2ytU2q7mSByfDWa6lukbzCg1Hq6xjHlIRSAZL/yvCy6hhlqMfLY11aMxjhPDowalUakpglUXDbtNx74Uz",
        "e1ACJxjfQWyUX64dZHBy/LpcPWQzITwgyMG6Rri7OqNpt1Gi9UBw8nTGp7ddjqD3VoPQSH6yhoccboxRALdHodQzjuhHe+f70rLY",
        "68cG28yw1JsICY1idBMV9P+nt+j7n92yTr5a/2WAakzQfw7WiycnWnkJ+qW9jz+FDoncRZ+sDJdjm33HnVOzC3YYpPLSjNpZNo0w",
        "72oD954fYKnv/MP5RrR8UP5lArfZLH8TjRx0NZ16wrLGU7P8FWe4LKfNhFjSNOIimnpU3ekQRAYCRB0vJLxF9uFKIxQnYmkEMSoO",
        "lQHFiSwqzv9Uz5qsJ2JUbusksiY5a5ITWSmkDjcVJ82p4EpXWlVFUZZUR+s6mUFN9a0s8Zf2RuWGDCoORvq7XtPTpjfk4z2gZvrR",
        "hlCV0ptIVUr3GpF035BRVelpU3GQQU2B2h2Mn46DO5XmFAVOlcqNeoNppKooBHcxvaNlSXSnxDs9H+otKYqqSiOIpTMoCgrBt5FG",
        "qAwwBwopivAdfPM9ym/fqXz+p7f7DVBLAwQUAAAACAAoYddcl4q7HMAAAAATAgAACwAAAF9yZWxzLy5yZWxznZK5bsMwDEB/xdCe",
        "MAfQIYgzZfEWBPkBVqIP2BIFikWdv6/apXGQCxl5PTwS3B5pQO04pLaLqRj9EFJpWtW4AUi2JY9pzpFCrtQsHjWH0kBE22NDsFos",
        "PkAuGWa3vWQWp3OkV4hc152lPdsvT0FvgK86THFCaUhLMw7wzdJ/MvfzDDVF5UojlVsaeNPl/nbgSdGhIlgWmkXJ06IdpX8dx/aQ",
        "0+mvYyK0elvo+XFoVAqO3GMljHFitP41gskP7H4AUEsDBBQAAAAIAChh11wauhurMAEAACMCAAAPAAAAeGwvd29ya2Jvb2sueG1s",
        "jVHRSsNAEPyVcB9gUtGCpemLRS2IFit9vySbZundbdjbtNqvd5MQLPji097OLMPM3PJMfCyIjsmXdyHmphFpF2kaywa8jTfUQlCm",
        "JvZWdOVDGlsGW8UGQLxLb7NsnnqLwayWk9aW0+uFBEpBCgr2wB7hHH/5fk1OGLFAh/Kdm+HtwCQeA3q8QJWbzCSxofMLMV4oiHW7",
        "ksm53MxGYg8sWP6Bd73JT1vEARFbfFg1kpt5poI1cpThYtC36vEEejxundATOgFeW4Fnpq7FcOhlNEV6FWPoYZpjiQv+T41U11jC",
        "msrOQ5CxRwbXGwyxwTaaJFgPuRksDoF0bqoxnKirq6p4gUrwphr9TaYqqDFA9aY6UXEtqNxy0o9B5/bufvagRXTOPSr2Hl7JVlPG",
        "6X9WP1BLAwQUAAAACAAoYddcJB6boq0AAAD4AQAAGgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxztZE9DoMwDIWvEuUANVCp",
        "QwVMXVgrLhAF8yMSEsWuCrcvhQGQOnRhsp4tf+/JTp9oFHduoLbzJEZrBspky+zvAKRbtIouzuMwT2oXrOJZhga80r1qEJIoukHY",
        "M2Se7pminDz+Q3R13Wl8OP2yOPAPMLxd6KlFZClKFRrkTMJotjbBUuLLTJaiqDIZiiqWcFog4skgbWlWfbBPTrTneRc390WuzeMJ",
        "rt8McHh0/gFQSwMEFAAAAAgAKGHXXGWQeZIZAQAAzwMAABMAAABbQ29udGVudF9UeXBlc10ueG1srZNNTsMwEIWvEmVbJS4sWKCm",
        "G2ALXXABY08aq/6TZ1rS2zNO2kqgEhWFTax43rzPnpes3o8RsOid9diUHVF8FAJVB05iHSJ4rrQhOUn8mrYiSrWTWxD3y+WDUMET",
        "eKooe5Tr1TO0cm+peOl5G03wTZnAYlk8jcLMakoZozVKEtfFwesflOpEqLlz0GBnIi5YUIqrhFz5HXDqeztASkZDsZGJXqVjleit",
        "QDpawHra4soZQ9saBTqoveOWGmMCqbEDIGfr0XQxTSaeMIzPu9n8wWYKyMpNChE5sQR/x50jyd1VZCNIZKaveCGy9ez7QU5bg76R",
        "zeP9DGk35IFiWObP+HvGF/8bzvERwu6/P7G81k4af+aL4T9efwFQSwECFAAUAAAACAAoYddcRsdNSJUAAADNAAAAEAAAAAAAAAAA",
        "AAAAgAEAAAAAZG9jUHJvcHMvYXBwLnhtbFBLAQIUABQAAAAIAChh11zLBmzB7gAAACsCAAARAAAAAAAAAAAAAACAAcMAAABkb2NQ",
        "cm9wcy9jb3JlLnhtbFBLAQIUABQAAAAIAChh11yZXJwjEAYAAJwnAAATAAAAAAAAAAAAAACAAeABAAB4bC90aGVtZS90aGVtZTEu",
        "eG1sUEsBAhQAFAAAAAgAKGHXXIiejuqRAQAAmQMAABgAAAAAAAAAAAAAALaBIQgAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBL",
        "AQIUABQAAAAIAChh11x886PcUQIAAPYJAAANAAAAAAAAAAAAAACAAegJAAB4bC9zdHlsZXMueG1sUEsBAhQAFAAAAAgAKGHXXJeK",
        "uxzAAAAAEwIAAAsAAAAAAAAAAAAAAIABZAwAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAKGHXXBq6G6swAQAAIwIAAA8AAAAAAAAA",
        "AAAAAIABTQ0AAHhsL3dvcmtib29rLnhtbFBLAQIUABQAAAAIAChh11wkHpuirQAAAPgBAAAaAAAAAAAAAAAAAACAAaoOAAB4bC9f",
        "cmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUABQAAAAIAChh11xlkHmSGQEAAM8DAAATAAAAAAAAAAAAAACAAY8PAABbQ29udGVu",
        "dF9UeXBlc10ueG1sUEsFBgAAAAAJAAkAPgIAANkQAAAAAA==",
    );

    fn sample_xlsx_bytes() -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(SAMPLE_XLSX_B64).expect("valid base64 fixture")
    }

    #[test]
    fn parses_xlsx_headers_and_rows() {
        let bytes = sample_xlsx_bytes();
        let parsed = parse_xlsx_bytes(&bytes, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "score", "active"]);
        assert_eq!(parsed.total_rows, 2);
        // 第 1 行：int 1 → Number, string "Ada", float 9.5 → Number, bool true。
        assert_eq!(parsed.rows[0], vec![json!(1.0), json!("Ada"), json!(9.5), json!(true)]);
        // 第 2 行：空 name 单元格 → NULL。
        assert_eq!(parsed.rows[1][0], json!(2.0));
        assert_eq!(parsed.rows[1][1], Value::Null);
        assert_eq!(parsed.rows[1][3], json!(false));
    }

    #[test]
    fn xlsx_preview_limit_truncates_rows_but_counts_total() {
        let bytes = sample_xlsx_bytes();
        let parsed = parse_xlsx_bytes(&bytes, 1).unwrap();
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.total_rows, 2);
    }

    #[test]
    fn detects_xlsx_kind_by_extension() {
        assert_eq!(import_file_kind("book.xlsx").unwrap(), ImportFileKind::Xlsx);
        assert_eq!(import_file_kind("BOOK.XLS").unwrap(), ImportFileKind::Xlsx);
        assert_eq!(import_file_kind("data.xlsm").unwrap(), ImportFileKind::Xlsx);
        assert_eq!(ImportFileKind::Xlsx.label(), "xlsx");
    }

    #[test]
    fn parse_import_bytes_routes_xlsx() {
        let bytes = sample_xlsx_bytes();
        let parsed = parse_import_bytes(ImportFileKind::Xlsx, &bytes, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "score", "active"]);
    }

    #[test]
    fn parses_csv_headers_and_preview_rows() {
        let parsed = parse_csv_bytes(b"id,name,active\n1,Ada,true\n2,,false\n", 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![json!("1"), json!("Ada"), json!("true")]);
        // 空字段 → NULL
        assert_eq!(parsed.rows[1], vec![json!("2"), Value::Null, json!("false")]);
    }

    #[test]
    fn preview_limit_truncates_rows_but_counts_total() {
        let parsed = parse_csv_bytes(b"id\n1\n2\n3\n4\n", 2).unwrap();
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.total_rows, 4);
    }

    #[test]
    fn normalizes_empty_header_to_column_n() {
        let parsed = parse_csv_bytes(b"id,,c\n1,2,3\n", 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "column_2", "c"]);
    }

    #[test]
    fn parses_tsv_with_tab_delimiter() {
        let parsed = parse_delimited_bytes(b"id\tname\n1\tAda\n", b'\t', 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.rows[0], vec![json!("1"), json!("Ada")]);
    }

    #[test]
    fn parses_json_array_of_objects_with_union_columns() {
        let parsed = parse_json_bytes(br#"[{"id":1,"name":"Ada"},{"id":2,"active":true}]"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![json!(1), json!("Ada"), Value::Null]);
        assert_eq!(parsed.rows[1], vec![json!(2), Value::Null, json!(true)]);
    }

    #[test]
    fn parses_json_array_of_arrays_with_indexed_columns() {
        let parsed = parse_json_bytes(br#"[[1,"Ada"],[2,"Linus"]]"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.rows[1], vec![json!(2), json!("Linus")]);
    }

    #[test]
    fn json_single_object_is_one_row() {
        let parsed = parse_json_bytes(br#"{"id":7}"#, 10).unwrap();
        assert_eq!(parsed.columns, vec!["id"]);
        assert_eq!(parsed.total_rows, 1);
    }

    #[test]
    fn empty_json_array_errors() {
        assert!(parse_json_bytes(b"[]", 10).is_err());
    }

    #[test]
    fn mapping_skips_empty_targets_and_reorders() {
        let data = ParsedImportFile {
            columns: vec!["id".into(), "name".into(), "junk".into()],
            rows: vec![],
            total_rows: 0,
        };
        let mappings = vec![
            ImportColumnMapping { source_column: "id".into(), target_column: "user_id".into() },
            ImportColumnMapping { source_column: "junk".into(), target_column: "".into() },
            ImportColumnMapping { source_column: "name".into(), target_column: "display_name".into() },
        ];
        let mapped = mapping_indexes(&data, &mappings).unwrap();
        assert_eq!(mapped, vec![(0, "user_id".to_string()), (1, "display_name".to_string())]);
    }

    #[test]
    fn mapping_rejects_unknown_source_and_duplicate_target() {
        let data = ParsedImportFile { columns: vec!["a".into(), "b".into()], rows: vec![], total_rows: 0 };
        assert!(mapping_indexes(
            &data,
            &[ImportColumnMapping { source_column: "nope".into(), target_column: "x".into() }]
        )
        .is_err());
        assert!(mapping_indexes(
            &data,
            &[
                ImportColumnMapping { source_column: "a".into(), target_column: "dup".into() },
                ImportColumnMapping { source_column: "b".into(), target_column: "dup".into() },
            ]
        )
        .is_err());
    }

    #[test]
    fn mapping_all_skipped_errors() {
        let data = ParsedImportFile { columns: vec!["a".into()], rows: vec![], total_rows: 0 };
        assert!(mapping_indexes(
            &data,
            &[ImportColumnMapping { source_column: "a".into(), target_column: "".into() }]
        )
        .is_err());
    }

    #[test]
    fn builds_batched_inserts_from_mapped_columns() {
        let data = ParsedImportFile {
            columns: vec!["id".into(), "name".into(), "ignored".into()],
            rows: vec![
                vec![json!("1"), json!("Ada"), json!("x")],
                vec![json!("2"), json!("O'Hara"), json!("y")],
                vec![json!("3"), Value::Null, json!("z")],
            ],
            total_rows: 3,
        };
        let mappings = vec![
            ImportColumnMapping { source_column: "id".into(), target_column: "user_id".into() },
            ImportColumnMapping { source_column: "name".into(), target_column: "display_name".into() },
        ];
        let batches = build_import_insert_batches(
            DatabaseType::Postgres,
            true,
            Some("public"),
            "users",
            &data,
            &mappings,
            2,
        )
        .unwrap();
        assert_eq!(
            batches,
            vec![
                ImportSqlBatch {
                    sql: r#"INSERT INTO "public"."users" ("user_id", "display_name") VALUES ('1', 'Ada'), ('2', 'O''Hara');"#.to_string(),
                    row_count: 2,
                },
                ImportSqlBatch {
                    sql: r#"INSERT INTO "public"."users" ("user_id", "display_name") VALUES ('3', NULL);"#.to_string(),
                    row_count: 1,
                },
            ]
        );
    }

    #[test]
    fn mysql_inserts_use_backtick_quoting() {
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")]],
            total_rows: 1,
        };
        let mappings = vec![ImportColumnMapping { source_column: "id".into(), target_column: "id".into() }];
        let batches =
            build_import_insert_batches(DatabaseType::Mysql, false, None, "t", &data, &mappings, 500).unwrap();
        assert_eq!(batches[0].sql, "INSERT INTO `t` (`id`) VALUES ('1');");
    }

    #[test]
    fn zero_batch_size_falls_back_to_one_per_statement() {
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")], vec![json!("2")]],
            total_rows: 2,
        };
        let mappings = vec![ImportColumnMapping { source_column: "id".into(), target_column: "id".into() }];
        let batches =
            build_import_insert_batches(DatabaseType::Sqlite, false, None, "t", &data, &mappings, 0).unwrap();
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn truncate_sql_uses_delete_on_sqlite() {
        assert_eq!(truncate_sql(DatabaseType::Sqlite, false, None, "t"), "DELETE FROM \"t\"");
        assert_eq!(truncate_sql(DatabaseType::Mysql, false, None, "t"), "TRUNCATE TABLE `t`");
    }

    #[test]
    fn target_column_with_injection_chars_is_escaped() {
        // 防注入回归：目标列名含反引号/双引号/分号时，quote_ident 必须转义，
        // 生成的 SQL 不能因此被截断或注入额外语句。
        let data = ParsedImportFile {
            columns: vec!["id".into()],
            rows: vec![vec![json!("1")]],
            total_rows: 1,
        };
        // 双引号方言（Postgres）：目标列含双引号 + 分号注入尝试。
        let pg_mappings = vec![ImportColumnMapping {
            source_column: "id".into(),
            target_column: r#"evil"; DROP TABLE users;--"#.into(),
        }];
        let pg = build_import_insert_batches(
            DatabaseType::Postgres, false, None, "t", &data, &pg_mappings, 500,
        )
        .unwrap();
        // 双引号被加倍转义为 ""，整个列名仍被包在一对引号内 → 不会逃逸出标识符。
        assert_eq!(
            pg[0].sql,
            r#"INSERT INTO "t" ("evil""; DROP TABLE users;--") VALUES ('1');"#
        );

        // 反引号方言（MySQL）：目标列含反引号。
        let my_mappings = vec![ImportColumnMapping {
            source_column: "id".into(),
            target_column: "ev`il".into(),
        }];
        let my = build_import_insert_batches(
            DatabaseType::Mysql, false, None, "t", &data, &my_mappings, 500,
        )
        .unwrap();
        assert_eq!(my[0].sql, "INSERT INTO `t` (`ev``il`) VALUES ('1');");
    }

    #[test]
    fn import_size_guard_rejects_oversize_files() {
        // 超过上限的文件应被拒绝（避免一次性把整文件 + 展开行同时驻留堆）。
        assert!(check_import_size(MAX_IMPORT_BYTES).is_ok());
        assert!(check_import_size(MAX_IMPORT_BYTES + 1).is_err());
        assert!(check_import_size(0).is_ok());
    }

    #[test]
    fn transaction_keywords_match_dialect() {
        // 支持事务的引擎用 BEGIN/COMMIT/ROLLBACK 包裹 truncate + INSERT。
        let (begin, commit, rollback) = transaction_keywords(DatabaseType::Sqlserver);
        assert_eq!((begin, commit, rollback), ("BEGIN TRANSACTION", "COMMIT", "ROLLBACK"));
        let (begin, _, _) = transaction_keywords(DatabaseType::Postgres);
        assert_eq!(begin, "BEGIN");
    }

    #[test]
    fn truncate_no_rollback_warning_only_for_non_transactional() {
        // 不支持事务的引擎（ClickHouse 等）在 truncate 模式下必须给出「无回滚」告警。
        assert!(truncate_no_rollback_warning(DatabaseType::Clickhouse).is_some());
        assert!(truncate_no_rollback_warning(DatabaseType::Redis).is_some());
        // 支持事务的引擎不需要告警（会被事务包裹）。
        assert!(truncate_no_rollback_warning(DatabaseType::Postgres).is_none());
        assert!(truncate_no_rollback_warning(DatabaseType::Sqlite).is_none());
    }
}
