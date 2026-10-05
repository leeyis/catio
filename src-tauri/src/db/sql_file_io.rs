//! Bounded SQL-file preparation and execution shared by transport adapters.
//! Inspired by DBX's chunked file reader; unlike direct streaming writes, validate the
//! complete source into a private, auto-deleted spool BEFORE executing any statement.
use std::{collections::VecDeque, path::Path, sync::Arc, time::Instant};
use ring::digest::{Context, SHA256};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use super::{DbError, DatabaseType, driver::Driver, query_session::TransactionState,
    sql_file::{self as sf, SqlParsingOptions, SqlStatementSplitter, SqlFileProgress, SqlFileRequest, SqlFileStatus}};

pub const READ_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_STATEMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
enum Encoding { Utf8, Utf16Le, Utf16Be }
impl Encoding {
    fn name(self) -> &'static str { match self { Self::Utf8=>"UTF-8", Self::Utf16Le=>"UTF-16LE", Self::Utf16Be=>"UTF-16BE" } }
}

/// Strict incremental decoder. Never replaces invalid bytes with U+FFFD: that can
/// silently change identifiers or SQL values. UTF-16 requires a BOM; UTF-32 is rejected.
#[derive(Default)]
struct Decoder { pending: Vec<u8>, encoding: Option<Encoding>, high: Option<u16> }
impl Decoder {
    fn push(&mut self, bytes: &[u8], last: bool) -> Result<String, DbError> {
        self.pending.extend_from_slice(bytes);
        if self.encoding.is_none() {
            if self.pending.len() < 4 && !last { return Ok(String::new()); }
            let p=&self.pending;
            if p.starts_with(&[0,0,0xfe,0xff]) || p.starts_with(&[0xff,0xfe,0,0]) {
                return Err(DbError::Io("UTF-32 SQL files are unsupported; save as UTF-8 or BOM-marked UTF-16".into()));
            }
            let (encoding, bom) = if p.starts_with(&[0xef,0xbb,0xbf]) {(Encoding::Utf8,3)}
                else if p.starts_with(&[0xff,0xfe]) {(Encoding::Utf16Le,2)}
                else if p.starts_with(&[0xfe,0xff]) {(Encoding::Utf16Be,2)} else {(Encoding::Utf8,0)};
            self.encoding=Some(encoding); self.pending.drain(..bom);
        }
        let error=||DbError::Io("Invalid or incomplete SQL file encoding; save as UTF-8 or BOM-marked UTF-16".into());
        match self.encoding.unwrap() {
            Encoding::Utf8 => {
                let valid=match std::str::from_utf8(&self.pending) {
                    Ok(_) => self.pending.len(),
                    Err(e) if e.error_len().is_none() && !last => e.valid_up_to(),
                    Err(_) => return Err(error()),
                };
                let text=std::str::from_utf8(&self.pending[..valid]).map_err(|_|error())?.to_owned();
                self.pending.drain(..valid);
                // A decoded NUL often means BOM-less UTF-16. Do not send truncated SQL to drivers.
                if text.contains('\0') { return Err(error()); }
                Ok(text)
            }
            encoding => {
                let count=self.pending.len()/2*2;
                let mut text=String::with_capacity(count);
                for pair in self.pending[..count].chunks_exact(2) {
                    let unit=if matches!(encoding,Encoding::Utf16Le) {u16::from_le_bytes([pair[0],pair[1]])} else {u16::from_be_bytes([pair[0],pair[1]])};
                    if let Some(high)=self.high.take() {
                        if !(0xdc00..=0xdfff).contains(&unit) {return Err(error());}
                        let scalar=0x10000+(((high as u32-0xd800)<<10)|(unit as u32-0xdc00));
                        text.push(char::from_u32(scalar).ok_or_else(error)?);
                    } else if (0xd800..=0xdbff).contains(&unit) {self.high=Some(unit);}
                    else {if unit==0 {return Err(error());} text.push(char::from_u32(unit as u32).ok_or_else(error)?);}
                }
                self.pending.drain(..count);
                if last && (!self.pending.is_empty() || self.high.is_some()) {return Err(error());}
                Ok(text)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub size_bytes: u64,
    pub statement_count: usize,
    pub fingerprint: String,
    pub encoding: String,
}

pub struct PreparedSqlFile { pub preview: SqlFilePreview, spool: tokio::fs::File, remaining: usize }
impl PreparedSqlFile {
    pub async fn next_statement(&mut self) -> Result<Option<String>, DbError> {
        if self.remaining==0 {return Ok(None);}
        let len=self.spool.read_u32_le().await.map_err(io_error)? as usize;
        if len>MAX_STATEMENT_BYTES {return Err(DbError::Io("Invalid SQL statement spool".into()));}
        let mut bytes=vec![0;len]; self.spool.read_exact(&mut bytes).await.map_err(io_error)?;
        self.remaining-=1;
        String::from_utf8(bytes).map(Some).map_err(|_|DbError::Io("Invalid SQL statement spool encoding".into()))
    }
}
fn io_error(error: std::io::Error) -> DbError {DbError::Io(error.to_string())}
fn check_statement_budget(bytes: usize) -> Result<(), DbError> {
    if bytes>MAX_STATEMENT_BYTES {Err(DbError::Io("SQL statement exceeds the 8 MiB limit; split extended INSERT statements".into()))} else {Ok(())}
}

pub async fn prepare_sql_file(path: &Path, db: DatabaseType, cancel: &CancellationToken,
    progress: impl FnMut(u64)) -> Result<PreparedSqlFile, DbError> {
    if cancel.is_cancelled() {return Err(DbError::Cancelled);}
    let file=tokio::fs::File::open(path).await.map_err(io_error)?;
    let metadata=file.metadata().await.map_err(io_error)?;
    if !metadata.is_file() {return Err(DbError::Io("SQL input must be a regular file".into()));}
    sf::check_sql_file_size(usize::try_from(metadata.len()).unwrap_or(usize::MAX)).map_err(DbError::Io)?;
    prepare_reader(file, path.file_name().and_then(|s|s.to_str()).unwrap_or("query.sql").to_owned(), db, cancel, progress).await
}

/// Reads bounded chunks; count and byte limits are enforced against actual reads,
/// not just metadata (which can race with a growing file). The private spool owns cleanup.
async fn prepare_reader(mut reader: impl AsyncRead+Unpin, name: String, db: DatabaseType,
    cancel: &CancellationToken, mut progress: impl FnMut(u64)) -> Result<PreparedSqlFile,DbError> {
    let mut spool=tokio::fs::File::from_std(tempfile::tempfile().map_err(io_error)?);
    let mut splitter=SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(db));
    let mut decoder=Decoder::default(); let mut digest=Context::new(&SHA256);
    let mut chunk=vec![0;READ_CHUNK_BYTES]; let mut size=0u64; let mut total=0usize;
    loop {
        let count=tokio::select!{biased; _=cancel.cancelled()=>return Err(DbError::Cancelled), read=reader.read(&mut chunk)=>read.map_err(io_error)?};
        size+=count as u64;
        sf::check_sql_file_size(usize::try_from(size).unwrap_or(usize::MAX)).map_err(DbError::Io)?;
        digest.update(&chunk[..count]);
        let text=decoder.push(&chunk[..count],count==0)?;
        let mut statements=VecDeque::from(splitter.push_chunk(&text));
        check_statement_budget(splitter.buffered_bytes())?;
        if count==0 {statements.extend(std::mem::take(&mut splitter).finish());}
        while let Some(statement)=statements.pop_front() {
            if cancel.is_cancelled() {return Err(DbError::Cancelled);}
            check_statement_budget(statement.len())?;
            spool.write_u32_le(statement.len() as u32).await.map_err(io_error)?;
            spool.write_all(statement.as_bytes()).await.map_err(io_error)?;
            total+=1;
        }
        progress(size);
        if count==0 {break;}
    }
    if cancel.is_cancelled() {return Err(DbError::Cancelled);}
    spool.flush().await.map_err(io_error)?;
    spool.rewind().await.map_err(io_error)?;
    let fingerprint=digest.finish().as_ref().iter().map(|b|format!("{b:02x}")).collect();
    Ok(PreparedSqlFile{preview:SqlFilePreview{file_name:name,size_bytes:size,statement_count:total,fingerprint,
        encoding:decoder.encoding.unwrap_or(Encoding::Utf8).name().into()},spool,remaining:total})
}

/// Caller registers the scoped execution guard BEFORE any preparation await.
/// Driver futures are awaited to a real receipt even when cancel is requested.
/// Never cancel by dropping a write future and pretending it rolled back.
pub async fn execute_sql_file(driver: Arc<dyn Driver>, req: &SqlFileRequest, cancel: CancellationToken,
    mut emit: impl FnMut(SqlFileProgress)) -> SqlFileProgress {
    let started=Instant::now();
    let mut receipt=SqlFileProgress {execution_id:req.execution_id.clone(),status:SqlFileStatus::Started,
        statement_index:0,total:0,success_count:0,failure_count:0,affected_rows:0,elapsed_ms:0,
        statement_summary:String::new(),error:None,phase:Some("preparing".into()),bytes_read:Some(0)};
    emit(receipt.clone());
    let result=async {
        if matches!(driver.db_type(),DatabaseType::Redis|DatabaseType::Mongodb|DatabaseType::Elasticsearch) {
            return Err(DbError::Unsupported("SQL files require a SQL database driver".into()));
        }
        let mut last_emit=Instant::now();
        let mut prepared=prepare_sql_file(Path::new(&req.file_path),driver.db_type(),&cancel,|read|{
            receipt.bytes_read=Some(read);
            if last_emit.elapsed().as_millis()>=100 {receipt.elapsed_ms=started.elapsed().as_millis();emit(receipt.clone());last_emit=Instant::now();}
        }).await?;
        receipt.total=prepared.preview.statement_count; receipt.bytes_read=Some(prepared.preview.size_bytes);
        if req.expected_fingerprint.as_deref().is_some_and(|expected|expected!=prepared.preview.fingerprint) {
            return Err(DbError::Io("SQL file changed after preview; preview it again before executing".into()));
        }
        if cancel.is_cancelled() {return Err(DbError::Cancelled);}
        // Dedicated physical sessions preserve TEMP tables/explicit transactions without
        // leaking transaction state into other tabs or executing BEGIN on a pooled client.
        let isolated=driver.capabilities().query_sessions;
        let runner=if isolated {driver.fork_query_session().await?} else {driver.clone()};
        let execution=async {
            receipt.phase=Some("executing".into());
            while let Some(statement)=prepared.next_statement().await? {
                if cancel.is_cancelled() {return Err(DbError::Cancelled);}
                receipt.statement_index+=1; receipt.statement_summary=sf::statement_summary(&statement);
                receipt.status=SqlFileStatus::Running;receipt.elapsed_ms=started.elapsed().as_millis();emit(receipt.clone());
                match runner.query_cancellable(&statement,0,None,cancel.clone()).await {
                    Ok(result)=>{receipt.success_count+=1;receipt.affected_rows=receipt.affected_rows.saturating_add(result.rows_affected.unwrap_or(0));receipt.status=SqlFileStatus::StatementDone;receipt.error=None;}
                    Err(error)=>{
                        if cancel.is_cancelled() || matches!(error,DbError::Cancelled) {return Err(error);}
                        receipt.failure_count+=1;receipt.status=SqlFileStatus::StatementFailed;receipt.error=Some(error.to_string());
                        receipt.elapsed_ms=started.elapsed().as_millis();emit(receipt.clone());
                        if !req.continue_on_error {return Err(error);}
                        continue;
                    }
                }
                receipt.elapsed_ms=started.elapsed().as_millis();emit(receipt.clone());
            }
            if cancel.is_cancelled() {return Err(DbError::Cancelled);}
            Ok(())
        }.await;
        if isolated {
            let state=runner.transaction_state().await;
            let close=runner.close_query_session().await;
            if let Err(error)=close {return Err(DbError::QueryFailed(format!("SQL file session cleanup failed; verify the database before retrying: {error}")));}
            if execution.is_ok() && !matches!(state,Ok(TransactionState::Idle)) {
                return Err(DbError::QueryFailed("SQL file did not finish with a confirmed idle transaction; session closed, verify committed changes before retrying".into()));
            }
        }
        execution
    }.await;
    receipt.status=match &result {Ok(())=>SqlFileStatus::Done,Err(DbError::Cancelled)=>SqlFileStatus::Cancelled,Err(_)=>SqlFileStatus::Error};
    receipt.error=result.err().map(|e|e.to_string());
    receipt.phase=None;receipt.elapsed_ms=started.elapsed().as_millis();emit(receipt.clone());receipt
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoding_every_byte_preserves_utf8_and_bom_marked_utf16() {
        let text="SELECT '中文😀';\nSELECT 'a';";
        let mut cases=vec![text.as_bytes().to_vec(),[vec![0xef,0xbb,0xbf],text.as_bytes().to_vec()].concat()];
        for be in [false,true] {let mut bytes=if be {vec![0xfe,0xff]} else {vec![0xff,0xfe]};for u in text.encode_utf16(){bytes.extend(if be{u.to_be_bytes()}else{u.to_le_bytes()});} cases.push(bytes);}
        for bytes in cases {for width in 1..=7 {let mut decoder=Decoder::default();let mut actual=String::new();for chunk in bytes.chunks(width){actual+=&decoder.push(chunk,false).unwrap();}actual+=&decoder.push(&[],true).unwrap();assert_eq!(actual,text);}}
    }
    #[test]
    fn invalid_encoding_is_never_lossily_replaced() {
        for bytes in [vec![0xef,0xbb],vec![0xff],vec![0xff,0xfe,0x00,0xd8],vec![0xfe,0xff,0xdc,0x00],vec![0xff,0xfe,0x41],vec![b'S',0,b'E',0],vec![0xff,0xfe,0,0,0x41,0,0,0]] {
            let mut decoder=Decoder::default();assert!(decoder.push(&bytes,true).is_err(),"{bytes:?}");
        }
    }
    #[tokio::test]
    async fn stream_spools_without_executing_and_cancellation_during_read_stops() {
        let source=format!("{}\nSELECT '中文'; SELECT 2;", "-- comment; not SQL\n".repeat(5000));
        let cancel=CancellationToken::new();
        let mut prepared=prepare_reader(source.as_bytes(),"qa.sql".into(),DatabaseType::Sqlite,&cancel, |_|{}).await.unwrap();
        assert_eq!(prepared.preview.statement_count,2);assert_eq!(prepared.preview.size_bytes,source.len() as u64);
        assert!(prepared.next_statement().await.unwrap().unwrap().ends_with("SELECT '中文'"));
        assert_eq!(prepared.next_statement().await.unwrap().unwrap(),"SELECT 2");assert!(prepared.next_statement().await.unwrap().is_none());
        assert!(matches!(prepare_reader(source.as_bytes(),"qa.sql".into(),DatabaseType::Sqlite,&cancel, |_|cancel.cancel()).await,Err(DbError::Cancelled)));
    }
    #[tokio::test]
    async fn statement_budget_is_enforced_and_truncated_utf8_is_rejected_before_use() {
        let source=format!("SELECT '{}';","a".repeat(MAX_STATEMENT_BYTES));
        assert!(prepare_reader(source.as_bytes(),"qa.sql".into(),DatabaseType::Sqlite,&CancellationToken::new(), |_|{}).await.is_err());
        assert!(prepare_reader(&b"SELECT 1; SELECT '\xe4\xb8"[..],"qa.sql".into(),DatabaseType::Sqlite,&CancellationToken::new(), |_|{}).await.is_err());
    }
}
