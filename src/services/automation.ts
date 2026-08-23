// Frontend bridge to the automation workbench (scheduled tasks / skills / MCP
// connections / prompt history). Desktop-only for now — the server head wires
// the same store behind authenticated dispatch.
import { isTauri } from './ssh'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ---- shared wire types (camelCase, mirror the Rust side) ----

export type TaskTrigger =
  | { type: 'cron'; expr: string }
  | { type: 'interval'; seconds: number }
  | { type: 'once'; at: string }
export type TaskKind = 'shell' | 'prompt'
export type TaskPolicy = 'reject' | 'whitelist' | 'auto'

export interface ScheduledTask {
  id: string
  name: string
  trigger: TaskTrigger
  kind: TaskKind
  script?: string
  prompt?: string
  targetRef?: string
  skillIds: string[]
  mcpIds: string[]
  policy: TaskPolicy
  whitelist: string[]
  enabled: boolean
  autoConfirmed: boolean
  ownerId: string
}

export type SkillScope = 'global' | 'target'
export type SkillRisk = 'readonly' | 'readonlyPreferred' | 'confirmedWrite'
export type SkillSource = { type: 'import' } | { type: 'url'; url: string }

export interface Skill {
  id: string
  name: string
  scope: SkillScope
  targetRef?: string
  promptTemplate: string
  riskPolicy: SkillRisk
  source: SkillSource
  version: number
  enabled: boolean
  ownerId: string
}

export type McpTransport = 'http'
export type McpAuth = 'none' | 'bearer' | 'header'
export type McpStatus = 'disconnected' | 'connected' | 'error'

export interface McpConnection {
  id: string
  name: string
  transport: McpTransport
  url: string
  auth: McpAuth
  credential: string // session-only; never persisted
  toolAllowlist: string[]
  status: McpStatus
  discoveredTools: string[]
  ownerId: string
}

export type PromptSource = 'task' | 'chat'
export type PromptOutcome = 'completed' | 'failed' | 'cancelled' | 'outcomeUnknown'

export type TaskRunStatus = 'success' | 'failed'
export interface TaskRunInfo {
  taskId: string
  status: TaskRunStatus
  summary: string
  at: string
}

export type ProviderProtocol = 'openai' | 'anthropic' | 'ollama'
export type AnthropicAuthMode = 'auto' | 'apiKey' | 'authToken'

export interface PromptHistoryEntry {
  id: string
  kind: 'prompt'
  source: PromptSource
  turnId: string
  target: string
  text: string
  outcome: PromptOutcome
  when: string
  dur: string
  ownerId: string
}

// ---- tasks ----

export async function automationListTasks(): Promise<ScheduledTask[]> {
  if (!isTauri()) return []
  return tauriInvoke<ScheduledTask[]>('automation_list_tasks')
}

export async function automationCreateTask(task: Omit<ScheduledTask, 'ownerId'>): Promise<string> {
  return tauriInvoke<string>('automation_create_task', { task })
}

export async function automationDeleteTask(id: string): Promise<void> {
  return tauriInvoke<void>('automation_delete_task', { id })
}

export async function automationSetTaskEnabled(id: string, enabled: boolean): Promise<void> {
  return tauriInvoke<void>('automation_set_task_enabled', { id, enabled })
}

// ---- skills ----

export async function automationListSkills(): Promise<Skill[]> {
  if (!isTauri()) return []
  return tauriInvoke<Skill[]>('automation_list_skills')
}

export async function automationImportSkill(
  body: string,
  scope: SkillScope,
  targetRef?: string,
): Promise<Skill> {
  return tauriInvoke<Skill>('automation_import_skill', { body, scope, targetRef })
}

export async function automationInstallSkill(
  url: string,
  scope: SkillScope,
  targetRef?: string,
): Promise<Skill> {
  return tauriInvoke<Skill>('automation_install_skill', { url, scope, targetRef })
}

export async function automationDeleteSkill(id: string): Promise<void> {
  return tauriInvoke<void>('automation_delete_skill', { id })
}

export async function automationSetSkillEnabled(id: string, enabled: boolean): Promise<void> {
  return tauriInvoke<void>('automation_set_skill_enabled', { id, enabled })
}

// ---- MCP connections ----

export async function automationListMcps(): Promise<McpConnection[]> {
  if (!isTauri()) return []
  return tauriInvoke<McpConnection[]>('automation_list_mcps')
}

export async function automationAddMcp(conn: Omit<McpConnection, 'ownerId'>): Promise<string> {
  return tauriInvoke<string>('automation_add_mcp', { conn })
}

export async function automationDeleteMcp(id: string): Promise<void> {
  return tauriInvoke<void>('automation_delete_mcp', { id })
}

export async function automationTestMcp(conn: McpConnection): Promise<string[]> {
  return tauriInvoke<string[]>('automation_test_mcp', { conn })
}

// ---- prompt history ----

export async function automationListPromptHistory(): Promise<PromptHistoryEntry[]> {
  if (!isTauri()) return []
  return tauriInvoke<PromptHistoryEntry[]>('automation_list_prompt_history')
}

export async function automationClearPromptHistory(): Promise<void> {
  return tauriInvoke<void>('automation_clear_prompt_history')
}

export async function automationDeletePromptHistory(id: string): Promise<void> {
  return tauriInvoke<void>('automation_delete_prompt_history', { id })
}

// ---- task run results + provider (prompt tasks) ----

export async function automationTaskResults(): Promise<TaskRunInfo[]> {
  if (!isTauri()) return []
  return tauriInvoke<TaskRunInfo[]>('automation_task_results')
}

export async function automationSetProvider(
  protocol: ProviderProtocol,
  baseUrl: string,
  model: string,
  anthropicAuthMode: AnthropicAuthMode,
  credential: string,
): Promise<void> {
  return tauriInvoke<void>('automation_set_provider', {
    protocol,
    baseUrl,
    model,
    anthropicAuthMode,
    credential,
  })
}
