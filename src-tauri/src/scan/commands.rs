//! 自动扫描命令：`scan_start` / `scan_cancel`。
//!
//! `scan_start` 解析 ranges → (ip,port) 待扫列表，开一个受信号量限流的 tokio 任务池：
//!   * host 模式：SSH banner 识别 → creds 字典逐个试 SSH 密码登录 → keyUsers×keys 试私钥；
//!   * db   模式：对每个引擎做原生协议探测识别类型/版本 → creds 字典逐个试连（命中即停）；
//!     JDBC-only 引擎无原生握手，直接靠试连确认。
//!
//! 逐节点 emit `scan://found`，周期 emit `scan://progress`，收尾 emit `scan://done`。
//! 取消由 `ScanState` 的 `CancellationToken` 驱动。

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use std::time::Duration;
use tokio::net::lookup_host;
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::db::driver::ConnectArgs as DbConnectArgs;
use crate::db::DatabaseType;
use crate::scan::probe::{self, ProbeResult};
use crate::scan::range::{self};
use crate::scan::{ScanError, ScanState};
use crate::ssh::conn::{self, AuthMethod, ConnectArgs as SshConnectArgs};

static SCAN_SEQ: AtomicU64 = AtomicU64::new(0);

const DEFAULT_CONCURRENCY: u32 = 64;

/// 单次试登录上限：防止被防火墙/tarpit 接受 TCP 却挂起 SSH/DB 握手时无限阻塞，
/// 同时也避免本该命中的认证因长时间挂起被卡死。超时按“该次未命中”处理，继续下一条。
const AUTH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(12);

// ─── 入参（serde camelCase，严格匹配前端契约）─────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEngine {
    pub engine_id: String,
    pub db_type: String,
    pub driver_profile: Option<String>,
    pub port: u16,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cred {
    pub user: String,
    pub password: String,
}

// 遮蔽密码，避免经 {:?}/trace 泄露。
impl std::fmt::Debug for Cred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cred")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySpec {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanArgs {
    pub mode: String,
    #[serde(default)]
    pub ranges: Vec<String>,
    #[serde(default)]
    pub ports: Vec<u16>,
    #[serde(default)]
    pub engines: Vec<ProbeEngine>,
    #[serde(default)]
    pub creds: Vec<Cred>,
    #[serde(default)]
    pub keys: Vec<KeySpec>,
    #[serde(default)]
    pub key_users: Vec<String>,
    #[serde(default)]
    pub concurrency: u32,
}

// ─── 出参（serde camelCase，严格匹配 scan://found / scan://progress）────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFound {
    pub scan_id: String,
    pub ip: String,
    pub port: u16,
    pub address: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_auth_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_key_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    pub scanned: u64,
    pub total: u64,
    pub found: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDone {
    pub scan_id: String,
}

// ─── 进度计数器：跨任务共享的原子计数，按需 emit progress ──────────────────────

struct Counters {
    scanned: AtomicU64,
    found: AtomicU64,
    failed: AtomicU64,
    total: u64,
}

impl Counters {
    fn new(total: u64) -> Self {
        Self {
            scanned: AtomicU64::new(0),
            found: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            total,
        }
    }

    fn snapshot(&self, scan_id: &str) -> ScanProgress {
        ScanProgress {
            scan_id: scan_id.to_string(),
            scanned: self.scanned.load(Ordering::Relaxed),
            total: self.total,
            found: self.found.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
        }
    }
}

fn emit_progress(app: &AppHandle, scan_id: &str, counters: &Counters) {
    let _ = app.emit("scan://progress", counters.snapshot(scan_id));
}

fn emit_found(app: &AppHandle, found: &ScanFound) {
    let _ = app.emit("scan://found", found.clone());
}

// ─── DatabaseType 解析：契约里 dbType 是字符串，需转回后端枚举 ──────────────────

fn parse_db_type(s: &str) -> Option<DatabaseType> {
    match s {
        "postgres" => Some(DatabaseType::Postgres),
        "mysql" => Some(DatabaseType::Mysql),
        "sqlite" => Some(DatabaseType::Sqlite),
        "duckdb" => Some(DatabaseType::Duckdb),
        "sqlserver" => Some(DatabaseType::Sqlserver),
        "clickhouse" => Some(DatabaseType::Clickhouse),
        "elasticsearch" => Some(DatabaseType::Elasticsearch),
        "rqlite" => Some(DatabaseType::Rqlite),
        "mongodb" => Some(DatabaseType::Mongodb),
        "redis" => Some(DatabaseType::Redis),
        "jdbc" => Some(DatabaseType::Jdbc),
        _ => None,
    }
}

