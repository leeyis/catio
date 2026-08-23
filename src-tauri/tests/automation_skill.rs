//! Task 4 contract tests: skill import / install / template rendering / version.

use catio_lib::automation::skill::{
    new_skill_from_import, parse_skill_json, render_template, SkillImport,
};
use catio_lib::automation::{SkillRisk, SkillScope, SkillSource};
use std::collections::HashMap;

fn valid_pack() -> &'static [u8] {
    "{ \"name\": \"数据库巡检\", \"promptTemplate\": \"检查 {{db}} 的健康状态\", \"riskPolicy\": \"readonly\" }"
        .as_bytes()
}

#[test]
fn parses_valid_skill_json() {
    let imp = parse_skill_json(valid_pack()).unwrap();
    assert_eq!(imp.name, "数据库巡检");
    assert_eq!(imp.prompt_template, "检查 {{db}} 的健康状态");
    assert_eq!(imp.risk_policy, SkillRisk::Readonly);
}

#[test]
fn risk_policy_defaults_to_readonly() {
    let imp = parse_skill_json(b"{ \"name\": \"x\", \"promptTemplate\": \"t\" }").unwrap();
    assert_eq!(imp.risk_policy, SkillRisk::Readonly);
}

#[test]
fn rejects_skill_json_without_name() {
    let err = parse_skill_json(b"{ \"promptTemplate\": \"t\" }").unwrap_err();
    assert!(err.to_string().contains("name"));
}

#[test]
fn rejects_skill_json_without_template() {
    let err = parse_skill_json(b"{ \"name\": \"x\" }").unwrap_err();
    assert!(err.to_string().to_lowercase().contains("prompt"));
}

#[test]
fn rejects_invalid_json() {
    assert!(parse_skill_json(b"<html>").is_err());
}

#[test]
fn renders_known_placeholders() {
    let mut ctx = HashMap::new();
    ctx.insert("host".into(), "web-01".into());
    ctx.insert("db".into(), "postgres-prod".into());
    let out = render_template("检查 {{host}} 与 {{db}}", &ctx);
    assert_eq!(out, "检查 web-01 与 postgres-prod");
}

#[test]
fn leaves_unknown_placeholders_untouched() {
    let mut ctx = HashMap::new();
    ctx.insert("host".into(), "web-01".into());
    let out = render_template("{{host}} {{missing}}", &ctx);
    assert_eq!(out, "web-01 {{missing}}");
}

#[test]
fn builds_skill_from_import() {
    let imp = parse_skill_json(valid_pack()).unwrap();
    let skill = new_skill_from_import(
        &imp,
        SkillScope::Target,
        Some("postgres-prod".into()),
        SkillSource::Import,
        "owner-a",
    );
    assert_eq!(skill.name, "数据库巡检");
    assert_eq!(skill.scope, SkillScope::Target);
    assert_eq!(skill.target_ref.as_deref(), Some("postgres-prod"));
    assert_eq!(skill.source, SkillSource::Import);
    assert_eq!(skill.version, 1);
    assert!(skill.enabled);
    assert_eq!(skill.owner_id, "owner-a");
}

#[tokio::test]
async fn install_skill_downloads_and_parses() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let body = valid_pack().to_vec();
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = sock.read(&mut buf).await.unwrap();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.write_all(&body).await;
    });

    let url = format!("http://{addr}/skills/s1.json");
    let skill = catio_lib::automation::skill::install_skill(
        &reqwest::Client::new(),
        &url,
        SkillScope::Global,
        None,
        "owner-a",
    )
    .await
    .unwrap();
    assert_eq!(skill.name, "数据库巡检");
    assert_eq!(skill.source, SkillSource::Url { url });
    handle.await.unwrap();
}

#[tokio::test]
async fn install_skill_fails_on_http_error() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = sock.read(&mut buf).await.unwrap();
        let _ = sock
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
    });

    let url = format!("http://{addr}/nope");
    assert!(catio_lib::automation::skill::install_skill(
        &reqwest::Client::new(),
        &url,
        SkillScope::Global,
        None,
        "owner-a",
    )
    .await
    .is_err());
    handle.await.unwrap();
}
