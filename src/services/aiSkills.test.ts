import { describe, it, expect } from 'vitest'
import {
  AI_SKILLS,
  aiSkillById,
  aiSkillTitle,
  buildSkillUserInstruction,
} from './aiSkills'

describe('AI_SKILLS 技能集', () => {
  it('覆盖 generate/explain/optimize/fix/convert 五个核心技能', () => {
    const ids = AI_SKILLS.map((s) => s.id)
    for (const id of ['generate_sql', 'explain_sql', 'optimize_sql', 'fix_sql', 'convert_sql']) {
      expect(ids).toContain(id)
    }
  })

  it('每个技能都同时提供 en/zh 文案,不留空', () => {
    for (const skill of AI_SKILLS) {
      expect(skill.title.en.trim().length).toBeGreaterThan(0)
      expect(skill.title.zh.trim().length).toBeGreaterThan(0)
      expect(skill.userInstruction.en.trim().length).toBeGreaterThan(0)
      expect(skill.userInstruction.zh.trim().length).toBeGreaterThan(0)
    }
  })

  it('explain 技能为只读(readonly),不产生写操作', () => {
    expect(aiSkillById('explain_sql')?.riskPolicy).toBe('readonly')
    expect(aiSkillById('optimize_sql')?.riskPolicy).toBe('readonly')
  })

  it('generate 技能声明需要 schema 上下文', () => {
    expect(aiSkillById('generate_sql')?.contextNeeds).toContain('schema')
  })

  it('aiSkillById 命中返回定义,未命中返回 undefined', () => {
    expect(aiSkillById('generate_sql')?.id).toBe('generate_sql')
    expect(aiSkillById('nope')).toBeUndefined()
  })

  it('aiSkillTitle 按语言返回标题,缺省回退英文', () => {
    expect(aiSkillTitle('explain_sql', 'zh')).toBe(aiSkillById('explain_sql')!.title.zh)
    expect(aiSkillTitle('explain_sql', 'en')).toBe(aiSkillById('explain_sql')!.title.en)
    expect(aiSkillTitle('nope', 'zh')).toBe('')
  })

  it('buildSkillUserInstruction 把技能指令与用户文本拼成可发送内容', () => {
    const out = buildSkillUserInstruction('explain_sql', 'zh', 'SELECT 1')
    expect(out).toContain(aiSkillById('explain_sql')!.userInstruction.zh)
    expect(out).toContain('SELECT 1')
  })

  it('buildSkillUserInstruction 未知技能时回退为纯用户文本', () => {
    expect(buildSkillUserInstruction('nope', 'zh', 'hello')).toBe('hello')
  })
})
