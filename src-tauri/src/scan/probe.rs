//! 原生协议探针：免凭证识别服务类型 + 版本。
//!
//! 每个探针先 TCP 连接 + 超时判定端口开放，再做最小握手读取识别信息：
//!   * SSH        —— 读首行 `SSH-...` banner；
//!   * MySQL-wire —— 读握手包，从中解析 server version（覆盖 mysql/mariadb/tidb/doris）；
//!   * PostgreSQL —— 发 SSLRequest，服务端回 `S`/`N` 即可判定为 PG 家族（版本留空待认证回填）；
//!   * Redis      —— 发 `PING`，读 `+PONG`；
//!   * MongoDB    —— 发 hello/isMaster（OP_QUERY），从回包 BSON 中解析 version。
//!
//! JDBC-only 引擎（达梦/oracle/db2…）无统一原生握手，不在此处探测，仅靠后续试连确认。

use std::net::IpAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// 一次探测的识别结果。
#[derive(Debug, Clone, Default)]
pub struct ProbeResult {
    /// 端口是否可建立 TCP 连接。
    pub open: bool,
    /// 识别到的服务版本（可空——能识别族但拿不到版本时留 None）。
    pub version: Option<String>,
    /// SSH banner 等粗粒度 OS/服务标识（仅 host 模式有意义）。
    pub os: Option<String>,
    /// 是否识别为目标协议族（true=匹配）。
    pub matched: bool,
}

/// 仅判定端口是否开放（TCP connect 成功）。
pub async fn port_open(ip: IpAddr, port: u16) -> bool {
    matches!(connect(ip, port).await, Some(_))
}

async fn connect(ip: IpAddr, port: u16) -> Option<TcpStream> {
    match timeout(CONNECT_TIMEOUT, TcpStream::connect((ip, port))).await {
        Ok(Ok(s)) => Some(s),
        _ => None,
    }
}

/// SSH 探针：连上后读首行，以 `SSH-` 开头即识别。banner 形如
/// `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.4`。
pub async fn probe_ssh(ip: IpAddr, port: u16) -> ProbeResult {
    let mut res = ProbeResult::default();
    let mut stream = match connect(ip, port).await {
        Some(s) => s,
        None => return res,
    };
    res.open = true;
    let mut buf = [0u8; 256];
    if let Ok(Ok(n)) = timeout(IO_TIMEOUT, stream.read(&mut buf)).await {
        if n > 0 {
            let line = String::from_utf8_lossy(&buf[..n]);
            let line = line.lines().next().unwrap_or("").trim();
            if line.starts_with("SSH-") {
                res.matched = true;
                res.os = Some(line.to_string());
                // SSH-2.0-OpenSSH_8.9p1 → 取 "-" 后第三段作为版本标识。
                if let Some(ver) = line.splitn(3, '-').nth(2) {
                    res.version = Some(ver.trim().to_string());
                }
            }
        }
    }
    res
}

/// MySQL-wire 探针：服务端在连上后主动发握手包（Protocol::Handshake），
/// 包体首字节为协议版本（通常 10），随后是以 NUL 结尾的 server version 字符串。
/// 包结构：3 字节长度(LE) + 1 字节 seq + payload。
pub async fn probe_mysql(ip: IpAddr, port: u16) -> ProbeResult {
    let mut res = ProbeResult::default();
    let mut stream = match connect(ip, port).await {
        Some(s) => s,
        None => return res,
    };
    res.open = true;
    let mut buf = [0u8; 512];
    if let Ok(Ok(n)) = timeout(IO_TIMEOUT, stream.read(&mut buf)).await {
        // 至少要有 4 字节包头 + 1 字节协议版本。
        if n >= 5 {
            let payload = &buf[4..n];
            // payload[0] = protocol version（10=HandshakeV10）；其后为 server version（NUL 结尾）。
            if payload[0] == 10 {
                if let Some(end) = payload[1..].iter().position(|&b| b == 0) {
                    let ver = String::from_utf8_lossy(&payload[1..1 + end]).trim().to_string();
                    if !ver.is_empty() {
                        res.matched = true;
                        res.version = Some(ver);
                    }
                }
            }
        }
    }
    res
}

/// PostgreSQL 探针：发 SSLRequest（8 字节，长度 8 + 魔数 80877103），服务端回单字节
/// `S`（支持 TLS）或 `N`（不支持）即可判定为 PG 协议。版本此处不读，留待认证后回填。
pub async fn probe_postgres(ip: IpAddr, port: u16) -> ProbeResult {
    let mut res = ProbeResult::default();
    let mut stream = match connect(ip, port).await {
        Some(s) => s,
        None => return res,
    };
    res.open = true;
    // SSLRequest：int32 length=8, int32 code=80877103。
    let mut req = Vec::with_capacity(8);
    req.extend_from_slice(&8u32.to_be_bytes());
    req.extend_from_slice(&80_877_103u32.to_be_bytes());
    if timeout(IO_TIMEOUT, stream.write_all(&req)).await.is_err() {
        return res;
    }
    let mut byte = [0u8; 1];
    if let Ok(Ok(1)) = timeout(IO_TIMEOUT, stream.read(&mut byte)).await {
        if byte[0] == b'S' || byte[0] == b'N' {
            res.matched = true;
        }
    }
    res
}

