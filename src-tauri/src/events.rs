//! Transport-agnostic event sink. Streaming command cores (SSH terminals now; VNC, SFTP
//! transfer progress later) push frames through this trait instead of calling `AppHandle::emit`
//! directly, so the SAME core serves both heads:
//!   * desktop (Tauri) → `TauriSink` forwards to the webview event bus (`listen`),
//!   * web            → the WebSocket hub (`server::ws`) broadcasts to topic subscribers.
//!
//! Topics are the existing emit names verbatim (`term://{chanId}`, `history://{sessionId}`,
//! `vnc-rect://{id}`, …), so the frontend's topic strings are identical across both heads.

use serde_json::Value;

/// Somewhere a streaming command sends frames. Cheap to clone behind an `Arc<dyn EventSink>`.
pub trait EventSink: Send + Sync {
    fn emit(&self, topic: &str, payload: Value);
}

/// Desktop sink: forward to the Tauri webview event bus. Compiled into `catio_lib` (which always
/// depends on `tauri`); the web `catio-server` binary links it but never constructs it.
pub struct TauriSink(pub tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, topic: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit(topic, payload);
    }
}
