import { describe, expect, it } from 'vitest'
import { projectAgentEvent, type AgentEventEnvelope, type AgentProjectorState } from './agentProjector'

function env(turnId: string, sequence: number, event: AgentEventEnvelope['event']): AgentEventEnvelope {
  return { ownerId: 'local', conversationId: 'conv-1', turnId, sequence, event }
}

const initial: AgentProjectorState = {
  lastSequenceByTurn: {},
  handledApprovalIds: [],
  handledExecutionIds: [],
  activeMessageByTurn: {},
  textByMessageId: {},
  busyByTurn: {},
}

describe('agent event projector', () => {
  it('appends text deltas only to the owning message', () => {
    let state = initial
    let result = projectAgentEvent(state, env('t1', 1, { type: 'turnStarted' }))
    state = result.state
    result = projectAgentEvent(state, env('t1', 2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 }))
    state = result.state
    result = projectAgentEvent(state, env('t1', 3, { type: 'textDelta', messageId: 'm0', delta: 'hello ' }))
    state = result.state
    result = projectAgentEvent(state, env('t1', 4, { type: 'textDelta', messageId: 'm0', delta: 'world' }))
    state = result.state
    expect(state.textByMessageId['m0']).toBe('hello world')
    // Other messages are untouched.
    result = projectAgentEvent(state, env('t1', 5, { type: 'assistantMessageStarted', messageId: 'm1', round: 1 }))
    state = result.state
    expect(state.textByMessageId['m1']).toBeUndefined()
  })

  it('does not re-run effects for a duplicate sequence', () => {
    let state = initial
    const first = projectAgentEvent(state, env('t1', 1, { type: 'approvalRequested', toolUseId: 'u1', reason: 'x' }))
    state = first.state
    expect(first.effects).toEqual([{ type: 'requestApproval', turnId: 't1', toolUseId: 'u1', reason: 'x' }])
    const replay = projectAgentEvent(state, env('t1', 1, { type: 'approvalRequested', toolUseId: 'u1', reason: 'x' }))
    expect(replay.effects).toEqual([])
  })

  it('warns on sequence gaps and out-of-order events', () => {
    let state = initial
    const result = projectAgentEvent(state, env('t1', 5, { type: 'turnStarted' }))
    expect(result.effects).toEqual([{ type: 'showWarning', code: 'agentEventOrder' }])
    expect(result.state.lastSequenceByTurn['t1']).toBe(5)
  })

  it('emits requestApproval once per tool id', () => {
    let state = initial
    const first = projectAgentEvent(state, env('t1', 1, { type: 'approvalRequested', toolUseId: 'u1', reason: 'x' }))
    state = first.state
    const second = projectAgentEvent(state, env('t1', 2, { type: 'approvalRequested', toolUseId: 'u1', reason: 'x' }))
    expect(first.effects).toHaveLength(1)
    expect(second.effects).toEqual([])
  })

  it('emits executeTool once per tool id with target and input', () => {
    const result = projectAgentEvent(initial, env('t1', 1, {
      type: 'toolExecutionRequested',
      toolUseId: 'u1',
      target: 'target-1',
      input: { command: 'pwd' },
    }))
    expect(result.effects).toEqual([
      { type: 'executeTool', turnId: 't1', toolUseId: 'u1', target: 'target-1', input: { command: 'pwd' } },
    ])
    const replay = projectAgentEvent(result.state, env('t1', 1, {
      type: 'toolExecutionRequested',
      toolUseId: 'u1',
      target: 'target-1',
      input: { command: 'pwd' },
    }))
    expect(replay.effects).toEqual([])
  })

  it('clears busy on every terminal event type', () => {
    for (const terminal of [
      { type: 'turnFinished' },
      { type: 'turnCancelled' },
      { type: 'turnFailed', code: 'x', message: 'y' },
    ] as const) {
      const started = projectAgentEvent(initial, env('t1', 1, { type: 'turnStarted' }))
      const settled = projectAgentEvent(started.state, env('t1', 2, terminal as never))
      expect(settled.state.busyByTurn['t1']).toBe(false)
      expect(settled.effects).toContainEqual({ type: 'turnSettled', turnId: 't1' })
    }
  })

  it('drops malformed envelopes and reports diagnostics', () => {
    const diagnostics: string[] = []
    const missingType = projectAgentEvent(initial, { ownerId: 'x', turnId: 't1', sequence: 1 } as never, (d) => diagnostics.push(d))
    expect(missingType.effects).toEqual([])
    const missingSequence = projectAgentEvent(initial, { ownerId: 'x', conversationId: 'c', turnId: 't1', event: { type: 'turnStarted' } } as never, (d) => diagnostics.push(d))
    expect(missingSequence.effects).toEqual([])
    expect(diagnostics.length).toBe(2)
  })
})
