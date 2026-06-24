//! XLSX 导出:手写 worksheet XML + 共享样式 + zip 打包,无第三方 xlsx writer crate。
//!
//! 对齐 dbx crates/dbx-core/src/xlsx_export.rs 的 `build_xlsx_workbook` 语义:
//!   - 内联字符串单元格(t="inlineStr"),数字/布尔走 <v>,null 输出空 <c/>;
//!   - XML 转义 & < > " 并过滤非法控制字符;
//!   - 首行冻结 + autoFilter + 估算列宽;
//!   - 用 zip(CompressionMethod::Stored)打成标准 OOXML 包。
//! 拆出纯函数(escape_xml / column_name / cell_xml / worksheet_xml)便于单测;真实 .xlsx
//! 能否被 Excel 打开需真机验证。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Write};

/// 一张工作表的导出数据:表名(可选)+ 列名 + 行(每行按列顺序的 JSON 值)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorksheetData {
    #[serde(default)]
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// XML 文本转义:过滤 XML 1.0 非法控制字符,转义 & < > "。
fn escape_xml(value: &str) -> String {
    value
        .chars()
        .filter(|ch| {
            let code = *ch as u32;
            code == 9 || code == 10 || code == 13 || code >= 32
        })
        .flat_map(|ch| match ch {
            '&' => "&amp;".chars().collect::<Vec<_>>(),
            '<' => "&lt;".chars().collect::<Vec<_>>(),
            '>' => "&gt;".chars().collect::<Vec<_>>(),
            '"' => "&quot;".chars().collect::<Vec<_>>(),
            _ => vec![ch],
        })
        .collect()
}

