//! OSC 633 (VS Code) / OSC 133 (FinalTerm) shell-integration parsing.
//! Scans a byte stream, extracts command-audit events, and returns the bytes
//! with the OSC 633/133 sequences removed (so they never reach the terminal UI).
//! Adapted from the sequence definitions in VS Code's terminal shell integration (MIT).

#[derive(Debug, PartialEq, Clone)]
pub enum OscEvent {
    CommandLine(String),
    InputStart,
    ExecStart,
    ExecEnd(Option<i32>),
    Cwd(String),
}

/// Defensive cap: if a partial sequence buffer grows past this without a
/// terminator, flush it as visible and reset rather than buffer unbounded.
const PENDING_CAP: usize = 64 * 1024;

/// Unescape the VS Code value encoding: `\\`->`\`, `\xAB`->byte.
pub fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            match b[i + 1] {
                b'\\' => { out.push(b'\\'); i += 2; }
                b'x' | b'X' if i + 3 < b.len() => {
                    let hex = std::str::from_utf8(&b[i + 2..i + 4]).unwrap_or("");
                    if let Ok(v) = u8::from_str_radix(hex, 16) { out.push(v); i += 4; }
                    else { out.push(b[i]); i += 1; }
                }
                _ => { out.push(b[i]); i += 1; }
            }
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stateful scanner: feed chunks; emits events and returns visible bytes
/// (input minus complete OSC 633/133 sequences). Buffers a partial sequence
/// across chunk boundaries. `nonce` gates 633;E.
pub struct Scanner { nonce: String, pending: Vec<u8> }

impl Scanner {
    pub fn new(nonce: impl Into<String>) -> Self { Self { nonce: nonce.into(), pending: Vec::new() } }

    /// Parse the payload (bytes after `\x1b]`, before the terminator) of an
    /// OSC 633/133 sequence into zero or more events.
    fn parse_payload(&self, payload: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        let text = match std::str::from_utf8(payload) {
            Ok(t) => t,
            Err(_) => return events, // malformed -> no event (already stripped)
        };
        // Strip the leading "633;" / "133;" prefix.
        let rest = if let Some(r) = text.strip_prefix("633;") {
            r
        } else if let Some(r) = text.strip_prefix("133;") {
            r
        } else {
            return events;
        };

        // Match on the first token (the command letter).
        if rest == "A" {
            // prompt start -> no event
        } else if rest == "B" {
            // prompt end / input start -> emit so the UI knows the prompt is done
            // and the cursor now marks where user input begins.
            events.push(OscEvent::InputStart);
        } else if rest == "C" {
            events.push(OscEvent::ExecStart);
        } else if rest == "D" {
            events.push(OscEvent::ExecEnd(None));
        } else if let Some(code) = rest.strip_prefix("D;") {
            // ExecEnd with exit code; ignore if unparseable -> None.
            events.push(OscEvent::ExecEnd(code.parse::<i32>().ok()));
        } else if let Some(after_e) = rest.strip_prefix("E;") {
            // E;<escapedCmd>;<nonce>  (633 only; the cmd is pre-escaped so it
            // has no raw ';' — split on the LAST ';' to isolate the nonce).
            if let Some(idx) = after_e.rfind(';') {
                let cmd = &after_e[..idx];
                let nonce = &after_e[idx + 1..];
                if nonce == self.nonce {
                    events.push(OscEvent::CommandLine(unescape(cmd)));
                }
            }
        } else if let Some(prop) = rest.strip_prefix("P;") {
            // 633;P;Cwd=<escapedPwd>  (other P props: strip, no event).
            if let Some(val) = prop.strip_prefix("Cwd=") {
                events.push(OscEvent::Cwd(unescape(val)));
            }
        }
        events
    }

