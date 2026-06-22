use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_ES_URL (format: "host:port:user:password:dbname").
/// Typically all empty after host:port: "127.0.0.1:59200::::"
fn es_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_ES_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Elasticsearch,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: None,
        options: None,
        ssl: false,
        ssl_mode: None,
        ca_cert_path: None,
        ssl_reject_unauthorized: None,
    })
}

fn es_base_url(args: &ConnectArgs) -> String {
    format!("http://{}:{}", args.host, args.port)
}

/// Helper: seed an ES index with one document using reqwest directly.
/// Returns the reqwest client for use in cleanup.
async fn seed_index(base_url: &str, index: &str, doc: serde_json::Value) {
    let client = reqwest::Client::new();
    // Create index (ignore error if exists)
    let _ = client
        .put(format!("{}/{}", base_url, index))
        .send()
        .await;
    // Put document with refresh=true so it's immediately searchable
    let resp = client
        .put(format!("{}/{}/_doc/1?refresh=true", base_url, index))
        .json(&doc)
        .send()
        .await
        .expect("seed PUT should succeed");
    assert!(
        resp.status().is_success(),
        "seeding index {index} failed: {}",
        resp.status()
    );
}

/// Helper: delete an ES index for cleanup.
async fn delete_index(base_url: &str, index: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .delete(format!("{}/{}", base_url, index))
        .send()
        .await;
}

#[tokio::test]
async fn es_connect_and_test() {
    let Some(args) = es_args() else {
        eprintln!("SKIP es_connect_and_test: set CATIO_TEST_ES_URL=host:port::::");
        return;
    };
    let driver = connect(&args).await.expect("should connect to Elasticsearch");
    let version = driver.test().await.expect("test() should return version");
    assert!(!version.is_empty(), "version should be non-empty, got: {version:?}");
    eprintln!("Elasticsearch test result: {version}");
}

#[tokio::test]
async fn es_list_schemas_is_default() {
    let Some(args) = es_args() else { return; };
    let driver = connect(&args).await.unwrap();
    let schemas = driver.list_schemas().await.unwrap();
    assert_eq!(schemas, vec!["default"]);
}

#[tokio::test]
async fn es_list_tables_includes_seeded_index() {
    let Some(args) = es_args() else { return; };
    let base_url = es_base_url(&args);
    let index = "catio_it_es_test";

    // Seed
    seed_index(&base_url, index, serde_json::json!({"field1": "hello", "field2": 42})).await;

    let driver = connect(&args).await.unwrap();
    let tables = driver.list_tables("default").await.unwrap();
    assert!(
        tables.iter().any(|t| t.name == index),
        "expected '{index}' in tables, got: {:?}", tables
    );

    // Cleanup
    delete_index(&base_url, index).await;
}

#[tokio::test]
async fn es_query_returns_seeded_doc_as_row() {
    let Some(args) = es_args() else { return; };
    let base_url = es_base_url(&args);
    let index = "catio_it_es_query";

    // Seed
    seed_index(
        &base_url,
        index,
        serde_json::json!({"name": "Alice", "score": 99}),
    ).await;

    let driver = connect(&args).await.unwrap();
    // query() treats `sql` as the index name
    let r = driver.query(index, 100).await.unwrap();
    assert!(!r.columns.is_empty(), "expected columns, got empty");
    assert_eq!(r.rows.len(), 1, "expected 1 doc as row, got: {}", r.rows.len());

    // _id column should be present
    assert!(
        r.columns.iter().any(|c| c.name == "_id"),
        "expected _id column, got: {:?}", r.columns
    );
    // name and score should be present
    let name_col_idx = r.columns.iter().position(|c| c.name == "name");
    let score_col_idx = r.columns.iter().position(|c| c.name == "score");
    assert!(name_col_idx.is_some(), "expected 'name' column, got: {:?}", r.columns);
    assert!(score_col_idx.is_some(), "expected 'score' column, got: {:?}", r.columns);

    if let (Some(ni), Some(si)) = (name_col_idx, score_col_idx) {
        assert_eq!(r.rows[0][ni], serde_json::json!("Alice"));
        assert_eq!(r.rows[0][si], serde_json::json!(99));
    }

    // Cleanup
    delete_index(&base_url, index).await;
}

#[tokio::test]
async fn es_table_structure_from_mapping() {
    let Some(args) = es_args() else { return; };
    let base_url = es_base_url(&args);
    let index = "catio_it_es_struct";

    // Seed
    seed_index(
        &base_url,
        index,
        serde_json::json!({"username": "bob", "age": 30}),
    ).await;

    let driver = connect(&args).await.unwrap();
    let st = driver.table_structure("default", index).await.unwrap();
    assert!(!st.columns.is_empty(), "expected columns from mapping");
    assert!(
        st.columns.iter().any(|c| c.name == "_id"),
        "expected _id in columns"
    );

    // Cleanup
    delete_index(&base_url, index).await;
}
