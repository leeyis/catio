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
use tokio::sync::mpsc::Sender;

use crate::events::EventSink;

/// Cap on topics one connection may subscribe to — stops an authenticated client from growing
/// the subscription set without bound.
const MAX_TOPICS_PER_CONN: usize = 512;

struct Conn {
    /// Writer channel — carries fully-formed wire envelopes (events, replies, pongs). BOUNDED:
    /// a slow client that can't drain its socket fills this and is dropped (below) rather than
    /// letting `emit` queue JSON without limit and blow up server memory.
    tx: Sender<Value>,
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
    pub fn register(&self, tx: Sender<Value>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().unwrap().insert(id, Conn { tx, topics: HashSet::new() });
        id
    }

    /// Drop a connection and all its subscriptions (called when the socket closes).
    pub fn unregister(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
    }

    /// Subscribe `id` to `topic`. Capped at `MAX_TOPICS_PER_CONN`; over the cap the request is
    /// silently ignored (the connection already streams plenty).
    pub fn subscribe(&self, id: u64, topic: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            if c.topics.contains(topic) || c.topics.len() < MAX_TOPICS_PER_CONN {
                c.topics.insert(topic.to_string());
            }
        }
    }

    pub fn unsubscribe(&self, id: u64, topic: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            c.topics.remove(topic);
        }
    }

    /// Current connection count — used to cap total connections at the upgrade.
    pub fn conn_count(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    /// True iff at least one currently-registered connection is subscribed to `topic`. Pure read
    /// (no mutation), locking the same `conns` mutex as `emit`. The server-mode MCP realtime-log
    /// path uses this as its emit gate (replacing the desktop's `live_log` AtomicBool): no
    /// subscriber → no log payload is built or emitted.
    pub fn has_subscriber(&self, topic: &str) -> bool {
        self.conns.lock().unwrap().values().any(|c| c.topics.contains(topic))
    }
}

impl EventSink for WsHub {
    fn emit(&self, topic: &str, payload: Value) {
        let env = json!({ "type": "event", "topic": topic, "payload": payload });
        // Collect connections whose bounded writer is full/closed and evict them after the
        // borrow ends — a slow client that can't keep up is dropped, not allowed to balloon memory.
        let mut dead = Vec::new();
        {
            let conns = self.conns.lock().unwrap();
            for (id, c) in conns.iter() {
                if c.topics.contains(topic) && c.tx.try_send(env.clone()).is_err() {
                    dead.push(*id);
                }
            }
        }
        if !dead.is_empty() {
            let mut conns = self.conns.lock().unwrap();
            for id in dead {
                conns.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::channel;

    #[test]
    fn emit_reaches_only_subscribers() {
        let hub = WsHub::default();
        let (tx_a, mut rx_a) = channel(16);
        let (tx_b, mut rx_b) = channel(16);
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
