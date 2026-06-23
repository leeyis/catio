//! SQL 文件批量执行的可单测纯逻辑（对齐 dbx crates/dbx-core/src/sql.rs 的语句切分 +
//! sql_file_import.rs 的「逐句执行 + 进度 + 错误恢复」编排语义）。
//!
//! 本模块只放**纯函数 / 纯数据**（重点 TDD）:
//!   - `SqlStatementSplitter`：流式语句切分器，正确处理单/双引号、反引号、行/块注释、
//!     PG 的 `$$ ... $$` dollar-quote、MySQL 的 `#` 行注释，以及 `;` 分隔符。
//!   - `statement_summary`：把多行语句压成单行短摘要，供进度展示。
//!   - `decide_statement_error`：单条语句失败后的「继续 / 中止」决策（continue_on_error）。
//!
//! 真实「逐句走驱动 query 执行 + 发进度事件 + 取消」的 I/O 编排在 commands.rs 接线
//! （照搬 scan 的 CancellationToken + app.emit、db_import_table 的逐批执行），需真机验证。

use serde::{Deserialize, Serialize};

use crate::db::DatabaseType;

/// 方言相关的切分选项。当前仅 MySQL 系支持 `#` 行注释。
#[derive(Debug, Clone, Copy, Default)]
pub struct SqlParsingOptions {
    pub supports_hash_line_comments: bool,
    /// 是否启用 backslash 字符串转义（MySQL 默认开启）。开启时按「连续反斜杠奇偶」
    /// 判定引号是否被转义：奇数 = 转义（引号不闭合），偶数 = 未转义（引号闭合）。
    pub supports_backslash_escapes: bool,
}

impl SqlParsingOptions {
    pub fn for_database_type(db_type: DatabaseType) -> Self {
        Self {
            supports_hash_line_comments: matches!(db_type, DatabaseType::Mysql),
            supports_backslash_escapes: matches!(db_type, DatabaseType::Mysql),
        }
    }
}

/// 流式 SQL 语句切分器（对齐 dbx SqlStatementSplitter）。
///
/// 按字符扫描，跨 `push_chunk` 调用保留引号/注释/dollar-quote 状态，`finish` 收尾。
/// 只在「不在任何引号/注释/dollar-quote/自定义分隔符内」时把 `;` 视为语句边界；
/// 空白 / 纯注释片段不产出语句。
#[derive(Default)]
pub struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    dollar_quote_tag: Option<String>,
    previous: Option<char>,
    custom_delimiter: Option<String>,
    options: SqlParsingOptions,
}

