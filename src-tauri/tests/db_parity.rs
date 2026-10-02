//! DBX parity regression gates. Never connect unless a CATIO_TEST_* fixture is configured.
use catio_lib::db::{driver::{connect, ConnectArgs}, DatabaseType};
use serde_json::json;

fn args(db_type: DatabaseType) -> ConnectArgs {
    ConnectArgs { db_type, host: ":memory:".into(), port: 0, user: String::new(), database: None,
        driver_profile: None, options: None, secret: None, ssl: false, ssl_mode: None,
        ca_cert_path: None, ssl_reject_unauthorized: None }
}

fn external(db: DatabaseType, env: &str) -> Option<ConnectArgs> {
    let Ok(raw) = std::env::var(env) else { eprintln!("SKIP: {env} is not configured"); return None; };
    let p: Vec<_> = raw.splitn(5, ':').collect();
    assert_eq!(p.len(), 5, "{env} must be host:port:user:password:database");
    Some(ConnectArgs { host: p[0].into(), port: p[1].parse().expect("fixture port"),
        user: p[2].into(), secret: Some(p[3].into()), database: Some(p[4].into()), ..args(db) })
}

#[tokio::test]
async fn sqlite_pages_have_exact_has_more_semantics() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE pages(id INTEGER PRIMARY KEY)", 0).await.unwrap();
    d.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<205) INSERT INTO pages SELECT i FROM n", 0).await.unwrap();
    for (offset, count, more) in [(0, 100, true), (100, 100, true), (200, 5, false)] {
        let r = d.table_data(Some("main"), "pages", 100, offset).await.unwrap();
        assert_eq!(r.rows.len(), count);
        assert_eq!(r.truncated, more, "has-more at offset {offset}");
    }
    d.query("DELETE FROM pages WHERE id > 200", 0).await.unwrap();
    assert!(!d.table_data(None, "pages", 100, 100).await.unwrap().truncated);
}

#[tokio::test]
async fn paginated_query_preserves_existing_limit_and_trailing_semicolon() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    let r = d.paginated_query("SELECT 1 AS id UNION ALL SELECT 2 UNION ALL SELECT 3 LIMIT 2; -- end", 1, 1).await.unwrap();
    assert_eq!(r.rows, vec![vec![json!(2)]]);
    assert!(!r.truncated, "must not read beyond the user's LIMIT");
}

#[tokio::test]
async fn pagination_never_replays_writes_or_multi_statements() {
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE safety(id INTEGER PRIMARY KEY)", 0).await.unwrap();
    for sql in ["INSERT INTO safety VALUES(1) RETURNING id", "SELECT 1; DELETE FROM safety", "WITH n AS (SELECT 1) DELETE FROM safety RETURNING id"] {
        assert!(d.paginated_query(sql, 10, 0).await.is_err(), "pagination must reject {sql}");
    }
    assert!(d.paginated_query("SELECT 1", 0, 0).await.is_err());
    assert_eq!(d.query("SELECT COUNT(*) FROM safety", 1).await.unwrap().rows[0][0], json!(0));
}

#[tokio::test]
async fn every_embedded_transaction_capability_has_real_rollback() {
    for db in [DatabaseType::Sqlite, DatabaseType::Duckdb] {
        eprintln!("{db:?}: connect");
        let d = connect(&args(db)).await.unwrap();
        assert!(d.capabilities().transactions);
        d.query("CREATE TABLE atomic_edits(id INTEGER PRIMARY KEY, v VARCHAR)", 0).await.unwrap();
        eprintln!("{db:?}: begin successful batch");
        let r = d.exec_batch(&["INSERT INTO atomic_edits VALUES(1, 'first')".into(), "INSERT INTO atomic_edits VALUES(2, 'second')".into()]).await;
        assert!(r.is_ok(), "{db:?} advertises transactions: {r:?}");
        eprintln!("{db:?}: commit completed; begin failing batch");
        let r = d.exec_batch(&["UPDATE atomic_edits SET v='changed' WHERE id=1".into(), "INSERT INTO atomic_edits VALUES(2, 'duplicate')".into()]).await;
        assert!(r.is_err());
        eprintln!("{db:?}: rollback returned; checking original value");
        assert_eq!(d.query("SELECT v FROM atomic_edits WHERE id=1", 1).await.unwrap().rows[0][0], json!("first"), "{db:?} rollback");
        eprintln!("{db:?}: verified");
    }
}

