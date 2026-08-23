//! Live PostgreSQL verification against a real postgres:16 container.
//!
//! Ignored by default (requires a local container):
//!   docker run -d --name catio-pg-test -e POSTGRES_PASSWORD=testpass -e POSTGRES_USER=test -e POSTGRES_DB=testdb -p 5433:5432 postgres:16
//! Then run: `cargo test --test db_live -- --ignored`

use tokio_postgres::{Config, NoTls};

#[tokio::test]
#[ignore = "requires a local postgres container on 127.0.0.1:5433"]
async fn live_pg_connects_and_runs_sql() {
    let mut cfg = Config::new();
    cfg.host("127.0.0.1")
        .port(5433)
        .user("test")
        .password("testpass")
        .dbname("testdb");
    let (client, conn) = cfg.connect(NoTls).await.expect("pg connect failed");
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("pg connection error: {e}");
        }
    });

    let row = client.query_one("SELECT version()", &[]).await.expect("version query failed");
    let version: String = row.get(0);
    assert!(version.contains("PostgreSQL"), "unexpected version: {version}");

    // Real DDL + DML round-trip.
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS catio_probe(id int PRIMARY KEY, name text); \
             TRUNCATE catio_probe; \
             INSERT INTO catio_probe VALUES (1, 'alpha'), (2, 'beta');",
        )
        .await
        .expect("ddl/dml failed");
    let count: i64 = client
        .query_one("SELECT count(*) FROM catio_probe", &[])
        .await
        .expect("count query failed")
        .get(0);
    assert_eq!(count, 2);
}
