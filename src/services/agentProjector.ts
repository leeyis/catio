//! Pure projection of ordered Agent events into UI state + effects. No
//! transport, no credentials: `projectAgentEvent(state, envelope)` returns the
//! next state and at most one effect (approval request, tool dispatch, warning,
//! or turn settled).

import { isAgentEventEnvelope } from './agentRuntime'

export interface AgentProjectorState {
  /** Last accepted sequence per turn (strictly increasing). */
  lastSequenceByTurn: Record<string, number>
  /** Tool-use ids that already produced an approval effect. */
  handledApprovalIds: string[]
  /** Tool-use ids that already produced an execution effect. */
  handledExecutionIds: string[]
  /** Active assistant message per turn. */
  activeMessageByTurn: Record<string, { messageId: string; round: number }>
  /** Accumulated text per message id. */
  textByMessageId: Record<string, string>
  /** Whether a turn is still streaming (false after any terminal event). */
  busyByTurn: Record<string, boolean>
}

export const initialProjectorState: AgentProjectorState = {
  lastSequenceByTurn: {},
  handledApprovalIds: [],
  handledExecutionIds: [],
  activeMessageByTurn: {},
  textByMessageId: {},
  busyByTurn: {},
}

export type AgentProjectionEffect =
  | { type: 'requestApproval'; turnId: string; toolUseId: string; reason: string }
  | { type: 'executeTool'; turnId: string; toolUseId: string; target: string; input: unknown }
  | { type: 'showWarning'; code: string; message?: string }
  | { type: 'turnSettled'; turnId: string }

export interface AgentProjection {
  state: AgentProjectorState
  effects: AgentProjectionEffect[]
  /**
   * True when the envelope was accepted into the projection (its event
   * mutated state). Malformed, duplicate and gapped envelopes are NOT
   * accepted; callers must not apply their event payload to conversations or
   * tool routing, but MUST still run `effects` (e.g. the order warning).
   */
  accepted: boolean
}

type Diagnostic = (message: string) => void

const TERMINAL_TYPES = new Set(['turnFinished', 'turnCancelled', 'turnFailed'])

function nextState(state: AgentProjectorState): AgentProjectorState {
  return {
    lastSequenceByTurn: { ...state.lastSequenceByTurn },
    handledApprovalIds: [...state.handledApprovalIds],
    handledExecutionIds: [...state.handledExecutionIds],
    activeMessageByTurn: { ...state.activeMessageByTurn },
    textByMessageId: { ...state.textByMessageId },
    busyByTurn: { ...state.busyByTurn },
  }
}

/**
 * Projects one envelope. Malformed or out-of-order payloads are dropped with a
 * diagnostic (and a `showWarning` effect for order violations); duplicate
 * sequences never re-run effects.
 */
export function projectAgentEvent(
  state: AgentProjectorState,
  envelope: unknown,
  onDiagnostic: Diagnostic = () => {},
): AgentProjection {
  if (!isAgentEventEnvelope(envelope)) {
    onDiagnostic('agent: malformed envelope dropped')
    return { state, effects: [], accepted: false }
  }
  const { turnId, sequence, event } = envelope
  const last = state.lastSequenceByTurn[turnId] ?? 0
  if (sequence <= last) {
    // Duplicate/out-of-order: never re-run effects.
    return { state, effects: [], accepted: false }
  }
  if (sequence > last + 1) {
    onDiagnostic(`agent: sequence gap for turn ${turnId}: ${last} -> ${sequence}`)
    const next = nextState(state)
    next.lastSequenceByTurn[turnId] = sequence
    return {
      state: next,
      effects: [{ type: 'showWarning', code: 'agentEventOrder' }],
      accepted: false,
    }
  }

  const next = nextState(state)
  next.lastSequenceByTurn[turnId] = sequence
  const effects: AgentProjectionEffect[] = []

  switch (event.type) {
    case 'turnStarted':
      next.busyByTurn[turnId] = true
      break
    case 'assistantMessageStarted':
      next.activeMessageByTurn[turnId] = { messageId: event.messageId, round: event.round }
      break
    case 'textDelta':
      next.textByMessageId[event.messageId] =
        (next.textByMessageId[event.messageId] ?? '') + event.delta
      break
    case 'approvalRequested':
      if (!next.handledApprovalIds.includes(event.toolUseId)) {
        next.handledApprovalIds.push(event.toolUseId)
        effects.push({ type: 'requestApproval', turnId, toolUseId: event.toolUseId, reason: event.reason })
      }
      break
    case 'toolExecutionRequested':
      if (!next.handledExecutionIds.includes(event.toolUseId)) {
        next.handledExecutionIds.push(event.toolUseId)
        effects.push({
          type: 'executeTool',
          turnId,
          toolUseId: event.toolUseId,
          target: event.target,
          input: event.input,
        })
      }
      break
    case 'turnFinished':
    case 'turnCancelled':
    case 'turnFailed':
      next.busyByTurn[turnId] = false
      effects.push({ type: 'turnSettled', turnId })
      break
    default:
      // Informational events (thinking/tool deltas, usage, fallback) have no effect.
      break
  }

  return { state: next, effects, accepted: true }
}

/** True when the event terminates its turn. */
export function isTerminalEventType(type: string): boolean {
  return TERMINAL_TYPES.has(type)
}
