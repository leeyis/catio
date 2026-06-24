use catio_lib::db::driver::{connect, ConnectArgs};
use catio_lib::db::DatabaseType;

/// Parse CATIO_TEST_MSSQL_URL = "host:port:user:password:dbname".
/// Uses splitn(5) so the password field (index 3) may contain colons — but our
/// password here is "Catio_pw1" (no colons); still safe.
fn mssql_args() -> Option<ConnectArgs> {
    let raw = std::env::var("CATIO_TEST_MSSQL_URL").ok()?;
    // Split into at most 5 parts; password is parts[3], dbname is parts[4].
    let parts: Vec<&str> = raw.splitn(5, ':').collect();
    if parts.len() != 5 {
        return None;
    }
    Some(ConnectArgs {
        db_type: DatabaseType::Sqlserver,
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

#[tokio::test]
async fn mssql_connect_and_test() {
    let Some(args) = mssql_args() else {
        eprintln!("SKIP mssql_connect_and_test: set CATIO_TEST_MSSQL_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("should connect to SQL Server");
    let version = driver.test().await.expect("test() should return version");
    assert!(
        version.contains("Microsoft SQL Server"),
        "expected 'Microsoft SQL Server' in version string, got: {version}"
    );
}

#[tokio::test]
async fn mssql_query_returns_generic_rows() {
    let Some(args) = mssql_args() else {
        eprintln!("SKIP mssql_query_returns_generic_rows: set CATIO_TEST_MSSQL_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.unwrap();
    let r = driver
        .query("SELECT 1 AS n, 'hi' AS s", 100)
        .await
        .unwrap();
    assert_eq!(r.columns.len(), 2, "expected 2 columns, got {:?}", r.columns);
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.columns[1].name, "s");
    assert_eq!(r.rows.len(), 1, "expected 1 row");
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("hi"));
}

#[tokio::test]
async fn mssql_introspects_structure() {
    let Some(args) = mssql_args() else {
        eprintln!("SKIP mssql_introspects_structure: set CATIO_TEST_MSSQL_URL=host:port:user:pw:db");
        return;
    };
    let driver = connect(&args).await.expect("connect");

    // Drop test tables if they exist (idempotent setup)
    driver
        .query(
            "IF OBJECT_ID('dbo.catio_it_child', 'U') IS NOT NULL DROP TABLE dbo.catio_it_child",
            1,
        )
        .await
        .ok();
    driver
        .query(
            "IF OBJECT_ID('dbo.catio_it_parent', 'U') IS NOT NULL DROP TABLE dbo.catio_it_parent",
            1,
        )
        .await
        .ok();

    // Create parent table
    driver
        .query(
            "CREATE TABLE dbo.catio_it_parent (id INT NOT NULL PRIMARY KEY, name NVARCHAR(100))",
            1,
        )
        .await
        .expect("CREATE TABLE catio_it_parent");

    // Create child table with FK to parent
    driver
        .query(
            "CREATE TABLE dbo.catio_it_child (\
               id INT NOT NULL PRIMARY KEY, \
               parent_id INT, \
               CONSTRAINT fk_catio_it_child_parent FOREIGN KEY (parent_id) \
                 REFERENCES dbo.catio_it_parent(id)\
             )",
            1,
        )
        .await
        .expect("CREATE TABLE catio_it_child");

    // list_schemas: dbo must be present
    let schemas = driver.list_schemas().await.expect("list_schemas");
    assert!(
        schemas.iter().any(|s| s == "dbo"),
        "dbo schema missing: {:?}",
        schemas
    );

    // list_tables: catio_it_parent must appear under dbo
    let tables = driver.list_tables("dbo").await.expect("list_tables");
    assert!(
        tables.iter().any(|t| t.name == "catio_it_parent"),
        "catio_it_parent not found in table list: {:?}",
        tables
    );

    // table_structure of parent: id must be PK
    let st = driver
        .table_structure("dbo", "catio_it_parent")
        .await
        .expect("table_structure parent");
    assert!(
        st.columns.iter().any(|c| c.name == "id" && c.key == "PK"),
        "expected id PK, got: {:?}",
        st.columns
    );

    // er_relations: child -> parent FK must appear
    let rels = driver.er_relations("dbo").await.expect("er_relations");
    assert!(
        rels.iter()
            .any(|r| r.from == "catio_it_child" && r.to == "catio_it_parent"),
        "expected child->parent relation, got: {:?}",
        rels
    );

    // table_structure of child: parent_id must be FK; fks must reference catio_it_parent
    let child_st = driver
        .table_structure("dbo", "catio_it_child")
        .await
        .expect("table_structure child");
    assert!(
        child_st.columns.iter().any(|c| c.name == "parent_id" && c.key == "FK"),
        "expected parent_id FK, got: {:?}",
        child_st.columns
    );
    assert!(
        !child_st.fks.is_empty(),
        "expected non-empty fks for catio_it_child"
    );
    assert!(
        child_st.fks.iter().any(|fk| fk.references.contains("catio_it_parent")),
        "expected fks to reference catio_it_parent, got: {:?}",
        child_st.fks
    );

    // Cleanup
    driver
        .query(
            "IF OBJECT_ID('dbo.catio_it_child', 'U') IS NOT NULL DROP TABLE dbo.catio_it_child",
            1,
        )
        .await
        .ok();
    driver
        .query(
            "IF OBJECT_ID('dbo.catio_it_parent', 'U') IS NOT NULL DROP TABLE dbo.catio_it_parent",
            1,
        )
        .await
        .ok();
}
