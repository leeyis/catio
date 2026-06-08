//! Remote shell-integration bootstrap.
//!
//! Builds a single line to write into a freshly-opened PTY shell that installs
//! OSC 633 hooks for bash AND zsh (self-detecting). The hooks emit:
//!   * pre-exec: `\e]633;E;<escapedCmd>;<nonce>\a\e]633;C\a`
//!   * prompt:   `\e]633;D;<exit>\a\e]633;P;Cwd=<escapedPwd>\a`
//!     which `osc::Scanner` (gated by the same `nonce`) strips and turns into
//!     command-audit events.
//!
//! The integration body is adapted from VS Code's shellIntegration-bash.sh and
//! shellIntegration-rc.zsh (Copyright (c) Microsoft Corporation, MIT License).

use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// The shell-integration body, with `__CATIO_NONCE__` as the nonce placeholder.
/// Installs OSC 633 preexec/precmd hooks for zsh and bash.
const INTEGRATION_TEMPLATE: &str = r#"if [ -n "${ZSH_VERSION:-}" ]; then
  __catio_n='__CATIO_NONCE__'
  __catio_esc(){ local s=${1//\\/\\\\}; s=${s//;/\\x3b}; s=${s//$'\n'/\\x0a}; print -rn -- "$s"; }
  __catio_pe(){ print -rn -- $'\e]633;E;'"$(__catio_esc "$1")"';'"$__catio_n"$'\a\e]633;C\a'; }
  __catio_pc(){ local e=$?; print -rn -- $'\e]633;D;'"$e"$'\a\e]633;P;Cwd='"$(__catio_esc "$PWD")"$'\a'; }
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec __catio_pe; add-zsh-hook precmd __catio_pc
elif [ -n "${BASH_VERSION:-}" ]; then
  __catio_n='__CATIO_NONCE__'
  __catio_esc(){ local s=${1//\\/\\\\}; s=${s//;/\\x3b}; s=${s//$'\n'/\\x0a}; printf '%s' "$s"; }
  __catio_in=0
  __catio_pe(){ if [ "$__catio_in" = 0 ]; then __catio_in=1; local c; c=$(builtin history 1 | sed 's/ *[0-9][0-9]* *//'); printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__catio_esc "$c")" "$__catio_n"; fi; }
  __catio_pc(){ local e=$?; printf '\e]633;D;%s\a\e]633;P;Cwd=%s\a' "$e" "$(__catio_esc "$PWD")"; __catio_in=0; }
  trap '__catio_pe' DEBUG
  case "${PROMPT_COMMAND:-}" in *__catio_pc*) ;; *) PROMPT_COMMAND="__catio_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
fi"#;

/// Returns ONE line to write to the PTY that installs the shell-integration
/// hooks for the given `nonce`. The integration body is base64-encoded and
/// decoded remotely (covering both GNU `base64 -d` and BSD `base64 --decode`).
///
/// The leading space, combined with `HISTCONTROL=ignorespace`, keeps the
/// bootstrap out of the remote shell's history.
pub fn bootstrap_line(nonce: &str) -> String {
    let body = INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", nonce);
    let b64 = B64.encode(body.as_bytes());
    format!(
        " export HISTCONTROL=ignorespace; eval \"$(printf %s '{b64}' | base64 -d 2>/dev/null || printf %s '{b64}' | base64 --decode)\"\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_line_shape() {
        let line = bootstrap_line("ABC");
        // Leading space keeps it out of history with HISTCONTROL=ignorespace.
        assert!(line.starts_with(' '), "must start with a space: {line:?}");
        // Covers GNU base64 decode.
        assert!(line.contains("base64 -d"), "missing `base64 -d`: {line:?}");
        // Covers BSD base64 decode fallback.
        assert!(line.contains("base64 --decode"), "missing `base64 --decode`: {line:?}");
        // A non-empty base64 blob must be present (the encoded integration body).
        let b64 = B64.encode(INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", "ABC").as_bytes());
        assert!(!b64.is_empty());
        assert!(line.contains(&b64), "base64 blob not embedded");
        // The nonce must round-trip into the encoded body.
        let decoded = String::from_utf8(B64.decode(b64.as_bytes()).unwrap()).unwrap();
        assert!(decoded.contains("ABC"), "nonce not embedded in body");
    }
}
