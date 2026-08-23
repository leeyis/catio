//! Task 6 contract tests: scheduled prompt assembly from skills + target ctx.

use catio_lib::automation::prompt::build_user_prompt;
use catio_lib::automation::{
    ScheduledTask, Skill, SkillRisk, SkillScope, SkillSource, TaskKind, TaskPolicy, TaskTrigger,
};
use std::collections::HashMap;

fn task(prompt: &str) -> ScheduledTask {
    ScheduledTask {
        id: "t1".into(),
        name: "巡检".into(),
        trigger: TaskTrigger::Once {
            at: "2026-08-23T22:30:00Z".into(),
        },
        kind: TaskKind::Prompt,
        script: None,
        prompt: Some(prompt.into()),
        target_ref: Some("web-01".into()),
        skill_ids: vec!["s1".into()],
        mcp_ids: vec![],
        policy: TaskPolicy::Reject,
        whitelist: vec![],
        enabled: true,
        auto_confirmed: false,
        owner_id: "owner-a".into(),
    }
}

fn skill(name: &str, template: &str, enabled: bool) -> Skill {
    Skill {
        id: name.into(),
        name: name.into(),
        scope: SkillScope::Global,
        target_ref: None,
        prompt_template: template.into(),
        risk_policy: SkillRisk::Readonly,
        source: SkillSource::Import,
        version: 1,
        enabled,
        owner_id: "owner-a".into(),
    }
}

#[test]
fn no_skills_returns_task_prompt() {
    let t = task("检查磁盘空间");
    let out = build_user_prompt(&t, &[], &HashMap::new());
    assert_eq!(out, "检查磁盘空间");
}

#[test]
fn renders_skill_template_before_prompt() {
    let t = task("并给出结论");
    let skills = [skill("服务器巡检", "检查 {{host}} 的 CPU 与磁盘", true)];
    let mut ctx = HashMap::new();
    ctx.insert("host".into(), "web-01".into());
    let out = build_user_prompt(&t, &skills, &ctx);
    assert_eq!(out, "检查 web-01 的 CPU 与磁盘\n\n并给出结论");
}

#[test]
fn multiple_skills_join_in_order() {
    let t = task("收尾");
    let skills = [skill("a", "甲", true), skill("b", "乙 {{db}}", true)];
    let mut ctx = HashMap::new();
    ctx.insert("db".into(), "postgres-prod".into());
    let out = build_user_prompt(&t, &skills, &ctx);
    assert_eq!(out, "甲\n\n乙 postgres-prod\n\n收尾");
}

#[test]
fn disabled_skills_are_excluded() {
    let t = task("正文");
    let skills = [skill("a", "不应出现", false), skill("b", "应出现", true)];
    let out = build_user_prompt(&t, &skills, &HashMap::new());
    assert!(!out.contains("不应出现"));
    assert!(out.contains("应出现"));
    assert!(out.contains("正文"));
}

#[test]
fn blank_prompt_still_carries_skill_instructions() {
    let t = task("");
    let skills = [skill("a", "指令", true)];
    let out = build_user_prompt(&t, &skills, &HashMap::new());
    assert_eq!(out, "指令");
}
