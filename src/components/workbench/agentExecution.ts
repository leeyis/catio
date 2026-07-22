import type { AgentExecutionMode } from '../../state/agentConfig'
import { isSensitiveCommand } from './sensitiveCommands'

export type AgentShellExecutionPlan =
  | { action: 'none' }
  | { action: 'repair'; reason: string }
  | { action: 'run' | 'confirm'; command: string }

export const MAX_AGENT_SHELL_STEPS = 8

const SHELL_LANGS = new Set(['sh', 'shell', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch'])
const CONTROL_SYNTAX = /[\r\n;&|<>`$(){}!^]/

// Semi-auto is intentionally narrow: arbitrary paths, environment reads and
// resource inspection can expose secrets that later enter the Agent context.
// Anything outside these exact host-status queries requires confirmation.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'whoami', 'id', 'uname', 'uname -a', 'hostname', 'date',
  'uptime', 'df', 'df -h', 'free', 'free -h', 'ps', 'ps aux', 'ps -ef',
  'nvidia-smi', 'lspci', 'lsusb', 'ipconfig', 'ipconfig /all', 'ifconfig',
  'netstat', 'netstat -ano', 'ss', 'ss -tulpn', 'tasklist', 'systeminfo', 'ver',
  'git status', 'git status --short', 'git status --porcelain',
  'docker ps', 'docker images', 'docker stats --no-stream', 'docker version',
  'docker info', 'kubectl version --client', 'systemctl list-units --no-pager',
  'systemctl is-system-running', 'ollama list', 'ollama ps',
  'get-location', 'get-process', 'get-service',
  'get-computerinfo', 'get-nettcpconnection', 'get-disk', 'get-volume',
  'get-psdrive', 'get-date', 'get-host',
])

export function firstShellCommand(markdown: string): string | null {
  const fences = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fences)) {
    const lang = match[1].trim().toLowerCase().split(/\s+/)[0]
    const command = match[2].trim()
    // Automatic execution must map to one shell submission so one OSC start/end
    // pair can be matched reliably. The model can issue the next command next turn.
    if (SHELL_LANGS.has(lang) && command && !/[\r\n]/.test(command)) return command
  }
  return null
}

function shellCommandFormatError(markdown: string): string | null {
  const opener = /```([^\r\n`]*)\r?\n/g
  for (const match of markdown.matchAll(opener)) {
    const lang = match[1].trim().toLowerCase().split(/\s+/)[0]
    if (!SHELL_LANGS.has(lang)) continue
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = markdown.indexOf('```', bodyStart)
    if (bodyEnd < 0) return 'The shell command block was not closed.'
    const command = markdown.slice(bodyStart, bodyEnd).trim()
    if (!command) return 'The shell command block was empty.'
    if (/[\r\n]/.test(command)) return 'The shell command block contained more than one line.'
    return null
  }
  return null
}

export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || CONTROL_SYNTAX.test(trimmed) || isSensitiveCommand(trimmed).sensitive) return false
  return READ_ONLY_COMMANDS.has(trimmed.replace(/\s+/g, ' ').toLowerCase())
}

export function planAgentShellExecution(markdown: string, mode: AgentExecutionMode): AgentShellExecutionPlan {
  if (mode === 'manual') return { action: 'none' }
  const command = firstShellCommand(markdown)
  if (!command) {
    const reason = shellCommandFormatError(markdown)
    return reason ? { action: 'repair', reason } : { action: 'none' }
  }
  if (mode === 'auto' || isReadOnlyShellCommand(command)) return { action: 'run', command }
  return { action: 'confirm', command }
}

/** Continue like pi's tool loop until the assistant returns no shell command. */
export async function runAgentShellLoop(
  initialReply: string,
  mode: AgentExecutionMode,
  runStep: (plan: Exclude<AgentShellExecutionPlan, { action: 'none' }>) => Promise<string | null>,
): Promise<{ limitReached: boolean }> {
  let reply = initialReply
  for (let step = 0; step < MAX_AGENT_SHELL_STEPS; step++) {
    const plan = planAgentShellExecution(reply, mode)
    if (plan.action === 'none') return { limitReached: false }
    const nextReply = await runStep(plan)
    if (nextReply === null) return { limitReached: false }
    reply = nextReply
  }
  return { limitReached: planAgentShellExecution(reply, mode).action !== 'none' }
}
