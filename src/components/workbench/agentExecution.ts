import type { AgentExecutionMode } from '../../state/agentConfig'
import { isSensitiveCommand } from './sensitiveCommands'

export type AgentShellExecutionPlan =
  | { action: 'none' }
  | { action: 'run' | 'confirm'; command: string }

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
  'docker info', 'kubectl version --client', 'systemctl list-units',
  'systemctl is-system-running', 'get-location', 'get-process', 'get-service',
  'get-computerinfo', 'get-nettcpconnection', 'get-disk', 'get-volume',
  'get-psdrive', 'get-date', 'get-host',
])

export function firstShellCommand(markdown: string): string | null {
  const fences = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fences)) {
    const lang = match[1].trim().toLowerCase().split(/\s+/)[0]
    const command = match[2].trim()
    if (SHELL_LANGS.has(lang) && command) return command
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
  if (!command) return { action: 'none' }
  if (mode === 'auto' || isReadOnlyShellCommand(command)) return { action: 'run', command }
  return { action: 'confirm', command }
}