#[tokio::test]
async fn postgres_values_are_not_silently_replaced_by_null() {
    let Some(a) = external(DatabaseType::Postgres, "CATIO_TEST_PG_URL") else { return; };
    let d = connect(&a).await.unwrap();
    let r = d.query("SELECT '123e4567-e89b-12d3-a456-426614174000'::uuid AS id, 1234567890123456789012345678901234567890.123456789::numeric AS amount, ARRAY[1,2,NULL] AS items, '2026-01-02 03:04:05.123456'::timestamp AS at, '1 day 02:03:04'::interval AS duration, '192.0.2.1/24'::inet AS ip, NULL::uuid AS missing", 10).await.unwrap();
    assert_eq!(r.rows[0][0], json!("123e4567-e89b-12d3-a456-426614174000"));
    assert_eq!(r.rows[0][1], json!("1234567890123456789012345678901234567890.123456789"));
    for index in 2..6 { assert!(!r.rows[0][index].is_null(), "column {index} lost its value"); }
    assert!(r.rows[0][3].as_str().unwrap().contains(".123456"));
    assert_eq!(r.rows[0][6], json!(null));
}

#[tokio::test]
async fn postgres_view_preview_and_ctid_are_valid() {
    let Some(a) = external(DatabaseType::Postgres, "CATIO_TEST_PG_URL") else { return; };
    let d = connect(&a).await.unwrap();
    // Unique names keep concurrent test runs isolated.
    let s = format!("catio_parity_{}", std::process::id());
    d.query(&format!("CREATE SCHEMA {s}"), 0).await.unwrap();
    d.query(&format!("CREATE TABLE {s}.t (v text)"), 0).await.unwrap();
    d.query(&format!("INSERT INTO {s}.t VALUES ('kept')"), 0).await.unwrap();
    d.query(&format!("CREATE VIEW {s}.v AS SELECT v FROM {s}.t"), 0).await.unwrap();
    let table = d.table_data(Some(&s), "t", 10, 0).await;
    let view = d.table_data(Some(&s), "v", 10, 0).await;
    d.query(&format!("DROP SCHEMA {s} CASCADE"), 0).await.unwrap();
    let table = table.unwrap();
    let key = table.columns.iter().position(|c| c.name == "__ctid").expect("row identity");
    assert!(table.rows[0][key].as_str().is_some_and(|s| s.starts_with('(')), "ctid must be a usable tuple id");
    assert_eq!(view.unwrap().rows, vec![vec![json!("kept")]]);
}

#[tokio::test]
async fn import_replacement_and_append_are_atomic() {
    use catio_lib::db::{write_ops, table_import::ImportColumnMapping};
    for db in [DatabaseType::Sqlite, DatabaseType::Duckdb] {
        let d = connect(&args(db)).await.unwrap();
        d.query("CREATE TABLE import_target(id INTEGER PRIMARY KEY, v VARCHAR)", 0).await.unwrap();
        d.query("INSERT INTO import_target VALUES(9, 'original')", 0).await.unwrap();
        let mapping = vec![ImportColumnMapping { source_column: "id".into(), target_column: "id".into() },
            ImportColumnMapping { source_column: "v".into(), target_column: "v".into() }];
        for mode in ["truncate", "append"] {
            let r = write_ops::import_bytes(d.as_ref(), None, "import_target", "rows.csv",
                b"id,v\n1,first\n1,duplicate", &mapping, mode, 1, true).await;
            assert!(r.is_err(), "{db:?} must reject duplicate in second batch");
            assert_eq!(d.query("SELECT id,v FROM import_target", 10).await.unwrap().rows,
                vec![vec![json!(9),json!("original")]], "{db:?} {mode} must roll back the entire import");
        }
        assert!(write_ops::import_bytes(d.as_ref(), None, "import_target", "rows.csv",
            b"id,v\n1,first", &mapping, "truncate", 1, false).await.is_err());
    }
}

