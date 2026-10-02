//! Connection-scoped, bounded SQL session leases. No credentials or durable storage.
use std::{collections::HashMap,sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use crate::db::{DbError,driver::Driver,query_control::{RunningQueries,QueryGuard}};

const MAX_PER_CONNECTION:usize=16;
const MAX_TOTAL:usize=128;
pub const SESSION_LEASE_SECONDS:u64=30*60;

struct Entry {
    parent:String,
    driver:Option<Arc<dyn Driver>>,
    cancelled:CancellationToken,
    touched:Instant,
    operation:Arc<tokio::sync::Mutex<()>>,
}
struct Inner {
    entries:Mutex<HashMap<String,Entry>>,
    running:RunningQueries,
    reaper_started:AtomicBool,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for (id,entry) in self.entries.get_mut().drain() {
            entry.cancelled.cancel();self.running.cancel_connection(&id);
            if let Some(driver)=entry.driver {driver.close();}
        }
    }
}
#[derive(Clone)]
pub struct QuerySessions {inner:Arc<Inner>}

pub(crate) struct OpeningSession {
    registry:QuerySessions,
    pub id:String,
    pub cancel:CancellationToken,
    activated:bool,
}
impl Drop for OpeningSession {
    fn drop(&mut self) {
        if !self.activated {
            if let Some(entry)=self.registry.inner.entries.lock().remove(&self.id) {
                entry.cancelled.cancel();
                if let Some(driver)=entry.driver {driver.close();}
            }
        }
    }
}
fn missing()->DbError {DbError::NotFound("SQL query session (closed, expired, or owned by another connection)".into())}

