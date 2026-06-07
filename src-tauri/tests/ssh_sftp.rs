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
