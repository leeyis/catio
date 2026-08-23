// Frontend bridge to the automation workbench (scheduled tasks / skills / MCP
// connections / prompt history). Desktop-only for now — the server head wires
// the same store behind authenticated dispatch.
import { isTauri } from './ssh'

// ---- Mock data (browser/dev only): lets the panels render fully outside the
// Tauri shell so the UI can be visually verified. Never hits the backend. ----

const MOCK_TASKS: ScheduledTask[] = [
  { id: 't1', name: '每日数据库备份巡检', trigger: { type: 'cron', expr: '0 2 * * *' }, kind: 'shell', script: 'pg_dump -Fc prod > /backup/prod.dump', targetRef: 'postgres-prod', skillIds: [], mcpIds: [], policy: 'reject', whitelist: [], enabled: true, autoConfirmed: false, ownerId: 'local' },
  { id: 't2', name: '磁盘空间告警检查', trigger: { type: 'interval', seconds: 1800 }, kind: 'prompt', prompt: '检查磁盘空间，超过 80% 时汇总最大文件并给出清理建议', targetRef: 'web-01', skillIds: ['s1'], mcpIds: ['m1'], policy: 'reject', whitelist: [], enabled: true, autoConfirmed: false, ownerId: 'local' },
  { id: 't3', name: 'Nginx 日志错误分析', trigger: { type: 'once', at: '2026-08-23T22:30:00Z' }, kind: 'prompt', prompt: '分析今天的 Nginx 5xx 错误', targetRef: 'nginx-02', skillIds: ['s2'], mcpIds: ['m1', 'm2'], policy: 'auto', whitelist: [], enabled: false, autoConfirmed: true, ownerId: 'local' },
  { id: 't4', name: 'SSL 证书到期提醒', trigger: { type: 'cron', expr: '0 9 * * 1' }, kind: 'shell', script: 'check-ssl --days 14', targetRef: 'all-hosts', skillIds: [], mcpIds: [], policy: 'reject', whitelist: [], enabled: true, autoConfirmed: false, ownerId: 'local' },
]

const MOCK_SKILLS: Skill[] = [
  { id: 's1', name: '数据库巡检', scope: 'global', promptTemplate: '检查目标数据库的健康状态，包含连接、慢查询与容量，输出摘要。', riskPolicy: 'readonly', source: { type: 'import' }, version: 3, enabled: true, ownerId: 'local' },
  { id: 's2', name: 'Nginx 故障排查', scope: 'target', targetRef: 'nginx-02', promptTemplate: '检查 Nginx 错误日志、5xx 统计与 upstream 状态，定位根因。', riskPolicy: 'readonlyPreferred', source: { type: 'url', url: 'https://skills.example/nginx.json' }, version: 1, enabled: true, ownerId: 'local' },
  { id: 's3', name: '应用滚动部署', scope: 'global', promptTemplate: '按灰度比例执行滚动部署，失败自动回滚。', riskPolicy: 'confirmedWrite', source: { type: 'url', url: 'https://skills.example/deploy.json' }, version: 2, enabled: true, ownerId: 'local' },
  { id: 's4', name: '慢查询定位', scope: 'global', promptTemplate: '定位慢查询并给出索引优化建议。', riskPolicy: 'readonly', source: { type: 'import' }, version: 1, enabled: false, ownerId: 'local' },
]

