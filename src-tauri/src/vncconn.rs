//! VNC (RFB 3.8) live connection: handshake, auth, framebuffer streaming, input.
//!
//! Builds on the unit-tested codec in [`crate::vnc`]. Connects over TCP, negotiates
//! security (None or VNC-auth DES challenge), reads ServerInit, then loops reading
//! FramebufferUpdates and streams each rectangle to the frontend as base64 RGBA over
//! `vnc-rect://{id}` events; ServerInit/desktop-size go over `vnc-init://{id}`, and
//! `vnc-closed://{id}` on disconnect. Pointer/key events flow back via commands.
//!
//! NOTE: the codec layer is unit-tested; this connection layer needs a live VNC
//! server to verify end-to-end (handshake/auth/rendering), like the app's other
//! live paths (SSH terminal, remote-file edit) that are exercised in the running app.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use des::cipher::{BlockEncrypt, KeyInit};
use des::cipher::generic_array::GenericArray;
use des::Des;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::AbortHandle;

use crate::events::EventSink;
use crate::ssh::ids::IdGen;
use crate::ssh::SshError;
use crate::vnc;

static VNC_IDS: IdGen = IdGen::new("vnc");

struct VncSession {
    input_tx: UnboundedSender<Vec<u8>>,
    /// Reader + writer + ticker abort handles — all aborted on close so no task /
    /// socket half leaks.
    aborts: Vec<AbortHandle>,
}

/// VNC session registry (Tauri State).
#[derive(Default)]
pub struct VncManager {
    sessions: Mutex<HashMap<String, VncSession>>,
}

impl VncManager {
    fn insert(&self, id: String, s: VncSession) {
        self.sessions.lock().unwrap().insert(id, s);
    }
    fn input(&self, id: &str) -> Option<UnboundedSender<Vec<u8>>> {
        self.sessions.lock().unwrap().get(id).map(|s| s.input_tx.clone())
    }
    fn remove(&self, id: &str) -> Option<VncSession> {
        self.sessions.lock().unwrap().remove(id)
    }
}

/// DES-ECB encrypt the 16-byte VNC-auth challenge with the (bit-reversed) password key.
fn vnc_auth_response(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    let key = vnc::vnc_des_key(password);
    let cipher = Des::new(GenericArray::from_slice(&key));
    let mut out = [0u8; 16];
    for blk in 0..2 {
        let mut block = GenericArray::clone_from_slice(&challenge[blk * 8..blk * 8 + 8]);
        cipher.encrypt_block(&mut block);
        out[blk * 8..blk * 8 + 8].copy_from_slice(&block);
    }
    out
}

/// SetPixelFormat asking for 32bpp little-endian RGBA-on-wire (byte order R,G,B,pad).
fn set_pixel_format_msg() -> [u8; 20] {
    let mut m = [0u8; 20];
    m[0] = 0; // message type
    // m[1..4] padding
    m[4] = 32; // bits-per-pixel
    m[5] = 24; // depth
    m[6] = 0; // big-endian-flag = little-endian
    m[7] = 1; // true-color
    m[8..10].copy_from_slice(&255u16.to_be_bytes()); // red-max
    m[10..12].copy_from_slice(&255u16.to_be_bytes()); // green-max
    m[12..14].copy_from_slice(&255u16.to_be_bytes()); // blue-max
    m[14] = 0; // red-shift   → low byte
    m[15] = 8; // green-shift
    m[16] = 16; // blue-shift
    // m[17..20] padding
    m
}

/// SetEncodings: Raw(0), CopyRect(1), DesktopSize(-223).
fn set_encodings_msg() -> Vec<u8> {
    let encs: [i32; 3] = [0, 1, -223];
    let mut m = vec![2u8, 0];
    m.extend_from_slice(&(encs.len() as u16).to_be_bytes());
    for e in encs {
        m.extend_from_slice(&e.to_be_bytes());
    }
    m
}

async fn read_exact_vec(stream: &mut TcpStream, n: usize) -> Result<Vec<u8>, SshError> {
    let mut buf = vec![0u8; n];
    stream.read_exact(&mut buf).await.map_err(|e| SshError::Io(e.to_string()))?;
    Ok(buf)
}

