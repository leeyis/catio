//! Real network test for the DBeaver-style one-click driver download. Hits Maven
//! Central, so it's gated by CATIO_TEST_JDBC_DOWNLOAD=1 (skips by default).
//! Proves `download_driver_to_dir` fetches a genuine JAR to the drivers dir.

use catio_lib::db::commands::download_driver_to_dir;
use catio_lib::db::DbError;

#[tokio::test]
async fn downloads_a_real_driver_jar() {
    if std::env::var("CATIO_TEST_JDBC_DOWNLOAD").ok().as_deref() != Some("1") {
        eprintln!("SKIP downloads_a_real_driver_jar: set CATIO_TEST_JDBC_DOWNLOAD=1 (network)");
        return;
    }
    let dir = std::env::temp_dir().join("catio-jdbc-dltest");
    std::fs::create_dir_all(&dir).unwrap();

    // firebird/jaybird is a small (~1.5MB) self-contained driver — quick to fetch.
    let status = download_driver_to_dir("firebird", &dir).await.expect("download should succeed");
    assert!(status.installed, "status should report installed after download");
    assert!(status.downloadable);

    let file = dir.join(status.file_name.clone().expect("file_name"));
    assert!(file.exists(), "jar should exist at {}", file.display());
    let bytes = std::fs::read(&file).unwrap();
    assert!(bytes.len() > 200_000, "jar suspiciously small: {} bytes", bytes.len());
    // JAR == ZIP → first two bytes are the "PK" local-file-header magic.
    assert_eq!(&bytes[..2], b"PK", "downloaded file is not a valid JAR/ZIP");

    // Idempotent: a second call is a no-op and still reports installed.
    let again = download_driver_to_dir("firebird", &dir).await.expect("idempotent download");
    assert!(again.installed);

    std::fs::remove_file(&file).ok();
}

#[tokio::test]
async fn manual_only_driver_is_unsupported() {
    if std::env::var("CATIO_TEST_JDBC_DOWNLOAD").ok().as_deref() != Some("1") { return; }
    let dir = std::env::temp_dir().join("catio-jdbc-dltest");
    std::fs::create_dir_all(&dir).ok();
    // 达梦 (dameng) is proprietary — no Maven download.
    let err = download_driver_to_dir("dameng", &dir).await.err().expect("should be unsupported");
    assert!(matches!(err, DbError::Unsupported(_)), "got: {err:?}");
}
