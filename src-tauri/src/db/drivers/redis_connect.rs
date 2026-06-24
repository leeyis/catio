//! Redis 连接模式(单机 / Cluster / Sentinel)的纯函数解析与连接规格构建。
//!
//! Catio 的 ConnectArgs 没有独立的 redis 字段,沿用通用的 `options`(URL 查询串)
//! 承载模式与节点配置,保持外科手术式改动:
//!   - `mode=cluster|sentinel|standalone`(缺省 standalone)
//!   - `nodes=h1:6379,h2:6379`(cluster 种子节点 / sentinel 哨兵节点,逗号/分号/空白分隔)
//!   - `master=mymaster`(sentinel 模式下的 master name,必填)
//!
//! 节点 URL / 端点解析参考 dbx redis_driver.rs(redis_node_endpoints / parse_redis_endpoint
//! L209-313)。真实 cluster/sentinel 握手走 redis-rs I/O,需真机验证;本模块只负责把
//! 配置确定性地转成可交给 redis-rs 的连接规格(URL 列表 / 端点列表),便于纯函数单测。

use super::redis::build_redis_url;

/// Redis 连接模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedisMode {
    Standalone,
    Cluster,
    Sentinel,
}

/// 单机模式下解析出的连接规格:一个 redis(s):// URL。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandaloneSpec {
    pub url: String,
}

/// Cluster 模式:多个种子节点 URL(交给 redis::cluster::ClusterClient::new)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterSpec {
    pub seed_urls: Vec<String>,
}

/// Sentinel 模式:master 名 + 哨兵节点 URL 列表(交给 redis::sentinel::SentinelClient)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentinelSpec {
    pub master_name: String,
    pub sentinel_urls: Vec<String>,
}

/// 从 `options` 查询串里取某个 key 的值(大小写不敏感的 key,值原样保留)。
/// options 形如 "mode=cluster&nodes=h1:6379,h2:6379&master=mymaster"。
pub fn option_value<'a>(options: Option<&'a str>, key: &str) -> Option<&'a str> {
    let opts = options?;
    opts.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k.trim().eq_ignore_ascii_case(key) {
            Some(v.trim())
        } else {
            None
        }
    })
}

/// 解析连接模式;缺省或无法识别时回落 Standalone(保留现有单机直连路径)。
pub fn parse_redis_mode(options: Option<&str>) -> RedisMode {
    match option_value(options, "mode").map(|m| m.to_ascii_lowercase()) {
        Some(m) if m == "cluster" => RedisMode::Cluster,
        Some(m) if m == "sentinel" => RedisMode::Sentinel,
        _ => RedisMode::Standalone,
    }
}

/// 把 "h1:6379, h2:6380;h3" 这样的节点串拆成 (host, port) 列表。
/// 分隔符:逗号/分号/空白/换行。无端口的节点回落 `default_port`。
/// 支持 IPv6 字面量 `[::1]:6379` 与可选的 `redis://` / `rediss://` 前缀(剥离)。
/// 照搬 dbx parse_redis_endpoint 的解析意图。
pub fn parse_node_endpoints(raw: &str, default_port: u16) -> Vec<(String, u16)> {
    raw.split([',', ';', '\n', '\r', ' ', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|ep| parse_endpoint(ep, default_port))
        .collect()
}

/// 解析单个端点 "host:port" → (host, port)。剥离 scheme 前缀与 userinfo,
/// 处理 IPv6 字面量。无端口回落 default_port。
fn parse_endpoint(endpoint: &str, default_port: u16) -> (String, u16) {
    let endpoint = endpoint.trim();
    // 剥离 scheme 与 userinfo(若有)。
    let endpoint = endpoint
        .strip_prefix("rediss://")
        .or_else(|| endpoint.strip_prefix("redis://"))
        .unwrap_or(endpoint);
    let endpoint = endpoint.rsplit_once('@').map(|(_, tail)| tail).unwrap_or(endpoint);
    // 剥离尾部路径/查询/锚。
    let endpoint = endpoint.split(['/', '?', '#']).next().unwrap_or(endpoint);

    // IPv6 字面量:[host]:port
    if let Some(rest) = endpoint.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .filter(|v| !v.is_empty())
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(default_port);
            return (host.to_string(), port);
        }
    }

    // host:port —— 仅当冒号右侧是纯数字且左侧不含冒号(排除裸 IPv6)时才拆端口。
    if let Some((host, port)) = endpoint.rsplit_once(':') {
        if !host.contains(':') && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(p) = port.parse::<u16>() {
                return (host.to_string(), p);
            }
        }
    }

    (endpoint.to_string(), default_port)
}