/// Perform the RFB handshake + auth + init. Returns (ServerInit) on success.
async fn handshake(stream: &mut TcpStream, password: &str) -> Result<vnc::ServerInit, SshError> {
    // 1. ProtocolVersion.
    let ver = read_exact_vec(stream, 12).await?;
    let (smaj, smin) = vnc::parse_protocol_version(&ver).ok_or_else(|| SshError::Sftp("bad RFB version".into()))?;
    // We implement the 3.7+ security handshake; reject older. Never request higher than the server.
    if smaj != 3 || smin < 7 {
        return Err(SshError::Sftp(format!("unsupported RFB protocol version {smaj}.{smin}")));
    }
    let reply_minor = smin.min(8);
    stream.write_all(&vnc::encode_protocol_version(3, reply_minor)).await.map_err(|e| SshError::Io(e.to_string()))?;

    // 2. Security types (RFB 3.7+: count, then that many type bytes).
    let count = stream.read_u8().await.map_err(|e| SshError::Io(e.to_string()))?;
    if count == 0 {
        // Failure: u32 reason length + reason string.
        let rl = stream.read_u32().await.map_err(|e| SshError::Io(e.to_string()))? as usize;
        let reason = read_exact_vec(stream, rl).await.unwrap_or_default();
        return Err(SshError::Sftp(format!("VNC rejected: {}", String::from_utf8_lossy(&reason))));
    }
    let types = read_exact_vec(stream, count as usize).await?;
    let has_none = types.contains(&1);
    let has_vnc = types.contains(&2);
    // Prefer VNC-auth when a password was supplied — never silently connect with None
    // (a hostile/misconfigured server could advertise None to bypass the password).
    let want_auth = !password.is_empty();
    let chosen = if has_vnc && want_auth { 2 } else if has_none { 1 } else if has_vnc { 2 } else {
        return Err(SshError::Sftp("no supported VNC security type".into()));
    };
    stream.write_all(&[chosen]).await.map_err(|e| SshError::Io(e.to_string()))?;

    // 3. VNC-auth DES challenge (type 2 only).
    if chosen == 2 {
        let mut challenge = [0u8; 16];
        stream.read_exact(&mut challenge).await.map_err(|e| SshError::Io(e.to_string()))?;
        let resp = vnc_auth_response(password, &challenge);
        stream.write_all(&resp).await.map_err(|e| SshError::Io(e.to_string()))?;
    }

    // 4. SecurityResult: always sent after VNC-auth; for None only on RFB ≥ 3.8.
    if chosen == 2 || reply_minor >= 8 {
        let result = stream.read_u32().await.map_err(|e| SshError::Io(e.to_string()))?;
        if result != 0 {
            return Err(SshError::AuthFailed);
        }
    }

    // 5. ClientInit (shared = 1) → ServerInit.
    stream.write_all(&[1u8]).await.map_err(|e| SshError::Io(e.to_string()))?;
    let head = read_exact_vec(stream, 24).await?;
    let name_len = u32::from_be_bytes([head[20], head[21], head[22], head[23]]) as usize;
    let name = read_exact_vec(stream, name_len).await?;
    let mut full = head;
    full.extend_from_slice(&name);
    let si = vnc::parse_server_init(&full).ok_or_else(|| SshError::Sftp("bad ServerInit".into()))?;

    // 6. Pixel format + encodings.
    stream.write_all(&set_pixel_format_msg()).await.map_err(|e| SshError::Io(e.to_string()))?;
    stream.write_all(&set_encodings_msg()).await.map_err(|e| SshError::Io(e.to_string()))?;
    Ok(si)
}

/// Connect to a VNC server and start streaming. Returns a session id.
#[tauri::command]
pub async fn vnc_connect(
    host: String,
    port: u16,
    password: String,
    app: tauri::AppHandle,
    mgr: tauri::State<'_, VncManager>,
) -> Result<String, SshError> {
    if host.trim().is_empty() {
        return Err(SshError::Io("vnc host is empty".into()));
    }
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| SshError::HostUnreachable(format!("{host}:{port}")))?
    .map_err(|e| SshError::Io(e.to_string()))?;

    // Bound the handshake too (a server that completes TCP but stalls mid-handshake
    // would otherwise wedge this command forever).
    let si = tokio::time::timeout(std::time::Duration::from_secs(15), handshake(&mut stream, &password))
        .await
        .map_err(|_| SshError::HostUnreachable("VNC handshake timed out".into()))??;

    let id = VNC_IDS.next();
    let _ = app.emit(&format!("vnc-init://{id}"), serde_json::json!({ "width": si.width, "height": si.height, "name": si.name }));

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (mut rd, mut wr) = stream.into_split();
    let (fbw, fbh) = (si.width, si.height);

    // Initial full framebuffer request, then forward input verbatim. The ticker is the
    // SOLE source of incremental refreshes — no per-input request amplification.
    let _ = input_tx.send(vnc::encode_fb_update_request(false, 0, 0, fbw, fbh).to_vec());
    let writer = tokio::spawn(async move {
        while let Some(bytes) = input_rx.recv().await {
            if wr.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });

    // Steady ~20fps incremental refresh via the input channel.
    let ticker_tx = input_tx.clone();
    let ticker = tokio::spawn(async move {
        let mut iv = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            iv.tick().await;
            if ticker_tx.send(vnc::encode_fb_update_request(true, 0, 0, fbw, fbh).to_vec()).is_err() {
                break;
            }
        }
    });

    let writer_abort = writer.abort_handle();
    let ticker_abort = ticker.abort_handle();

    // Reader: pump framebuffer updates; on natural exit (server disconnect), stop the
    // sibling tasks and deregister. vnc_close aborts all three handles directly.
    let app2 = app.clone();
    let id2 = id.clone();
    let wa = writer_abort.clone();
    let ta = ticker_abort.clone();
    let reader = tokio::spawn(async move {
        let res = pump_messages_split(&mut rd, &crate::events::TauriSink(app2.clone()), &id2).await;
        wa.abort();
        ta.abort();
        let _ = app2.emit(&format!("vnc-closed://{id2}"), serde_json::json!({ "error": res.err().map(|e| e.to_string()) }));
        app2.state::<VncManager>().remove(&id2);
    });

    mgr.insert(id.clone(), VncSession { input_tx, aborts: vec![reader.abort_handle(), writer_abort, ticker_abort] });
    Ok(id)
}

