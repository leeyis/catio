//! M1 — DB-over-HTTP dispatcher integration tests. Drives the full Data-grid +
//! Data-Compare-sync flow a LAN browser performs against `catio-server`: connect →
//! create/insert → query → introspect schema/structure → exec sync batch → preview/apply
//! edits → object admin → disconnect. Uses an in-memory SQLite kept alive by the shared
//! `ConnManager`, so every call reuses the same connection like the real session.

use std::net::SocketAddr;

use catio_lib::server::{build_router, AppState};
use serde_json::{json, Value};

/// Spin the axum app on an ephemeral port with throwaway static/data dirs and return its
/// base URL. The server task is detached; the OS reclaims the port when the test ends.
async fn start() -> String {
    let tmp = tempfile::tempdir().expect("tempdir");
    let state = AppState::new(tmp.path().to_path_buf(), tmp.path().join("data")).expect("state");
    // Keep the tempdir alive for the whole process (leak is fine in a test binary).
    std::mem::forget(tmp);
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    let bound = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });
    format!("http://{bound}")
}

/// A client with a cookie jar, so the session cookie set by login/bootstrap rides every
/// subsequent request automatically (per host:port, matching the test's own server).
fn jar_client() -> reqwest::Client {
    reqwest::Client::builder().cookie_store(true).build().unwrap()
}

/// Start a server AND authenticate: M2 gates every command behind a session, so the DB flow
/// tests bootstrap a first admin (cookie lands in the jar) before doing anything.
async fn authed() -> (reqwest::Client, String) {
    let base = start().await;
    let cl = jar_client();
    let (st, body) = invoke(&cl, &base, "auth_bootstrap",
        json!({ "username": "admin", "password": "secret123" })).await;
    assert_eq!(st, 200, "bootstrap failed: {body}");
    (cl, base)
}

/// POST /api/invoke {cmd,args} with the (cookie-bearing) client; return (status, parsed body).
async fn invoke(cl: &reqwest::Client, base: &str, cmd: &str, args: Value) -> (u16, Value) {
    let res = cl
        .post(format!("{base}/api/invoke"))
        .json(&json!({ "cmd": cmd, "args": args }))
        .send()
        .await
        .expect("send");
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

/// db_connect with an in-memory SQLite; returns the connId.
async fn connect_mem(cl: &reqwest::Client, base: &str) -> String {
    let (st, body) = invoke(
        cl, base,
        "db_connect",
        json!({ "args": { "dbType": "sqlite", "host": ":memory:", "port": 0, "user": "", "ssl": false } }),
    )
    .await;
    assert_eq!(st, 200, "db_connect failed: {body}");
    body["connId"].as_str().expect("connId").to_string()
}

#[tokio::test]
async fn healthz_ok() {
    // /healthz is public (no auth) so a Docker healthcheck works pre-login.
    let base = start().await;
    let res = reqwest::get(format!("{base}/healthz")).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "ok");
}

#[tokio::test]
async fn unknown_command_is_400_with_error() {
    let (cl, base) = authed().await;
    let (st, body) = invoke(&cl, &base, "rdp_launch", json!({})).await;
    assert_eq!(st, 400);
    assert!(body["error"].as_str().unwrap_or("").contains("rdp_launch"), "body={body}");
}

#[tokio::test]
async fn full_query_and_introspect_flow() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;

    // Create + seed via db_query (max_rows irrelevant for DDL/DML).
    let (st, _) = invoke(&cl, &base, "db_query", json!({
        "connId": conn, "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE)"
    })).await;
    assert_eq!(st, 200);
    let (st, _) = invoke(&cl, &base, "db_query", json!({
        "connId": conn, "sql": "INSERT INTO t (name,email) VALUES ('alice','a@x'),('bob','b@x')"
    })).await;
    assert_eq!(st, 200);

    // db_query result shape (columns + rows).
    let (st, body) = invoke(&cl, &base, "db_query", json!({
        "connId": conn, "sql": "SELECT id,name FROM t ORDER BY id"
    })).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 2);
    assert_eq!(body["rows"][0][1], json!("alice"));

    // db_schema lists the table.
    let (st, body) = invoke(&cl, &base, "db_schema", json!({ "connId": conn })).await;
    assert_eq!(st, 200);
    let found = body.as_array().unwrap().iter().any(|pair| {
        pair[1].as_array().map(|tables| tables.iter().any(|t| t["name"] == "t")).unwrap_or(false)
    });
    assert!(found, "db_schema missing table t: {body}");

    // db_table_structure annotates PK + UNIQUE.
    let (st, body) = invoke(&cl, &base, "db_table_structure", json!({
        "connId": conn, "schema": "main", "table": "t"
    })).await;
    assert_eq!(st, 200, "{body}");
    let cols = body["columns"].as_array().unwrap();
    assert!(cols.iter().any(|c| c["name"] == "id" && c["key"] == "PK"));

    // db_table_preview returns rows.
    let (st, body) = invoke(&cl, &base, "db_table_preview", json!({
        "connId": conn, "schema": "main", "table": "t", "limit": 100, "offset": 0
    })).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 2);

    // db_table_query (server-side WHERE/ORDER BY).
    let (st, body) = invoke(&cl, &base, "db_table_query", json!({
        "connId": conn, "schema": "main", "table": "t",
        "whereClause": "id = 1", "orderBy": "id", "limit": 100, "offset": 0
    })).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 1);

    // db_query_page windows results.
    let (st, body) = invoke(&cl, &base, "db_query_page", json!({
        "connId": conn, "sql": "SELECT id FROM t ORDER BY id", "limit": 1, "offset": 1
    })).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 1);
    assert_eq!(body["rows"][0][0], json!(2));
}