impl QuerySessions {
    pub fn new(running:RunningQueries)->Self {Self{inner:Arc::new(Inner{entries:Mutex::new(HashMap::new()),running,reaper_started:AtomicBool::new(false)})}}
    /// Caller holds the parent-connection map lock while reserving, preventing disconnect/create races.
    pub(crate) fn reserve(&self,parent:&str)->Result<OpeningSession,DbError> {
        let mut entries=self.inner.entries.lock();
        if entries.len()>=MAX_TOTAL || entries.values().filter(|e|e.parent==parent).count()>=MAX_PER_CONNECTION {
            return Err(DbError::Unsupported("Too many SQL sessions; close unused query tabs".into()));
        }
        let id=format!("sql-{:032x}",rand::random::<u128>());
        let cancel=CancellationToken::new();
        entries.insert(id.clone(),Entry{parent:parent.into(),driver:None,cancelled:cancel.clone(),touched:Instant::now(),operation:Arc::new(tokio::sync::Mutex::new(()))});
        drop(entries);
        self.start_reaper();
        Ok(OpeningSession{registry:self.clone(),id,cancel,activated:false})
    }
    pub(crate) fn activate(&self,ticket:&mut OpeningSession,driver:Arc<dyn Driver>)->Result<(),DbError> {
        let mut entries=self.inner.entries.lock();
        let Some(entry)=entries.get_mut(&ticket.id).filter(|e|!e.cancelled.is_cancelled()) else {driver.close();return Err(missing());};
        entry.driver=Some(driver);entry.touched=Instant::now();ticket.activated=true;Ok(())
    }
    fn usable(entry:&Entry,parent:&str)->bool {
        entry.parent==parent && !entry.cancelled.is_cancelled() && entry.touched.elapsed()<Duration::from_secs(SESSION_LEASE_SECONDS)
    }
    pub(crate) fn driver(&self,parent:&str,id:&str)->Result<Arc<dyn Driver>,DbError> {
        let mut entries=self.inner.entries.lock();
        let entry=entries.get_mut(id).filter(|e|Self::usable(e,parent)).ok_or_else(missing)?;
        let driver=entry.driver.clone().ok_or_else(missing)?;entry.touched=Instant::now();Ok(driver)
    }
    /// Register cancellation under the SAME critical section as lookup, so close
    /// cannot miss an execution between looking up its driver and registering it.
    pub(crate) fn acquire(&self,parent:&str,id:&str,execution:&str)->Result<(Arc<dyn Driver>,Arc<tokio::sync::Mutex<()>>,QueryGuard),DbError> {
        let mut entries=self.inner.entries.lock();
        let entry=entries.get_mut(id).filter(|e|Self::usable(e,parent)).ok_or_else(missing)?;
        let driver=entry.driver.clone().ok_or_else(missing)?;
        let guard=self.inner.running.register(id,execution)?;
        entry.touched=Instant::now();Ok((driver,entry.operation.clone(),guard))
    }
    pub(crate) fn touch(&self,parent:&str,id:&str)->Result<(),DbError> {self.driver(parent,id).map(|_|())}
    pub(crate) fn cancel(&self,parent:&str,id:&str,execution:&str)->Result<(),DbError> {
        let driver=self.driver(parent,id)?;
        if !driver.supports_query_cancel(){return Err(DbError::Unsupported("This engine cannot interrupt a statement without closing its SQL session".into()));}
        self.inner.running.cancel(id,execution)
    }
    pub(crate) async fn close(&self,parent:&str,id:&str)->Result<(),DbError> {
        let entry={let mut entries=self.inner.entries.lock();
            let Some(existing)=entries.get(id) else {return Ok(());};
            if existing.parent!=parent{return Err(missing());}
            entries.remove(id).expect("validated session")};
        self.retire(id,entry).await;Ok(())
    }
    pub(crate) async fn close_parent(&self,parent:&str) {
        let retired={let mut entries=self.inner.entries.lock();
            let ids:Vec<_>=entries.iter().filter(|(_,e)|e.parent==parent).map(|(id,_)|id.clone()).collect();
            ids.into_iter().filter_map(|id|entries.remove(&id).map(|entry|(id,entry))).collect::<Vec<_>>()};
        futures_util::future::join_all(retired.into_iter().map(|(id,entry)|async move{self.retire(&id,entry).await;})).await;
    }
    async fn retire(&self,id:&str,entry:Entry) {
        entry.cancelled.cancel();self.inner.running.cancel_connection(id);
        if let Some(driver)=entry.driver {
            // Cleanup must survive the caller dropping its HTTP/IPC future.
            let task=tokio::spawn(async move {
                struct CloseOnDrop(Arc<dyn Driver>);
                impl Drop for CloseOnDrop {fn drop(&mut self){self.0.close();}}
                let closing=CloseOnDrop(driver);
                let _=tokio::time::timeout(Duration::from_secs(6),closing.0.close_query_session()).await;
            });
            let _=task.await;
        }
    }
    async fn reap_expired_at(&self,now:Instant) {
        let retired={let mut entries=self.inner.entries.lock();
            let ids:Vec<_>=entries.iter().filter(|(_,e)|now.saturating_duration_since(e.touched)>=Duration::from_secs(SESSION_LEASE_SECONDS))
                .map(|(id,_)|id.clone()).collect();
            ids.into_iter().filter_map(|id|entries.remove(&id).map(|entry|(id,entry))).collect::<Vec<_>>()};
        futures_util::future::join_all(retired.into_iter().map(|(id,entry)|async move{self.retire(&id,entry).await;})).await;
    }
    fn start_reaper(&self) {
        if self.inner.reaper_started.swap(true,Ordering::SeqCst){return;}
        let weak=Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(inner)=weak.upgrade() else {break;};
                let registry=QuerySessions{inner};
                registry.reap_expired_at(Instant::now()).await;
            }
        });
    }
    pub fn count(&self)->usize {self.inner.entries.lock().len()}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{driver::{connect,ConnectArgs},DatabaseType};
    use serde_json::json;
    async fn sqlite()->Arc<dyn Driver>{connect(&ConnectArgs{db_type:DatabaseType::Sqlite,host:":memory:".into(),port:0,
        user:String::new(),database:None,driver_profile:None,options:None,secret:None,ssl:false,ssl_mode:None,
        ca_cert_path:None,ssl_reject_unauthorized:None}).await.unwrap()}
    #[tokio::test]
    async fn abandoned_opening_releases_its_slot() {
        let sessions=QuerySessions::new(RunningQueries::default());
        let ticket=sessions.reserve("a").unwrap();let cancel=ticket.cancel.clone();
        assert_eq!(sessions.count(),1);drop(ticket);assert_eq!(sessions.count(),0);assert!(cancel.is_cancelled());
    }
    #[tokio::test]
    async fn parent_close_during_opening_rejects_late_activation() {
        let sessions=QuerySessions::new(RunningQueries::default());
        let mut ticket=sessions.reserve("a").unwrap();sessions.close_parent("a").await;
        let child=sqlite().await;assert!(sessions.activate(&mut ticket,child.clone()).is_err());
        assert!(child.query("SELECT 1",1).await.is_err());assert_eq!(sessions.count(),0);
    }
    #[tokio::test]
    async fn expired_lease_rolls_back_the_actual_database_transaction() {
        let sessions=QuerySessions::new(RunningQueries::default());let parent=sqlite().await;
        parent.query("CREATE TABLE lease_data(id INT)",0).await.unwrap();let child=parent.fork_query_session().await.unwrap();
        let mut ticket=sessions.reserve("a").unwrap();sessions.activate(&mut ticket,child.clone()).unwrap();
        child.query("BEGIN",0).await.unwrap();child.query("INSERT INTO lease_data VALUES(1)",0).await.unwrap();
        sessions.reap_expired_at(Instant::now()+Duration::from_secs(SESSION_LEASE_SECONDS+1)).await;
        assert_eq!(sessions.count(),0);assert!(sessions.touch("a",&ticket.id).is_err());
        assert_eq!(parent.query("SELECT COUNT(*) FROM lease_data",1).await.unwrap().rows[0][0],json!(0));
        sessions.close("a",&ticket.id).await.unwrap(); // idempotent close of an expired lease
    }
}
