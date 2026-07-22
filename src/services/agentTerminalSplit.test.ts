import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyAgentTerminalSplitReady,
  onAgentTerminalSplitCancel,
  onAgentTerminalSplitRequest,
  requestAgentTerminalSplit,
} from './agentTerminalSplit'

afterEach(() => vi.useRealTimers())

describe('Agent terminal split handshake', () => {
  it('resolves with the new channel once the matching terminal reports ready', async () => {
    const controller = new AbortController()
    const stop = onAgentTerminalSplitRequest('tab-1', requestId => {
      notifyAgentTerminalSplitReady('tab-1', requestId, 'chan-new')
    })

    await expect(requestAgentTerminalSplit('tab-1', controller.signal)).resolves.toBe('chan-new')
    stop()
  })

  it('ignores another tab and returns null when cancelled', async () => {
    const controller = new AbortController()
    let cancelledRequest = ''
    const stopCancel = onAgentTerminalSplitCancel('tab-1', requestId => { cancelledRequest = requestId })
    const stop = onAgentTerminalSplitRequest('tab-other', requestId => {
      notifyAgentTerminalSplitReady('tab-other', requestId, 'wrong-channel')
    })
    const pending = requestAgentTerminalSplit('tab-1', controller.signal)
    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(cancelledRequest).toMatch(/^agent-split-/)
    stop()
    stopCancel()
  })
})
