//! Skill acquisition and template rendering.
//!
//! P0 supports two acquisition paths: importing a local skill pack (JSON) and
//! installing from a URL the user typed. A skill pack is a small JSON document:
//!
//! ```json
//! { "name": "数据库巡检", "promptTemplate": "检查 {{db}} 的健康状态", "riskPolicy": "readonly" }
//! ```
//!
//! `riskPolicy` defaults to `readonly`. Placeholders like `{{host}}` / `{{db}}`
//! are substituted at render time with the turn's target context.

use super::types::{AutomationError, Skill, SkillRisk, SkillScope, SkillSource};
use rand::RngExt as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The parsed, transport-neutral body of a skill pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImport {
    pub name: String,
    pub prompt_template: String,
    #[serde(default = "default_risk")]
    pub risk_policy: SkillRisk,
}

fn default_risk() -> SkillRisk {
    SkillRisk::Readonly
}

/// Parse a JSON skill pack. Rejects packs without a name or template.
pub fn parse_skill_json(bytes: &[u8]) -> Result<SkillImport, AutomationError> {
    let imp: SkillImport = serde_json::from_slice(bytes)
        .map_err(|e| AutomationError::Invalid(format!("invalid skill JSON: {e}")))?;
    if imp.name.trim().is_empty() {
        return Err(AutomationError::Invalid("skill name is required".into()));
    }
    if imp.prompt_template.trim().is_empty() {
        return Err(AutomationError::Invalid(
            "skill prompt_template is required".into(),
        ));
    }
    Ok(imp)
}

/// Substitute `{{key}}` placeholders from `ctx`. Unknown placeholders are left
/// untouched so callers can surface them (or let the model handle them).
pub fn render_template(template: &str, ctx: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (key, value) in ctx {
        out = out.replace(&format!("{{{{{key}}}}}"), value);
    }
    out
}

/// Build a new `Skill` (version 1, enabled) from an imported pack.
pub fn new_skill_from_import(
    imp: &SkillImport,
    scope: SkillScope,
    target_ref: Option<String>,
    source: SkillSource,
    owner_id: &str,
) -> Skill {
    Skill {
        id: format!("skill-{}", rand::rng().random::<u64>()),
        name: imp.name.clone(),
        scope,
        target_ref,
        prompt_template: imp.prompt_template.clone(),
        risk_policy: imp.risk_policy.clone(),
        source,
        version: 1,
        enabled: true,
        owner_id: owner_id.to_string(),
    }
}

/// Download a skill pack from `url` and build a `Skill`. P0 treats HTTP 4xx/5xx
/// and unparseable bodies as failures (no silent fallback).
pub async fn install_skill(
    http: &reqwest::Client,
    url: &str,
    scope: SkillScope,
    target_ref: Option<String>,
    owner_id: &str,
) -> Result<Skill, AutomationError> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| AutomationError::Network(e.to_string()))?;
    if resp.status().is_client_error() || resp.status().is_server_error() {
        return Err(AutomationError::Network(format!(
            "skill download failed: {}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AutomationError::Network(e.to_string()))?
        .to_vec();
    let imp = parse_skill_json(&bytes)?;
    Ok(new_skill_from_import(
        &imp,
        scope,
        target_ref,
        SkillSource::Url {
            url: url.to_string(),
        },
        owner_id,
    ))
}
