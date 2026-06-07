use std::collections::HashMap;

/// known_hosts 极简格式：每行 `host:port fingerprint`。
pub fn parse(contents: &str) -> HashMap<String, String> {
    contents
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let (h, f) = l.split_once(' ')?;
            Some((h.to_string(), f.to_string()))
        })
        .collect()
}

pub fn serialize(map: &HashMap<String, String>) -> String {
    let mut lines: Vec<String> = map.iter().map(|(h, f)| format!("{h} {f}")).collect();
    lines.sort();
    lines.join("\n") + "\n"
}

pub enum Verdict {
    Trusted,
    Unknown,
    Mismatch,
}

pub fn verify(map: &HashMap<String, String>, host_port: &str, fp: &str) -> Verdict {
    match map.get(host_port) {
        Some(known) if known == fp => Verdict::Trusted,
        Some(_) => Verdict::Mismatch,
        None => Verdict::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_verify() {
        let mut m = HashMap::new();
        m.insert("h:22".to_string(), "SHA256:abc".to_string());
        let s = serialize(&m);
        let m2 = parse(&s);
        assert_eq!(m, m2);
        assert!(matches!(verify(&m2, "h:22", "SHA256:abc"), Verdict::Trusted));
        assert!(matches!(verify(&m2, "h:22", "SHA256:xxx"), Verdict::Mismatch));
        assert!(matches!(verify(&m2, "other:22", "SHA256:abc"), Verdict::Unknown));
    }
}
