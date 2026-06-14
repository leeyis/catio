//! Query-execution history + saved SQL snippets, persisted as JSON in the app
//! data dir. Structures mirror the frontend `HistoryItem` / `Snippet` types
//! (camelCase via serde). File-read/write helpers take a `&Path` dir so they are
//! unit-testable with a temp directory (no Tauri AppHandle needed).
//!
//! Simplified from dbx crates/dbx-core/src/history.rs & saved_sql.rs (Apache-2.0).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One execution-history row. Mirrors the frontend `HistoryItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// 'sql' | 'shell' — DB engines always record 'sql'.
    pub kind: String,
    /// The connection id the query ran against.
    pub target: String,
    /// The SQL text.
    pub text: String,
    /// Human-ish timestamp string (set by the command layer).
    pub when: String,
    /// Elapsed time, e.g. "12ms".
    pub dur: String,
    /// Friendly connection name at record time (so closed connections still show
    /// a readable label instead of the internal `conn-N` id). Optional for
    /// backward compatibility with entries written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Database engine/dbType (e.g. "mysql", "mongodb") recorded at query time,
    /// used by the history panel to filter to the active tab's database type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Stable saved-profile id — survives reconnects and process restarts (unlike
    /// the ephemeral `target` connId), so history can be deleted alongside its
    /// connection profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// One saved SQL snippet. Mirrors the frontend `Snippet`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub id: String,
    pub scope: String,
    pub desc: String,
    pub icon: String,
    pub code: String,
}

/// Default cap on retained history entries.
pub const MAX_HISTORY: usize = 200;

const HISTORY_FILE: &str = "history.json";
const SNIPPETS_FILE: &str = "snippets.json";

/// Pure helper: prepend `item` (most-recent first) and truncate to the `cap`
/// most-recent entries. Unit-testable without files.
pub fn append_capped(
    mut list: Vec<HistoryEntry>,
    item: HistoryEntry,
    cap: usize,
) -> Vec<HistoryEntry> {
    list.insert(0, item);
    if list.len() > cap {
        list.truncate(cap);
    }
    list
}

fn history_path(dir: &Path) -> PathBuf {
    dir.join(HISTORY_FILE)
}

fn snippets_path(dir: &Path) -> PathBuf {
    dir.join(SNIPPETS_FILE)
}

/// Read `history.json` from `dir`. Returns an empty vec when missing or on parse
/// failure (history is best-effort — never fatal).
pub fn load_history(dir: &Path) -> Vec<HistoryEntry> {
    read_json(&history_path(dir))
}

/// Overwrite `history.json` in `dir` with `entries`.
pub fn save_history(dir: &Path, entries: &[HistoryEntry]) -> std::io::Result<()> {
    write_json(dir, &history_path(dir), entries)
}

/// Read `snippets.json` from `dir`. Empty vec when missing / unparseable.
pub fn load_snippets(dir: &Path) -> Vec<SnippetEntry> {
    read_json(&snippets_path(dir))
}

/// Overwrite `snippets.json` in `dir` with `entries`.
pub fn save_snippets(dir: &Path, entries: &[SnippetEntry]) -> std::io::Result<()> {
    write_json(dir, &snippets_path(dir), entries)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(dir: &Path, path: &Path, entries: &[T]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            kind: "sql".into(),
            target: "conn-1".into(),
            text: "SELECT 1".into(),
            when: "2026-06-07T00:00:00Z".into(),
            dur: "1ms".into(),
            name: None,
            engine: None,
            profile_id: None,
        }
    }

    #[test]
    fn append_capped_prepends_and_truncates_to_cap() {
        let mut list = vec![];
        for i in 0..5 {
            list = append_capped(list, entry(&format!("h-{i}")), 3);
        }
        // Most-recent first, capped at 3.
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, "h-4");
        assert_eq!(list[1].id, "h-3");
        assert_eq!(list[2].id, "h-2");
    }

    #[test]
    fn history_round_trips_through_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("catio-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Missing file → empty.
        assert!(load_history(&dir).is_empty());

        let entries = vec![entry("h-1"), entry("h-2")];
        save_history(&dir, &entries).unwrap();
        let back = load_history(&dir);
        assert_eq!(back, entries);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn snippets_round_trip_through_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("catio-snip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load_snippets(&dir).is_empty());

        let snips = vec![SnippetEntry {
            id: "s-1".into(),
            scope: "global".into(),
            desc: "count rows".into(),
            icon: "table".into(),
            code: "SELECT count(*) FROM t".into(),
        }];
        save_snippets(&dir, &snips).unwrap();
        assert_eq!(load_snippets(&dir), snips);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