    /// Returns `(visible_bytes, events, first_marker_offset)`.
    ///
    /// `first_marker_offset` is `Some(n)` when this call stripped at least one
    /// OSC 633/133 sequence, where `n` is the length of `visible_bytes` accumulated
    /// *before* the first such sequence. Callers use this to locate where shell
    /// integration first became live within the batch — everything before it is
    /// pre-integration output (e.g. the echoed bootstrap line), everything after
    /// is the clean prompt. `None` means no 633/133 sequence appeared in this batch.
    pub fn feed(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<OscEvent>, Option<usize>) {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);

        let mut visible: Vec<u8> = Vec::with_capacity(buf.len());
        let mut events: Vec<OscEvent> = Vec::new();
        // Offset (into `visible`) just before the first stripped 633/133 sequence.
        let mut first_marker: Option<usize> = None;
        let mut i = 0;

        while i < buf.len() {
            // Look for the OSC introducer ESC ] = \x1b]
            if buf[i] == 0x1b {
                if i + 1 >= buf.len() {
                    // Trailing lone ESC — could be the start of a split ESC].
                    // Stash from here in pending and stop.
                    self.pending.extend_from_slice(&buf[i..]);
                    return self.finish(visible, events, first_marker);
                }
                if buf[i + 1] == b']' {
                    // OSC start. Search for a terminator from i+2.
                    let payload_start = i + 2;
                    match find_terminator(&buf[payload_start..]) {
                        None => {
                            // Incomplete OSC -> buffer the rest in pending.
                            self.pending.extend_from_slice(&buf[i..]);
                            return self.finish(visible, events, first_marker);
                        }
                        Some((rel_term_start, term_len)) => {
                            let term_start = payload_start + rel_term_start;
                            let payload = &buf[payload_start..term_start];
                            let seq_end = term_start + term_len; // exclusive
                            if payload.starts_with(b"633;") || payload.starts_with(b"133;") {
                                // Parse + strip (do not add to visible). Record the
                                // visible offset of the first such marker in this batch.
                                if first_marker.is_none() {
                                    first_marker = Some(visible.len());
                                }
                                events.extend(self.parse_payload(payload));
                            } else {
                                // Pass-through: copy the full sequence inclusive.
                                visible.extend_from_slice(&buf[i..seq_end]);
                            }
                            i = seq_end;
                            continue;
                        }
                    }
                }
                // ESC not followed by ] -> ordinary byte (pass-through).
            }
            visible.push(buf[i]);
            i += 1;
        }

        self.finish(visible, events, first_marker)
    }

    /// Apply the defensive pending cap, then return.
    fn finish(
        &mut self,
        mut visible: Vec<u8>,
        events: Vec<OscEvent>,
        first_marker: Option<usize>,
    ) -> (Vec<u8>, Vec<OscEvent>, Option<usize>) {
        if self.pending.len() > PENDING_CAP {
            // No terminator within a reasonable window — flush as visible and reset.
            visible.append(&mut self.pending);
            self.pending.clear();
        }
        (visible, events, first_marker)
    }
}

