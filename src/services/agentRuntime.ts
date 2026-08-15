//! Typed transport client for the Rust `AgentRuntime`. The frontend subscribes
//! to `agent://events` FIRST, then starts/responds/cancels turns. This module
//! never holds credentials: the request reference is passed through and the
//! caller clears it after `startAgentTurn` resolves.

import { rpc, subscribe } from './transport'

export const AGENT_EVENTS_TOPIC = 'agent://events'

// ─── Wire types (mirror src-tauri/src/agent/types.rs, camelCase) ─────────────

export type AgentRole = 'user' | 'assistant'

export interface ContentBlockText {
  type: 'text'
  text: string
}

export interface ContentBlockThinking {
  type: 'thinking'
  thinking: string
}

export interface ContentBlockToolUse {
  type: 'toolUse'
  id: string
  name: string
  input: unknown
}

export type ToolResultStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'cancelled'
  | 'outcomeUnknown'
  | 'unsupported'

export interface ContentBlockToolResult {
  type: 'toolResult'
  toolUseId: string
  content: string
  status: ToolResultStatus
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult

export interface AgentMessage {
  role: AgentRole
  content: ContentBlock[]
}

export type ProviderProtocol = 'openai' | 'anthropic' | 'ollama'
export type AnthropicAuthMode = 'auto' | 'apiKey' | 'authToken'
export type ExecutionMode = 'manual' | 'ask' | 'auto'

export interface ProviderConfig {
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  credential: string
  anthropicAuthMode: AnthropicAuthMode
}

/** The frontend payload; `ownerId` is transport-owned and rejected server-side. */
export interface AgentTurnRequest {
  conversationId: string
  messages: AgentMessage[]
  systemPrompt: string
  terminalContext: string
  targetRef: string
  provider: ProviderConfig
  executionMode: ExecutionMode
  singleLineCommands: boolean
  roundCap: number
}

export interface TurnHandle {
  turnId: string
}

export type ApprovalDecision = 'allow' | 'deny'

export type ToolExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'outcomeUnknown'
  | 'unsupported'

export interface ToolExecutionOutcome {
  content: string
  status: ToolExecutionStatus
}

export type ClientTurnResponse =
  | { type: 'approvalDecision'; toolUseId: string; decision: ApprovalDecision }
  | { type: 'toolExecutionResult'; toolUseId: string; outcome: ToolExecutionOutcome }

export type AgentEvent =
  | { type: 'turnStarted' }
  | { type: 'assistantMessageStarted'; messageId: string; round: number }
  | { type: 'textDelta'; messageId: string; delta: string }
  | { type: 'thinkingDelta'; messageId: string; delta: string }
  | { type: 'assistantMessageFinished'; messageId: string }
  | { type: 'toolProposed'; toolUseId: string; name: string; input: unknown; risk: string[] }
  | { type: 'approvalRequested'; toolUseId: string; reason: string }
  | { type: 'toolExecutionRequested'; toolUseId: string; target: string; input: unknown }
  | { type: 'toolStarted'; toolUseId: string }
  | { type: 'toolOutputDelta'; toolUseId: string; delta: string }
  | { type: 'toolFinished'; toolUseId: string; result: { toolUseId: string; content: string; status: ToolResultStatus } }
  | { type: 'usageUpdated'; inputTokens: number; outputTokens: number }
  | { type: 'compatibilityFallbackActivated'; provider: string; reason: string }
  | { type: 'turnFinished' }
  | { type: 'turnCancelled' }
  | { type: 'turnFailed'; code: string; message: string }

export interface AgentEventEnvelope {
  ownerId: string
  conversationId: string
  turnId: string
  sequence: number
  event: AgentEvent
}

// ─── Type guards ─────────────────────────────────────────────────────────────

const TOOL_RESULT_STATUSES = new Set([
  'succeeded', 'failed', 'denied', 'blocked', 'cancelled', 'outcomeUnknown', 'unsupported',
])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isToolResult(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    isNonEmptyString(r.toolUseId) &&
    typeof r.content === 'string' &&
    typeof r.status === 'string' &&
    TOOL_RESULT_STATUSES.has(r.status)
  )
}

