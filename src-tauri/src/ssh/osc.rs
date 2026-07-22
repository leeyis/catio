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
    /// Our own shell-integration bootstrap finished installing its hooks and
    /// emitted the nonce-gated `633;P;CatioReady=<nonce>` sentinel. This is the
    /// ONLY trusted signal that OUR integration is live — the terminal layer uses
    /// it (not any generic 633/133 marker, which a host's pre-existing integration
    /// could emit before our bootstrap even runs) to end the connect-time mute.
    Ready,
}

#[derive(Debug, PartialEq, Clone)]
pub struct PositionedOscEvent {
    pub event: OscEvent,
    /// Byte offset in the visible output at which this stripped OSC marker appeared.
    pub visible_offset: usize,
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
/// across chunk boundaries. `nonce` gates the command lifecycle markers.
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
        } else if let Some(nonce) = rest.strip_prefix("C;") {
            if nonce == self.nonce {
                events.push(OscEvent::ExecStart);
            }
        } else if let Some(after_d) = rest.strip_prefix("D;") {
            // D;<exitCode>;<nonce>. C/D are nonce-gated just like E so command
            // output cannot forge an early completion boundary.
            if let Some(idx) = after_d.rfind(';') {
                let code = &after_d[..idx];
                let nonce = &after_d[idx + 1..];
                if nonce == self.nonce {
                    events.push(OscEvent::ExecEnd(code.parse::<i32>().ok()));
                }
            }
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
            // 633;P;Cwd=<escapedPwd> or 633;P;CatioReady=<nonce> (our sentinel).
            // Other P props: strip, no event.
            if let Some(val) = prop.strip_prefix("Cwd=") {
                events.push(OscEvent::Cwd(unescape(val)));
            } else if let Some(n) = prop.strip_prefix("CatioReady=") {
                // Nonce-gated: only OUR bootstrap knows the nonce, so a host's
                // pre-existing integration can't spoof this to unmute early.
                if n == self.nonce {
                    events.push(OscEvent::Ready);
                }
            }
        }
        events
    }

    /// Returns `(visible_bytes, positioned_events, ready_offset)`.
    ///
    /// `ready_offset` is `Some(n)` when this call stripped OUR nonce-gated
    /// `633;P;CatioReady=<nonce>` sentinel, where `n` is the length of
    /// `visible_bytes` accumulated *before* that sentinel. The terminal layer uses
    /// it to end the connect-time mute precisely at the point our integration went
    /// live: everything before `n` is pre-integration output (the echoed bootstrap
    /// line, plus any MOTD), everything at/after is the clean first prompt. `None`
    /// means our sentinel did not appear in this batch — a generic 633/133 marker
    /// (e.g. from a host's own integration) deliberately does NOT set this.
    pub fn feed(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<PositionedOscEvent>, Option<usize>) {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);

        let mut visible: Vec<u8> = Vec::with_capacity(buf.len());
        let mut events: Vec<PositionedOscEvent> = Vec::new();
        // Offset (into `visible`) just before OUR Ready sentinel, once seen.
        let mut ready_offset: Option<usize> = None;
        let mut i = 0;

        while i < buf.len() {
            // Look for the OSC introducer ESC ] = \x1b]
            if buf[i] == 0x1b {
                if i + 1 >= buf.len() {
                    // Trailing lone ESC — could be the start of a split ESC].
                    // Stash from here in pending and stop.
                    self.pending.extend_from_slice(&buf[i..]);
                    return self.finish(visible, events, ready_offset);
                }
                if buf[i + 1] == b']' {
                    // OSC start. Search for a terminator from i+2.
                    let payload_start = i + 2;
                    match find_terminator(&buf[payload_start..]) {
                        None => {
                            // Incomplete OSC -> buffer the rest in pending.
                            self.pending.extend_from_slice(&buf[i..]);
                            return self.finish(visible, events, ready_offset);
                        }
                        Some((rel_term_start, term_len)) => {
                            let term_start = payload_start + rel_term_start;
                            let payload = &buf[payload_start..term_start];
                            let seq_end = term_start + term_len; // exclusive
                            if payload.starts_with(b"633;") || payload.starts_with(b"133;") {
                                // Parse + strip (do not add to visible).
                                let evs = self.parse_payload(payload);
                                // Record the visible offset of OUR Ready sentinel.
                                if ready_offset.is_none()
                                    && evs.iter().any(|e| *e == OscEvent::Ready)
                                {
                                    ready_offset = Some(visible.len());
                                }
                                events.extend(evs.into_iter().map(|event| PositionedOscEvent {
                                    event,
                                    visible_offset: visible.len(),
                                }));
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

        self.finish(visible, events, ready_offset)
    }

    /// Apply the defensive pending cap, then return.
    fn finish(
        &mut self,
        mut visible: Vec<u8>,
        events: Vec<PositionedOscEvent>,
        ready_offset: Option<usize>,
    ) -> (Vec<u8>, Vec<PositionedOscEvent>, Option<usize>) {
        if self.pending.len() > PENDING_CAP {
            // No terminator within a reasonable window — flush as visible and reset.
            visible.append(&mut self.pending);
            self.pending.clear();
        }
        (visible, events, ready_offset)
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
    fn has(events: &[PositionedOscEvent], expected: &OscEvent) -> bool {
        events.iter().any(|event| &event.event == expected)
    }

    #[test] fn unescape_basic() {
        assert_eq!(unescape("ls\\x3b cat"), "ls; cat");
        assert_eq!(unescape("a\\\\b"), "a\\b");
        assert_eq!(unescape("x\\x0ay"), "x\ny");
    }
    #[test] fn extracts_command_and_exit_and_strips() {
        let mut sc = Scanner::new("N");
        let input = b"\x1b]633;E;ls\\x3b cat;N\x07\x1b]633;C;N\x07hello\r\n\x1b]633;D;0;N\x07$ ";
        let (vis, ev, _) = sc.feed(input);
        assert_eq!(s(&vis), "hello\r\n$ ");
        assert!(has(&ev, &OscEvent::CommandLine("ls; cat".into())));
        assert!(has(&ev, &OscEvent::ExecStart));
        assert!(has(&ev, &OscEvent::ExecEnd(Some(0))));
    }
    #[test] fn rejects_wrong_nonce() {
        let mut sc = Scanner::new("GOOD");
        let (_v, ev, _) = sc.feed(b"\x1b]633;E;whoami;BAD\x07");
        assert!(!ev.iter().any(|e| matches!(&e.event, OscEvent::CommandLine(_))));
    }
    #[test] fn buffers_split_sequence() {
        let mut sc = Scanner::new("N");
        let (v1, e1, _) = sc.feed(b"out\x1b]633;D;1");
        assert_eq!(s(&v1), "out"); assert!(e1.is_empty());
        let (v2, e2, _) = sc.feed(b"3;N\x07more");
        assert_eq!(s(&v2), "more");
        assert!(has(&e2, &OscEvent::ExecEnd(Some(13))));
    }
    #[test] fn passes_through_other_osc() {
        let mut sc = Scanner::new("N");
        let (v, _e, _) = sc.feed(b"\x1b]0;my title\x07X");
        assert_eq!(s(&v), "\x1b]0;my title\x07X");
    }
    #[test] fn ignores_ungated_lifecycle_markers() {
        let mut sc = Scanner::new("N");
        let (_v, ev, _) = sc.feed(b"\x1b]133;C\x07\x1b]133;D;2\x07\x1b]633;C;BAD\x07\x1b]633;D;0;BAD\x07");
        assert!(!ev.iter().any(|event| matches!(&event.event, OscEvent::ExecStart | OscEvent::ExecEnd(_))));
    }
    #[test] fn input_start_event_and_stripped() {
        let mut sc = Scanner::new("N");
        // 633;B (prompt end / input start) must emit InputStart and be stripped.
        let (vis, ev, _) = sc.feed(b"$ \x1b]633;B\x07");
        assert_eq!(s(&vis), "$ ");
        assert!(has(&ev, &OscEvent::InputStart));
        // 633;A (prompt start) must NOT emit an event but is still stripped.
        let (vis2, ev2, _) = sc.feed(b"\x1b]633;A\x07x");
        assert_eq!(s(&vis2), "x");
        assert!(!ev2.iter().any(|e| matches!(&e.event, OscEvent::InputStart)));
    }
    #[test] fn cwd_event() {
        let mut sc = Scanner::new("N");
        let (_v, ev, _) = sc.feed(b"\x1b]633;P;Cwd=/home/u\x07");
        assert!(has(&ev, &OscEvent::Cwd("/home/u".into())));
    }
    #[test] fn st_terminator_supported() {
        let mut sc = Scanner::new("N");
        // ST terminator (ESC \) instead of BEL
        let (vis, ev, _) = sc.feed(b"\x1b]633;C;N\x1b\\done");
        assert_eq!(s(&vis), "done");
        assert!(has(&ev, &OscEvent::ExecStart));
    }
    #[test] fn ready_sentinel_emits_event_and_is_nonce_gated() {
        let mut sc = Scanner::new("GOOD");
        // Correct nonce -> Ready event, stripped from visible.
        let (vis, ev, _) = sc.feed(b"x\x1b]633;P;CatioReady=GOOD\x07");
        assert_eq!(s(&vis), "x");
        assert!(has(&ev, &OscEvent::Ready));
        // Wrong nonce -> NO Ready (a host's own integration can't spoof it).
        let mut sc2 = Scanner::new("GOOD");
        let (_v, ev2, off2) = sc2.feed(b"\x1b]633;P;CatioReady=BAD\x07");
        assert!(!has(&ev2, &OscEvent::Ready));
        assert_eq!(off2, None);
    }
    #[test] fn ready_offset_splits_pre_integration_noise() {
        // The batch carrying our Ready sentinel may also carry the echoed bootstrap
        // line (and a host's own 633 marker) before it. `ready_offset` must point
        // just past that noise so callers drop it and keep only the clean prompt.
        let mut sc = Scanner::new("N");
        // Pre-existing host integration marker (633;A) must NOT set the offset;
        // only OUR nonce-gated sentinel does.
        let (vis, _ev, off) = sc.feed(
            b"\x1b]633;A\x07host-prompt$ __c='blob'\r\n\x1b]633;P;CatioReady=N\x07user@host:~$ ",
        );
        assert_eq!(s(&vis), "host-prompt$ __c='blob'\r\nuser@host:~$ ");
        assert_eq!(off, Some("host-prompt$ __c='blob'\r\n".len()));
        assert_eq!(s(&vis[off.unwrap()..]), "user@host:~$ ");
    }
    #[test] fn ready_offset_none_without_sentinel() {
        let mut sc = Scanner::new("N");
        // Plain output and even a generic 633 marker leave ready_offset None.
        let (_v, _e, off) = sc.feed(b"plain\x1b]633;A\x07more");
        assert_eq!(off, None);
    }

    #[test]
    fn lifecycle_events_keep_their_visible_offsets() {
        let mut sc = Scanner::new("N");
        let (visible, events, _) = sc.feed(
            b"prompt\x1b]633;E;echo hi;N\x07\x1b]633;C;N\x07out\x1b]633;D;0;N\x07next",
        );
        assert_eq!(s(&visible), "promptoutnext");
        assert_eq!(
            events,
            vec![
                PositionedOscEvent { event: OscEvent::CommandLine("echo hi".into()), visible_offset: 6 },
                PositionedOscEvent { event: OscEvent::ExecStart, visible_offset: 6 },
                PositionedOscEvent { event: OscEvent::ExecEnd(Some(0)), visible_offset: 9 },
            ],
        );
    }
}