impl SqlStatementSplitter {
    pub fn with_options(options: SqlParsingOptions) -> Self {
        Self { options, ..Self::default() }
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let chars = chunk.chars().collect::<Vec<_>>();
        let mut i = 0;

        while i < chars.len() {
            // dollar-quote 体内：原样吞字符，直到遇到收尾 tag。
            if let Some(tag) = &self.dollar_quote_tag {
                let tag_chars = tag.chars().collect::<Vec<_>>();
                if starts_with_chars(&chars, i, &tag_chars) {
                    for tag_ch in &tag_chars {
                        self.buffer.push(*tag_ch);
                        self.previous = Some(*tag_ch);
                    }
                    i += tag_chars.len();
                    self.dollar_quote_tag = None;
                    continue;
                }
                let ch = chars[i];
                self.buffer.push(ch);
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            let ch = chars[i];
            let next = chars.get(i + 1).copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if self.options.supports_hash_line_comments && ch == '#' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if let Some(tag) = dollar_quote_tag_at(&chars, i) {
                    if self.custom_delimiter.is_none() && !self.on_delimiter_line() {
                        for tag_ch in tag.chars() {
                            self.buffer.push(tag_ch);
                            self.previous = Some(tag_ch);
                        }
                        i += tag.chars().count();
                        self.dollar_quote_tag = Some(tag);
                        continue;
                    }
                }
            }

            match ch {
                '\'' if !self.in_double_quote && !self.in_backtick && !self.quote_is_escaped() => {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote && !self.in_backtick && !self.quote_is_escaped() => {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    if self.custom_delimiter.is_some() {
                        self.buffer.push(ch);
                    } else {
                        self.push_current_statement(&mut statements);
                    }
                }
                _ => self.buffer.push(ch),
            }

            // 处理 MySQL `DELIMITER xx` 命令行 + 自定义分隔符收尾。
            if !self.in_single_quote
                && !self.in_double_quote
                && !self.in_backtick
                && self.dollar_quote_tag.is_none()
            {
                if ch == '\n' {
                    let buf_end = self.buffer.len() - 1;
                    let last_line_start = self.buffer[..buf_end].rfind('\n').map_or(0, |p| p + 1);
                    let last_line = self.buffer[last_line_start..buf_end].trim();
                    if let Some(new_delim) = parse_delimiter_command(last_line) {
                        self.custom_delimiter = if new_delim == ";" { None } else { Some(new_delim.to_string()) };
                        if last_line_start > 0 {
                            let before = self.buffer[..last_line_start].trim();
                            if has_executable_sql(before, self.options) {
                                statements.push(before.to_string());
                            }
                        }
                        self.buffer.clear();
                        self.previous = None;
                        i += 1;
                        continue;
                    }
                }
                if let Some(delim) = self.custom_delimiter.clone() {
                    if self.buffer.ends_with(delim.as_str()) {
                        self.buffer.truncate(self.buffer.len() - delim.len());
                        self.push_current_statement(&mut statements);
                    }
                }
            }

            self.previous = Some(ch);
            i += 1;
        }

        statements
    }

    pub fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        let trimmed = self.buffer.trim();
        let last_line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
        if parse_delimiter_command(last_line).is_some() {
            let before = trimmed.rsplit_once('\n').map(|x| x.0).unwrap_or("").trim();
            if has_executable_sql(before, self.options) {
                statements.push(before.to_string());
            }
            self.buffer.clear();
        } else if let Some(ref delim) = self.custom_delimiter {
            if self.buffer.ends_with(delim.as_str()) {
                self.buffer.truncate(self.buffer.len() - delim.len());
            }
        }
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if has_executable_sql(statement, self.options) {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.previous = None;
    }

    /// 当前引号是否被 backslash 转义。仅在启用 backslash 转义（MySQL）时生效：
    /// 统计 buffer 末尾连续反斜杠个数，奇数表示该引号被转义（`\'`），偶数表示未转义
    /// （`\\'` 双反斜杠后引号正常闭合）。未启用时引号永不被反斜杠转义。
    fn quote_is_escaped(&self) -> bool {
        if !self.options.supports_backslash_escapes {
            return false;
        }
        let trailing_backslashes = self.buffer.chars().rev().take_while(|c| *c == '\\').count();
        trailing_backslashes % 2 == 1
    }

    fn on_delimiter_line(&self) -> bool {
        let start = self.buffer.rfind('\n').map_or(0, |p| p + 1);
        let line = self.buffer[start..].trim_start().as_bytes();
        line.len() >= 9 && line[..9].eq_ignore_ascii_case(b"delimiter")
    }
}

/// 按方言一次性切分整段 SQL（不流式，内部复用 splitter）。
pub fn split_sql_statements_for_database(sql: &str, db_type: DatabaseType) -> Vec<String> {
    let mut splitter = SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(db_type));
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    statements
}

/// SQL 文件大小上限（200 MiB，对齐 dbx sql_file.rs 的 200 MB 保护）。
/// db_sql_file_preview / db_run_sql_file 都需把整文件读入内存再切分，对几 GB 的 dump
/// 会直接 OOM，因此在读盘前用此上限拦截。
pub const MAX_SQL_FILE_BYTES: usize = 200 * 1024 * 1024;

/// 在读盘前校验 SQL 文件大小，超过 MAX_SQL_FILE_BYTES 直接报错（防 OOM）。
pub fn check_sql_file_size(len: usize) -> Result<(), String> {
    if len > MAX_SQL_FILE_BYTES {
        let cap_mb = MAX_SQL_FILE_BYTES / (1024 * 1024);
        let got_mb = len / (1024 * 1024);
        return Err(format!(
            "SQL 文件过大（{got_mb} MB），超过上限 {cap_mb} MB；请拆分文件后再执行"
        ));
    }
    Ok(())
}

/// 把语句压成单行、限长的摘要（供进度展示）。
pub fn statement_summary(statement: &str) -> String {
    const MAX_LEN: usize = 120;
    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_LEN {
        return collapsed;
    }
    collapsed.chars().take(MAX_LEN).collect()
}

/// 片段是否含可执行 SQL（即去掉所有注释/空白后还剩非空内容）。
/// 纯注释 / 纯空白 → false，不产出空语句。
fn has_executable_sql(statement: &str, options: SqlParsingOptions) -> bool {
    let chars = statement.chars().collect::<Vec<_>>();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut previous = None;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }
        if in_block_comment {
            if previous == Some('*') && ch == '/' {
                in_block_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }
        if ch == '-' && next == Some('-') {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }
        if options.supports_hash_line_comments && ch == '#' {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }
        if !ch.is_whitespace() {
            return true;
        }
        previous = Some(ch);
        i += 1;
    }
    false
}

