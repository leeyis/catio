mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, connect_checked, AuthMethod, ConnectArgs};

#[tokio::test]
async fn test_server_starts_and_binds() {
    let addr = test_server::start().await;
    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert!(addr.port() > 0);
}

#[tokio::test]
async fn connects_with_password() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, fp) = connect_authenticated(&args).await.expect("should connect");
    assert!(!fp.is_empty(), "fingerprint captured");
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
}

#[tokio::test]
async fn rejects_wrong_password() {
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some("wrong".into()),
    };
    assert!(connect_authenticated(&args).await.is_err());
}

#[tokio::test]
async fn rejects_host_key_mismatch() {
    let dir = std::env::temp_dir().join(format!("catio-kh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let addr = test_server::start().await;
    let hp = format!("{}:{}", addr.ip(), addr.port());
    std::fs::write(dir.join("known_hosts"), format!("{hp} SHA256:bogus\n")).unwrap();
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let res = connect_checked(&args, Some(dir.as_path())).await;
    assert!(matches!(res, Err(catio_lib::ssh::SshError::HostKeyMismatch)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn trusts_known_host() {
    // Step 1: connect with no known_hosts to learn the real fingerprint.
    let addr = test_server::start().await;
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::Password,
        secret: Some(test_server::TEST_PW.into()),
    };
    let (handle, fp, _) = connect_checked(&args, None).await.expect("first connect");
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    // Step 2: pre-write the real fingerprint and verify it is trusted.
    let hp = format!("{}:{}", addr.ip(), addr.port());
    let dir = std::env::temp_dir().join(format!("catio-kh-trust-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("known_hosts"), format!("{hp} {fp}\n")).unwrap();

    let (handle2, fp2, trusted) = connect_checked(&args, Some(dir.as_path()))
        .await
        .expect("second connect should succeed");
    assert!(trusted, "host should be trusted");
    assert_eq!(fp, fp2, "fingerprint should be stable");
    handle2
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn connects_with_key_file() {
    let addr = test_server::start().await;
    let key_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/id_test");
    let args = ConnectArgs {
        host: addr.ip().to_string(),
        port: addr.port(),
        user: test_server::TEST_USER.into(),
        auth: AuthMethod::KeyFile { path: key_path.into() },
        secret: None,
    };
    let (handle, _fp) = connect_authenticated(&args).await.expect("key auth");
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
}
