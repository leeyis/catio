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
  case "$PS1" in *'633;B'*) ;; *) PS1="$PS1"$'%{\e]633;B\a%}';; esac
  print -rn -- $'\e]633;P;CatioReady='"$__catio_n"$'\a'
elif [ -n "${BASH_VERSION:-}" ]; then
  __catio_n='__CATIO_NONCE__'
  __catio_esc(){ local s=${1//\\/\\\\}; s=${s//;/\\x3b}; s=${s//$'\n'/\\x0a}; printf '%s' "$s"; }
  __catio_in=0
  __catio_pe(){ case "$BASH_COMMAND" in __catio_*) return;; esac; if [ "$__catio_in" = 0 ]; then __catio_in=1; local c; c=$(builtin history 1 | sed 's/ *[0-9][0-9]* *//'); printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__catio_esc "$c")" "$__catio_n"; fi; }
  __catio_pc(){ local e=$?; __catio_in=0; printf '\e]633;D;%s\a\e]633;P;Cwd=%s\a' "$e" "$(__catio_esc "$PWD")"; }
  trap '__catio_pe' DEBUG
  case "${PROMPT_COMMAND:-}" in *__catio_pc*) ;; *) PROMPT_COMMAND="__catio_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
  case "$PS1" in *'633;B'*) ;; *) PS1="$PS1"$'\[\e]633;B\a\]';; esac
  printf '\e]633;P;CatioReady=%s\a' "$__catio_n"
fi"#;

/// 块大小：每条赋值行携带的 base64 字节数。配合固定前缀后整行远低于 POSIX
/// `MAX_CANON`（规范模式单行上限，最小可低至 255 字节），确保任何 PTY 都不会截断。
const CHUNK: usize = 120;