/// `chars[start..]` 是否以 `needle` 开头。
fn starts_with_chars(chars: &[char], start: usize, needle: &[char]) -> bool {
    start + needle.len() <= chars.len() && chars[start..start + needle.len()] == *needle
}

/// 识别 PG dollar-quote 起始 tag（`$$` 或 `$name$`），返回完整 tag 字符串。
fn dollar_quote_tag_at(chars: &[char], start: usize) -> Option<String> {
    if chars.get(start) != Some(&'$') {
        return None;
    }
    match chars.get(start + 1) {
        Some('$') => return Some("$$".to_string()),
        Some(ch) if ch.is_ascii_alphabetic() || *ch == '_' => {}
        _ => return None,
    }
    let mut end = start + 2;
    while let Some(ch) = chars.get(end) {
        if *ch == '$' {
            return Some(chars[start..=end].iter().collect());
        }
        if !ch.is_ascii_alphanumeric() && *ch != '_' {
            return None;
        }
        end += 1;
    }
    None
}

/// 识别 MySQL `DELIMITER xx` 命令（不区分大小写），返回新分隔符。
fn parse_delimiter_command(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let rest = if bytes.len() > 10
        && (bytes[..10].eq_ignore_ascii_case(b"delimiter ") || bytes[..10].eq_ignore_ascii_case(b"delimiter\t"))
    {
        Some(&line[10..])
    } else {
        None
    };
    rest.map(|r| r.trim()).filter(|r| !r.is_empty())
}

// ── 执行编排用的纯数据 / 纯决策 ────────────────────────────────────────────

/// 前端发起 SQL 文件执行的请求。`continue_on_error` 决定单句失败后继续还是中止。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRequest {
    pub execution_id: String,
    pub conn_id: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

/// 进度事件状态（序列化为 camelCase 供前端判别）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileStatus {
    Started,
    Running,
    StatementDone,
    StatementFailed,
    Done,
    Error,
    Cancelled,
}

/// 单次进度推送（每条语句开始/完成/失败、整体完成/出错/取消时各发一次）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileProgress {
    pub execution_id: String,
    pub status: SqlFileStatus,
    /// 已处理到第几条语句（1-based，整体事件可为 0）。
    pub statement_index: usize,
    pub total: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: Option<String>,
}

/// 单条语句失败后的决策（纯函数，便于 TDD「继续 / 中止」分支）。
#[derive(Debug, PartialEq, Eq)]
pub struct StatementErrorDecision {
    /// 累加后的失败计数。
    pub failure_count: usize,
    /// 是否中止整个批量执行（continue_on_error=false 时为 true）。
    pub abort: bool,
}