// ─── 待扫目标解析（含主机名 DNS）────────────────────────────────────────────────

/// 解析 ranges：先本地展开 IP，再对主机名做异步 DNS（失败的主机名计入 `failed`）。
async fn resolve_targets(ranges: &[String]) -> (Vec<IpAddr>, u64) {
    let expanded = range::expand_ranges(ranges);
    let mut ips = expanded.ips;
    let mut failed = 0u64;
    for host in expanded.hostnames {
        // lookup_host 需要 host:port 形式；端口仅占位，取首个解析到的 IP。
        match lookup_host((host.as_str(), 0u16)).await {
            Ok(addrs) => {
                let mut got = false;
                for a in addrs {
                    ips.push(a.ip());
                    got = true;
                    break;
                }
                if !got {
                    failed += 1;
                }
            }
            Err(_) => failed += 1,
        }
    }
    // 去重（DNS 可能与 CIDR 重叠）。
    let mut seen = std::collections::HashSet::new();
    ips.retain(|ip| seen.insert(*ip));
    (ips, failed)
}

// ─── 命令 ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_start(
    args: ScanArgs,
    app: AppHandle,
    state: tauri::State<'_, ScanState>,
) -> Result<String, ScanError> {
    if args.mode != "host" && args.mode != "db" {
        return Err(ScanError::BadArgs(format!("unknown mode: {}", args.mode)));
    }
    if args.ranges.is_empty() {
        return Err(ScanError::BadRange("ranges is empty".into()));
    }

    let scan_id = format!("scan-{}", SCAN_SEQ.fetch_add(1, Ordering::Relaxed));
    let token = state.register(scan_id.clone()).await;

    let state = state.inner().clone();
    let app_bg = app.clone();
    let sid = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_scan(app_bg, sid.clone(), args, token).await;
        state.remove(&sid).await;
    });

    Ok(scan_id)
}

#[tauri::command]
pub async fn scan_cancel(
    scan_id: String,
    state: tauri::State<'_, ScanState>,
) -> Result<(), ScanError> {
    state.cancel(&scan_id).await;
    Ok(())
}

/// 读取本地文本文件内容——供②页“上传字典文件”用（沿用“前端选路径→Rust 读取”模式，
/// 避免前端引入 plugin-fs）。仅读取，不缓存、不落盘。
#[tauri::command]
pub async fn scan_read_text_file(path: String) -> Result<String, ScanError> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ScanError::Io(format!("{path}: {e}")))
}

// ─── 扫描主流程 ─────────────────────────────────────────────────────────────────

