use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调 ID 生成器。prefix 形如 "conn" → "conn-1","conn-2"...
pub struct IdGen {
    prefix: &'static str,
    n: AtomicU64,
}

impl IdGen {
    pub const fn new(prefix: &'static str) -> Self {
        Self { prefix, n: AtomicU64::new(0) }
    }
    pub fn next(&self) -> String {
        let v = self.n.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{}-{}", self.prefix, v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_monotonic_and_prefixed() {
        let g = IdGen::new("conn");
        assert_eq!(g.next(), "conn-1");
        assert_eq!(g.next(), "conn-2");
    }
}
