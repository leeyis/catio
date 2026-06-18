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
use catio_lib::ssh::sftp_transfer::{
    download_sftp, download_sftp_segmented, open_sftp, plan_segments, upload_sftp,
    upload_sftp_segmented,
};

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

// ─── slice 4（slice4-segmented-download）集成测试 ────────────────────────────
//
// 验证 `download_sftp_segmented`：用 plan_segments 分多段、各段独立 File 句柄并行
// seek/读写、本地 set_len 预占位、共享 done 聚合进度、共享 cancel 处置。

/// 多 MB 文件（> MIN_SEG_SIZE，触发多段）分段下载：字节一致、大小一致、进度终值正确。
#[tokio::test]
async fn segmented_download_multi_mb_round_trip() {
    let root = std::env::temp_dir().join(format!("catio-seg-dl-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    // 远端准备 3 MiB + 1234 字节文件：plan_segments 应给出多段（ceil(3MiB/1MiB)=4，取 4 段）。
    let total_usize = 3 * 1024 * 1024 + 1234;
    let payload: Vec<u8> = (0..total_usize).map(|i| (i % 251) as u8).collect();
    let remote = "big.bin";
    std::fs::write(root.join(remote), &payload).unwrap();
    let total = payload.len() as u64;

    // 前置：确认该大小确实被分成多段（否则测的不是分段路径）。
    assert!(plan_segments(total).len() >= 2, "测试负载应触发多段");

    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp");
    let dst = root.join("big-dst.bin");
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicU64::new(0));
    let done_cb = done.clone();
    let cancelled = download_sftp_segmented(
        Arc::new(sftp),
        remote,
        dst.to_str().unwrap(),
        total,
        cancel,
        move |d| {
            // 进度单调不减、不超过 total。
            done_cb.store(d, Ordering::Relaxed);
        },
    )
    .await
    .expect("segmented download ok");
    assert!(!cancelled, "未取消应正常完成");
    assert_eq!(done.load(Ordering::Relaxed), total, "进度终值应为总字节数");

    let got = std::fs::read(&dst).unwrap();
    assert_eq!(got.len() as u64, total, "下载文件大小应与源一致");
    assert_eq!(got, payload, "分段下载内容应与源逐字节一致");

    let _ = std::fs::remove_dir_all(&root);
}

/// 预置取消标志 → 分段下载返回 Ok(true) 且清理本地半成品文件。
#[tokio::test]
async fn segmented_download_respects_cancel_flag() {
    let root = std::env::temp_dir().join(format!("catio-seg-dl-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    let total_usize = 3 * 1024 * 1024;
    let payload: Vec<u8> = vec![0x33u8; total_usize];
    let remote = "big-cancel.bin";
    std::fs::write(root.join(remote), &payload).unwrap();
    let total = payload.len() as u64;

    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp");
    let dst = root.join("big-cancel-dst.bin");
    let cancel = Arc::new(AtomicBool::new(true)); // 预先置位
    let cancelled = download_sftp_segmented(
        Arc::new(sftp),
        remote,
        dst.to_str().unwrap(),
        total,
        cancel,
        |_d| {},
    )
    .await
    .expect("segmented download returns ok(true) on cancel");
    assert!(cancelled, "预置取消标志应使分段下载返回 Ok(true)");
    assert!(!dst.exists(), "取消后本地半成品文件应被清理");

    let _ = std::fs::remove_dir_all(&root);
}

// ─── slice 5（slice5-segmented-upload）集成测试 ──────────────────────────────
//
// 验证 `upload_sftp_segmented`（设计文档 §5.3）：先 CREATE|TRUNCATE|WRITE 建/清空远端
// 并立即关闭，再 plan_segments 分多段、各段独立本地/远端 File 句柄并行 seek 到 offset、
// 循环本地读/远端写；共享 done 聚合进度、共享 cancel 处置；取消/失败删除远端半成品。

/// 多 MB 文件（> MIN_SEG_SIZE，触发多段）分段上传：经测试服落盘校验字节一致、大小一致、
/// 进度终值正确；再用 download_sftp_segmented 取回二次校验 round-trip。
#[tokio::test]
async fn segmented_upload_multi_mb_round_trip() {
    let root = std::env::temp_dir().join(format!("catio-seg-ul-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    // 本地准备 3 MiB + 1234 字节文件：plan_segments 应给出多段。
    let total_usize = 3 * 1024 * 1024 + 1234;
    let payload: Vec<u8> = (0..total_usize).map(|i| (i % 251) as u8).collect();
    let src = root.join("seg-src.bin");
    std::fs::write(&src, &payload).unwrap();
    let total = payload.len() as u64;

    // 前置：确认该大小确实被分成多段（否则测的不是分段路径）。
    assert!(plan_segments(total).len() >= 2, "测试负载应触发多段");

    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp for upload");
    let remote = "seg-remote.bin";
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicU64::new(0));
    let done_cb = done.clone();
    let cancelled = upload_sftp_segmented(
        Arc::new(sftp),
        src.to_str().unwrap(),
        remote,
        total,
        cancel,
        move |d| {
            done_cb.store(d, Ordering::Relaxed);
        },
    )
    .await
    .expect("segmented upload ok");
    assert!(!cancelled, "未取消应正常完成");
    assert_eq!(done.load(Ordering::Relaxed), total, "上传进度终值应为总字节数");

    // 经测试服文件系统直接校验远端落盘内容。
    let landed = std::fs::read(root.join(remote)).unwrap();
    assert_eq!(landed.len() as u64, total, "远端文件大小应与源一致");
    assert_eq!(landed, payload, "分段上传落盘内容应与源逐字节一致");

    // 再 round-trip 下载二次校验。
    let sftp2 = open_sftp(&mgr, "sess-1").await.expect("open sftp for download");
    let dst = root.join("seg-dst.bin");
    let cancel2 = Arc::new(AtomicBool::new(false));
    let cancelled = download_sftp_segmented(
        Arc::new(sftp2),
        remote,
        dst.to_str().unwrap(),
        total,
        cancel2,
        |_d| {},
    )
    .await
    .expect("download back ok");
    assert!(!cancelled);
    let got = std::fs::read(&dst).unwrap();
    assert_eq!(got, payload, "上传后下载取回应与源逐字节一致");

    let _ = std::fs::remove_dir_all(&root);
}

/// 预置取消标志 → 分段上传返回 Ok(true) 且清理远端半成品文件。
#[tokio::test]
async fn segmented_upload_respects_cancel_flag() {
    let root = std::env::temp_dir().join(format!("catio-seg-ul-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let addr = test_server::start_with_root(root.clone()).await;
    let mgr = manager_with_session(addr).await;

    let total_usize = 3 * 1024 * 1024;
    let payload: Vec<u8> = vec![0x7Eu8; total_usize];
    let src = root.join("seg-cancel-src.bin");
    std::fs::write(&src, &payload).unwrap();
    let total = payload.len() as u64;

    let sftp = open_sftp(&mgr, "sess-1").await.expect("open sftp");
    let remote = "seg-cancel-remote.bin";
    let cancel = Arc::new(AtomicBool::new(true)); // 预先置位
    let cancelled = upload_sftp_segmented(
        Arc::new(sftp),
        src.to_str().unwrap(),
        remote,
        total,
        cancel,
        |_d| {},
    )
    .await
    .expect("segmented upload returns ok(true) on cancel");
    assert!(cancelled, "预置取消标志应使分段上传返回 Ok(true)");
    assert!(
        !root.join(remote).exists(),
        "取消后远端半成品文件应被清理"
    );

    let _ = std::fs::remove_dir_all(&root);
}
