import {
  DEFAULT_AGENT_SHELL_STEPS,
  MAX_AGENT_SHELL_STEPS,
  MIN_AGENT_SHELL_STEPS,
  type AgentExecutionMode,
} from '../../state/agentConfig'
import { isSensitiveCommand } from './sensitiveCommands'

export type AgentShellExecutionPlan =
  | { action: 'none' }
  | { action: 'repair'; reason: string }
  | { action: 'run' | 'confirm'; command: string }

const SHELL_LANGS = new Set(['sh', 'shell', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch'])

export interface AgentShellLoopOptions {
  singleLineCommands?: boolean
  maxSteps?: number
}

export function firstShellCommand(markdown: string, singleLineCommands = true): string | null {
  const fences = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fences)) {
    const lang = match[1].trim().toLowerCase().split(/\s+/)[0]
    const command = match[2].trim()
    if (SHELL_LANGS.has(lang) && command && (!singleLineCommands || !/[\r\n]/.test(command))) return command
  }
  return null
}

function shellCommandFormatError(markdown: string, singleLineCommands: boolean): string | null {
  const opener = /```([^\r\n`]*)\r?\n/g
  for (const match of markdown.matchAll(opener)) {
    const lang = match[1].trim().toLowerCase().split(/\s+/)[0]
    if (!SHELL_LANGS.has(lang)) continue
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = markdown.indexOf('```', bodyStart)
    if (bodyEnd < 0) return 'The shell command block was not closed.'
    const command = markdown.slice(bodyStart, bodyEnd).trim()
    if (!command) return 'The shell command block was empty.'
    if (singleLineCommands && /[\r\n]/.test(command)) return 'The shell command block contained more than one line.'
    return null
  }
  return null
}

export function planAgentShellExecution(
  markdown: string,
  mode: AgentExecutionMode,
  singleLineCommands = true,
): AgentShellExecutionPlan {
  if (mode === 'manual') return { action: 'none' }
  const command = firstShellCommand(markdown, singleLineCommands)
  if (!command) {
    const reason = shellCommandFormatError(markdown, singleLineCommands)
    return reason ? { action: 'repair', reason } : { action: 'none' }
  }
  if (mode === 'auto' || !isSensitiveCommand(command).sensitive) return { action: 'run', command }
  return { action: 'confirm', command }
}

/** Continue like pi's tool loop until the assistant returns no shell command. */
export async function runAgentShellLoop(
  initialReply: string,
  mode: AgentExecutionMode,
  runStep: (plan: Exclude<AgentShellExecutionPlan, { action: 'none' }>) => Promise<string | null>,
  options: AgentShellLoopOptions = {},
): Promise<{ limitReached: boolean }> {
  const singleLineCommands = options.singleLineCommands ?? true
  const requestedMaxSteps = options.maxSteps ?? DEFAULT_AGENT_SHELL_STEPS
  const maxSteps = Number.isFinite(requestedMaxSteps)
    ? Math.min(MAX_AGENT_SHELL_STEPS, Math.max(MIN_AGENT_SHELL_STEPS, Math.floor(requestedMaxSteps)))
    : DEFAULT_AGENT_SHELL_STEPS
  let reply = initialReply
  for (let step = 0; step < maxSteps; step++) {
    const plan = planAgentShellExecution(reply, mode, singleLineCommands)
    if (plan.action === 'none') return { limitReached: false }
    const nextReply = await runStep(plan)
    if (nextReply === null) return { limitReached: false }
    reply = nextReply
  }
  return { limitReached: planAgentShellExecution(reply, mode, singleLineCommands).action !== 'none' }
}
