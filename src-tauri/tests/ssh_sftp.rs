mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};
use catio_lib::ssh::sftp;

/// 端到端：进程内 sftp 服务端后端服务一个预置的临时目录，客户端列目录，
/// 断言两个文件 + 一个子目录出现，且文件 size 为 Some。
#[tokio::test]
async fn sftp_list_returns_dir_contents() {
    // 预置临时目录：2 文件 + 1 子目录。
    let dir = tempfile::tempdir().expect("create temp dir");
    let root = dir.path().to_path_buf();
    std::fs::write(root.join("alpha.txt"), b"hello world").expect("write alpha");
    std::fs::write(root.join("beta.bin"), vec![0u8; 2048]).expect("write beta");
    std::fs::create_dir(root.join("subdir")).expect("create subdir");

    let addr = test_server::start_with_root(root.clone()).await;

    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, _) = connect_authenticated(&args).await.unwrap();

    let sftp_sess = sftp::open_sftp(&handle).await.expect("open sftp");
    let root_str = root.to_string_lossy().to_string();
    let mut items = sftp::list(&sftp_sess, &root_str).await.expect("list");

    items.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    assert!(names.contains(&"alpha.txt"), "missing alpha.txt: {names:?}");
    assert!(names.contains(&"beta.bin"), "missing beta.bin: {names:?}");
    assert!(names.contains(&"subdir"), "missing subdir: {names:?}");

    let subdir = items.iter().find(|i| i.name == "subdir").unwrap();
    assert_eq!(subdir.kind, "dir");
    assert!(subdir.size.is_none(), "dir size should be None");

    let alpha = items.iter().find(|i| i.name == "alpha.txt").unwrap();
    assert_eq!(alpha.kind, "file");
    assert!(alpha.size.is_some(), "file size should be Some");

    // tempdir 析构时清理。
}

/// B2 端到端：上传一个已知内容的本地文件到远端根目录，经 list 确认出现，
/// 再下载回另一本地路径，断言字节一致；同时断言进度闭包被调用且 done==total。
#[tokio::test]
async fn sftp_upload_download_round_trip() {
    let remote_dir = tempfile::tempdir().expect("create remote root");
    let root = remote_dir.path().to_path_buf();

    // 本地源文件：5000 字节可重现内容。
    let local_dir = tempfile::tempdir().expect("create local dir");
    let src = local_dir.path().join("source.bin");
    let dst = local_dir.path().join("downloaded.bin");
    let content: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&src, &content).expect("write source");

    let addr = test_server::start_with_root(root.clone()).await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, _) = connect_authenticated(&args).await.unwrap();
    let sftp_sess = sftp::open_sftp(&handle).await.expect("open sftp");

    // 上传（裸文件名 → resolve 到 root）。
    let mut up_prog: Vec<(u64, u64)> = Vec::new();
    sftp::upload(&sftp_sess, &src, "uploaded.bin", |done, total| {
        up_prog.push((done, total));
    })
    .await
    .expect("upload");

    // list 应出现 uploaded.bin。
    let root_str = root.to_string_lossy().to_string();
    let items = sftp::list(&sftp_sess, &root_str).await.expect("list");
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    assert!(names.contains(&"uploaded.bin"), "missing uploaded.bin: {names:?}");

    // 下载回本地。
    let mut down_prog: Vec<(u64, u64)> = Vec::new();
    sftp::download(&sftp_sess, "uploaded.bin", &dst, |done, total| {
        down_prog.push((done, total));
    })
    .await
    .expect("download");

    // 字节一致。
    let got = std::fs::read(&dst).expect("read downloaded");
    assert_eq!(got, content, "downloaded bytes differ from source");

    // 进度被调用，且最终 done == total == 5000。
    assert!(!up_prog.is_empty(), "upload progress never called");
    assert!(!down_prog.is_empty(), "download progress never called");
    let (u_done, u_total) = *up_prog.last().unwrap();
    assert_eq!(u_done, u_total);
    assert_eq!(u_total, 5000);
    let (d_done, d_total) = *down_prog.last().unwrap();
    assert_eq!(d_done, d_total);
    assert_eq!(d_total, 5000);
}

/// B3 端到端：mkdir → list 见到目录 → rename → list 见新名不见旧名 →
/// delete(is_dir=true) → list 不再见到。
#[tokio::test]
async fn sftp_mkdir_rename_delete() {
    let remote_dir = tempfile::tempdir().expect("create remote root");
    let root = remote_dir.path().to_path_buf();

    let addr = test_server::start_with_root(root.clone()).await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, _) = connect_authenticated(&args).await.unwrap();
    let sftp_sess = sftp::open_sftp(&handle).await.expect("open sftp");
    let root_str = root.to_string_lossy().to_string();

    // mkdir
    sftp::mkdir(&sftp_sess, "newdir").await.expect("mkdir");
    let items = sftp::list(&sftp_sess, &root_str).await.expect("list 1");
    let newdir = items.iter().find(|i| i.name == "newdir").expect("newdir present");
    assert_eq!(newdir.kind, "dir");

    // rename newdir → renamed
    sftp::rename(&sftp_sess, "newdir", "renamed")
        .await
        .expect("rename");
    let items = sftp::list(&sftp_sess, &root_str).await.expect("list 2");
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    assert!(names.contains(&"renamed"), "missing renamed: {names:?}");
    assert!(!names.contains(&"newdir"), "newdir still present: {names:?}");

    // delete renamed (is_dir = true)
    sftp::delete(&sftp_sess, "renamed", true)
        .await
        .expect("delete dir");
    let items = sftp::list(&sftp_sess, &root_str).await.expect("list 3");
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    assert!(!names.contains(&"renamed"), "renamed not deleted: {names:?}");
}
