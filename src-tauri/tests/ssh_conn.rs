mod common;
use common::test_server;

use catio_lib::ssh::conn::{connect_authenticated, AuthMethod, ConnectArgs};

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