/// Redis 探针：发内联 `PING\r\n`，读 `+PONG`（未设密码）或 `-NOAUTH`/`-ERR`（识别为 Redis 但需认证）。
pub async fn probe_redis(ip: IpAddr, port: u16) -> ProbeResult {
    let mut res = ProbeResult::default();
    let mut stream = match connect(ip, port).await {
        Some(s) => s,
        None => return res,
    };
    res.open = true;
    if timeout(IO_TIMEOUT, stream.write_all(b"PING\r\n")).await.is_err() {
        return res;
    }
    let mut buf = [0u8; 128];
    if let Ok(Ok(n)) = timeout(IO_TIMEOUT, stream.read(&mut buf)).await {
        if n > 0 {
            let reply = String::from_utf8_lossy(&buf[..n]);
            // +PONG（无密码）或 -NOAUTH/-ERR（有密码但确为 Redis）。
            if reply.starts_with("+PONG")
                || reply.contains("NOAUTH")
                || reply.contains("Authentication")
                || reply.starts_with("-ERR")
            {
                res.matched = true;
            }
        }
    }
    res
}

/// MongoDB 探针：用 OP_QUERY 对 `admin.$cmd` 发 `{ isMaster: 1 }`，从回包 BSON 中
/// 解析顶层 `version` 字段（多数部署 isMaster 免认证可读，并带 server 版本）。
pub async fn probe_mongodb(ip: IpAddr, port: u16) -> ProbeResult {
    let mut res = ProbeResult::default();
    let mut stream = match connect(ip, port).await {
        Some(s) => s,
        None => return res,
    };
    res.open = true;

    let packet = build_ismaster_query();
    if timeout(IO_TIMEOUT, stream.write_all(&packet)).await.is_err() {
        return res;
    }
    let mut buf = vec![0u8; 4096];
    if let Ok(Ok(n)) = timeout(IO_TIMEOUT, stream.read(&mut buf)).await {
        if n > 16 {
            // OP_REPLY/OP_MSG 回包中含一段 BSON 文档；扫描其中的 CString "version" 后的 string 值。
            res.matched = true;
            if let Some(v) = extract_bson_string(&buf[..n], "version") {
                res.version = Some(v);
            }
        }
    }
    res
}

/// 构造一个最小 OP_QUERY 报文：查询 admin.$cmd，BSON = { isMaster: 1 }。
fn build_ismaster_query() -> Vec<u8> {
    // BSON 文档 { isMaster: i32(1) }
    let mut bson = Vec::new();
    // 文档：int32 totalLen + elements + 0x00
    let mut body = Vec::new();
    body.push(0x10); // int32 type
    body.extend_from_slice(b"isMaster\0");
    body.extend_from_slice(&1i32.to_le_bytes());
    body.push(0x00); // doc terminator
    let total = (body.len() + 4) as i32;
    bson.extend_from_slice(&total.to_le_bytes());
    bson.extend_from_slice(&body);

    // OP_QUERY (opcode 2004)
    let collection = b"admin.$cmd\0";
    let mut payload = Vec::new();
    payload.extend_from_slice(&0i32.to_le_bytes()); // flags
    payload.extend_from_slice(collection);
    payload.extend_from_slice(&0i32.to_le_bytes()); // numberToSkip
    payload.extend_from_slice(&1i32.to_le_bytes()); // numberToReturn
    payload.extend_from_slice(&bson);

    // msg header: int32 messageLength, int32 requestID, int32 responseTo, int32 opCode
    let mut msg = Vec::new();
    let msg_len = (16 + payload.len()) as i32;
    msg.extend_from_slice(&msg_len.to_le_bytes());
    msg.extend_from_slice(&1i32.to_le_bytes()); // requestID
    msg.extend_from_slice(&0i32.to_le_bytes()); // responseTo
    msg.extend_from_slice(&2004i32.to_le_bytes()); // OP_QUERY
    msg.extend_from_slice(&payload);
    msg
}

/// 在原始字节里查找 BSON string 元素：`0x02 <key>\0 <int32 len><utf8...\0>`。
/// 容错实现——只为从 isMaster 回包里捞 `version`，不做完整 BSON 解析。
fn extract_bson_string(data: &[u8], key: &str) -> Option<String> {
    let needle: Vec<u8> = {
        let mut v = vec![0x02u8];
        v.extend_from_slice(key.as_bytes());
        v.push(0x00);
        v
    };
    let pos = data.windows(needle.len()).position(|w| w == needle.as_slice())?;
    let mut idx = pos + needle.len();
    if idx + 4 > data.len() {
        return None;
    }
    let len = i32::from_le_bytes([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]) as usize;
    idx += 4;
    if len == 0 || idx + len > data.len() {
        return None;
    }
    // 字符串含尾随 NUL，截掉。
    let raw = &data[idx..idx + len - 1];
    Some(String::from_utf8_lossy(raw).to_string())
}
