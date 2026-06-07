mod common;
use common::test_server;

#[tokio::test]
async fn test_server_starts_and_binds() {
    let addr = test_server::start().await;
    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert!(addr.port() > 0);
}
