//! Prompt execution history — one shared store for scheduled-prompt tasks
//! (`source: Task`) and in-app Agent chats (`source: Chat`), so the History
//! panel shows them as one `prompt` kind with a source discriminator.
//!
//! Mirrors `db/history.rs` (JSON in the app data dir, best-effort reads) and
//! `AutomationStore` (owner scoping inside the store).

use super::types::AutomationError;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_PROMPT_HISTORY: usize = 200;

const HISTORY_FILE: &str = "prompt_history.json";

/// Where a prompt-history row came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptSource {
    /// A scheduled prompt task fired by the scheduler.
    Task,
    /// A manual chat in the Agent panel.
    Chat,
}

/// Terminal outcome of a prompt turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptOutcome {
    Completed,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

/// One prompt-history row. Wire shape mirrors the frontend `HistoryItem`
/// conventions (camelCase) plus the prompt-specific `source`/`turnId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryEntry {
    pub id: String,
    pub kind: String, // always "prompt"
    pub source: PromptSource,
    pub turn_id: String,
    /// Target host/db the prompt ran against (or the connection name).
    pub target: String,
    /// A short summary of the prompt text.
    pub text: String,
    pub outcome: PromptOutcome,
    pub when: String,
    pub dur: String,
    pub owner_id: String,
}

/// Owner-scoped prompt history persisted as JSON. Session writes go through the
/// same locked in-memory list that `list` reads, so reads are always fresh.
pub struct PromptHistoryStore {
    dir: PathBuf,
    inner: RwLock<Vec<PromptHistoryEntry>>,
}

impl PromptHistoryStore {
    pub fn open(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            inner: RwLock::new(load(&dir.join(HISTORY_FILE))),
        }
    }

    pub fn list(&self, owner: &str) -> Vec<PromptHistoryEntry> {
        self.inner
            .read()
            .iter()
            .filter(|e| e.owner_id == owner)
            .cloned()
            .collect()
    }

    /// Prepend one entry (most-recent first), cap the store, persist.
    pub fn push(&self, entry: PromptHistoryEntry) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        g.insert(0, entry);
        if g.len() > MAX_PROMPT_HISTORY {
            g.truncate(MAX_PROMPT_HISTORY);
        }
        save(&self.dir, &self.dir.join(HISTORY_FILE), &g)?;
        Ok(())
    }

    pub fn delete(&self, owner: &str, id: &str) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let pos = g
            .iter()
            .position(|e| e.id == id && e.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        g.remove(pos);
        save(&self.dir, &self.dir.join(HISTORY_FILE), &g)?;
        Ok(())
    }

    pub fn clear(&self, owner: &str) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        g.retain(|e| e.owner_id != owner);
        save(&self.dir, &self.dir.join(HISTORY_FILE), &g)?;
        Ok(())
    }
}

fn load(path: &Path) -> Vec<PromptHistoryEntry> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(dir: &Path, path: &Path, entries: &[PromptHistoryEntry]) -> Result<(), AutomationError> {
    std::fs::create_dir_all(dir).map_err(|e| AutomationError::Storage(e.to_string()))?;
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| AutomationError::Storage(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| AutomationError::Storage(e.to_string()))
}
