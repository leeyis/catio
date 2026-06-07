use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ssh::conn::ClientHandler;

/// 一条已建立的 SSH 会话。`handle` 是 russh 客户端句柄。
pub struct Session {
    pub handle: russh::client::Handle<ClientHandler>,
    pub host: String,
    pub user: String,
}

/// 进程内会话表。以会话 id（"sess-N"）为键。
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl SessionManager {
    pub async fn insert(&self, id: String, sess: Session) {
        self.sessions
            .lock()
            .await
            .insert(id, Arc::new(Mutex::new(sess)));
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().await.remove(id)
    }
}
