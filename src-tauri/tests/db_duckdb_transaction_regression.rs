//! Direct driver regression: a transaction must be finalized exactly once.
#[test]
fn duckdb_native_rollback_followed_by_indexed_read() {
    let conn = duckdb::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v VARCHAR)").unwrap();
    conn.execute_batch("BEGIN TRANSACTION").unwrap();
    conn.execute("INSERT INTO t VALUES(1,'first'),(2,'second')", []).unwrap();
    conn.execute_batch("COMMIT").unwrap();
    conn.execute_batch("BEGIN TRANSACTION").unwrap();
    conn.execute("UPDATE t SET v='changed' WHERE id=1", []).unwrap();
    assert!(conn.execute("INSERT INTO t VALUES(2,'duplicate')", []).is_err());
    conn.execute_batch("ROLLBACK").unwrap();
    let version: String = conn.query_row("SELECT version()", [], |r| r.get(0)).unwrap();
    eprintln!("DuckDB {version}: rollback completed; indexed reads must remain healthy");
    let value: String = conn.query_row("SELECT v FROM t WHERE id=1", [], |row| row.get(0)).unwrap();
    assert_eq!(value, "first");
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0)).unwrap();
    assert_eq!(catio_lib::db::result::safe_i64_to_json(count), serde_json::json!(2));
}
