//! MCP Streamable HTTP 传输的共享判定逻辑（transport-agnostic，两个 head 共用）。
//!
//! 背景：MCP 在 `2025-03-26` 用 **Streamable HTTP** 取代了 `2024-11-05` 的 HTTP+SSE
//! （catio 此前只实现后者）。Streamable HTTP 只需**一个** endpoint，`POST` 的响应
//! 直接是 `application/json`——不必为每次调用先开一条 SSE 流，省掉服务端为长连接
//! 维持的 per-session 任务与 keep-alive 心跳。
//!
//! 本模块只放**纯函数**：协商协议版本、判定 Accept、校验 Origin、构造错误体。
//! HTTP 收发留在各 head（桌面手写 tokio，server 用 axum），故这些规则只写一遍、
//! 单测直接覆盖，不需要起监听器。
//!
//! 版本策略：`SUPPORTED` 覆盖 Streamable HTTP 的各修订版；服务端**响应**客户端在
//! `initialize` 里声明的版本（若受支持），否则回落到 [`DEFAULT_VERSION`]。旧客户端
//! （Claude Code / Cursor 目前多为 `2024-11-05`）继续走保留的 SSE 端点，不受影响。

use serde_json::{json, Value};

/// 服务端支持的协议版本，新→旧。`2024-11-05` 仍在内：保留的 SSE 端点用它。
pub const SUPPORTED: &[&str] = &[
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];

/// 客户端未声明版本时的回落值。
///
/// 取 `2025-03-26` 而非最新：spec 规定「未带 `MCP-Protocol-Version` 头时服务端
/// SHOULD 假定 `2025-03-26`」，且该版本是 Streamable HTTP 的首个修订版——对不声明
/// 版本的客户端做最保守假设，避免我们按新版语义回话而对方读不懂。
pub const DEFAULT_VERSION: &str = "2025-03-26";

/// JSON-RPC「方法不存在」。
pub const CODE_METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC 解析失败。
pub const CODE_PARSE_ERROR: i64 = -32700;

/// 协商协议版本：客户端声明的版本受支持则原样采用，否则回落 [`DEFAULT_VERSION`]。
///
/// 不因未知版本报错——这是**响应** `initialize` 的路径，回落比 400 更利于互操作
/// （spec 的 `UnsupportedProtocolVersionError` 属 `2026-07-28` 的协商流程，
/// 我们尚未实现 `server/discover`，故不宣称支持那条路径）。
pub fn negotiate_version(requested: Option<&str>) -> &'static str {
    match requested {
        Some(v) => SUPPORTED
            .iter()
            .find(|s| **s == v)
            .copied()
            .unwrap_or(DEFAULT_VERSION),
        None => DEFAULT_VERSION,
    }
}

/// Streamable HTTP 的 `POST` 是否可用单个 JSON 对象回应。
///
/// spec 要求客户端 `Accept` 同列 `application/json` 与 `text/event-stream`，服务端
/// 二选一。我们恒选 JSON（无 server→client 主动请求，不需要流），故只要对方能收
/// JSON 就行。缺 `Accept` 头按「不挑」处理（宽松：现实中的客户端并不都严格合规）。
pub fn accepts_json(accept: Option<&str>) -> bool {
    match accept {
        None => true,
        Some(a) => {
            let a = a.to_ascii_lowercase();
            a.contains("application/json") || a.contains("*/*") || a.trim().is_empty()
        }
    }
}

/// `Origin` 是否可信。**DNS rebinding 防护**（spec 列为 MUST）：桌面端绑在
/// 127.0.0.1，若不校验 Origin，用户浏览器里的任意站点都能用 DNS rebinding 把
/// 请求打到本机 MCP 上、驱动用户的真实数据库与 SSH 会话。
///
/// 规则：无 `Origin`（原生客户端、curl）放行——它不是浏览器发起的跨源请求；
/// 有则必须是 loopback 源。`null`（file:// 等不透明源）拒绝。
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let o = origin.trim();
    if o.is_empty() {
        return true;
    }
    let rest = match o.split_once("://") {
        Some(("http", r)) | Some(("https", r)) => r,
        // 含 file://、null、以及任何非 http(s) 源。
        _ => return false,
    };
    // 去掉端口后比对主机；IPv6 字面量形如 [::1]:8765。
    let host = match rest.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => h,
        _ => rest,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        || host.starts_with("127.")
}

