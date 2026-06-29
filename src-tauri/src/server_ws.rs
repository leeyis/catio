//! WebSocket hub for the web head (M3). Tracks per-connection topic subscriptions and fans an
//! emitted frame out to exactly the connections subscribed to that topic. Implements `EventSink`,
//! so the streaming command cores (SSH terminal now; VNC later) push frames through it the same
//! way they push to the Tauri webview bus on desktop.
//!
//! Envelope (one JSON object per WS text message):
//!   client → server : {type:"sub"|"unsub", topic} · {type:"cmd", id, cmd, args} · {type:"ping"}
//!   server → client : {type:"event", topic, payload} · {type:"reply", id, ok, result|error} · {type:"pong"}

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::events::EventSink;

struct Conn {
    /// Writer channel — carries fully-formed wire envelopes (events, replies, pongs).
    tx: UnboundedSender<Value>,
    topics: HashSet<String>,
}

/// Connection registry + topic routing. One instance lives in `AppState`, shared by every
/// request, and is handed to the terminal core as `Arc<dyn EventSink>`.
#[derive(Default)]
pub struct WsHub {
    conns: Mutex<HashMap<u64, Conn>>,
    next_id: AtomicU64,
}

impl WsHub {
    /// Register a connection's writer channel; returns its id (used for sub/unsub/unregister).
    pub fn register(&self, tx: UnboundedSender<Value>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().unwrap().insert(id, Conn { tx, topics: HashSet::new() });
        id
    }

    /// Drop a connection and all its subscriptions (called when the socket closes).
    pub fn unregister(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
    }

    pub fn subscribe(&self, id: u64, topic: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            c.topics.insert(topic.to_string());
        }
    }

    pub fn unsubscribe(&self, id: u64, topic: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            c.topics.remove(topic);
        }
    }
}

impl EventSink for WsHub {
    fn emit(&self, topic: &str, payload: Value) {
        let env = json!({ "type": "event", "topic": topic, "payload": payload });
        let conns = self.conns.lock().unwrap();
        for c in conns.values() {
            if c.topics.contains(topic) {
                // Unbounded send is non-blocking; a dead receiver just means a closing socket.
                let _ = c.tx.send(env.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn emit_reaches_only_subscribers() {
        let hub = WsHub::default();
        let (tx_a, mut rx_a) = unbounded_channel();
        let (tx_b, mut rx_b) = unbounded_channel();
        let a = hub.register(tx_a);
        let b = hub.register(tx_b);

        hub.subscribe(a, "term://chan-1");
        // b is NOT subscribed → must not receive.
        hub.emit("term://chan-1", json!({ "bytesBase64": "aGk=" }));
        let got = rx_a.try_recv().expect("a subscribed → receives");
        assert_eq!(got["type"], "event");
        assert_eq!(got["topic"], "term://chan-1");
        assert_eq!(got["payload"]["bytesBase64"], "aGk=");
        assert!(rx_b.try_recv().is_err(), "b not subscribed → nothing");

        // Unsubscribe stops delivery.
        hub.unsubscribe(a, "term://chan-1");
        hub.emit("term://chan-1", json!({}));
        assert!(rx_a.try_recv().is_err(), "after unsub → nothing");

        // Unregister cleans up.
        hub.unregister(a);
        hub.unregister(b);
        hub.emit("term://chan-1", json!({}));
        let _ = b;
    }
}
