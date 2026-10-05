//! Browser SQL files accept bounded uploaded bytes, NEVER client-provided server paths.
//! Temporary input and parsed statement spools are private, request-owned and auto-deleted.
use std::io::Write;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
use crate::{server::AppState, db::{sql_file::SqlFileRequest, sql_file_io::{prepare_sql_file, execute_sql_file}}};

const MAX_WEB_SQL_BYTES: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Upload {
    conn_id: String, file_name: String, data_base64: String,
    execution_id: Option<String>, expected_fingerprint: Option<String>,
    #[serde(default)] continue_on_error: bool,
}

pub async fn handle(st: &AppState, owner: &str, execute: bool, args: Value) -> Result<Value,String> {
    let upload:Upload=serde_json::from_value(args).map_err(|_|"Invalid SQL file upload request (server paths are not accepted)")?;
    if upload.file_name.len()>1024 {return Err("SQL file name is too long".into());}
    if upload.data_base64.len()>(MAX_WEB_SQL_BYTES+2)/3*4 {return Err("Browser SQL files are limited to 8 MiB".into());}
    let driver=st.conns.get(&upload.conn_id).await.ok_or("connection not found")?;
    // Only a successfully registered job may proceed to decoding or I/O.
    let guard=if execute {Some(st.sql_files.register(&upload.conn_id,upload.execution_id.as_deref().ok_or("executionId required")?).map_err(|e|e.to_string())?)} else {None};
    if execute && !upload.expected_fingerprint.as_deref().is_some_and(|s|s.len()==64 && s.bytes().all(|b|b.is_ascii_hexdigit())) {
        return Err("Preview the uploaded SQL file before execution".into());
    }
    let bytes=STANDARD.decode(&upload.data_base64).map_err(|_|"Invalid SQL upload encoding")?;
    if bytes.len()>MAX_WEB_SQL_BYTES {return Err("Browser SQL files are limited to 8 MiB".into());}
    let name=upload.file_name.rsplit(['/', '\\']).next().filter(|s|!s.is_empty()).unwrap_or("query.sql").to_owned();
    // Dropping the HTTP response must not drop an in-flight write future. The task
    // retains the cancellation guard, input file and physical cleanup until receipt.
    let hub=st.ws.clone();let owner=owner.to_owned();
    tokio::spawn(async move {
        let file=tokio::task::spawn_blocking(move || {
            let mut file=tempfile::NamedTempFile::new()?;file.write_all(&bytes)?;file.flush()?;
            Ok::<_,std::io::Error>(file)
        }).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
        if let Some(guard)=guard {
            let req=SqlFileRequest{execution_id:upload.execution_id.unwrap(),conn_id:upload.conn_id,
                file_path:file.path().to_string_lossy().into(),continue_on_error:upload.continue_on_error,expected_fingerprint:upload.expected_fingerprint};
            let receipt=execute_sql_file(driver,&req,guard.token.clone(),|progress|{
                if let Ok(payload)=serde_json::to_value(progress) {hub.emit_to_owner(&owner,"db://sql-file-progress",payload);}
            }).await;
            serde_json::to_value(receipt).map_err(|e|e.to_string())
        } else {
            let mut preview=prepare_sql_file(file.path(),driver.db_type(),&tokio_util::sync::CancellationToken::new(), |_|{}).await.map_err(|e|e.to_string())?.preview;
            preview.file_name=name;serde_json::to_value(preview).map_err(|e|e.to_string())
        }
    }).await.map_err(|e|e.to_string())?
}