/// Pump server→client messages over the read half, emitting framebuffer rects.
async fn pump_messages_split(
    rd: &mut tokio::net::tcp::OwnedReadHalf,
    sink: &dyn EventSink,
    id: &str,
) -> Result<(), SshError> {
    let rect_evt = format!("vnc-rect://{id}");
    let init_evt = format!("vnc-init://{id}");
    loop {
        let msg_type = rd.read_u8().await.map_err(|e| SshError::Io(e.to_string()))?;
        match msg_type {
            0 => {
                let _pad = rd.read_u8().await.map_err(|e| SshError::Io(e.to_string()))?;
                let num = rd.read_u16().await.map_err(|e| SshError::Io(e.to_string()))?;
                for _ in 0..num {
                    let mut hdr = [0u8; 12];
                    rd.read_exact(&mut hdr).await.map_err(|e| SshError::Io(e.to_string()))?;
                    let r = vnc::parse_rect_header(&hdr).ok_or_else(|| SshError::Sftp("bad rect".into()))?;
                    match r.encoding {
                        0 => {
                            let len = r.width as usize * r.height as usize * 4;
                            let mut pixels = vec![0u8; len];
                            rd.read_exact(&mut pixels).await.map_err(|e| SshError::Io(e.to_string()))?;
                            sink.emit(&rect_evt, serde_json::json!({
                                "x": r.x, "y": r.y, "w": r.width, "h": r.height, "enc": "raw", "data": B64.encode(&pixels),
                            }));
                        }
                        1 => {
                            let sx = rd.read_u16().await.map_err(|e| SshError::Io(e.to_string()))?;
                            let sy = rd.read_u16().await.map_err(|e| SshError::Io(e.to_string()))?;
                            sink.emit(&rect_evt, serde_json::json!({
                                "x": r.x, "y": r.y, "w": r.width, "h": r.height, "enc": "copy", "srcX": sx, "srcY": sy,
                            }));
                        }
                        -223 => {
                            sink.emit(&init_evt, serde_json::json!({ "width": r.width, "height": r.height }));
                        }
                        other => return Err(SshError::Sftp(format!("unsupported VNC encoding {other}"))),
                    }
                }
            }
            1 => {
                let _ = rd.read_u8().await.map_err(|e| SshError::Io(e.to_string()))?;
                let _first = rd.read_u16().await.map_err(|e| SshError::Io(e.to_string()))?;
                let n = rd.read_u16().await.map_err(|e| SshError::Io(e.to_string()))? as usize;
                let mut skip = vec![0u8; n * 6];
                rd.read_exact(&mut skip).await.map_err(|e| SshError::Io(e.to_string()))?;
            }
            2 => {}
            3 => {
                let mut pad = [0u8; 3];
                rd.read_exact(&mut pad).await.map_err(|e| SshError::Io(e.to_string()))?;
                let n = rd.read_u32().await.map_err(|e| SshError::Io(e.to_string()))? as usize;
                let mut skip = vec![0u8; n];
                rd.read_exact(&mut skip).await.map_err(|e| SshError::Io(e.to_string()))?;
            }
            other => return Err(SshError::Sftp(format!("unknown VNC server message {other}"))),
        }
    }
}