/// 请求体是 JSON-RPC *通知*（无 `id`）吗？通知按 spec 回 `202 Accepted` 且无 body。
pub fn is_notification(req: &Value) -> bool {
    req.get("id").is_none()
}

/// 构造无 `id` 的 JSON-RPC 错误体（用于解析失败 / Origin 被拒这类无法取到 id 的场合）。
pub fn error_body(code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 版本协商 ──────────────────────────────────────────────────────────

    #[test]
    fn negotiates_to_the_client_requested_version_when_supported() {
        assert_eq!(negotiate_version(Some("2025-06-18")), "2025-06-18");
        assert_eq!(negotiate_version(Some("2026-07-28")), "2026-07-28");
        // 旧 SSE 客户端仍要拿回它自己声明的版本，否则握手对不上。
        assert_eq!(negotiate_version(Some("2024-11-05")), "2024-11-05");
    }

    #[test]
    fn falls_back_when_version_absent_or_unknown() {
        // spec：缺 MCP-Protocol-Version 头时假定 2025-03-26。
        assert_eq!(negotiate_version(None), "2025-03-26");
        assert_eq!(negotiate_version(Some("1999-01-01")), "2025-03-26");
        assert_eq!(negotiate_version(Some("")), "2025-03-26");
    }

    // ── Accept ────────────────────────────────────────────────────────────

    #[test]
    fn accepts_json_for_spec_compliant_and_lenient_clients() {
        // spec 要求的组合。
        assert!(accepts_json(Some("application/json, text/event-stream")));
        // 宽松：只收 JSON、通配、缺头、空头。
        assert!(accepts_json(Some("application/json")));
        assert!(accepts_json(Some("*/*")));
        assert!(accepts_json(None));
        assert!(accepts_json(Some("")));
        // 大小写不敏感。
        assert!(accepts_json(Some("Application/JSON")));
    }

    #[test]
    fn rejects_json_when_client_only_takes_sse() {
        assert!(!accepts_json(Some("text/event-stream")));
    }

    // ── Origin（DNS rebinding 防护）────────────────────────────────────────

    #[test]
    fn origin_absent_is_allowed_for_native_clients() {
        // 原生 MCP 客户端 / curl 不发 Origin——不是浏览器跨源请求。
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("")));
    }

    #[test]
    fn loopback_origins_are_allowed() {
        assert!(origin_allowed(Some("http://localhost:5173")));
        assert!(origin_allowed(Some("http://127.0.0.1:8765")));
        assert!(origin_allowed(Some("https://localhost")));
        assert!(origin_allowed(Some("http://[::1]:8765")));
        assert!(origin_allowed(Some("http://127.0.0.2:1234")), "整个 127/8 都是 loopback");
    }

    #[test]
    fn remote_origins_are_rejected() {
        // 这是本函数存在的理由：用户浏览器里的恶意页面不得驱动本机 MCP。
        assert!(!origin_allowed(Some("http://evil.example.com")));
        assert!(!origin_allowed(Some("https://evil.example.com:443")));
        // 前缀欺骗：主机名以 localhost 开头但并非 localhost。
        assert!(!origin_allowed(Some("http://localhost.evil.com")));
        // 不透明源。
        assert!(!origin_allowed(Some("null")));
        assert!(!origin_allowed(Some("file://")));
    }

    // ── JSON-RPC 形态 ─────────────────────────────────────────────────────

    #[test]
    fn distinguishes_notifications_from_requests() {
        assert!(is_notification(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })));
        assert!(!is_notification(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })));
        // id = 0 是合法请求 id，不能当成通知。
        assert!(!is_notification(&json!({ "jsonrpc": "2.0", "id": 0, "method": "ping" })));
    }

    #[test]
    fn error_body_has_null_id_and_given_code() {
        let e = error_body(CODE_PARSE_ERROR, "bad json");
        assert_eq!(e["error"]["code"], CODE_PARSE_ERROR);
        assert_eq!(e["error"]["message"], "bad json");
        assert!(e["id"].is_null(), "取不到 id 的场合必须回 null id");
    }
}
