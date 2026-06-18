mod common;
use common::test_server;

// slice 3（slice3-open_sftp-single-stream）集成测试。
//
// 验证 `sftp_transfer` 的单流顺序 SFTP 传输（N=1 路径）：
//   * `open_sftp(mgr, session_id)` 能在已建立的会话上开 sftp 子系统并建 `SftpSession`；
//   * `upload_sftp` / `download_sftp` 在文件 < 阈值时走单 File 句柄顺序读写；
//   * 小文件上传 → 下载 round-trip 字节一致、大小一致；
//   * 进度回调被调用、终值等于总字节数；取消标志生效。
//
// 测试不构造 Tauri `AppHandle`（参考现有集成测试约定）：传输核心接受进度回调闭包，
// 由本测试直接驱动，绕过事件层。会话经 `connect_authenticated` 建立后插入真实
// `SessionManager`，使 `open_sftp` 走与生产一致的「短暂持锁 → channel_open_session」路径。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::manager::{Session, SessionManager};
use catio_lib::ssh::sftp_transfer::{download_sftp, open_sftp, upload_sftp};

/// 连接测试服并把会话以 "sess-1" 插入一个新建的 `SessionManager`，返回 manager。
async fn manager_with_session(addr: std::net::SocketAddr) -> SessionManager {
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
        jump: None,
    };
    let (handle, _fp, forwarded, jump) = connect_authenticated(&args).await.expect("connect");
    let mgr = SessionManager::default();
    let sess = Session {
        handle,
        host: addr.ip().to_string(),
        user: test_server::TEST_USER.into(),
        terms: HashMap::new(),
        forwarded,
        _jump: jump,
    };
    mgr.insert("sess-1".into(), sess).await;
    mgr
}

/// 小文件（< 8 MiB 阈值）上传 → 下载 round-trip：字节一致、大小一致、进度终值正确。
#[tokio::test]
async fn small_file_upload_download_round_trip() {
    let root = std::env::temp_dir().join(format!("catio-xfer-rt-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    // 准备本地源文件（64 KiB，跨多个 CHUNK，且 < 阈值走单流）。
    let payload: Vec<u8> = (0..64 * 1024).map(|i| (i % 251) as u8).collect();
    let src = root.join("src.bin");
    std::fs::write(&src, &payload).unwrap();
    let total = payload.len() as u64;

    // ── 上传 ──
    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp for upload");
    let cancel = Arc::new(AtomicBool::new(false));
    let up_done = Arc::new(AtomicU64::new(0));
    let up_done_cb = up_done.clone();
    let remote = "remote.bin";
    let cancelled = upload_sftp(
        &sftp,
        src.to_str().unwrap(),
        remote,
        total,
        cancel.clone(),
        move |done| up_done_cb.store(done, Ordering::Relaxed),
    )
    .await
    .expect("upload ok");
    assert!(!cancelled, "未取消应正常完成");
    assert_eq!(up_done.load(Ordering::Relaxed), total, "上传进度终值应为总字节数");

    // 远端文件大小应等于本地大小。
    let remote_size = std::fs::metadata(root.join(remote)).unwrap().len();
    assert_eq!(remote_size, total, "远端文件大小应与源一致");

    // ── 下载 ──
    let sftp2 = open_sftp(&mgr, "sess-1").await.expect("open sftp for download");
    let dst = root.join("dst.bin");
    let dn_done = Arc::new(AtomicU64::new(0));
    let dn_done_cb = dn_done.clone();
    let cancel2 = Arc::new(AtomicBool::new(false));
    let cancelled = download_sftp(
        &sftp2,
        remote,
        dst.to_str().unwrap(),
        total,
        cancel2.clone(),
        move |done| dn_done_cb.store(done, Ordering::Relaxed),
    )
    .await
    .expect("download ok");
    assert!(!cancelled, "未取消应正常完成");
    assert_eq!(dn_done.load(Ordering::Relaxed), total, "下载进度终值应为总字节数");

    // 字节一致。
    let got = std::fs::read(&dst).unwrap();
    assert_eq!(got, payload, "下载内容应与源文件逐字节一致");

    let _ = std::fs::remove_dir_all(&root);
}

/// 取消标志在传输前置位 → 下载应返回 Ok(true) 且清理半成品本地文件。
#[tokio::test]
async fn download_respects_cancel_flag() {
    let root = std::env::temp_dir().join(format!("catio-xfer-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    // 远端准备一个文件。
    let payload: Vec<u8> = vec![0x5Au8; 32 * 1024];
    let remote = "tocancel.bin";
    std::fs::write(root.join(remote), &payload).unwrap();
    let total = payload.len() as u64;

    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp");
    let dst = root.join("dst-cancel.bin");
    let cancel = Arc::new(AtomicBool::new(true)); // 预先置位
    let cancelled = download_sftp(
        &sftp,
        remote,
        dst.to_str().unwrap(),
        total,
        cancel,
        |_done| {},
    )
    .await
    .expect("download returns ok(true) on cancel");
    assert!(cancelled, "预置取消标志应使下载返回 Ok(true)");
    assert!(!dst.exists(), "取消后半成品本地文件应被清理");

    let _ = std::fs::remove_dir_all(&root);
}
