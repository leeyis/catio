use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_MYSQL_URL ("host:port:user:password:dbname"); skip if absent.
fn mysql_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_MYSQL_URL").ok()?;
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Mysql,
        host: parts[0].into(),
        port: parts[1].parse().ok()?,
        user: parts[2].into(),
        secret: Some(parts[3].into()),
        database: Some(parts[4].into()),
        driver_profile: None,
    })
}

#[tokio::test]
async fn mysql_connect_and_test() {
    let Some(args) = mysql_args() else {
        eprintln!("SKIP mysql_connect_and_test: set CATIO_TEST_MYSQL_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect");
    let version = driver.test().await.expect("test() ok");
    assert!(
        !version.is_empty(),
        "version string should be non-empty, got: {version}"
    );
    // MySQL 8.x or MariaDB
    let lower = version.to_lowercase();
    assert!(
        lower.contains("8.") || lower.contains("maria") || lower.contains("5.") || lower.contains("9."),
        "expected MySQL 8.x/MariaDB/5.x version, got: {version}"
    );
}

#[tokio::test]
async fn mysql_query_returns_generic_rows() {
    let Some(args) = mysql_args() else {
        eprintln!("SKIP mysql_query_returns_generic_rows: set CATIO_TEST_MYSQL_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect");
    let r = driver
        .query("SELECT 1 AS n, 'hi' AS s", 100)
        .await
        .expect("query ok");
    assert_eq!(r.columns.len(), 2, "expected 2 columns");
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.columns[1].name, "s");
    assert_eq!(r.rows.len(), 1, "expected 1 row");
    // MySQL returns 1 as integer
    assert!(
        r.rows[0][0] == serde_json::json!(1)
            || r.rows[0][0] == serde_json::json!("1"),
        "expected n=1, got: {:?}",
        r.rows[0][0]
    );
    assert_eq!(r.rows[0][1], serde_json::json!("hi"));
}

#[tokio::test]
async fn mysql_introspects_structure() {
    let Some(args) = mysql_args() else {
        eprintln!(
            "SKIP mysql_introspects_structure: set CATIO_TEST_MYSQL_URL=host:port:user:pw:db"
        );
        return;
    };
    let driver = connect(&args).await.expect("should connect");
    let db = args.database.clone().unwrap_or_else(|| "catio".into());

    // ---- Setup: drop then recreate temp tables ----
    let _ = driver
        .query("DROP TABLE IF EXISTS catio_it_child", 1)
        .await;
    let _ = driver
        .query("DROP TABLE IF EXISTS catio_it_parent", 1)
        .await;
    driver
        .query(
            "CREATE TABLE catio_it_parent (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100))",
            1,
        )
        .await
        .expect("create parent table");
    driver
        .query(
            "CREATE TABLE catio_it_child ( \
             id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, \
             parent_id INT, \
             CONSTRAINT fk_catio_child_parent FOREIGN KEY (parent_id) \
               REFERENCES catio_it_parent(id) ON DELETE SET NULL ON UPDATE CASCADE \
             )",
            1,
        )
        .await
        .expect("create child table");

    // ---- list_schemas: returns the connected DB name ----
    let schemas = driver.list_schemas().await.expect("list_schemas ok");
    assert!(
        schemas.contains(&db),
        "expected db '{db}' in schemas, got: {:?}",
        schemas
    );

    // ---- list_tables: both tables must appear ----
    let tables = driver.list_tables(&db).await.expect("list_tables ok");
    assert!(
        tables.iter().any(|t| t.name == "catio_it_parent"),
        "catio_it_parent not in tables: {:?}",
        tables
    );
    assert!(
        tables.iter().any(|t| t.name == "catio_it_child"),
        "catio_it_child not in tables: {:?}",
        tables
    );

    // ---- table_structure: parent.id should be PK ----
    let parent_st = driver
        .table_structure(&db, "catio_it_parent")
        .await
        .expect("table_structure catio_it_parent ok");
    assert!(
        parent_st.columns.iter().any(|c| c.name == "id" && c.key == "PK"),
        "expected id PK in parent, got: {:?}",
        parent_st.columns
    );

    // ---- table_structure: child.parent_id should be FK ----
    let child_st = driver
        .table_structure(&db, "catio_it_child")
        .await
        .expect("table_structure catio_it_child ok");
    assert!(
        child_st.columns.iter().any(|c| c.name == "parent_id" && c.key == "FK"),
        "expected parent_id FK in child, got: {:?}",
        child_st.columns
    );
    assert!(
        !child_st.fks.is_empty(),
        "expected non-empty fks for catio_it_child"
    );
    assert!(
        child_st.fks.iter().any(|fk| fk.references.contains("catio_it_parent")),
        "expected FK references to contain 'catio_it_parent', got: {:?}",
        child_st.fks
    );

    // ---- er_relations: child -> parent must appear ----
    let rels = driver.er_relations(&db).await.expect("er_relations ok");
    assert!(
        rels.iter().any(|r| r.from == "catio_it_child" && r.to == "catio_it_parent"),
        "expected child->parent ER relation, got: {:?}",
        rels
    );

    // ---- Cleanup ----
    let _ = driver.query("DROP TABLE catio_it_child", 1).await;
    let _ = driver.query("DROP TABLE catio_it_parent", 1).await;
}
