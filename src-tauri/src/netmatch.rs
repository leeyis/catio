//! IPv4 CIDR matcher shared by the desktop MCP head (`crate::mcp`) and the server-mode MCP head
//! (`crate::server_mcp`). Moved out of `mcp/mod.rs` verbatim so both heads gate on ONE
//! implementation; the desktop behavior is byte-identical (same names, signatures, public fields).

use std::net::{IpAddr, Ipv4Addr};

// ---- IP whitelist (network-layer gate, additive to the token) ----

/// One whitelist entry: an IPv4 base address + prefix length (single IP = /32).
#[derive(Clone, Copy)]
pub struct WhitelistRule {
    pub base: u32,
    pub prefix: u8,
}

impl WhitelistRule {
    /// Parse "a.b.c.d" (=> /32) or "a.b.c.d/n" (n in 0..=32). None on any malformed input.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let (ip_part, prefix) = match s.split_once('/') {
            Some((ip, n)) => {
                let n: u8 = n.parse().ok()?;
                if n > 32 {
                    return None;
                }
                (ip, n)
            }
            None => (s, 32u8),
        };
        let addr: Ipv4Addr = ip_part.parse().ok()?; // rejects bad octets / non-IPv4
        Some(WhitelistRule { base: u32::from(addr), prefix })
    }

    /// True if `ip` (an IPv4) falls inside this rule, comparing the high `prefix` bits.
    pub fn matches(&self, ip: Ipv4Addr) -> bool {
        if self.prefix == 0 {
            return true;
        }
        // Special-case 32 to avoid the `u32::MAX >> 32` (>>) overflow.
        let mask: u32 = if self.prefix == 32 { u32::MAX } else { !(u32::MAX >> self.prefix) };
        (u32::from(ip) & mask) == (self.base & mask)
    }
}

/// 127.0.0.1 and ::1 are always allowed; otherwise the IPv4 must match a rule.
/// Non-loopback IPv6 has no rules => denied. Unparseable client_ip => denied.
pub fn ip_allowed(client_ip: &str, rules: &[WhitelistRule]) -> bool {
    match client_ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            if v4.is_loopback() {
                return true; // 127.0.0.0/8
            }
            rules.iter().any(|r| r.matches(v4))
        }
        Ok(IpAddr::V6(v6)) => v6.is_loopback(), // ::1 only
        Err(_) => false,
    }
}
