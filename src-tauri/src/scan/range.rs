//! ranges 文本 → IP 列表展开。
//!
//! 支持四种 token（以空白/逗号/换行分隔）：
//!   * CIDR：`192.168.10.0/24`（用 `ipnet` 枚举主机地址，剔除网络/广播地址）；
//!   * 末段区间：`192.168.10.1-254`（仅最后一段取区间）；
//!   * 单 IP：`192.168.10.5`；
//!   * 主机名：`db.internal`（交由 commands 层做异步 DNS 解析，本模块原样返回为待解析项）。
//!
//! `expand_ranges` 是可单元测试的纯函数：解析出确定的 `IpAddr` 列表 + 无法在本地确定
//! 的主机名 token（供上层 DNS 解析）。

use std::net::{IpAddr, Ipv4Addr};
use std::str::FromStr;

use ipnet::Ipv4Net;

/// 一段 ranges 文本的解析产物。
#[derive(Debug, Default)]
pub struct Expanded {
    /// 已确定的 IP 地址（CIDR/区间/单 IP 展开）。
    pub ips: Vec<IpAddr>,
    /// 需异步 DNS 解析的主机名 token（保持出现顺序，去重交给上层）。
    pub hostnames: Vec<String>,
}

/// 把 ranges 文本（多条）切分为 token，逐个展开。识别不了的非法 token 直接跳过
/// （不报错——单条坏 token 不应让整次扫描失败；调用方可据 `hostnames` 再做 DNS）。
pub fn expand_ranges(ranges: &[String]) -> Expanded {
    let mut out = Expanded::default();
    for raw in ranges {
        for token in raw.split(|c: char| c.is_whitespace() || c == ',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            expand_token(token, &mut out);
        }
    }
    dedup_ips(&mut out.ips);
    out
}

fn expand_token(token: &str, out: &mut Expanded) {
    // CIDR
    if token.contains('/') {
        if let Ok(net) = Ipv4Net::from_str(token) {
            // /31、/32 直接收所有地址；否则剔除网络/广播地址。
            let prefix = net.prefix_len();
            for ip in net.hosts() {
                out.ips.push(IpAddr::V4(ip));
            }
            // hosts() 对 /31、/32 已返回全部地址，对其他前缀自动剔除网络/广播，
            // 无需额外处理。prefix 仅用于显式说明意图。
            let _ = prefix;
        }
        return;
    }
    // 末段区间：a.b.c.START-END
    if let Some((head, tail)) = token.rsplit_once('.') {
        if let Some((lo, hi)) = tail.split_once('-') {
            if let (Ok(base), Ok(lo), Ok(hi)) =
                (Ipv4Addr::from_str(&format!("{head}.0")), lo.parse::<u8>(), hi.parse::<u8>())
            {
                let octets = base.octets();
                let (start, end) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                for last in start..=end {
                    out.ips
                        .push(IpAddr::V4(Ipv4Addr::new(octets[0], octets[1], octets[2], last)));
                }
                return;
            }
        }
    }
    // 单 IP（v4 / v6）
    if let Ok(ip) = IpAddr::from_str(token) {
        out.ips.push(ip);
        return;
    }
    // 其余视为主机名，交上层 DNS 解析。
    out.hostnames.push(token.to_string());
}

fn dedup_ips(ips: &mut Vec<IpAddr>) {
    let mut seen = std::collections::HashSet::new();
    ips.retain(|ip| seen.insert(*ip));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ipv4(s: &str) -> IpAddr {
        IpAddr::from_str(s).unwrap()
    }

    #[test]
    fn single_ip() {
        let e = expand_ranges(&["192.168.1.10".into()]);
        assert_eq!(e.ips, vec![ipv4("192.168.1.10")]);
        assert!(e.hostnames.is_empty());
    }

    #[test]
    fn last_octet_range() {
        let e = expand_ranges(&["10.0.0.1-3".into()]);
        assert_eq!(
            e.ips,
            vec![ipv4("10.0.0.1"), ipv4("10.0.0.2"), ipv4("10.0.0.3")]
        );
    }

    #[test]
    fn cidr_excludes_network_and_broadcast() {
        let e = expand_ranges(&["192.168.0.0/30".into()]);
        // /30 主机地址 = .1、.2（剔除 .0 网络、.3 广播）。
        assert_eq!(e.ips, vec![ipv4("192.168.0.1"), ipv4("192.168.0.2")]);
    }

    #[test]
    fn slash32_yields_single() {
        let e = expand_ranges(&["192.168.0.5/32".into()]);
        assert_eq!(e.ips, vec![ipv4("192.168.0.5")]);
    }

    #[test]
    fn hostname_collected() {
        let e = expand_ranges(&["db.internal".into()]);
        assert!(e.ips.is_empty());
        assert_eq!(e.hostnames, vec!["db.internal".to_string()]);
    }

    #[test]
    fn mixed_and_dedup() {
        let e = expand_ranges(&["192.168.1.1, 192.168.1.1\n192.168.1.2".into()]);
        assert_eq!(e.ips, vec![ipv4("192.168.1.1"), ipv4("192.168.1.2")]);
    }
}
