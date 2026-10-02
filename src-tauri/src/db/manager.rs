use std::collections::HashMap;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tokio::sync::Mutex;
use crate::db::{driver::Driver, query_control::{RunningQueries,QueryGuard}, result::QueryResult, DbError,
    query_session::{TransactionState,QuerySessionInfo,TransactionAction}, query_session_registry::{QuerySessions,SESSION_LEASE_SECONDS}};

static QUERY_IDS: crate::db::ids::IdGen = crate::db::ids::IdGen::new("query");

pub struct ConnManager {
    pub conns: Mutex<HashMap<String, Arc<dyn Driver>>>,
    pub running: RunningQueries,
    pub sessions: QuerySessions,
}
impl Default for ConnManager {
    fn default()->Self {let running=RunningQueries::default();Self{conns:Mutex::new(HashMap::new()),sessions:QuerySessions::new(running.clone()),running}}
}
struct Deadline(Option<tokio::task::JoinHandle<()>>);
impl Drop for Deadline {fn drop(&mut self){if let Some(task)=self.0.take(){task.abort();}}}

impl ConnManager {
    pub async fn insert(&self,id:String,driver:Arc<dyn Driver>){self.conns.lock().await.insert(id,driver);}
    pub async fn get(&self,id:&str)->Option<Arc<dyn Driver>>{self.conns.lock().await.get(id).cloned()}
    pub async fn remove(&self,id:&str)->bool {
        let driver={let mut connections=self.conns.lock().await;
            let driver=connections.remove(id);self.running.cancel_connection(id);driver};
        self.sessions.close_parent(id).await;
        if let Some(driver)=driver {driver.close();true}else{false}
    }
    /// Lock order is connections -> session registry -> execution registry. No I/O under these locks.
    pub async fn open_query_session(&self,connection:&str)->Result<QuerySessionInfo,DbError> {
        let (driver,mut ticket)={let connections=self.conns.lock().await;
            let driver=connections.get(connection).cloned().ok_or_else(||DbError::NotFound(connection.into()))?;
            (driver,self.sessions.reserve(connection)?)};
        let cancel=ticket.cancel.clone();
        let child=tokio::select! {
            _=cancel.cancelled()=>return Err(DbError::Cancelled),
            created=tokio::time::timeout(std::time::Duration::from_secs(30),driver.fork_query_session())=>
                created.map_err(|_|DbError::ConnectFailed("Opening a SQL session timed out".into()))??,
        };
        self.sessions.activate(&mut ticket,child)?;
        self.query_session_status(connection,&ticket.id).await
    }
    pub async fn close_query_session(&self,connection:&str,session:&str)->Result<(),DbError> {
        if self.get(connection).await.is_none(){return Err(DbError::NotFound(connection.into()));}
        self.sessions.close(connection,session).await
    }
    pub async fn touch_query_session(&self,connection:&str,session:&str)->Result<(),DbError> {
        let connections=self.conns.lock().await;
        if !connections.contains_key(connection){return Err(DbError::NotFound(connection.into()));}
        self.sessions.touch(connection,session)
    }
    async fn session_driver(&self,connection:&str,session:&str)->Result<Arc<dyn Driver>,DbError> {
        let connections=self.conns.lock().await;
        if !connections.contains_key(connection){return Err(DbError::NotFound(connection.into()));}
        self.sessions.driver(connection,session)
    }
    pub async fn query_session_status(&self,connection:&str,session:&str)->Result<QuerySessionInfo,DbError> {
        let driver=self.session_driver(connection,session).await?;
        let busy=self.running.has_active(session);
        let transaction_state=if busy {TransactionState::Unknown} else {
            tokio::time::timeout(std::time::Duration::from_secs(5),driver.transaction_state()).await.ok().and_then(Result::ok).unwrap_or(TransactionState::Unknown)
        };
        Ok(QuerySessionInfo{id:session.into(),transaction_state,busy,can_cancel:driver.supports_query_cancel(),supports_transactions:driver.capabilities().transactions,lease_seconds:SESSION_LEASE_SECONDS})
    }
    async fn acquire(&self,connection:&str,session:Option<&str>,execution:&str)
        ->Result<(Arc<dyn Driver>,Option<Arc<Mutex<()>>>,QueryGuard),DbError> {
        let connections=self.conns.lock().await;
        let main=connections.get(connection).cloned().ok_or_else(||DbError::NotFound(connection.into()))?;
        if let Some(session)=session {
            let (driver,operation,guard)=self.sessions.acquire(connection,session,execution)?;
            Ok((driver,Some(operation),guard))
        } else {Ok((main,None,self.running.register(connection,execution)?))}
    }
    pub async fn cancel_query(&self,connection:&str,execution:&str)->Result<(),DbError>{self.cancel_query_in_session(connection,execution,None).await}
    pub async fn cancel_query_in_session(&self,connection:&str,execution:&str,session:Option<&str>)->Result<(),DbError> {
        let connections=self.conns.lock().await;
        let driver=connections.get(connection).ok_or_else(||DbError::NotFound(connection.into()))?;
        if let Some(session)=session{return self.sessions.cancel(connection,session,execution);}
        if !driver.supports_query_cancel(){return Err(DbError::Unsupported("This engine cannot interrupt a running query; it is still executing".into()));}
        self.running.cancel(connection,execution)
    }
    pub async fn query(&self,connection:&str,sql:&str,max_rows:u32,namespace:Option<&str>,execution_id:Option<&str>,timeout_ms:Option<u64>)->Result<QueryResult,DbError>{
        self.query_in_session(connection,sql,max_rows,namespace,execution_id,timeout_ms,None).await
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn query_in_session(&self,connection:&str,sql:&str,max_rows:u32,namespace:Option<&str>,execution_id:Option<&str>,timeout_ms:Option<u64>,session:Option<&str>)->Result<QueryResult,DbError>{
        let id=execution_id.map(str::to_string).unwrap_or_else(||QUERY_IDS.next());
        let (driver,operation,guard)=self.acquire(connection,session,&id).await?;
        Self::execute(driver,operation,guard,sql,max_rows.min(100_000),namespace,timeout_ms).await
    }
    pub async fn query_page_in_session(&self,connection:&str,session:&str,sql:&str,limit:u32,offset:u32,namespace:Option<&str>)->Result<QueryResult,DbError>{
        let (driver,operation,guard)=self.acquire(connection,Some(session),&QUERY_IDS.next()).await?;
        let _operation=tokio::select!{_=guard.token.cancelled()=>return Err(DbError::Cancelled),lock=operation.expect("session operation lock").lock_owned()=>lock};
        driver.paginated_query_cancellable(sql,limit,offset,namespace,guard.token.clone()).await
    }
    #[allow(clippy::too_many_arguments)]
    async fn execute(driver:Arc<dyn Driver>,operation:Option<Arc<Mutex<()>>>,guard:QueryGuard,sql:&str,max_rows:u32,namespace:Option<&str>,timeout_ms:Option<u64>)->Result<QueryResult,DbError>{
        let timeout=timeout_ms.unwrap_or(0);
        if timeout>86_400_000{return Err(DbError::QueryFailed("Query timeout exceeds 24 hours".into()));}
        if timeout>0 && !driver.supports_query_cancel(){return Err(DbError::Unsupported("Query timeout requires native cancellation support".into()));}
        let timed_out=Arc::new(AtomicBool::new(false));
        let _deadline=Deadline(if timeout>0 {let token=guard.token.clone();let expired=timed_out.clone();Some(tokio::spawn(async move{
            tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;expired.store(true,Ordering::SeqCst);token.cancel();
        }))}else{None});
        let result=async {
            let _operation=if let Some(operation)=operation {Some(tokio::select!{
                _=guard.token.cancelled()=>return Err(DbError::Cancelled),lock=operation.lock_owned()=>lock,
            })}else{None};
            driver.query_cancellable(sql,max_rows,namespace,guard.token.clone()).await
        }.await;
        match result{Err(DbError::Cancelled) if timed_out.load(Ordering::SeqCst)=>Err(DbError::TimedOut),other=>other}
    }
    pub async fn query_session_transaction(&self,connection:&str,session:&str,action:TransactionAction)->Result<QuerySessionInfo,DbError>{
        let (driver,operation,guard)=self.acquire(connection,Some(session),&QUERY_IDS.next()).await?;
        let _operation=tokio::select!{_=guard.token.cancelled()=>return Err(DbError::Cancelled),lock=operation.expect("session operation lock").lock_owned()=>lock};
        let before=driver.transaction_state().await?;
        if action==TransactionAction::Begin && before!=TransactionState::Idle {
            return Err(DbError::QueryFailed("Cannot start another transaction: current state is active, failed, or unknown".into()));
        }
        if action==TransactionAction::Commit && !matches!(before,TransactionState::Active|TransactionState::Manual) {
            return Err(DbError::QueryFailed("Commit requires a healthy active transaction; roll back a failed transaction".into()));
        }
        if before!=TransactionState::Idle || action==TransactionAction::Begin {
            driver.transaction_command(action,guard.token.clone()).await?;
        }
        let state=driver.transaction_state().await.unwrap_or(TransactionState::Unknown);
        Ok(QuerySessionInfo{id:session.into(),transaction_state:state,busy:false,can_cancel:driver.supports_query_cancel(),supports_transactions:driver.capabilities().transactions,lease_seconds:SESSION_LEASE_SECONDS})
    }
}