/// 给定当前失败计数 + 是否「出错继续」策略，决定失败计数与是否中止。
/// continue_on_error=true → 失败 +1 且继续；false → 失败 +1 且中止。
pub fn decide_statement_error(failure_count: usize, continue_on_error: bool) -> StatementErrorDecision {
    StatementErrorDecision { failure_count: failure_count + 1, abort: !continue_on_error }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Vec<String> {
        split_sql_statements_for_database(sql, DatabaseType::Postgres)
    }

    #[test]
    fn splits_multiple_simple_statements() {
        let out = split("SELECT 1; SELECT 2;\nSELECT 3");
        assert_eq!(out, vec!["SELECT 1", "SELECT 2", "SELECT 3"]);
    }

    #[test]
    fn semicolon_inside_string_literal_is_not_a_separator() {
        let out = split("INSERT INTO t VALUES ('a;b'); SELECT 1;");
        assert_eq!(out, vec!["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
    }

    #[test]
    fn line_comment_with_semicolon_is_ignored() {
        let out = split("SELECT 1; -- drop; everything;\nSELECT 2;");
        assert_eq!(out, vec!["SELECT 1", "-- drop; everything;\nSELECT 2"]);
    }

    #[test]
    fn block_comment_with_semicolon_is_ignored() {
        let out = split("SELECT 1 /* a; b; c */; SELECT 2;");
        assert_eq!(out, vec!["SELECT 1 /* a; b; c */", "SELECT 2"]);
    }

    #[test]
    fn pure_comment_and_whitespace_produce_no_statements() {
        assert!(split("-- just a comment\n   \n/* block */\n").is_empty());
    }

    #[test]
    fn dollar_quoted_body_keeps_inner_semicolons() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;";
        let out = split(sql);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("$$ BEGIN RETURN 1; END; $$"));
        assert_eq!(out[1], "SELECT 1");
    }

    #[test]
    fn named_dollar_tag_is_honored() {
        let sql = "DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2;";
        let out = split(sql);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("$body$ BEGIN PERFORM 1; END $body$"));
        assert_eq!(out[1], "SELECT 2");
    }

    #[test]
    fn hash_comment_is_only_a_comment_for_mysql() {
        // MySQL: `#` 起行注释，分号被吞。
        let mysql = split_sql_statements_for_database("SELECT 1 # c; still comment\n; SELECT 2;", DatabaseType::Mysql);
        assert_eq!(mysql, vec!["SELECT 1 # c; still comment", "SELECT 2"]);
        // Postgres: `#` 不是注释，分号照常切分。
        let pg = split("SELECT 1 # not comment; SELECT 2;");
        assert_eq!(pg, vec!["SELECT 1 # not comment", "SELECT 2"]);
    }

    #[test]
    fn mysql_delimiter_command_changes_separator() {
        let sql = "DELIMITER //\nCREATE TRIGGER t BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nSELECT 3;";
        let out = split_sql_statements_for_database(sql, DatabaseType::Mysql);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("SELECT 1; SELECT 2; END"));
        assert_eq!(out[1], "SELECT 3");
    }

    #[test]
    fn streaming_chunks_join_across_boundaries() {
        let mut s = SqlStatementSplitter::with_options(SqlParsingOptions::default());
        let mut out = s.push_chunk("SELECT 'a;");
        out.extend(s.push_chunk("b'; SELECT 2"));
        out.extend(s.finish());
        assert_eq!(out, vec!["SELECT 'a;b'", "SELECT 2"]);
    }

    #[test]
    fn statement_summary_collapses_whitespace_and_truncates() {
        assert_eq!(statement_summary("SELECT\n  1,\n  2"), "SELECT 1, 2");
        let long = "x".repeat(200);
        assert_eq!(statement_summary(&long).chars().count(), 120);
    }

    #[test]
    fn mysql_double_backslash_closes_string_literal() {
        // MySQL 默认开启 backslash 转义：`'a\\'` 是「双反斜杠 + 引号」，引号应结束字符串，
        // 因此后面的 `; SELECT 1;` 是两条语句。若按 `previous == '\\'` 误判为转义引号，
        // 整个字符串不会闭合，切分会出错。
        let out = split_sql_statements_for_database(
            r"INSERT INTO t VALUES ('a\\'); SELECT 1;",
            DatabaseType::Mysql,
        );
        assert_eq!(out, vec![r"INSERT INTO t VALUES ('a\\')", "SELECT 1"]);
    }

    #[test]
    fn mysql_escaped_quote_does_not_close_string_literal() {
        // `'a\'b'` 是「转义引号」，单引号不结束字符串；整体是一条语句里的一个字符串。
        let out = split_sql_statements_for_database(
            r"INSERT INTO t VALUES ('a\'b'); SELECT 1;",
            DatabaseType::Mysql,
        );
        assert_eq!(out, vec![r"INSERT INTO t VALUES ('a\'b')", "SELECT 1"]);
    }

    #[test]
    fn check_sql_file_size_rejects_oversize() {
        assert!(check_sql_file_size(MAX_SQL_FILE_BYTES).is_ok());
        assert!(check_sql_file_size(MAX_SQL_FILE_BYTES + 1).is_err());
        assert!(check_sql_file_size(0).is_ok());
    }

    #[test]
    fn decide_statement_error_continue_vs_abort() {
        assert_eq!(decide_statement_error(0, true), StatementErrorDecision { failure_count: 1, abort: false });
        assert_eq!(decide_statement_error(2, false), StatementErrorDecision { failure_count: 3, abort: true });
    }

    #[test]
    fn progress_serializes_camel_case() {
        let p = SqlFileProgress {
            execution_id: "e1".into(),
            status: SqlFileStatus::StatementDone,
            statement_index: 1,
            total: 3,
            success_count: 1,
            failure_count: 0,
            affected_rows: 5,
            elapsed_ms: 7,
            statement_summary: "select 1".into(),
            error: None,
        };
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(v["executionId"], "e1");
        assert_eq!(v["statementIndex"], 1);
        assert_eq!(v["status"], "statementDone");
        assert!(v.get("execution_id").is_none());
    }
}