/// 0 基列号 → Excel 列名(0→A、25→Z、26→AA)。
fn column_name(index: usize) -> String {
    let mut out = String::new();
    let mut n = index + 1;
    while n > 0 {
        let rem = (n - 1) % 26;
        out.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    out
}

/// 0 基行/列号 → 单元格引用(如 row=1,col=2 → "C2")。
fn cell_ref(row_index: usize, col_index: usize) -> String {
    format!("{}{}", column_name(col_index), row_index + 1)
}

/// 维度引用 A1:<lastCol><lastRow>;空表回落 A1。
fn sheet_range(column_count: usize, row_count: usize) -> String {
    if column_count == 0 || row_count == 0 {
        return "A1".to_string();
    }
    format!("A1:{}{}", column_name(column_count - 1), row_count)
}

/// 规范化工作表名:剔除非法字符 [ ] : * ? / \,trim 后截断到 31 字符,空则回落 Sheet1。
fn normalize_sheet_name(input: Option<&str>) -> String {
    let base = input.unwrap_or("Sheet1");
    let name: String = base
        .chars()
        .map(|ch| match ch {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => ' ',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();
    let fallback = if name.is_empty() { "Sheet1" } else { &name };
    fallback.chars().take(31).collect()
}

/// JSON 值 → 估算列宽用的文本(null 空串、bool true/false、数字/字符串原样)。
fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(v)) => if *v { "true".to_string() } else { "false".to_string() },
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 按表头 + 前 100 行估算每列字符宽度(8..=60,留 2 字符余量)。
fn estimate_column_widths(columns: &[String], rows: &[Vec<Value>]) -> Vec<usize> {
    columns
        .iter()
        .enumerate()
        .map(|(col_index, column)| {
            let values = rows.iter().take(100).map(|row| value_text(row.get(col_index)));
            let max_len = std::iter::once(column.clone())
                .chain(values)
                .map(|v| v.chars().count().min(60))
                .fold(8usize, usize::max);
            (max_len + 2).clamp(10, 60)
        })
        .collect()
}

/// 单个单元格 XML。string/对象/数组走 inlineStr,数字走 <v>(非有限回落 inlineStr),
/// bool 走 t="b"+0/1,null 输出自闭合 <c/>。`style` 非空时加 s="<n>" 属性(表头加粗)。
fn cell_xml(value: Option<&Value>, row_index: usize, col_index: usize, style: Option<usize>) -> String {
    let reference = cell_ref(row_index, col_index);
    let style_attr = style.map_or(String::new(), |s| format!(" s=\"{s}\""));
    match value {
        Some(Value::Null) | None => format!("<c r=\"{reference}\"{style_attr}/>"),
        Some(Value::Bool(v)) => {
            let bool_v = if *v { 1 } else { 0 };
            format!("<c r=\"{reference}\" t=\"b\"{style_attr}><v>{bool_v}</v></c>")
        }
        Some(Value::Number(n)) => {
            if n.as_f64().is_some_and(|f| f.is_finite()) {
                format!("<c r=\"{reference}\"{style_attr}><v>{}</v></c>", n)
            } else {
                format!(
                    "<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>",
                    escape_xml(&n.to_string())
                )
            }
        }
        Some(Value::String(s)) => {
            format!("<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>", escape_xml(s))
        }
        Some(other) => format!(
            "<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>",
            escape_xml(&other.to_string())
        ),
    }
}

/// 拼装整张 worksheet 的 XML(冻结首行 + cols 宽度 + sheetData + autoFilter)。
fn worksheet_xml(data: &XlsxWorksheetData) -> String {
    let total_rows = data.rows.len() + 1;
    let range = sheet_range(data.columns.len(), total_rows);
    let widths = estimate_column_widths(&data.columns, &data.rows);

    let cols_xml = widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            format!("<col min=\"{}\" max=\"{}\" width=\"{}\" customWidth=\"1\"/>", index + 1, index + 1, width)
        })
        .collect::<String>();

    let header_xml = format!(
        "<row r=\"1\">{}</row>",
        data.columns
            .iter()
            .enumerate()
            .map(|(index, col)| cell_xml(Some(&Value::String(col.clone())), 0, index, Some(1)))
            .collect::<String>()
    );

    let body_xml = data
        .rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let excel_row = row_index + 2;
            let cells = data
                .columns
                .iter()
                .enumerate()
                .map(|(col_index, _)| cell_xml(row.get(col_index), excel_row - 1, col_index, None))
                .collect::<String>();
            format!("<row r=\"{excel_row}\">{cells}</row>")
        })
        .collect::<String>();

    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
            "<dimension ref=\"{range}\"/>",
            "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>",
            "<sheetFormatPr defaultRowHeight=\"15\"/>",
            "<cols>{cols_xml}</cols>",
            "<sheetData>{header_xml}{body_xml}</sheetData>",
            "<autoFilter ref=\"{range}\"/>",
            "</worksheet>"
        ),
        range = range,
        cols_xml = cols_xml,
        header_xml = header_xml,
        body_xml = body_xml,
    )
}

fn content_types_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
        "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
        "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>",
        "</Types>"
    )
}

fn root_rels_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
        "</Relationships>"
    )
}

fn workbook_xml(sheet_name: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
            "<sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets>",
            "</workbook>"
        ),
        escape_xml(sheet_name)
    )
}

fn workbook_rels_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
        "</Relationships>"
    )
}

fn styles_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
        "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>",
        "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>",
        "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>",
        "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>",
        "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>",
        "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>",
        "</styleSheet>"
    )
}

