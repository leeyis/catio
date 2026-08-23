//! Prompt assembly for scheduled prompt tasks: renders the task's referenced
//! skills (with target placeholders) and prepends them to the task's own prompt
//! text. Pure — fully unit-testable.

use super::skill::render_template;
use super::types::{ScheduledTask, Skill};
use std::collections::HashMap;

/// Assemble the user-message prompt for a scheduled prompt task. Enabled skills
/// render their template against `ctx` (host/db placeholders) and are joined
/// before the task's own prompt. A blank/no prompt task still carries the
/// rendered skill instructions.
pub fn build_user_prompt(
    task: &ScheduledTask,
    skills: &[Skill],
    ctx: &HashMap<String, String>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for skill in skills {
        if skill.enabled {
            let rendered = render_template(&skill.prompt_template, ctx)
                .trim()
                .to_string();
            if !rendered.is_empty() {
                parts.push(rendered);
            }
        }
    }
    if let Some(prompt) = task
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        parts.push(prompt.to_string());
    }
    parts.join("\n\n")
}
