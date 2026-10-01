use catio_lib::db::{driver::{connect, ConnectArgs}, drivers::http::HttpClient, DatabaseType};
use serde_json::json;
fn args() -> ConnectArgs {
    ConnectArgs { db_type: DatabaseType::Clickhouse, host: "127.0.0.1".into(), port: 8123, user: String::new(),
        database: None, driver_profile: None, options: None, secret: None, ssl: false,
        ssl_mode: None, ca_cert_path: None, ssl_reject_unauthorized: None }
}
#[test]
fn http_tls_configuration_is_not_silently_ignored() {
    let mut a = args(); a.ssl = true;
    assert!(HttpClient::from_args(&a).unwrap().base_url.starts_with("https://"));
    a.ssl_mode = Some("disable".into());
    assert!(HttpClient::from_args(&a).unwrap().base_url.starts_with("http://"));
    a.ssl = false; a.ssl_mode = Some("verify-full".into()); a.host = "2001:db8::1".into();
    assert_eq!(HttpClient::from_args(&a).unwrap().base_url, "https://[2001:db8::1]:8123");
    a.ca_cert_path = Some("/nonexistent/catio-fixture-ca.pem".into());
    assert!(HttpClient::from_args(&a).is_err());
}
#[tokio::test]
async fn clickhouse_http_200_is_not_a_success_receipt_when_the_body_contains_an_error() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = axum::Router::new().route("/", axum::routing::get(|| async { "24.8 fixture" })
        .post(|| async { "Code: 60. DB::Exception: late fixture failure" }));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
    let mut a = args(); a.port = port;
    let d = connect(&a).await.unwrap();
    let result = d.query("INSERT INTO absent VALUES(1)", 0).await;
    server.abort();
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("late fixture failure"));
}
#[tokio::test]
async fn clickhouse_real_https_validates_the_fixture_ca() {
    let Ok(raw) = std::env::var("CATIO_TEST_CH_TLS_URL") else { eprintln!("SKIP: CATIO_TEST_CH_TLS_URL is not configured"); return; };
    let ca = std::env::var("CATIO_TEST_CA_CERT").expect("TLS fixture requires a CA file");
    let p: Vec<_> = raw.splitn(5, ':').collect(); assert_eq!(p.len(), 5);
    let mut a = ConnectArgs { host: p[0].into(), port: p[1].parse().unwrap(), user: p[2].into(),
        secret: Some(p[3].into()), database: Some(p[4].into()), ssl: true, ..args() };
    assert!(connect(&a).await.is_err(), "an untrusted self-signed server must not connect by default");
    a.ca_cert_path = Some(ca);
    let d = connect(&a).await.expect("trusted fixture CA must validate HTTPS");
    let r = d.query("/* comments preserve read results */ SELECT 1 AS n, toDecimal128('12345678901234567890.12345678', 8) AS precise", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!(1));
    assert_eq!(r.rows[0][1], json!("12345678901234567890.12345678"));
}