/// 把工作表数据打成完整的 .xlsx 字节(标准 OOXML zip 包)。
pub fn build_xlsx_workbook(data: &XlsxWorksheetData) -> Result<Vec<u8>, String> {
    let sheet_name = normalize_sheet_name(data.sheet_name.as_deref());
    let files = vec![
        ("[Content_Types].xml", content_types_xml().to_string()),
        ("_rels/.rels", root_rels_xml().to_string()),
        ("xl/workbook.xml", workbook_xml(&sheet_name)),
        ("xl/_rels/workbook.xml.rels", workbook_rels_xml().to_string()),
        ("xl/styles.xml", styles_xml().to_string()),
        ("xl/worksheets/sheet1.xml", worksheet_xml(data)),
    ];

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for (path, content) in files {
        zip.start_file(path, options).map_err(|err| err.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|err| err.to_string())?;
    }

    let output = zip.finish().map_err(|err| err.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn column_name_maps_index_to_excel_letters() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
    }

    #[test]
    fn escape_xml_escapes_entities_and_drops_control_chars() {
        assert_eq!(escape_xml("a & b < c > d \" e"), "a &amp; b &lt; c &gt; d &quot; e");
        // 非法控制字符(\u{0001})被过滤,合法的制表/换行保留
        assert_eq!(escape_xml("x\u{0001}y\tz"), "xy\tz");
    }

    #[test]
    fn cell_xml_renders_typed_cells() {
        // 数字走 <v>,无样式
        assert_eq!(cell_xml(Some(&json!(1)), 1, 0, None), "<c r=\"A2\"><v>1</v></c>");
        // 布尔走 t="b"
        assert_eq!(cell_xml(Some(&json!(true)), 1, 2, None), "<c r=\"C2\" t=\"b\"><v>1</v></c>");
        // 字符串走 inlineStr 且转义 &
        assert_eq!(
            cell_xml(Some(&json!("Ada & Bob")), 1, 1, None),
            "<c r=\"B2\" t=\"inlineStr\"><is><t>Ada &amp; Bob</t></is></c>"
        );
        // null 自闭合
        assert_eq!(cell_xml(Some(&Value::Null), 1, 1, None), "<c r=\"B2\"/>");
        // 表头样式 s="1"
        assert_eq!(
            cell_xml(Some(&json!("id")), 0, 0, Some(1)),
            "<c r=\"A1\" t=\"inlineStr\" s=\"1\"><is><t>id</t></is></c>"
        );
    }

    #[test]
    fn worksheet_xml_contains_header_and_body_rows() {
        let data = XlsxWorksheetData {
            sheet_name: Some("Users".into()),
            columns: vec!["id".into(), "name".into()],
            rows: vec![vec![json!(1), json!("Ada")]],
        };
        let xml = worksheet_xml(&data);
        // 表头行用样式列、autoFilter 覆盖 2 行(表头 + 1 数据)
        assert!(xml.contains("<row r=\"1\"><c r=\"A1\" t=\"inlineStr\" s=\"1\"><is><t>id</t></is></c>"));
        assert!(xml.contains("<row r=\"2\"><c r=\"A2\"><v>1</v></c>"));
        assert!(xml.contains("<autoFilter ref=\"A1:B2\"/>"));
        assert!(xml.contains("state=\"frozen\""));
    }

    #[test]
    fn builds_xlsx_zip_with_sheet_data() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Users".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
            rows: vec![
                vec![json!(1), json!("Ada & Bob"), json!(true)],
                vec![json!(2), json!(null), json!(false)],
            ],
        })
        .expect("build workbook");
        let text = String::from_utf8_lossy(&workbook);

        // zip 魔术字节 "PK"
        assert_eq!(workbook[0], 0x50);
        assert_eq!(workbook[1], 0x4b);
        assert!(text.contains("[Content_Types].xml"));
        assert!(text.contains("xl/worksheets/sheet1.xml"));
        assert!(text.contains("name=\"Users\""));
        assert!(text.contains("<c r=\"A2\"><v>1</v></c>"));
        assert!(text.contains("Ada &amp; Bob"));
        assert!(text.contains("<c r=\"C2\" t=\"b\"><v>1</v></c>"));
    }

    #[test]
    fn sanitizes_invalid_sheet_name() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("bad/name:with*chars?and-a-very-long-tail".to_string()),
            columns: vec!["value".to_string()],
            rows: vec![vec![json!("ok")]],
        })
        .expect("build workbook");
        let text = String::from_utf8_lossy(&workbook);
        assert!(text.contains("name=\"bad name with chars and-a-very-\""));
    }
}
