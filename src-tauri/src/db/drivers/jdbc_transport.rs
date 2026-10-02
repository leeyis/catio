//! Request-ID multiplexing for a single JDBC sidecar. Blocking pipe I/O never holds a driver/session lock.
use std::{collections::HashMap,io::{BufRead,BufReader,BufWriter,Read,Write},process::{Child,ChildStdin},
    sync::{Arc,Weak,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}}};
use serde_json::{Value,json};
use tokio::sync::oneshot;
use crate::db::DbError;
const MAX_FRAME:usize=64*1024*1024;
const MAX_PENDING:usize=256;
type Reply=Result<Value,String>;

pub(super) struct JdbcProcess {
    child:Mutex<Child>,
    input:Mutex<BufWriter<ChildStdin>>,
    pending:Mutex<HashMap<u64,oneshot::Sender<Reply>>>,
    sequence:AtomicU64,
    closed:AtomicBool,
    stderr:Mutex<Vec<u8>>,
}
pub(super) struct JdbcRequest {
    pub id:u64,
    receiver:Option<oneshot::Receiver<Reply>>,
    process:Weak<JdbcProcess>,
}
impl JdbcRequest {
    pub async fn response(mut self)->Reply {
        self.receiver.take().expect("single JDBC response").await.unwrap_or_else(|_|Err("JDBC response channel closed".into()))
    }
}
impl Drop for JdbcRequest {
    fn drop(&mut self){if let Some(process)=self.process.upgrade(){if let Ok(mut pending)=process.pending.lock(){pending.remove(&self.id);}}}
}
impl JdbcProcess {
    pub fn new(mut child:Child)->Result<Arc<Self>,DbError> {
        let input=child.stdin.take().ok_or_else(||DbError::ConnectFailed("Missing JDBC input pipe".into()))?;
        let output=child.stdout.take().ok_or_else(||DbError::ConnectFailed("Missing JDBC output pipe".into()))?;
        let errors=child.stderr.take();
        let process=Arc::new(Self{child:Mutex::new(child),input:Mutex::new(BufWriter::new(input)),pending:Mutex::new(HashMap::new()),
            sequence:AtomicU64::new(0),closed:AtomicBool::new(false),stderr:Mutex::new(Vec::new())});
        let weak=Arc::downgrade(&process);
        std::thread::spawn(move||{
            let mut reader=BufReader::new(output);
            loop {
                let mut line=String::new();
                let read=reader.by_ref().take((MAX_FRAME+1) as u64).read_line(&mut line);
                let Some(process)=weak.upgrade() else {break;};
                match read {
                    Ok(0)=>{process.fail("JDBC sidecar closed");break;},
                    Ok(n) if n>MAX_FRAME||!line.ends_with('\n')=>{process.fail("JDBC response exceeded the frame limit or was incomplete");break;},
                    Err(_)=>{process.fail("JDBC output pipe failed");break;},
                    _=>{},
                }
                let Ok(value)=serde_json::from_str::<Value>(&line) else {process.fail("Invalid JDBC response frame");break;};
                let Some(id)=value.get("id").and_then(Value::as_u64) else {process.fail("JDBC response has no request identity");break;};
                let sender=process.pending.lock().ok().and_then(|mut pending|pending.remove(&id));
                // A cancelled caller may have dropped its receiver. Never deliver
                // that old response to another request or interpret it as a retry.
                if let Some(sender)=sender {let _=sender.send(Ok(value));}
            }
        });
        if let Some(mut errors)=errors {
            let weak=Arc::downgrade(&process);
            std::thread::spawn(move||{let mut bytes=[0u8;4096];while let Ok(count)=errors.read(&mut bytes){
                if count==0{break;}let Some(process)=weak.upgrade() else{break;};
                if let Ok(mut tail)=process.stderr.lock(){tail.extend_from_slice(&bytes[..count]);let excess=tail.len().saturating_sub(8192);if excess>0{tail.drain(..excess);}};
            }});
        }
        Ok(process)
    }
    pub fn start(self:&Arc<Self>,method:&str,params:Value)->Result<JdbcRequest,DbError> {
        if self.closed.load(Ordering::SeqCst){return Err(DbError::ConnectFailed("JDBC sidecar is closed".into()));}
        let id=self.sequence.fetch_add(1,Ordering::SeqCst)+1;
        let mut bytes=serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).map_err(|_|DbError::QueryFailed("Cannot encode JDBC request".into()))?;
        if bytes.len()>MAX_FRAME{return Err(DbError::Unsupported("JDBC request exceeds 64 MiB".into()));}bytes.push(b'\n');
        let (sender,receiver)=oneshot::channel();
        {let mut pending=self.pending.lock().map_err(|_|DbError::ConnectFailed("JDBC request registry is unavailable".into()))?;
            if pending.len()>=MAX_PENDING{return Err(DbError::Unsupported("Too many pending JDBC requests".into()));}
            if self.closed.load(Ordering::SeqCst){return Err(DbError::ConnectFailed("JDBC sidecar is closed".into()));}
            pending.insert(id,sender);
        }
        let process=self.clone();
        let write=move||{
            if process.closed.load(Ordering::SeqCst){return;}
            let result=process.input.lock().map_err(|_|()).and_then(|mut input|input.write_all(&bytes).and_then(|_|input.flush()).map_err(|_|()));
            if result.is_err(){process.fail("JDBC input pipe failed");}
        };
        if let Ok(runtime)=tokio::runtime::Handle::try_current(){runtime.spawn_blocking(write);}else{std::thread::spawn(write);}
        Ok(JdbcRequest{id,receiver:Some(receiver),process:Arc::downgrade(self)})
    }
    pub fn detached(self:&Arc<Self>,method:&str,params:Value) {
        // Dropping the receiver discards only its response, not the request.
        // Used for cleanup on Drop; server-side close/cancel are idempotent.
        let _=self.start(method,params);
    }
    pub fn stderr_tail(&self)->String {self.stderr.lock().ok().map(|s|String::from_utf8_lossy(&s).trim().to_string()).unwrap_or_default()}
    pub fn close(&self){self.fail("JDBC sidecar disconnected");}
    fn fail(&self,message:&str) {
        if self.closed.swap(true,Ordering::SeqCst){return;}
        if let Ok(mut child)=self.child.lock(){let _=child.kill();let _=child.wait();}
        if let Ok(mut pending)=self.pending.lock(){for (_,sender) in pending.drain(){let _=sender.send(Err(message.into()));}}
    }
}
impl Drop for JdbcProcess {
    fn drop(&mut self){if let Ok(child)=self.child.get_mut(){let _=child.kill();let _=child.wait();}}
}