/// Find the first OSC terminator in `s`. Returns (start_index, length):
/// BEL 0x07 (len 1) or ST = ESC \ = \x1b\x5c (len 2).
fn find_terminator(s: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < s.len() {
        if s[i] == 0x07 {
            return Some((i, 1));
        }
        if s[i] == 0x1b && i + 1 < s.len() && s[i + 1] == 0x5c {
            return Some((i, 2));
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }

    #[test] fn unescape_basic() {
        assert_eq!(unescape("ls\\x3b cat"), "ls; cat");
        assert_eq!(unescape("a\\\\b"), "a\\b");
        assert_eq!(unescape("x\\x0ay"), "x\ny");
    }
    #[test] fn extracts_command_and_exit_and_strips() {
        let mut sc = Scanner::new("N");
        let input = b"\x1b]633;E;ls\\x3b cat;N\x07\x1b]633;C\x07hello\r\n\x1b]633;D;0\x07$ ";
        let (vis, ev, _) = sc.feed(input);
        assert_eq!(s(&vis), "hello\r\n$ ");
        assert!(ev.contains(&OscEvent::CommandLine("ls; cat".into())));
        assert!(ev.contains(&OscEvent::ExecStart));
        assert!(ev.contains(&OscEvent::ExecEnd(Some(0))));
    }
    #[test] fn rejects_wrong_nonce() {
        let mut sc = Scanner::new("GOOD");
        let (_v, ev, _) = sc.feed(b"\x1b]633;E;whoami;BAD\x07");
        assert!(!ev.iter().any(|e| matches!(e, OscEvent::CommandLine(_))));
    }
    #[test] fn buffers_split_sequence() {
        let mut sc = Scanner::new("N");
        let (v1, e1, _) = sc.feed(b"out\x1b]633;D;1");
        assert_eq!(s(&v1), "out"); assert!(e1.is_empty());
        let (v2, e2, _) = sc.feed(b"3\x07more");
        assert_eq!(s(&v2), "more");
        assert!(e2.contains(&OscEvent::ExecEnd(Some(13))));
    }
    #[test] fn passes_through_other_osc() {
        let mut sc = Scanner::new("N");
        let (v, _e, _) = sc.feed(b"\x1b]0;my title\x07X");
        assert_eq!(s(&v), "\x1b]0;my title\x07X");
    }
    #[test] fn osc133_exit_and_start() {
        let mut sc = Scanner::new("N");
        let (_v, ev, _) = sc.feed(b"\x1b]133;C\x07\x1b]133;D;2\x07");
        assert!(ev.contains(&OscEvent::ExecStart));
        assert!(ev.contains(&OscEvent::ExecEnd(Some(2))));
    }
    #[test] fn input_start_event_and_stripped() {
        let mut sc = Scanner::new("N");
        // 633;B (prompt end / input start) must emit InputStart and be stripped.
        let (vis, ev, _) = sc.feed(b"$ \x1b]633;B\x07");
        assert_eq!(s(&vis), "$ ");
        assert!(ev.contains(&OscEvent::InputStart));
        // 633;A (prompt start) must NOT emit an event but is still stripped.
        let (vis2, ev2, _) = sc.feed(b"\x1b]633;A\x07x");
        assert_eq!(s(&vis2), "x");
        assert!(!ev2.iter().any(|e| matches!(e, OscEvent::InputStart)));
    }
    #[test] fn cwd_event() {
        let mut sc = Scanner::new("N");
        let (_v, ev, _) = sc.feed(b"\x1b]633;P;Cwd=/home/u\x07");
        assert!(ev.contains(&OscEvent::Cwd("/home/u".into())));
    }
    #[test] fn st_terminator_supported() {
        let mut sc = Scanner::new("N");
        // ST terminator (ESC \) instead of BEL
        let (vis, ev, _) = sc.feed(b"\x1b]633;C\x1b\\done");
        assert_eq!(s(&vis), "done");
        assert!(ev.contains(&OscEvent::ExecStart));
    }
    #[test] fn first_marker_offset_splits_pre_integration_noise() {
        // The batch that first carries a 633/133 marker may also carry the echoed
        // bootstrap line before it. `first_marker_offset` must point just past that
        // pre-marker noise so callers can drop it and keep only the clean prompt.
        let mut sc = Scanner::new("N");
        let (vis, _ev, off) = sc.feed(b"__c='blob'\r\n\x1b]633;A\x07user@host:~$ ");
        assert_eq!(s(&vis), "__c='blob'\r\nuser@host:~$ ");
        assert_eq!(off, Some("__c='blob'\r\n".len()));
        // Bytes at/after the offset are the clean prompt.
        assert_eq!(s(&vis[off.unwrap()..]), "user@host:~$ ");
    }
    #[test] fn first_marker_offset_none_without_marker() {
        let mut sc = Scanner::new("N");
        let (_v, _e, off) = sc.feed(b"plain output, no osc");
        assert_eq!(off, None);
    }
}