/// Transport-agnostic VNC connect (web head). Mirrors the desktop command's orchestration but
/// emits through an `EventSink` (the WS hub) and removes its session from an `Arc<VncManager>` on
/// natural disconnect. The protocol bulk (`handshake`, `pump_messages_split`) is SHARED with the
/// desktop command, so only the connect/task wiring differs.
pub async fn vnc_connect_core(
    host: String,
    port: u16,
    password: String,
    sink: Arc<dyn EventSink>,
    mgr: Arc<VncManager>,
    on_open: impl FnOnce(&str),
) -> Result<String, SshError> {
    if host.trim().is_empty() {
        return Err(SshError::Io("vnc host is empty".into()));
    }
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| SshError::HostUnreachable(format!("{host}:{port}")))?
        .map_err(|e| SshError::Io(e.to_string()))?;
    let si = tokio::time::timeout(std::time::Duration::from_secs(15), handshake(&mut stream, &password))
        .await
        .map_err(|_| SshError::HostUnreachable("VNC handshake timed out".into()))??;

    let id = VNC_IDS.next();
    // Subscribe the WS connection to vnc-init/rect/closed BEFORE the first emit (no lost frames).
    on_open(&id);
    sink.emit(&format!("vnc-init://{id}"), serde_json::json!({ "width": si.width, "height": si.height, "name": si.name }));

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (mut rd, mut wr) = stream.into_split();
    let (fbw, fbh) = (si.width, si.height);
    let _ = input_tx.send(vnc::encode_fb_update_request(false, 0, 0, fbw, fbh).to_vec());
    let writer = tokio::spawn(async move {
        while let Some(bytes) = input_rx.recv().await {
            if wr.write_all(&bytes).await.is_err() { break; }
        }
    });
    let ticker_tx = input_tx.clone();
    let ticker = tokio::spawn(async move {
        let mut iv = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            iv.tick().await;
            if ticker_tx.send(vnc::encode_fb_update_request(true, 0, 0, fbw, fbh).to_vec()).is_err() { break; }
        }
    });
    let writer_abort = writer.abort_handle();
    let ticker_abort = ticker.abort_handle();

    let id2 = id.clone();
    let (wa, ta) = (writer_abort.clone(), ticker_abort.clone());
    let mgr2 = mgr.clone();
    // Gate the reader until the session is registered, so its natural-disconnect cleanup
    // (`mgr2.remove`) can never run before `mgr.insert` (a multi-threaded-runtime race that would
    // leave a stale entry).
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let reader = tokio::spawn(async move {
        let _ = ready_rx.await;
        let res = pump_messages_split(&mut rd, sink.as_ref(), &id2).await;
        wa.abort();
        ta.abort();
        sink.emit(&format!("vnc-closed://{id2}"), serde_json::json!({ "error": res.err().map(|e| e.to_string()) }));
        mgr2.remove(&id2);
    });

    mgr.insert(id.clone(), VncSession { input_tx, aborts: vec![reader.abort_handle(), writer_abort, ticker_abort] });
    let _ = ready_tx.send(());
    Ok(id)
}

/// Send a pointer event (button mask + position).
#[tauri::command]
pub fn vnc_pointer(session_id: String, mask: u8, x: u16, y: u16, mgr: tauri::State<'_, VncManager>) -> Result<(), SshError> {
    vnc_pointer_core(&mgr, &session_id, mask, x, y)
}

pub fn vnc_pointer_core(mgr: &VncManager, session_id: &str, mask: u8, x: u16, y: u16) -> Result<(), SshError> {
    let tx = mgr.input(session_id).ok_or(SshError::ChannelClosed)?;
    tx.send(vnc::encode_pointer_event(mask, x, y).to_vec()).map_err(|_| SshError::ChannelClosed)
}

/// Send a key event (down flag + X11 keysym).
#[tauri::command]
pub fn vnc_key(session_id: String, down: bool, keysym: u32, mgr: tauri::State<'_, VncManager>) -> Result<(), SshError> {
    vnc_key_core(&mgr, &session_id, down, keysym)
}

pub fn vnc_key_core(mgr: &VncManager, session_id: &str, down: bool, keysym: u32) -> Result<(), SshError> {
    let tx = mgr.input(session_id).ok_or(SshError::ChannelClosed)?;
    tx.send(vnc::encode_key_event(down, keysym).to_vec()).map_err(|_| SshError::ChannelClosed)
}

/// Close a VNC session.
#[tauri::command]
pub fn vnc_close(session_id: String, mgr: tauri::State<'_, VncManager>) -> Result<(), SshError> {
    vnc_close_core(&mgr, &session_id)
}

pub fn vnc_close_core(mgr: &VncManager, session_id: &str) -> Result<(), SshError> {
    if let Some(s) = mgr.remove(session_id) {
        for a in s.aborts {
            a.abort();
        }
    }
    Ok(())
}
