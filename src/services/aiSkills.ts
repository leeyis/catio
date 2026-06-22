/**
 * Catio Agent 技能集。纯数据 + 纯函数,单测覆盖。
 *
 * 参考 dbx-ref/apps/desktop/src/lib/aiSkills.ts。在 agentPrompt 的 sql/shell 两种
 * 基础模式之上,提供一组可复用的 SQL 技能(generate / explain / optimize / fix /
 * convert / sampleData):每个技能带本地化标题、用户指令、风险策略与上下文需求。
 * 基础模式不退化——技能只是在用户消息里追加一段结构化指令,系统提示仍由
 * buildAgentSystemPrompt 决定。
 */

export type AiSkillAction = 'generate' | 'explain' | 'optimize' | 'fix' | 'convert' | 'sampleData'
export type AiSkillRiskPolicy = 'readonly' | 'readonly_preferred' | 'confirmed_write' | 'sample_write'
export type AiSkillContextNeed =
  | 'currentSql'
  | 'schema'
  | 'indexes'
  | 'foreignKeys'
  | 'lastError'
  | 'lastResultPreview'
  | 'databaseDialect'

export type SkillLang = 'en' | 'zh'

export interface LocalizedText {
  en: string
  zh: string
}

export interface AiSkillDefinition {
  id: string
  action: AiSkillAction
  title: LocalizedText
  riskPolicy: AiSkillRiskPolicy
  contextNeeds: AiSkillContextNeed[]
  userInstruction: LocalizedText
}

export const AI_SKILLS: AiSkillDefinition[] = [
  {
    id: 'generate_sql',
    action: 'generate',
    title: { en: 'Generate SQL', zh: '生成 SQL' },
    riskPolicy: 'readonly_preferred',
    contextNeeds: ['schema', 'indexes', 'foreignKeys', 'databaseDialect'],
    userInstruction: {
      en: 'Generate a SQL query that satisfies the request. Return the SQL in a ```sql code block first, then at most 3 short notes. Use foreign-key relationships from the schema to infer correct JOIN conditions. If required information is missing, ask one clarifying question first.',
      zh: '根据请求生成 SQL。先在 ```sql 代码块中返回 SQL,然后最多 3 条简短说明。利用 Schema 中的外键关系推断正确的 JOIN 条件。信息不足时先提出一个澄清问题。',
    },
  },
  {
    id: 'explain_sql',
    action: 'explain',
    title: { en: 'Explain SQL', zh: '解释 SQL' },
    riskPolicy: 'readonly',
    contextNeeds: ['currentSql', 'schema', 'indexes', 'foreignKeys', 'lastResultPreview'],
    userInstruction: {
      en: 'Explain the current SQL step by step without changing it. Summarize its purpose first, then execution logic, risky operations, implicit assumptions, and potential performance issues.',
      zh: '逐步解释当前 SQL,不要改写它。先概括目的,再说明执行逻辑、危险操作、隐含假设和潜在性能问题。',
    },
  },
  {
    id: 'optimize_sql',
    action: 'optimize',
    title: { en: 'Optimize SQL', zh: '优化 SQL' },
    riskPolicy: 'readonly',
    contextNeeds: ['currentSql', 'schema', 'indexes', 'foreignKeys'],
    userInstruction: {
      en: 'Rewrite or suggest improvements for the current SQL. Return the improved SQL in a ```sql code block first, then explain the key changes in at most 3 notes. Use the index information in the schema to suggest index-aware optimizations (avoid full table scans, leverage existing indexes).',
      zh: '重写或优化当前 SQL。先在 ```sql 代码块中返回优化后的 SQL,再用最多 3 条说明解释关键改动。利用 Schema 中的索引信息建议索引友好的优化(避免全表扫描、利用现有索引)。',
    },
  },
  {
    id: 'fix_sql',
    action: 'fix',
    title: { en: 'Fix SQL', zh: '修复 SQL' },
    riskPolicy: 'readonly_preferred',
    contextNeeds: ['currentSql', 'schema', 'lastError', 'lastResultPreview', 'databaseDialect'],
    userInstruction: {
      en: 'Fix the current SQL using the provided error message and result context. Return the corrected SQL in a ```sql code block first, then briefly explain the root cause and the change.',
      zh: '根据报错信息和结果上下文修复当前 SQL。先在 ```sql 代码块中返回修正后的 SQL,再简要说明根因和改动。',
    },
  },
  {
    id: 'convert_sql',
    action: 'convert',
    title: { en: 'Convert SQL Dialect', zh: '转换 SQL 方言' },
    riskPolicy: 'readonly_preferred',
    contextNeeds: ['currentSql', 'schema', 'databaseDialect'],
    userInstruction: {
      en: 'Convert the current SQL to the target dialect requested by the user. Return the converted SQL in a ```sql code block first, then note important target-dialect syntax differences or incompatibilities. Preserve the query intent.',
      zh: '将当前 SQL 转换为用户指定的目标方言。先在 ```sql 代码块中返回转换后的 SQL,再说明目标方言下的重要语法差异或不兼容点。保持查询意图。',
    },
  },
  {
    id: 'sample_data',
    action: 'sampleData',
    title: { en: 'Generate Sample Data', zh: '生成样例数据' },
    riskPolicy: 'sample_write',
    contextNeeds: ['schema', 'databaseDialect'],
    userInstruction: {
      en: 'Generate safe sample INSERT statements or mock data for the current schema. Do not use or imply real production data, credentials, personal data, or secrets. Return SQL in a ```sql code block, then note which values are mock data.',
      zh: '为当前 Schema 生成安全的示例 INSERT 语句或模拟数据。不要使用或暗示真实生产数据、凭据、个人数据或密钥。在 ```sql 代码块中返回 SQL,再说明哪些值是模拟数据。',
    },
  },
]

export function aiSkillById(id: string): AiSkillDefinition | undefined {
  return AI_SKILLS.find((s) => s.id === id)
}

export function aiSkillForAction(action: AiSkillAction): AiSkillDefinition | undefined {
  return AI_SKILLS.find((s) => s.action === action)
}

export function aiSkillTitle(id: string, lang: SkillLang): string {
  const skill = aiSkillById(id)
  if (!skill) return ''
  return lang === 'zh' ? skill.title.zh : skill.title.en
}

/**
 * 把技能指令与用户文本拼成可发送的用户消息。未知技能时回退为纯用户文本,
 * 这样调用方即使传错 id 也不会丢失用户输入。
 */
export function buildSkillUserInstruction(id: string, lang: SkillLang, userText: string): string {
  const skill = aiSkillById(id)
  if (!skill) return userText
  const instruction = lang === 'zh' ? skill.userInstruction.zh : skill.userInstruction.en
  const trimmed = userText.trim()
  return trimmed ? `${instruction}\n\n${trimmed}` : instruction
}
