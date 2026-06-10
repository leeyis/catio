use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_REDIS_URL (format: "host:port:user:password:dbname").
/// Example: "127.0.0.1:56379::::"  (empty user/password/dbname all fine)
fn redis_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_REDIS_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        eprintln!("SKIP: CATIO_TEST_REDIS_URL must have 5 colon-separated parts: host:port:user:password:dbname");
        return None;
    }
    let host = parts[0].to_string();
    let port: u16 = parts[1].parse().ok()?;
    let user = parts[2].to_string();
    let secret_raw = parts[3];
    let secret = if secret_raw.is_empty() { None } else { Some(secret_raw.to_string()) };
    let db_raw = parts[4];
    let database = if db_raw.is_empty() { None } else { Some(db_raw.to_string()) };
    Some(ConnectArgs {
        db_type: DatabaseType::Redis,
        host,
        port,
        user,
        secret,
        database,
        driver_profile: None,
        options: None,
    })
}

#[tokio::test]
async fn redis_connect_and_test() {
    let Some(args) = redis_args() else {
        eprintln!("SKIP redis_connect_and_test: set CATIO_TEST_REDIS_URL=host:port:user:password:dbname");
        return;
    };

    let driver = connect(&args).await.expect("should connect to Redis");
    let version = driver.test().await.expect("test() should return version string");
    assert!(!version.is_empty(), "version should be non-empty, got: {version:?}");
    eprintln!("Redis test() version: {version}");
}

#[tokio::test]
async fn redis_query_lists_keys() {
    use ::redis::AsyncCommands;

    let Some(args) = redis_args() else {
        eprintln!("SKIP redis_query_lists_keys: set CATIO_TEST_REDIS_URL=host:port:user:password:dbname");
        return;
    };

    let host = args.host.clone();
    let port = args.port;

    // ---- Seed: use the redis crate directly on a dedicated key prefix ----
    let url = format!("redis://{}:{}/", host, port);
    let client = ::redis::Client::open(url.as_str()).expect("seed client open");
    let mut seed_conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("seed conn");

    // Use a unique prefix to avoid polluting other keys; clean up at end
    let prefix = "catio_test:";
    let k1 = format!("{}k1", prefix);
    let k2 = format!("{}k2", prefix);
    let k3 = format!("{}list1", prefix);

    // Clean up any leftover keys first
    let _: () = seed_conn.del(&[k1.clone(), k2.clone(), k3.clone()]).await.unwrap_or(());

    // SET two string keys
    let _: () = seed_conn.set(k1.clone(), "value1").await.expect("SET k1");
    let _: () = seed_conn.set(k2.clone(), "value2").await.expect("SET k2");
    // LPUSH a list
    let _: i64 = seed_conn.lpush(k3.clone(), &["elem1", "elem2"]).await.expect("LPUSH k3");

    // ---- Test via Driver abstraction ----
    let driver = connect(&args).await.expect("should connect to Redis");

    // list_schemas should include db0..db15 (or however many configured)
    let schemas = driver.list_schemas().await.expect("list_schemas failed");
    assert!(!schemas.is_empty(), "expected at least one schema, got empty");
    assert!(
        schemas.iter().any(|s| s == "db0"),
        "expected 'db0' in schemas, got: {schemas:?}"
    );
    eprintln!("list_schemas: {:?} (first 5)", &schemas[..schemas.len().min(5)]);

    // list_tables("db0") should return the "keys" pseudo-table
    let tables = driver.list_tables("db0").await.expect("list_tables failed");
    assert!(
        tables.iter().any(|t| t.name == "keys"),
        "expected 'keys' table, got: {tables:?}"
    );
    eprintln!("list_tables(db0): {:?}", tables);

    // query with the seeded prefix pattern
    let pattern = format!("{}*", prefix);
    let result = driver.query(&pattern, 100).await.expect("query failed");

    eprintln!(
        "query({pattern:?}) → {} rows, columns: {:?}",
        result.rows.len(),
        result.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
    );

    // Should have at least 3 rows (k1, k2, k3)
    assert!(
        result.rows.len() >= 3,
        "expected >=3 rows for seeded keys, got {}: rows={:?}",
        result.rows.len(),
        result.rows
    );

    // Column names must be exactly ["key","type","ttl","value"]
    let col_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(col_names, vec!["key", "type", "ttl", "value"],
        "unexpected column names: {col_names:?}");

    // Find column indices
    let key_idx   = result.columns.iter().position(|c| c.name == "key").unwrap();
    let type_idx  = result.columns.iter().position(|c| c.name == "type").unwrap();
    let value_idx = result.columns.iter().position(|c| c.name == "value").unwrap();

    // Extract key names from rows
    let row_keys: Vec<String> = result.rows.iter()
        .filter_map(|row| row.get(key_idx)?.as_str().map(str::to_string))
        .collect();

    // All three seeded keys should appear
    assert!(row_keys.contains(&k1), "expected {k1} in rows, got: {row_keys:?}");
    assert!(row_keys.contains(&k2), "expected {k2} in rows, got: {row_keys:?}");
    assert!(row_keys.contains(&k3), "expected {k3} in rows, got: {row_keys:?}");

    // String keys should have type="string" and value populated
    for row in &result.rows {
        let key = row.get(key_idx).and_then(|v| v.as_str()).unwrap_or("");
        let key_type = row.get(type_idx).and_then(|v| v.as_str()).unwrap_or("");
        let value = row.get(value_idx);

        if key == k1 || key == k2 {
            assert_eq!(key_type, "string", "key {key} should have type string, got {key_type}");
            assert!(
                value.map(|v| !v.is_null()).unwrap_or(false),
                "key {key} value should not be null"
            );
        }
        if key == k3 {
            assert_eq!(key_type, "list", "key {key} should have type list, got {key_type}");
        }
    }

    // table_structure should return Unsupported
    let ts_result = driver.table_structure("db0", "keys").await;
    assert!(ts_result.is_err(), "expected Err from table_structure, got Ok");
    eprintln!("table_structure returned: {:?}", ts_result.unwrap_err());

    // er_relations should return Ok(empty)
    let er = driver.er_relations("db0").await.expect("er_relations should return Ok(empty)");
    assert!(er.is_empty(), "expected empty er_relations");

    // ---- Cleanup ----
    let _: () = seed_conn.del(&[k1.clone(), k2.clone(), k3.clone()]).await.unwrap_or(());
    eprintln!("redis_query_lists_keys PASSED");
}
