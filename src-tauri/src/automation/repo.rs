//! AutomationStore — JSON persistence + owner isolation for tasks / skills /
//! MCP connections. Mirrors `db/history.rs`: pure `&Path` dir, unit-testable
//! with a temp dir, best-effort reads (missing/unparseable file → empty).

use super::types::{AutomationError, McpConnection, ScheduledTask, Skill};
use crate::agent::ApiCredential;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const TASKS_FILE: &str = "tasks.json";
const SKILLS_FILE: &str = "skills.json";
const MCPS_FILE: &str = "mcps.json";

/// In-memory store. Reads are synchronous and cheap; the whole store is guarded
/// by one write lock, consistent with the small scale of this data.
pub struct AutomationStore {
    dir: PathBuf,
    inner: RwLock<StoreInner>,
}

#[derive(Default)]
struct StoreInner {
    tasks: Vec<ScheduledTask>,
    skills: Vec<Skill>,
    mcps: Vec<McpConnection>,
    /// MCP credentials, session-only (never serialized). Keyed by mcp id.
    mcp_creds: HashMap<String, ApiCredential>,
}

/// Disk shape — credential intentionally absent.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskShape {
    tasks: Vec<ScheduledTask>,
    skills: Vec<Skill>,
    mcps: Vec<McpConnection>,
}

impl AutomationStore {
    /// Opens (or creates on first write) a store rooted at `dir`.
    pub fn open(dir: &Path) -> Self {
        let disk = load_shape(dir);
        Self {
            dir: dir.to_path_buf(),
            inner: RwLock::new(StoreInner {
                tasks: disk.tasks,
                skills: disk.skills,
                mcps: disk.mcps,
                mcp_creds: HashMap::new(),
            }),
        }
    }

    // ---- tasks ----

    pub fn list_tasks(&self, owner: &str) -> Vec<ScheduledTask> {
        self.inner
            .read()
            .tasks
            .iter()
            .filter(|t| t.owner_id == owner)
            .cloned()
            .collect()
    }

    pub fn upsert_task(&self, task: &ScheduledTask) -> Result<(), AutomationError> {
        task.validate()?;
        let mut g = self.inner.write();
        if let Some(existing) = g.tasks.iter_mut().find(|t| t.id == task.id) {
            *existing = task.clone();
        } else {
            g.tasks.push(task.clone());
        }
        self.save_locked(&g)
    }

    pub fn delete_task(&self, owner: &str, id: &str) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let pos = g
            .tasks
            .iter()
            .position(|t| t.id == id && t.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        g.tasks.remove(pos);
        self.save_locked(&g)
    }

    pub fn set_task_enabled(
        &self,
        owner: &str,
        id: &str,
        enabled: bool,
    ) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let task = g
            .tasks
            .iter_mut()
            .find(|t| t.id == id && t.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        task.enabled = enabled;
        self.save_locked(&g)
    }

    // ---- skills ----

    pub fn list_skills(&self, owner: &str) -> Vec<Skill> {
        self.inner
            .read()
            .skills
            .iter()
            .filter(|s| s.owner_id == owner)
            .cloned()
            .collect()
    }

    pub fn upsert_skill(&self, skill: &Skill) -> Result<(), AutomationError> {
        if skill.name.trim().is_empty() {
            return Err(AutomationError::Invalid("skill name is required".into()));
        }
        if skill.prompt_template.trim().is_empty() {
            return Err(AutomationError::Invalid(
                "skill prompt_template is required".into(),
            ));
        }
        if skill.scope == super::types::SkillScope::Target
            && skill.target_ref.as_deref().unwrap_or("").is_empty()
        {
            return Err(AutomationError::Invalid(
                "target-scoped skill requires target_ref".into(),
            ));
        }
        let mut g = self.inner.write();
        if let Some(existing) = g.skills.iter_mut().find(|s| s.id == skill.id) {
            *existing = skill.clone();
        } else {
            g.skills.push(skill.clone());
        }
        self.save_locked(&g)
    }