/// 单机规格:沿用既有 build_redis_url(单机直连)。
pub fn build_standalone_spec(
    host: &str,
    port: u16,
    password: Option<&str>,
    ssl: bool,
    insecure: bool,
) -> StandaloneSpec {
    StandaloneSpec { url: build_redis_url(host, port, password, ssl, insecure) }
}

/// 为一组端点构建带凭据的 redis(s):// URL 列表(cluster 种子 / sentinel 节点共用)。
/// 节点为空时回落到 (host, port)(主机字段),保证至少有一个种子。
fn build_node_urls(
    nodes_raw: &str,
    fallback_host: &str,
    fallback_port: u16,
    default_port: u16,
    password: Option<&str>,
    ssl: bool,
    insecure: bool,
) -> Vec<String> {
    let mut endpoints = parse_node_endpoints(nodes_raw, default_port);
    if endpoints.is_empty() {
        let port = if fallback_port == 0 { default_port } else { fallback_port };
        endpoints.push((fallback_host.to_string(), port));
    }
    endpoints
        .into_iter()
        .map(|(h, p)| build_redis_url(&h, p, password, ssl, insecure))
        .collect()
}

/// Cluster 规格:种子节点 URL 列表。`nodes` 缺省时用主机字段当唯一种子。
/// 种子节点默认端口 6379(集群节点对外端口)。
pub fn build_cluster_spec(
    nodes_raw: &str,
    fallback_host: &str,
    fallback_port: u16,
    password: Option<&str>,
    ssl: bool,
    insecure: bool,
) -> ClusterSpec {
    ClusterSpec {
        seed_urls: build_node_urls(nodes_raw, fallback_host, fallback_port, 6379, password, ssl, insecure),
    }
}

