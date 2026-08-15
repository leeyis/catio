//! Tool execution policy: manual/ask/auto mode plus sensitive-command
//! classification migrated from
//! `src/components/workbench/sensitiveCommands.ts`. The shared fixture
//! `src-tauri/tests/fixtures/agent/policy_commands.json` proves migration
//! parity on both sides.

use std::sync::OnceLock;

use regex::Regex;

use crate::agent::types::ExecutionMode;

/// Risk category codes, mirroring the TypeScript `RiskCode` union.
pub const RISK_CODES: [&str; 13] = [
    "fileDelete",
    "fileMove",
    "diskWrite",
    "power",
    "kill",
    "service",
    "chmodR",
    "forkbomb",
    "overwrite",
    "dbDrop",
    "infra",
    "gitDestructive",
    "secretAccess",
];

/// Classification result for one command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolRisk {
    pub sensitive: bool,
    pub reasons: Vec<String>,
}

/// Policy decision for a tool under an execution mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Hidden,
    Allowed { risk: ToolRisk },
    ApprovalRequired { risk: ToolRisk, reason: String },
}

/// Sensitive-command classifier plus execution-mode policy.
pub struct ToolPolicy;

impl ToolPolicy {
    /// Classifies a command against the 13 risk patterns (case-insensitive,
    /// whitespace-tolerant), returning deduplicated reasons.
    pub fn classify(command: &str) -> ToolRisk {
        let mut reasons = Vec::new();
        if !command.is_empty() {
            for (code, pattern) in patterns() {
                if pattern.is_match(command) {
                    reasons.push((*code).to_string());
                }
            }
        }
        let sensitive = !reasons.is_empty();
        ToolRisk { sensitive, reasons }
    }

    /// Applies the fixed mode matrix:
    /// - manual hides the tool entirely;
    /// - ask requires approval for sensitive commands, allows ordinary ones;
    /// - auto allows sensitive commands without approval.
    pub fn authorize(mode: ExecutionMode, command: &str) -> PolicyDecision {
        let risk = Self::classify(command);
        match mode {
            ExecutionMode::Manual => PolicyDecision::Hidden,
            ExecutionMode::Ask if risk.sensitive => PolicyDecision::ApprovalRequired {
                risk,
                reason: "sensitiveCommand".into(),
            },
            ExecutionMode::Ask | ExecutionMode::Auto => PolicyDecision::Allowed { risk },
        }
    }
}

/// Lazily compiled `[RiskCode, Regex]` patterns; identical semantics to the
/// TypeScript `RISK_PATTERNS` (all `i`-flagged).
fn patterns() -> &'static Vec<(&'static str, Regex)> {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                "fileDelete",
                r"(?i)\b(?:rm|rmdir|unlink|del|erase|remove-item)\b",
            ),
            ("fileMove", r"(?i)\b(?:mv|move|move-item)\b"),
            (
                "diskWrite",
                r"(?i)(?:\bdd\b(?:\s|$)|\bmkfs(?:\.[a-z0-9]+)?\b|>\s*/dev/(?:sd|nvme|hd|vd|mmcblk|disk)|\bof=\s*/dev/)",
            ),
            (
                "power",
                r"(?i)\b(?:shutdown|reboot|poweroff|halt|init\s+[06]|restart-computer|stop-computer)\b",
            ),
            (
                "kill",
                r"(?i)\b(?:kill|pkill|killall|taskkill|stop-process)\b",
            ),
            (
                "service",
                r"(?i)(?:\b(?:systemctl|service)\b[^\n;|&]*\b(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b|\b(?:start|stop|restart)-service\b|(?:^|[;&|]\s*|\b(?:sudo|doas)\s+)restart\b|\bsc(?:\.exe)?\s+(?:start|stop|config|delete)\b|\b(?:docker|podman)\s+(?:rm|stop|kill|restart)\b|\bdocker\s+compose\s+(?:down|restart|stop|kill|rm)\b|\bnvidia-smi\b[^\n;|&]*--gpu-reset\b)",
            ),
            (
                "chmodR",
                r"(?i)\b(?:chmod|chown|chgrp)\b[^\n;|&]*?(?:-[a-z]*r[a-z]*\b|--recursive\b)",
            ),
            ("forkbomb", r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),
            (
                "overwrite",
                r"(?i)(?:(?:>|>>|\btee\b|\bsed\s+-i\b|\bperl\s+-pi\b|\binstall\b|\bcp\b|\bcopy\b|\bset-content\b|\badd-content\b|\bout-file\b)[^\n;&]*(?:/etc/|/boot/|/root/|/(?:usr/)?s?bin/|/var/(?:lib|spool)/|[a-z]:\\windows\\(?:system32|syswow64)\\))",
            ),
            (
                "dbDrop",
                r"(?i)\b(?:drop\s+(?:database|schema|table)|truncate\s+(?:table\s+)?)\b",
            ),
            (
                "infra",
                r"(?i)(?:\bkubectl\s+(?:apply|replace|patch|delete|drain|cordon|uncordon|taint|scale)\b|\bkubectl\s+rollout\s+restart\b|\bterraform\s+(?:apply|destroy)\b|\b(?:docker|podman)\s+(?:system|volume|network|image)\s+prune\b)",
            ),
            (
                "gitDestructive",
                r"(?i)(?:\bgit\s+reset\b[^\n;|&]*--hard\b|\bgit\s+clean\b|\bgit\s+branch\b[^\n;|&]*-D\b|\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?\b|-f\b)|\bgit\s+(?:checkout\s+--|restore\b))",
            ),
            (
                "secretAccess",
                r"(?i)(?:(?:^|[\\/])\.(?:ssh|aws|kube)(?:[\\/]|$)|\bkubectl\b[^\n;|&]*\b(?:get|describe)\s+secrets?\b|^\s*(?:env|printenv|set)\s*$|\bget-childitem\s+env:\s*$)",
            ),
        ]
        .into_iter()
        .map(|(code, pattern)| (code, Regex::new(pattern).expect("static risk pattern")))
        .collect()
    })
}
