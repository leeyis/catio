//! Task 8 contract tests: prompt history store (owner scoping, cap, source).

use catio_lib::automation::history::{
    PromptHistoryEntry, PromptHistoryStore, PromptOutcome, PromptSource,
};
use catio_lib::automation::AutomationError;

fn entry(owner: &str, id: &str, source: PromptSource) -> PromptHistoryEntry {
    PromptHistoryEntry {
        id: id.into(),
        kind: "prompt".into(),
        source,
        turn_id: format!("turn-{id}"),
        target: "web-01".into(),
        text: "检查磁盘空间".into(),
        outcome: PromptOutcome::Completed,
        when: "2026-08-23T10:00:00Z".into(),
        dur: "3s".into(),
        owner_id: owner.into(),
    }
}

fn store_in(dir: &std::path::Path) -> PromptHistoryStore {
    let _ = std::fs::remove_dir_all(dir);
    PromptHistoryStore::open(dir)
}

#[test]
fn round_trips_through_temp_dir() {
    let dir = std::env::temp_dir().join(format!("catio-ph-{}", std::process::id()));
    let store = store_in(&dir);
    assert!(store.list("owner-a").is_empty());

    store
        .push(entry("owner-a", "h1", PromptSource::Task))
        .unwrap();
    store
        .push(entry("owner-a", "h2", PromptSource::Chat))
        .unwrap();

    let back = store.list("owner-a");
    assert_eq!(back.len(), 2);
    // Most-recent first.
    assert_eq!(back[0].id, "h2");
    assert_eq!(back[0].source, PromptSource::Chat);
    assert_eq!(back[0].kind, "prompt");

    // Reload persists.
    let reopened = PromptHistoryStore::open(&dir);
    assert_eq!(reopened.list("owner-a").len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn filters_by_owner() {
    let dir = std::env::temp_dir().join(format!("catio-ph-o-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .push(entry("owner-a", "h1", PromptSource::Task))
        .unwrap();
    store
        .push(entry("owner-b", "h2", PromptSource::Chat))
        .unwrap();

    assert_eq!(store.list("owner-a").len(), 1);
    assert_eq!(store.list("owner-b").len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delete_and_clear_are_owner_scoped() {
    let dir = std::env::temp_dir().join(format!("catio-ph-d-{}", std::process::id()));
    let store = store_in(&dir);
    store
        .push(entry("owner-a", "h1", PromptSource::Task))
        .unwrap();
    store
        .push(entry("owner-a", "h2", PromptSource::Chat))
        .unwrap();
    store
        .push(entry("owner-b", "h3", PromptSource::Chat))
        .unwrap();

    // Wrong-owner delete fails.
    assert_eq!(
        store.delete("owner-b", "h1").unwrap_err(),
        AutomationError::NotFound("h1".into())
    );
    store.delete("owner-a", "h1").unwrap();
    assert_eq!(store.list("owner-a").len(), 1);

    store.clear("owner-a").unwrap();
    assert!(store.list("owner-a").is_empty());
    assert_eq!(store.list("owner-b").len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn caps_at_max_and_prepends() {
    let dir = std::env::temp_dir().join(format!("catio-ph-c-{}", std::process::id()));
    let store = store_in(&dir);
    for i in 0..(catio_lib::automation::history::MAX_PROMPT_HISTORY + 5) {
        store
            .push(entry("owner-a", &format!("h{i}"), PromptSource::Task))
            .unwrap();
    }
    let back = store.list("owner-a");
    assert_eq!(
        back.len(),
        catio_lib::automation::history::MAX_PROMPT_HISTORY
    );
    assert_eq!(back[0].id, "h204"); // newest
    let _ = std::fs::remove_dir_all(&dir);
}