    pub fn delete_skill(&self, owner: &str, id: &str) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let pos = g
            .skills
            .iter()
            .position(|s| s.id == id && s.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        g.skills.remove(pos);
        self.save_locked(&g)
    }

    pub fn set_skill_enabled(
        &self,
        owner: &str,
        id: &str,
        enabled: bool,
    ) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let skill = g
            .skills
            .iter_mut()
            .find(|s| s.id == id && s.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        skill.enabled = enabled;
        self.save_locked(&g)
    }

    // ---- MCP connections ----

    pub fn list_mcps(&self, owner: &str) -> Vec<McpConnection> {
        self.inner
            .read()
            .mcps
            .iter()
            .filter(|m| m.owner_id == owner)
            .cloned()
            .collect()
    }

    pub fn upsert_mcp(&self, mcp: &McpConnection) -> Result<(), AutomationError> {
        if mcp.name.trim().is_empty() {
            return Err(AutomationError::Invalid("mcp name is required".into()));
        }
        if mcp.url.trim().is_empty() {
            return Err(AutomationError::Invalid("mcp url is required".into()));
        }
        let mut g = self.inner.write();
        if let Some(existing) = g.mcps.iter_mut().find(|m| m.id == mcp.id) {
            *existing = mcp.clone();
        } else {
            g.mcps.push(mcp.clone());
        }
        // Retain any session credential the caller provided.
        if !mcp.credential.expose().is_empty() {
            g.mcp_creds.insert(mcp.id.clone(), mcp.credential.clone());
        }
        self.save_locked(&g)
    }

    pub fn delete_mcp(&self, owner: &str, id: &str) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        let pos = g
            .mcps
            .iter()
            .position(|m| m.id == id && m.owner_id == owner)
            .ok_or_else(|| AutomationError::NotFound(id.into()))?;
        g.mcps.remove(pos);
        g.mcp_creds.remove(id);
        self.save_locked(&g)
    }

    /// Session-only credential for an MCP connection. Returns `None` if the
    /// owner never supplied one this session (or the connection is unknown).
    pub fn mcp_credential(&self, owner: &str, id: &str) -> Option<ApiCredential> {
        let g = self.inner.read();
        let owned = g.mcps.iter().any(|m| m.id == id && m.owner_id == owner);
        if !owned {
            return None;
        }
        g.mcp_creds.get(id).cloned()
    }

    /// Sets the session credential for a connection. Never persisted.
    pub fn set_mcp_credential(
        &self,
        owner: &str,
        id: &str,
        credential: ApiCredential,
    ) -> Result<(), AutomationError> {
        let mut g = self.inner.write();
        if !g.mcps.iter().any(|m| m.id == id && m.owner_id == owner) {
            return Err(AutomationError::NotFound(id.into()));
        }
        g.mcp_creds.insert(id.into(), credential);
        Ok(())
    }

    // ---- persistence ----

    fn save_locked(&self, g: &StoreInner) -> Result<(), AutomationError> {
        let shape = DiskShape {
            tasks: g.tasks.clone(),
            skills: g.skills.clone(),
            mcps: g.mcps.clone(),
        };
        write_json(&self.dir, &self.dir.join(TASKS_FILE), &shape.tasks).map_err(to_storage)?;
        write_json(&self.dir, &self.dir.join(SKILLS_FILE), &shape.skills).map_err(to_storage)?;
        write_json(&self.dir, &self.dir.join(MCPS_FILE), &shape.mcps).map_err(to_storage)?;
        Ok(())
    }
}

fn to_storage(e: std::io::Error) -> AutomationError {
    AutomationError::Storage(e.to_string())
}

fn load_shape(dir: &Path) -> DiskShape {
    DiskShape {
        tasks: read_json(&dir.join(TASKS_FILE)),
        skills: read_json(&dir.join(SKILLS_FILE)),
        mcps: read_json(&dir.join(MCPS_FILE)),
    }
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
