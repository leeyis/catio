import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./transport', () => ({
  rpc: vi.fn(),
  subscribe: vi.fn(),
}))

import { rpc, subscribe } from './transport'
import {
  cancelAgentTurn,
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