/// Returns the bytes to write to the PTY that install the shell-integration
/// hooks for the given `nonce`. The integration body is base64-encoded and
/// decoded remotely (covering both GNU `base64 -d` and BSD `base64 --decode`).
///
/// 关键：**绝不**一次写一条超长单行。部分 SSH 服务端（典型如 ESXi 的 dropbear）
/// PTY 规范模式的单行长度上限很小，超长行会被截断；截断点一旦落在 base64 的单引号
/// 字符串中间，引号便不闭合，远端 shell 随即卡在 PS2 续行（`> `）——之后每条命令都
/// 被当作续行，永不执行、永无输出。因此把 base64 切成小块，用多条各自引号闭合的短
/// 赋值命令拼到 `__c`，最后统一解码 `eval`。每行前导空格配合 `HISTCONTROL=ignorespace`
/// 使这些引导命令不进入 bash 历史。对无 `base64` 的极简 shell（如 ESXi 的 ash），
/// `eval` 得到空串、纯无害（shell-integration 本就只对 bash/zsh 生效），交互不再被卡死。
///
/// 返回值含多个换行：调用方一次写入 PTY，远端按行逐条执行（每行均短于截断上限）。
pub fn bootstrap_line(nonce: &str) -> String {
    let body = INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", nonce);
    let b64 = B64.encode(body.as_bytes());
    let mut s = String::new();
    s.push_str(" export HISTCONTROL=ignorespace\n");
    s.push_str(" __c=''\n");
    // b64 仅含 [A-Za-z0-9+/=]，是纯 ASCII，故按字节切片安全；单引号内这些字符绝对安全。
    let mut i = 0;
    while i < b64.len() {
        let end = (i + CHUNK).min(b64.len());
        s.push_str(" __c=\"$__c\"'");
        s.push_str(&b64[i..end]);
        s.push_str("'\n");
        i = end;
    }
    // 关键：把 `unset __c` 放进 eval 字符串的**最前面**(而非作为独立的最后一行)。
    // 独立的 ` unset __c` 行会在 integration 安装、第一个 prompt(OSC marker)解除
    // mute 之后才回显，于是被显示到终端(用户报告的 `unset __c` 噪声)。放进 eval 串内：
    //   * $() 在求值时先解码(此时 __c 仍在),
    //   * eval 执行 "unset __c; <body>"——unset 在 hook 安装前跑、无独立回显、不触发审计;
    //   * 这成为注入的最后一行,其后第一个 prompt 才解除 mute,终端从干净的 prompt 起显。
    // 对无 base64 的极简 shell(ESXi),$() 为空,eval 仅执行 `unset __c`,同样清理且无害。
    s.push_str(" eval \"unset __c; $(printf %s \"$__c\" | base64 -d 2>/dev/null || printf %s \"$__c\" | base64 --decode 2>/dev/null)\"\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // 从分块注入中还原出完整 base64：拼接每条 ` __c="$__c"'<chunk>'` 行的片段。
    fn reassemble_b64(script: &str) -> String {
        script
            .lines()
            .filter_map(|l| {
                let l = l.trim_start();
                let rest = l.strip_prefix("__c=\"$__c\"'")?;
                rest.strip_suffix('\'')
            })
            .collect()
    }

    #[test]
    fn bootstrap_line_shape() {
        let script = bootstrap_line("ABC");
        // Leading space keeps each command out of history with HISTCONTROL=ignorespace.
        assert!(script.starts_with(' '), "must start with a space: {script:?}");
        // Covers GNU base64 decode.
        assert!(script.contains("base64 -d"), "missing `base64 -d`: {script:?}");
        // Covers BSD base64 decode fallback.
        assert!(script.contains("base64 --decode"), "missing `base64 --decode`: {script:?}");
        // 把分块片段还原出 base64，解码后必须是带 nonce 的 integration 脚本。
        let b64 = reassemble_b64(&script);
        assert!(!b64.is_empty(), "no base64 chunks embedded: {script:?}");
        let decoded = String::from_utf8(B64.decode(b64.as_bytes()).unwrap()).unwrap();
        assert!(decoded.contains("ABC"), "nonce not embedded in body");
        assert!(
            decoded.contains("ZSH_VERSION") && decoded.contains("BASH_VERSION"),
            "decoded body is not the integration template: {decoded}"
        );
        // 还原结果必须与直接编码完整脚本逐字节一致（分块/拼接无损）。
        let expected = B64.encode(INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", "ABC").as_bytes());
        assert_eq!(b64, expected, "reassembled base64 differs from source");
    }

    #[test]
    fn no_line_exceeds_canonical_pty_limit() {
        // 根因回归：任何一行都必须远低于 POSIX MAX_CANON(255)，否则 ESXi 等 PTY 会
        // 截断该行、引号断裂，使远端 shell 卡死在 PS2 续行。用长 nonce 取更长的脚本。
        let script = bootstrap_line("deadbeefdeadbeefdeadbeefdeadbeef");
        for l in script.lines() {
            assert!(
                l.len() < 200,
                "injected line too long ({} bytes), risks PTY truncation: {l:?}",
                l.len()
            );
        }
        // 必须确实是多行注入（不是退回单行）。
        assert!(
            script.lines().count() > 5,
            "bootstrap must be split into many short lines"
        );
    }

    #[test]
    fn bash_debug_trap_skips_own_functions() {
        // The DEBUG trap must ignore our own prompt machinery so a single user
        // command isn't recorded multiple times (mirrors VS Code's __vsc_prompt guard).
        let body = INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", "N");
        assert!(
            body.contains(r#"case "$BASH_COMMAND" in __catio_*) return;; esac"#),
            "bash __catio_pe must skip __catio_* commands: {body}"
        );
        // __catio_pc must reset the in-flight guard at its start (after capturing $?).
        assert!(
            body.contains(r#"local e=$?; __catio_in=0;"#),
            "__catio_pc must reset __catio_in before its printfs: {body}"
        );
    }

    #[test]
    fn emits_nonce_gated_ready_sentinel() {
        // Both shells must emit our nonce-gated CatioReady sentinel AFTER installing
        // hooks. It is the only trusted signal that unmutes the terminal, so a host's
        // pre-existing integration (which lacks our nonce) can't unmute us early.
        let body = INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", "NONCE123");
        // zsh: print -rn -- $'\e]633;P;CatioReady='"$__catio_n"$'\a'
        assert!(
            body.contains(r#"print -rn -- $'\e]633;P;CatioReady='"$__catio_n"$'\a'"#),
            "zsh must emit CatioReady sentinel: {body}"
        );
        // bash: printf '\e]633;P;CatioReady=%s\a' "$__catio_n"
        assert!(
            body.contains(r#"printf '\e]633;P;CatioReady=%s\a' "$__catio_n""#),
            "bash must emit CatioReady sentinel: {body}"
        );
        // Exactly two emissions (one per shell branch).
        assert_eq!(
            body.matches("CatioReady").count(),
            2,
            "expected one CatioReady sentinel per shell branch: {body}"
        );
    }

    #[test]
    fn ps1_decorated_with_input_start_marker() {
        // Both shells must append a non-printing OSC 633;B (input start) marker to
        // PS1 so the prompt-end / input-begin position reaches the frontend.
        let body = INTEGRATION_TEMPLATE.replace("__CATIO_NONCE__", "N");
        // zsh: wrapped in %{ ... %} (zsh non-printing markers).
        assert!(
            body.contains(r#"PS1="$PS1"$'%{\e]633;B\a%}'"#),
            "zsh PS1 must append %{{ ESC]633;B BEL %}}: {body}"
        );
        // bash: wrapped in \[ ... \] (readline non-printing markers).
        assert!(
            body.contains(r#"PS1="$PS1"$'\[\e]633;B\a\]'"#),
            "bash PS1 must append \\[ ESC]633;B BEL \\]: {body}"
        );
        // Idempotent guard: don't append twice on re-bootstrap.
        assert_eq!(
            body.matches(r#"case "$PS1" in *'633;B'*"#).count(),
            2,
            "both shells must guard PS1 decoration against double-append: {body}"
        );
    }
}
