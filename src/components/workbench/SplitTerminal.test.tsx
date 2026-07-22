import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestAgentTerminalSplit } from '../../services/agentTerminalSplit'
import type { Connection } from '../../services/types'

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ onChannel, sessionId }: { onChannel?: (sessionId: string, chanId: string) => void; sessionId?: string }) => (
    <button type="button" onClick={() => onChannel?.(sessionId ?? '', 'new-channel')}>mock terminal</button>
  ),
}))

import { SplitTerminal } from './SplitTerminal'

describe('SplitTerminal Agent handshake', () => {
  it('creates and focuses a new pane for a hidden tab, then reports its channel', async () => {
    const conn: Connection = { id: 'host-1', group: '', kind: 'host', name: 'host', sub: 'u@h:22', icon: 'server', status: 'up', proto: 'ssh' }
    render(<SplitTerminal tabId="tab-1" conn={conn} sessionId="session-1" active={false} />)
    const controller = new AbortController()

    let pending!: Promise<string | null>
    act(() => { pending = requestAgentTerminalSplit('tab-1', controller.signal) })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'mock terminal' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'mock terminal' })[1])

    await expect(pending).resolves.toBe('new-channel')
  })

  it('removes an Agent-created pane when the split request is cancelled before ready', async () => {
    const conn: Connection = { id: 'host-1', group: '', kind: 'host', name: 'host', sub: 'u@h:22', icon: 'server', status: 'up', proto: 'ssh' }
    render(<SplitTerminal tabId="tab-cancel" conn={conn} sessionId="session-1" active={false} />)
    const controller = new AbortController()

    let pending!: Promise<string | null>
    act(() => { pending = requestAgentTerminalSplit('tab-cancel', controller.signal) })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'mock terminal' })).toHaveLength(2))
    act(() => controller.abort())

    await expect(pending).resolves.toBeNull()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'mock terminal' })).toHaveLength(1))
  })
})