async fn run_scan(app: AppHandle, scan_id: String, args: ScanArgs, token: CancellationToken) {
    let (ips, dns_failed) = resolve_targets(&args.ranges).await;

    // host 模式：端口集来自 args.ports（空则不可扫——但前端会传默认端口）。
    // db 模式：每个引擎一个端口，总目标 = ips × engines。
    let is_db = args.mode == "db";
    let total: u64 = if is_db {
        (ips.len() as u64) * (args.engines.len().max(0) as u64)
    } else {
        (ips.len() as u64) * (args.ports.len() as u64)
    };

    let counters = Arc::new(Counters::new(total));
    counters.failed.fetch_add(dns_failed, Ordering::Relaxed);

    let concurrency = if args.concurrency == 0 {
        DEFAULT_CONCURRENCY
    } else {
        args.concurrency
    } as usize;
    let sem = Arc::new(Semaphore::new(concurrency));

    let creds = Arc::new(args.creds);
    let keys = Arc::new(args.keys);
    let key_users = Arc::new(args.key_users);
    let engines = Arc::new(args.engines);

    let mut handles = Vec::new();

    for ip in ips {
        if token.is_cancelled() {
            break;
        }
        if is_db {
            for engine in engines.iter().cloned() {
                let permit_sem = sem.clone();
                let app = app.clone();
                let scan_id = scan_id.clone();
                let counters = counters.clone();
                let creds = creds.clone();
                let token = token.clone();
                handles.push(tauri::async_runtime::spawn(async move {
                    let _permit = match permit_sem.acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    if token.is_cancelled() {
                        return;
                    }
                    scan_db_target(&app, &scan_id, ip, &engine, &creds, &counters).await;
                    counters.scanned.fetch_add(1, Ordering::Relaxed);
                    emit_progress(&app, &scan_id, &counters);
                }));
            }
        } else {
            for port in args.ports.iter().copied() {
                let permit_sem = sem.clone();
                let app = app.clone();
                let scan_id = scan_id.clone();
                let counters = counters.clone();
                let creds = creds.clone();
                let keys = keys.clone();
                let key_users = key_users.clone();
                let token = token.clone();
                handles.push(tauri::async_runtime::spawn(async move {
                    let _permit = match permit_sem.acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    if token.is_cancelled() {
                        return;
                    }
                    scan_host_target(
                        &app, &scan_id, ip, port, &creds, &keys, &key_users, &counters,
                    )
                    .await;
                    counters.scanned.fetch_add(1, Ordering::Relaxed);
                    emit_progress(&app, &scan_id, &counters);
                }));
            }
        }
    }

    for h in handles {
        let _ = h.await;
    }

    // 收尾：补发一次终态进度 + done。
    emit_progress(&app, &scan_id, &counters);
    let _ = app.emit("scan://done", ScanDone { scan_id: scan_id.clone() });
}