const MOCK_MCPS: McpConnection[] = [
  { id: 'm1', name: 'Filesystem', transport: 'http', url: 'http://127.0.0.1:8080/mcp', auth: 'none', credential: '', toolAllowlist: [], status: 'connected', discoveredTools: ['read_file', 'write_file', 'list_directory', 'search_files', 'get_file_info', 'move_file', 'delete_file', 'create_directory'], ownerId: 'local' },
  { id: 'm2', name: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp', auth: 'bearer', credential: '', toolAllowlist: [], status: 'connected', discoveredTools: ['create_issue', 'list_issues', 'get_pull_request', 'list_repos'], ownerId: 'local' },
  { id: 'm3', name: 'Kubernetes', transport: 'http', url: 'https://k8s.internal/mcp', auth: 'header', credential: '', toolAllowlist: [], status: 'error', discoveredTools: [], ownerId: 'local' },
]

const MOCK_PROMPT_HISTORY: PromptHistoryEntry[] = [
  { id: 'ph1', kind: 'prompt', source: 'task', turnId: 'turn-1', target: 'web-01', text: '磁盘空间告警检查', outcome: 'completed', when: '2026-08-23T16:30:00Z', dur: '3.2s', ownerId: 'local' },
  { id: 'ph2', kind: 'prompt', source: 'chat', turnId: 'turn-2', target: 'nginx-02', text: '分析今天的 Nginx 5xx 错误', outcome: 'failed', when: '2026-08-23T15:00:00Z', dur: '1.1s', ownerId: 'local' },
  { id: 'ph3', kind: 'prompt', source: 'task', turnId: 'turn-3', target: 'postgres-prod', text: '每日数据库备份巡检', outcome: 'completed', when: '2026-08-23T02:00:00Z', dur: '34s', ownerId: 'local' },
]

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
  if (!isTauri()) return MOCK_TASKS
  return tauriInvoke<ScheduledTask[]>('automation_list_tasks')
}

export async function automationCreateTask(task: Omit<ScheduledTask, 'ownerId'>): Promise<string> {
  if (!isTauri()) return `task ${task.id} saved (mock)`
  return tauriInvoke<string>('automation_create_task', { task })
}

export async function automationDeleteTask(id: string): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke<void>('automation_delete_task', { id })
}

export async function automationSetTaskEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke<void>('automation_set_task_enabled', { id, enabled })
}

// ---- skills ----

export async function automationListSkills(): Promise<Skill[]> {
  if (!isTauri()) return MOCK_SKILLS
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
  if (!isTauri()) return MOCK_MCPS
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
  if (!isTauri()) return MOCK_PROMPT_HISTORY
  return tauriInvoke<PromptHistoryEntry[]>('automation_list_prompt_history')
}

export async function automationClearPromptHistory(): Promise<void> {
  return tauriInvoke<void>('automation_clear_prompt_history')
}

export async function automationDeletePromptHistory(id: string): Promise<void> {
  return tauriInvoke<void>('automation_delete_prompt_history', { id })
}

// ---- task run results + provider (prompt tasks) ----

const MOCK_RESULTS: TaskRunInfo[] = [
  { taskId: 't1', status: 'success', summary: '34s', at: '2026-08-23T02:00:00Z' },
  { taskId: 't2', status: 'failed', summary: '敏感命令被拒', at: '2026-08-23T16:30:00Z' },
  { taskId: 't4', status: 'success', summary: '12s', at: '2026-08-23T09:00:00Z' },
]

export async function automationTaskResults(): Promise<TaskRunInfo[]> {
  if (!isTauri()) return MOCK_RESULTS
  return tauriInvoke<TaskRunInfo[]>('automation_task_results')
}

/** Report the currently-active connection so natural-language task creation
 *  defaults its target to it. Empty clears the default. */
export async function automationSetActiveTarget(target: string): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke<void>('automation_set_active_target', { target })
}

/** Scheduler last-tick time (null if the loop isn't running). */
export async function automationSchedulerHeartbeat(): Promise<string | null> {
  if (!isTauri()) return new Date().toISOString()
  return tauriInvoke<string | null>('automation_scheduler_heartbeat')
}

export async function automationSetProvider(
  protocol: ProviderProtocol,
  baseUrl: string,
  model: string,
  anthropicAuthMode: AnthropicAuthMode,
  credential: string,
): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke<void>('automation_set_provider', {
    protocol,
    baseUrl,
    model,
    anthropicAuthMode,
    credential,
  })
}