/// Sentinel 规格:master name + 哨兵节点 URL 列表。哨兵默认端口 26379。
/// master 名为空返回 Err(必填,照搬 dbx connect_sentinel 的校验)。
pub fn build_sentinel_spec(
    master_name: &str,
    nodes_raw: &str,
    fallback_host: &str,
    fallback_port: u16,
    password: Option<&str>,
    ssl: bool,
    insecure: bool,
) -> Result<SentinelSpec, String> {
    let master = master_name.trim();
    if master.is_empty() {
        return Err("Sentinel 模式必须提供 master name(options 里的 master=)".to_string());
    }
    Ok(SentinelSpec {
        master_name: master.to_string(),
        sentinel_urls: build_node_urls(nodes_raw, fallback_host, fallback_port, 26379, password, ssl, insecure),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_value_is_case_insensitive_on_key() {
        let o = Some("Mode=cluster&Nodes=h1:6379&master=mymaster");
        assert_eq!(option_value(o, "mode"), Some("cluster"));
        assert_eq!(option_value(o, "NODES"), Some("h1:6379"));
        assert_eq!(option_value(o, "master"), Some("mymaster"));
        assert_eq!(option_value(o, "absent"), None);
        assert_eq!(option_value(None, "mode"), None);
    }

    #[test]
    fn parse_mode_defaults_standalone() {
        assert_eq!(parse_redis_mode(None), RedisMode::Standalone);
        assert_eq!(parse_redis_mode(Some("")), RedisMode::Standalone);
        assert_eq!(parse_redis_mode(Some("foo=bar")), RedisMode::Standalone);
        assert_eq!(parse_redis_mode(Some("mode=standalone")), RedisMode::Standalone);
        assert_eq!(parse_redis_mode(Some("mode=Cluster")), RedisMode::Cluster);
        assert_eq!(parse_redis_mode(Some("mode=SENTINEL")), RedisMode::Sentinel);
        // 无法识别的模式回落单机。
        assert_eq!(parse_redis_mode(Some("mode=garbage")), RedisMode::Standalone);
    }

    #[test]
    fn parse_node_endpoints_splits_and_defaults_port() {
        let eps = parse_node_endpoints("h1:6379, h2:6380;h3", 6379);
        assert_eq!(eps, vec![
            ("h1".to_string(), 6379),
            ("h2".to_string(), 6380),
            ("h3".to_string(), 6379),
        ]);
    }

    #[test]
    fn parse_node_endpoints_handles_ipv6_and_scheme_and_userinfo() {
        let eps = parse_node_endpoints("[::1]:7000, redis://user:pw@h2:6380, rediss://h3", 6379);
        assert_eq!(eps, vec![
            ("::1".to_string(), 7000),
            ("h2".to_string(), 6380),
            ("h3".to_string(), 6379),
        ]);
    }

    #[test]
    fn parse_node_endpoints_empty_yields_empty() {
        assert!(parse_node_endpoints("", 6379).is_empty());
        assert!(parse_node_endpoints("  , ; \n", 6379).is_empty());
    }

    #[test]
    fn standalone_spec_reuses_build_redis_url() {
        let s = build_standalone_spec("h", 6379, Some("pw"), false, false);
        assert_eq!(s.url, "redis://:pw@h:6379/");
        let s = build_standalone_spec("h", 6379, None, true, true);
        assert_eq!(s.url, "rediss://h:6379/#insecure");
    }

    #[test]
    fn cluster_spec_builds_seed_urls() {
        let c = build_cluster_spec("h1:7000,h2:7001", "ignored", 1234, Some("pw"), false, false);
        assert_eq!(c.seed_urls, vec![
            "redis://:pw@h1:7000/".to_string(),
            "redis://:pw@h2:7001/".to_string(),
        ]);
    }

    #[test]
    fn cluster_spec_falls_back_to_host_when_no_nodes() {
        // nodes 为空 → 用主机字段当唯一种子,端口取连接表单端口。
        let c = build_cluster_spec("", "myhost", 7000, None, false, false);
        assert_eq!(c.seed_urls, vec!["redis://myhost:7000/".to_string()]);
        // 端口为 0(未填)时回落 cluster 默认 6379。
        let c = build_cluster_spec("", "myhost", 0, None, false, false);
        assert_eq!(c.seed_urls, vec!["redis://myhost:6379/".to_string()]);
    }

    #[test]
    fn cluster_spec_tls_uses_rediss() {
        let c = build_cluster_spec("h1:7000", "h", 0, None, true, false);
        assert_eq!(c.seed_urls, vec!["rediss://h1:7000/".to_string()]);
    }

    #[test]
    fn sentinel_spec_requires_master_name() {
        let err = build_sentinel_spec("", "s1:26379", "h", 0, None, false, false);
        assert!(err.is_err(), "缺 master name 必须报错");
        let err = build_sentinel_spec("   ", "s1:26379", "h", 0, None, false, false);
        assert!(err.is_err());
    }

    #[test]
    fn sentinel_spec_builds_with_default_port_26379() {
        let s = build_sentinel_spec("mymaster", "s1, s2:26380", "h", 0, Some("pw"), false, false).unwrap();
        assert_eq!(s.master_name, "mymaster");
        assert_eq!(s.sentinel_urls, vec![
            "redis://:pw@s1:26379/".to_string(),
            "redis://:pw@s2:26380/".to_string(),
        ]);
    }

    #[test]
    fn sentinel_spec_falls_back_to_host_when_no_nodes() {
        let s = build_sentinel_spec("mymaster", "", "shost", 26380, None, false, false).unwrap();
        assert_eq!(s.sentinel_urls, vec!["redis://shost:26380/".to_string()]);
    }
}