// ─── host 目标 ───────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn scan_host_target(
    app: &AppHandle,
    scan_id: &str,
    ip: IpAddr,
    port: u16,
    creds: &[Cred],
    keys: &[KeySpec],
    key_users: &[String],
    counters: &Counters,
) {
    let probe = probe::probe_ssh(ip, port).await;
    if !probe.open {
        return; // 端口不开放——不算 found，也不计 failed。
    }
    if !probe.matched {
        // host 模式仅收录“能正常登录”的节点：端口开放但非 SSH 不上报。
        return;
    }

    let address = format!("{ip}:{port}");

    // 逐个 cred 试密码登录，命中即停。
    for cred in creds {
        let args = SshConnectArgs {
            host: ip.to_string(),
            port,
            user: cred.user.clone(),
            auth: AuthMethod::Password,
            secret: Some(cred.password.clone()),
            jump: None,
        };
        let res = match timeout(AUTH_ATTEMPT_TIMEOUT, conn::test_connection(args)).await {
            Ok(r) => r,
            Err(_) => continue, // 超时 → 视为该 cred 未命中，继续下一条。
        };
        if res.ok {
            emit_found(
                app,
                &ScanFound {
                    scan_id: scan_id.to_string(),
                    ip: ip.to_string(),
                    port,
                    address,
                    kind: "host".into(),
                    engine_id: None,
                    db_type: None,
                    driver_profile: None,
                    os: probe.os.clone(),
                    version: probe.version.clone(),
                    status: "authed".into(),
                    hit_user: Some(cred.user.clone()),
                    hit_secret: Some(cred.password.clone()),
                    hit_auth_kind: Some("password".into()),
                    hit_key_name: None,
                    hit_key_path: None,
                },
            );
            counters.found.fetch_add(1, Ordering::Relaxed);
            return;
        }
    }

    // 私钥试登录：keyUsers × keys 笛卡尔积，命中即停。
    for user in key_users {
        for key in keys {
            let args = SshConnectArgs {
                host: ip.to_string(),
                port,
                user: user.clone(),
                auth: AuthMethod::KeyFile {
                    path: key.path.clone(),
                },
                secret: None,
                jump: None,
            };
            let res = match timeout(AUTH_ATTEMPT_TIMEOUT, conn::test_connection(args)).await {
                Ok(r) => r,
                Err(_) => continue, // 超时 → 视为该 用户×私钥 未命中，继续下一组。
            };
            if res.ok {
                emit_found(
                    app,
                    &ScanFound {
                        scan_id: scan_id.to_string(),
                        ip: ip.to_string(),
                        port,
                        address,
                        kind: "host".into(),
                        engine_id: None,
                        db_type: None,
                        driver_profile: None,
                        os: probe.os.clone(),
                        version: probe.version.clone(),
                        status: "authed".into(),
                        hit_user: Some(user.clone()),
                        hit_secret: None,
                        hit_auth_kind: Some("key".into()),
                        hit_key_name: Some(key.name.clone()),
                        hit_key_path: Some(key.path.clone()),
                    },
                );
                counters.found.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
    }

    // 识别到 SSH 但字典/私钥均未命中：host 模式不收录（结果列表仅含可正常登录的节点）。
    // 与 db 模式不同——db 会保留“识别到但未认证”的节点供用户后续补凭证登录。
    let _ = address;
}

// ─── db 目标 ──────────────────────────────────────────────────────────────────

async fn scan_db_target(
    app: &AppHandle,
    scan_id: &str,
    ip: IpAddr,
    engine: &ProbeEngine,
    creds: &[Cred],
    counters: &Counters,
) {
    let port = engine.port;
    let db_type = match parse_db_type(&engine.db_type) {
        Some(t) => t,
        None => return, // 未知 dbType——跳过，不计数（前端编目应保证有效）。
    };

    // 先按引擎族做原生协议探测拿版本/识别；JDBC-only 引擎跳过原生探针。
    let probe = native_probe(db_type, ip, port).await;
    if !probe.open {
        return; // 端口不开放。
    }

    let address = format!("{ip}:{port}");

    // 逐个 cred 试连，命中即停（用返回的 version 回填）。
    for cred in creds {
        let args = DbConnectArgs {
            db_type,
            host: ip.to_string(),
            port,
            user: cred.user.clone(),
            database: None,
            driver_profile: engine.driver_profile.clone(),
            options: None,
            secret: Some(cred.password.clone()),
        };
        let attempt = timeout(AUTH_ATTEMPT_TIMEOUT, crate::db::commands::db_test_connection(args)).await;
        if let Ok(Ok(res)) = attempt {
            let version = if res.version.is_empty() {
                probe.version.clone()
            } else {
                Some(res.version)
            };
            emit_found(
                app,
                &ScanFound {
                    scan_id: scan_id.to_string(),
                    ip: ip.to_string(),
                    port,
                    address,
                    kind: "db".into(),
                    engine_id: Some(engine.engine_id.clone()),
                    db_type: Some(engine.db_type.clone()),
                    driver_profile: engine.driver_profile.clone(),
                    os: None,
                    version,
                    status: "authed".into(),
                    hit_user: Some(cred.user.clone()),
                    hit_secret: Some(cred.password.clone()),
                    hit_auth_kind: Some("password".into()),
                    hit_key_name: None,
                    hit_key_path: None,
                },
            );
            counters.found.fetch_add(1, Ordering::Relaxed);
            return;
        }
    }

    // 字典未命中：原生探针识别到该协议族 → unauthed；否则仅端口开放（含 JDBC 未确认）→ open。
    let status = if probe.matched { "unauthed" } else { "open" };
    emit_found(
        app,
        &ScanFound {
            scan_id: scan_id.to_string(),
            ip: ip.to_string(),
            port,
            address,
            kind: "db".into(),
            engine_id: Some(engine.engine_id.clone()),
            db_type: Some(engine.db_type.clone()),
            driver_profile: engine.driver_profile.clone(),
            os: None,
            version: probe.version.clone(),
            status: status.into(),
            hit_user: None,
            hit_secret: None,
            hit_auth_kind: None,
            hit_key_name: None,
            hit_key_path: None,
        },
    );
    counters.found.fetch_add(1, Ordering::Relaxed);
}

/// 按 DatabaseType 派发原生探针；无原生握手的族仅做端口开放探测。
async fn native_probe(db_type: DatabaseType, ip: IpAddr, port: u16) -> ProbeResult {
    match db_type {
        DatabaseType::Mysql => probe::probe_mysql(ip, port).await,
        DatabaseType::Postgres => probe::probe_postgres(ip, port).await,
        DatabaseType::Redis => probe::probe_redis(ip, port).await,
        DatabaseType::Mongodb => probe::probe_mongodb(ip, port).await,
        // 其余（sqlserver/clickhouse/es/rqlite/jdbc…）无统一原生握手：仅判端口开放。
        _ => ProbeResult {
            open: probe::port_open(ip, port).await,
            matched: false,
            version: None,
            os: None,
        },
    }
}