#[tokio::test]
async fn data_compare_sync_via_exec_batch() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)" })).await;

    // The Data-Compare panel ships its generated sync SQL through db_exec_batch (one txn).
    let (st, body) = invoke(&cl, &base, "db_exec_batch", json!({
        "connId": conn,
        "statements": ["INSERT INTO t (id,v) VALUES (1,'a')", "INSERT INTO t (id,v) VALUES (2,'b')"]
    })).await;
    assert_eq!(st, 200, "{body}");

    let (_, body) = invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "SELECT COUNT(*) FROM t" })).await;
    assert_eq!(body["rows"][0][0], json!(2));
}

#[tokio::test]
async fn preview_and_apply_edits() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)" })).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "INSERT INTO t (id,v) VALUES (1,'old')" })).await;

    // Preview renders SQL without executing.
    let edit = json!({ "table": "t", "kind": "update",
        "pk": [["id", 1]], "cells": [["v", "new"]] });
    let (st, body) = invoke(&cl, &base, "db_preview_dml", json!({ "connId": conn, "req": edit })).await;
    assert_eq!(st, 200, "{body}");
    assert!(body.as_str().unwrap().contains("UPDATE"), "{body}");

    // Apply mutates the row.
    let (st, body) = invoke(&cl, &base, "db_apply_edits", json!({ "connId": conn, "reqs": [edit] })).await;
    assert_eq!(st, 200, "{body}");
    let (_, body) = invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "SELECT v FROM t WHERE id=1" })).await;
    assert_eq!(body["rows"][0][0], json!("new"));
}

#[tokio::test]
async fn object_admin_truncate_and_drop() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY)" })).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "INSERT INTO t (id) VALUES (1),(2)" })).await;

    let (st, _) = invoke(&cl, &base, "db_truncate_table", json!({
        "connId": conn, "schema": Value::Null, "table": "t" })).await;
    assert_eq!(st, 200);
    let (_, body) = invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "SELECT COUNT(*) FROM t" })).await;
    assert_eq!(body["rows"][0][0], json!(0));

    let (st, _) = invoke(&cl, &base, "db_drop_object", json!({
        "connId": conn, "objectType": "TABLE", "schema": Value::Null, "name": "t" })).await;
    assert_eq!(st, 200);
    // Dropping a now-absent table is idempotent (drop_or_absent) → still 200.
    let (st, _) = invoke(&cl, &base, "db_drop_object", json!({
        "connId": conn, "objectType": "TABLE", "schema": Value::Null, "name": "t" })).await;
    assert_eq!(st, 200);
}

#[tokio::test]
async fn export_database_returns_sql_script() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)" })).await;
    invoke(&cl, &base, "db_query", json!({ "connId": conn,
        "sql": "INSERT INTO t (id,v) VALUES (1,'a')" })).await;

    // Whole-DB export is a pure request/response command (returns the SQL script as a string),
    // routed through the shared export_database_core — so the browser can export too.
    let (st, body) = invoke(&cl, &base, "db_export_database", json!({
        "connId": conn, "database": "main", "schema": "main",
        "selectedTables": ["t"], "tableDdls": {},
        "includeStructure": true, "includeData": true
    })).await;
    assert_eq!(st, 200, "{body}");
    assert!(body.as_str().unwrap().contains("INSERT INTO"), "{body}");
}

#[tokio::test]
async fn disconnect_then_query_is_error() {
    let (cl, base) = authed().await;
    let conn = connect_mem(&cl, &base).await;
    let (st, _) = invoke(&cl, &base, "db_disconnect", json!({ "connId": conn })).await;
    assert_eq!(st, 200);
    let (st, body) = invoke(&cl, &base, "db_query", json!({ "connId": conn, "sql": "SELECT 1" })).await;
    assert_eq!(st, 400);
    assert!(body["error"].is_string(), "{body}");
}

#[tokio::test]
async fn export_xlsx_bytes_returns_a_zip_workbook() {
    // Server mode builds the .xlsx server-side and returns base64 bytes for the browser to save.
    let (cl, base) = authed().await;
    let (st, body) = invoke(&cl, &base, "db_export_xlsx_bytes",
        json!({ "columns": ["id", "name"], "rows": [[1, "alice"], [2, "bob"]], "sheetName": "t" })).await;
    assert_eq!(st, 200, "{body}");
    let b64 = body.as_str().expect("base64 string");
    // .xlsx is a ZIP container → first bytes "PK\x03\x04" → base64 begins "UEsD".
    assert!(b64.starts_with("UEsD"), "not a zip workbook: {}", &b64[..b64.len().min(12)]);
}