/** Per-type required-field validators for the discriminated `event` payload. */
const EVENT_FIELD_GUARDS: Record<string, (v: Record<string, unknown>) => boolean> = {
  turnStarted: () => true,
  assistantMessageStarted: (v) => isNonEmptyString(v.messageId) && isNonNegativeInt(v.round),
  textDelta: (v) => isNonEmptyString(v.messageId) && typeof v.delta === 'string',
  thinkingDelta: (v) => isNonEmptyString(v.messageId) && typeof v.delta === 'string',
  assistantMessageFinished: (v) => isNonEmptyString(v.messageId),
  toolProposed: (v) => isNonEmptyString(v.toolUseId) && isNonEmptyString(v.name) && Array.isArray(v.risk),
  approvalRequested: (v) => isNonEmptyString(v.toolUseId) && isNonEmptyString(v.reason),
  toolExecutionRequested: (v) => isNonEmptyString(v.toolUseId) && isNonEmptyString(v.target),
  toolStarted: (v) => isNonEmptyString(v.toolUseId),
  toolOutputDelta: (v) => isNonEmptyString(v.toolUseId) && typeof v.delta === 'string',
  toolFinished: (v) => isNonEmptyString(v.toolUseId) && isToolResult(v.result),
  usageUpdated: (v) => isNonNegativeInt(v.inputTokens) && isNonNegativeInt(v.outputTokens),
  compatibilityFallbackActivated: (v) => isNonEmptyString(v.provider) && isNonEmptyString(v.reason),
  turnFinished: () => true,
  turnCancelled: () => true,
  turnFailed: (v) => isNonEmptyString(v.code) && isNonEmptyString(v.message),
}

/**
 * Discriminated wire validation: the envelope shape AND every required field
 * of the specific event type are checked. Malformed payloads (missing fields,
 * unknown types, NaN/negative/fractional sequences) are rejected so they can
 * never reach projection.
 */
export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!isNonEmptyString(v.ownerId)) return false
  if (!isNonEmptyString(v.conversationId)) return false
  if (!isNonEmptyString(v.turnId)) return false
  if (!isNonNegativeInt(v.sequence) || v.sequence === 0) return false
  if (typeof v.event !== 'object' || v.event === null) return false
  const event = v.event as Record<string, unknown>
  if (!isNonEmptyString(event.type)) return false
  const guard = EVENT_FIELD_GUARDS[event.type]
  return guard !== undefined && guard(event)
}

export function isClientTurnResponse(value: unknown): value is ClientTurnResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const type = v.type
  if (type === 'approvalDecision') {
    return typeof v.toolUseId === 'string' && (v.decision === 'allow' || v.decision === 'deny')
  }
  if (type === 'toolExecutionResult') {
    const outcome = v.outcome as Record<string, unknown> | undefined
    return (
      typeof v.toolUseId === 'string' &&
      typeof outcome === 'object' &&
      outcome !== null &&
      typeof outcome.content === 'string' &&
      typeof outcome.status === 'string'
    )
  }
  return false
}

// ─── Transport client ────────────────────────────────────────────────────────

/** Subscribe to the ordered Agent event stream. Must complete before startAgentTurn. */
export function subscribeAgentEvents(handler: (envelope: unknown) => void): Promise<() => void> {
  return subscribe(AGENT_EVENTS_TOPIC, handler)
}

export function startAgentTurn(request: AgentTurnRequest): Promise<TurnHandle> {
  return rpc<TurnHandle>('agent_start_turn', { request })
}

export function respondToAgentTurn(
  turnId: string,
  response: ClientTurnResponse,
): Promise<void> {
  return rpc<void>('agent_respond', { turnId, response })
}

export function cancelAgentTurn(turnId: string): Promise<void> {
  return rpc<void>('agent_cancel', { turnId })
}
