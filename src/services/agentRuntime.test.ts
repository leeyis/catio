import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./transport', () => ({
  rpc: vi.fn(),
  subscribe: vi.fn(),
}))

import { rpc, subscribe } from './transport'
import {
  cancelAgentTurn,
  isAgentEventEnvelope,
  respondToAgentTurn,
  startAgentTurn,
  subscribeAgentEvents,
} from './agentRuntime'

describe('agent runtime transport client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(rpc as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(subscribe as ReturnType<typeof vi.fn>).mockResolvedValue(() => {})
  })

  it('subscribes to the fixed agent://events topic', async () => {
    const handler = vi.fn()
    await subscribeAgentEvents(handler)
    expect(subscribe).toHaveBeenCalledWith('agent://events', handler)
  })

  it('starts a turn with the exact wire command and args', async () => {
    const request = { conversationId: 'conv-1' }
    ;(rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ turnId: 'turn-1' })
    const handle = await startAgentTurn(request as never)
    expect(rpc).toHaveBeenCalledWith('agent_start_turn', { request })
    expect(handle).toEqual({ turnId: 'turn-1' })
  })

  it('responds with the exact wire command and args', async () => {
    const response = { type: 'approvalDecision', toolUseId: 'tool-1', decision: 'allow' }
    await respondToAgentTurn('turn-1', response as never)
    expect(rpc).toHaveBeenCalledWith('agent_respond', { turnId: 'turn-1', response })
  })

  it('cancels with the exact wire command and args', async () => {
    await cancelAgentTurn('turn-1')
    expect(rpc).toHaveBeenCalledWith('agent_cancel', { turnId: 'turn-1' })
  })
})

describe('agent event envelope wire validation', () => {
  const valid: Record<string, unknown> = {
    ownerId: 'local',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    sequence: 1,
    event: { type: 'turnStarted' },
  }

  it('accepts a minimal valid envelope', () => {
    expect(isAgentEventEnvelope(valid)).toBe(true)
  })

  it('rejects NaN, negative, fractional and infinite sequences', () => {
    for (const sequence of [NaN, -1, 0, 1.5, Infinity, '1']) {
      expect(isAgentEventEnvelope({ ...valid, sequence })).toBe(false)
    }
  })

  it('rejects missing, empty or mistyped ids', () => {
    expect(isAgentEventEnvelope({ ...valid, ownerId: '' })).toBe(false)
    expect(isAgentEventEnvelope({ ...valid, conversationId: undefined })).toBe(false)
    expect(isAgentEventEnvelope({ ...valid, turnId: 42 })).toBe(false)
    expect(isAgentEventEnvelope({ ...valid, ownerId: null })).toBe(false)
  })

  it('rejects unknown event types', () => {
    expect(isAgentEventEnvelope({ ...valid, event: { type: 'teleport' } })).toBe(false)
    expect(isAgentEventEnvelope({ ...valid, event: null })).toBe(false)
    expect(isAgentEventEnvelope({ ...valid, event: undefined })).toBe(false)
  })

  it('rejects events missing required fields per discriminated type', () => {
    const cases: Array<Record<string, unknown>> = [
      { type: 'textDelta' },
      { type: 'textDelta', messageId: 'm0' },
      { type: 'assistantMessageStarted', messageId: 'm0' },
      { type: 'assistantMessageStarted', messageId: 'm0', round: -1 },
      { type: 'turnFailed', code: 'x' },
      { type: 'toolProposed', toolUseId: 'u1' },
      { type: 'toolProposed', toolUseId: 'u1', name: 'n', input: {}, risk: 'not-array' },
      { type: 'approvalRequested', toolUseId: 'u1' },
      { type: 'toolExecutionRequested', toolUseId: 'u1' },
      { type: 'toolFinished', toolUseId: 'u1' },
      { type: 'toolFinished', toolUseId: 'u1', result: { toolUseId: 'u1', content: '' } },
      { type: 'usageUpdated', inputTokens: 'a', outputTokens: 1 },
      { type: 'compatibilityFallbackActivated', provider: 'p' },
    ]
    for (const event of cases) {
      expect(isAgentEventEnvelope({ ...valid, event }), JSON.stringify(event)).toBe(false)
    }
  })

  it('rejects tool payloads with missing input property', () => {
    // `input` may be ANY JSON (including null), but the property is required
    // by the Rust wire contract: an absent input must never reach projection.
    const missingInput = [
      { type: 'toolProposed', toolUseId: 'u1', name: 'terminal_exec', risk: [] },
      { type: 'toolExecutionRequested', toolUseId: 'u1', target: 't' },
    ]
    for (const event of missingInput) {
      expect(isAgentEventEnvelope({ ...valid, event }), JSON.stringify(event)).toBe(false)
    }
  })

  it('accepts null input when the property is present', () => {
    const nullInput = [
      { type: 'toolProposed', toolUseId: 'u1', name: 'terminal_exec', input: null, risk: [] },
      { type: 'toolExecutionRequested', toolUseId: 'u1', target: 't', input: null },
    ]
    for (const event of nullInput) {
      expect(isAgentEventEnvelope({ ...valid, event }), JSON.stringify(event)).toBe(true)
    }
  })

  it('rejects toolProposed risk entries that are not strings', () => {
    const event = {
      type: 'toolProposed',
      toolUseId: 'u1',
      name: 'terminal_exec',
      input: { command: 'pwd' },
      risk: ['fileDelete', 42],
    }
    expect(isAgentEventEnvelope({ ...valid, event })).toBe(false)
  })

  it('rejects toolFinished whose result belongs to a different tool use', () => {
    const event = {
      type: 'toolFinished',
      toolUseId: 'u1',
      result: { toolUseId: 'u2', content: '', status: 'succeeded' },
    }
    expect(isAgentEventEnvelope({ ...valid, event })).toBe(false)
  })

  it('accepts fully-specified events of each discriminated type', () => {
    const events = [
      { type: 'turnStarted' },
      { type: 'assistantMessageStarted', messageId: 'm0', round: 0 },
      { type: 'textDelta', messageId: 'm0', delta: 'hi' },
      { type: 'thinkingDelta', messageId: 'm0', delta: 't' },
      { type: 'assistantMessageFinished', messageId: 'm0' },
      { type: 'toolProposed', toolUseId: 'u1', name: 'terminal_exec', input: { command: 'pwd' }, risk: [] },
      { type: 'approvalRequested', toolUseId: 'u1', reason: 'x' },
      { type: 'toolExecutionRequested', toolUseId: 'u1', target: 't', input: {} },
      { type: 'toolStarted', toolUseId: 'u1' },
      { type: 'toolOutputDelta', toolUseId: 'u1', delta: 'o' },
      { type: 'toolFinished', toolUseId: 'u1', result: { toolUseId: 'u1', content: '', status: 'succeeded' } },
      { type: 'usageUpdated', inputTokens: 1, outputTokens: 2 },
      { type: 'compatibilityFallbackActivated', provider: 'p', reason: 'r' },
      { type: 'turnFinished' },
      { type: 'turnCancelled' },
      { type: 'turnFailed', code: 'x', message: 'y' },
    ]
    for (const event of events) {
      expect(isAgentEventEnvelope({ ...valid, event }), JSON.stringify(event)).toBe(true)
    }
  })
})