#[tokio::test]
async fn staged_same_connection_transfer_rolls_back_on_target_failure() {
    use catio_lib::db::{write_ops, transfer::{TransferColumnMapping, TransferMode}};
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    d.query("CREATE TABLE source(id INTEGER, v TEXT)", 0).await.unwrap();
    d.query("CREATE TABLE target(id INTEGER PRIMARY KEY, v TEXT)", 0).await.unwrap();
    d.query("INSERT INTO source VALUES(1,'first'),(1,'duplicate')", 0).await.unwrap();
    d.query("INSERT INTO target VALUES(9,'original')", 0).await.unwrap();
    let mapping = vec![TransferColumnMapping { source_column: "id".into(), target_column: "id".into() },
        TransferColumnMapping { source_column: "v".into(), target_column: "v".into() }];
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), write_ops::transfer_table(
        d.as_ref(), None, "source", d.as_ref(), None, "target", &mapping, TransferMode::Overwrite,
        &[], 1, true, &|_, _| {})).await.expect("same-connection copy must not deadlock");
    assert!(result.is_err());
    assert_eq!(d.query("SELECT id,v FROM target", 10).await.unwrap().rows, vec![vec![json!(9),json!("original")]]);
}

#[tokio::test]
async fn transfer_preserves_binary_values_when_replacing_the_target() {
    use catio_lib::db::{write_ops, transfer::{TransferColumnMapping, TransferMode}};
    let d = connect(&args(DatabaseType::Sqlite)).await.unwrap();
    // SQLite can store a BLOB in a TEXT-declared column, even after a text-only first page.
    d.query("CREATE TABLE binary_source(id INTEGER, v TEXT)", 0).await.unwrap();
    d.query("CREATE TABLE binary_target(id INTEGER PRIMARY KEY, v TEXT)", 0).await.unwrap();
    d.query("INSERT INTO binary_source VALUES(1,'first'),(2,X'ff00')", 0).await.unwrap();
    d.query("INSERT INTO binary_target VALUES(9,'original')", 0).await.unwrap();
    let mapping = vec![TransferColumnMapping { source_column: "id".into(), target_column: "id".into() },
        TransferColumnMapping { source_column: "v".into(), target_column: "v".into() }];
    let result = write_ops::transfer_table(d.as_ref(), None, "binary_source", d.as_ref(), None,
        "binary_target", &mapping, TransferMode::Overwrite, &[], 1, true, &|_, _| {}).await;
    result.expect("typed metadata now permits a safe binary transfer");
    assert_eq!(d.query("SELECT id,typeof(v),v FROM binary_target ORDER BY id", 10).await.unwrap().rows,
        vec![vec![json!(1),json!("text"),json!("first")],vec![json!(2),json!("blob"),json!("0xff00")]]);
    // Unmapped binary data does not block a deliberate ID-only copy.
    write_ops::transfer_table(d.as_ref(), None, "binary_source", d.as_ref(), None, "binary_target",
        &mapping[..1], TransferMode::Overwrite, &[], 1, true, &|_, _| {}).await.unwrap();
    assert_eq!(d.query("SELECT COUNT(*) FROM binary_target", 1).await.unwrap().rows[0][0], json!(2));
}

#[tokio::test]
async fn statement_source_failure_rolls_back_embedded_transactions() {
    for db in [DatabaseType::Sqlite, DatabaseType::Duckdb] {
        let d = connect(&args(db)).await.unwrap();
        d.query("CREATE TABLE spool_failure(id INTEGER PRIMARY KEY)", 0).await.unwrap();
        let statements = vec![Ok("INSERT INTO spool_failure VALUES(1)".into()),
            Err(catio_lib::db::DbError::Io("simulated spool read error".into()))];
        assert!(d.exec_statement_batch(Box::new(statements.into_iter())).await.is_err());
        assert_eq!(d.query("SELECT COUNT(*) FROM spool_failure", 1).await.unwrap().rows[0][0], json!(0));
    }
}
