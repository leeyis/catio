//! Loopback-only browser QA head. Does not read or overwrite a normal Catio data directory.
//! Run from the repository root after `npm run build`:
//! cargo run --manifest-path src-tauri/Cargo.toml --example database_lab_server
use std::path::PathBuf;
use catio_lib::server::{build_router, AppState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let data = root.join(".worktrees/database-lab-web-data");
    let state = AppState::new(root.join("dist"), data)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18877").await?;
    eprintln!("Catio database QA: http://127.0.0.1:18877 (isolated data, loopback only)");
    axum::serve(listener, build_router(state)).await?;
    Ok(())
}
