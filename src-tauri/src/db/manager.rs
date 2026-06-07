use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::db::driver::Driver;

#[derive(Default)]
pub struct ConnManager {
    pub conns: Mutex<HashMap<String, Arc<dyn Driver>>>,
}

impl ConnManager {
    pub async fn insert(&self, id: String, driver: Arc<dyn Driver>) {
        self.conns.lock().await.insert(id, driver);
    }
    pub async fn get(&self, id: &str) -> Option<Arc<dyn Driver>> {
        self.conns.lock().await.get(id).cloned()
    }
    pub async fn remove(&self, id: &str) -> bool {
        self.conns.lock().await.remove(id).is_some()
    }
}
