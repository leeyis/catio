use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_MONGO_URL (format: "host:port:user:password:dbname").
/// Example: "127.0.0.1:57017:::catio_test"
fn mongo_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_MONGO_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        eprintln!("SKIP: CATIO_TEST_MONGO_URL must have 5 colon-separated parts: host:port:user:password:dbname");
        return None;
    }
    let user = parts[2].to_string();
    let secret = parts[3];
    let secret = if secret.is_empty() { None } else { Some(secret.to_string()) };
    Some(ConnectArgs {
        db_type: DatabaseType::Mongodb,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user,
        secret,
        database: Some(parts[4].into()),
        driver_profile: None,
        options: None,
    })
}

#[tokio::test]
async fn mongo_connect_and_test() {
    let Some(args) = mongo_args() else {
        eprintln!("SKIP mongo_connect_and_test: set CATIO_TEST_MONGO_URL=host:port:user:password:dbname");
        return;
    };
    let driver = connect(&args).await.expect("should connect to MongoDB");
    let version = driver.test().await.expect("test() should return version");
    assert!(!version.is_empty(), "version should be non-empty, got: {version:?}");
    eprintln!("MongoDB test() result: {version}");
}

#[tokio::test]
async fn mongo_list_and_query() {
    use mongodb::{Client, bson::doc};

    let Some(args) = mongo_args() else {
        eprintln!("SKIP mongo_list_and_query: set CATIO_TEST_MONGO_URL=host:port:user:password:dbname");
        return;
    };

    let db_name = args.database.clone().unwrap_or_else(|| "catio_test".into());
    let host = args.host.clone();
    let port = args.port;
    let coll_name = "people";

    // ---- Seed: use the mongodb crate directly ----
    let uri = format!("mongodb://{}:{}", host, port);
    let seed_client = Client::with_uri_str(&uri).await.expect("seed client connect");
    let seed_db = seed_client.database(&db_name);
    let coll = seed_db.collection::<mongodb::bson::Document>(coll_name);

    // Drop existing to start clean
    let _ = coll.drop().await;

    // Insert 3 documents
    coll.insert_many(vec![
        doc! { "name": "Alice", "age": 30_i32, "city": "Beijing" },
        doc! { "name": "Bob",   "age": 25_i32, "city": "Shanghai" },
        doc! { "name": "Carol", "age": 35_i32, "city": "Shenzhen" },
    ]).await.expect("seed insert_many should succeed");

    // ---- Now test via the Driver abstraction ----
    let driver = connect(&args).await.expect("should connect to MongoDB");

    // list_schemas should contain our test db
    let schemas = driver.list_schemas().await.expect("list_schemas failed");
    assert!(
        schemas.iter().any(|s| s == &db_name),
        "expected '{db_name}' in schemas, got: {schemas:?}"
    );

    // list_tables should include "people"
    let tables = driver.list_tables(&db_name).await.expect("list_tables failed");
    assert!(
        tables.iter().any(|t| t.name == coll_name),
        "expected '{coll_name}' in tables, got: {tables:?}"
    );

    // query("people") should return 3 rows with name / age columns
    let result = driver.query(coll_name, 100).await.expect("query failed");
    assert_eq!(result.rows.len(), 3, "expected 3 rows, got {}", result.rows.len());

    let col_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(
        col_names.contains(&"name"),
        "expected 'name' column, got: {col_names:?}"
    );
    assert!(
        col_names.contains(&"age"),
        "expected 'age' column, got: {col_names:?}"
    );

    // Verify values: all three names should appear somewhere
    let name_idx = result.columns.iter().position(|c| c.name == "name").unwrap();
    let names: Vec<&str> = result.rows.iter()
        .filter_map(|row| row.get(name_idx)?.as_str())
        .collect();
    assert!(names.contains(&"Alice"), "expected Alice in rows, got: {names:?}");
    assert!(names.contains(&"Bob"),   "expected Bob in rows, got: {names:?}");
    assert!(names.contains(&"Carol"), "expected Carol in rows, got: {names:?}");

    // table_data — the DATA GRID path. Must use the schema (database), NOT the
    // connection's default_db, and must paginate. This is the regression the user
    // hit: clicking a collection in another DB showed 0 rows.
    let page1 = driver.table_data(Some(&db_name), coll_name, 2, 0).await.expect("table_data page1");
    assert_eq!(page1.rows.len(), 2, "page size 2, got {}", page1.rows.len());
    assert!(page1.truncated, "3 docs with page size 2 → truncated");
    assert!(page1.columns.iter().any(|c| c.name == "_id" && c.pk), "_id pk column expected");
    let page2 = driver.table_data(Some(&db_name), coll_name, 2, 2).await.expect("table_data page2");
    assert_eq!(page2.rows.len(), 1, "remaining 1 doc on page 2");
    assert!(!page2.truncated, "page 2 is the last page");

    // ---- Cleanup ----
    let _ = coll.drop().await;
    eprintln!("mongo_list_and_query PASSED: schemas={schemas:?}, tables={tables:?}, rows={}", result.rows.len());
}
