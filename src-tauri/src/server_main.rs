//! `catio-server` — the web-server head. Serves the built UI and the HTTP core so a LAN
//! browser can use catio. Env: CATIO_PORT (default 8787), CATIO_STATIC (default ./dist).
use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("CATIO_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8787);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let static_dir = std::env::var("CATIO_STATIC").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("dist"));
    if let Err(e) = catio_lib::server::run_server(addr, static_dir).await {
        eprintln!("catio-server error: {e}");
        std::process::exit(1);
    }
}
