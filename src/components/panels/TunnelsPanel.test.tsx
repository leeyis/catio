import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'

// ---- ssh service mock ----
const h = vi.hoisted(() => ({
  getTunnels: vi.fn(),
  tunnelClose: vi.fn(),
  tunnelOpen: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('../../services/ssh', () => ({
  getTunnels: h.getTunnels,
  tunnelClose: h.tunnelClose,
  tunnelOpen: h.tunnelOpen,
  listen: h.listen,
}))

import { TunnelsPanel } from './TunnelsPanel'

const MOCK_TUNNELS = [
  {
    id: 'tun-1',
    type: 'L' as const,
    label: 'prod-orders',
    via: 'db-bastion',
    local: 'localhost:5432',
    remote: '10.0.4.2:5432',
    status: 'up' as const,
    bytes: '4.2 MB',
  },
  {
    id: 'tun-2',
    type: 'D' as const,
    label: 'SOCKS proxy',
    via: 'db-bastion',
    local: 'localhost:1080',
    remote: '(dynamic)',
    status: 'up' as const,
    bytes: '38 MB',
  },
]

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('TunnelsPanel (tunnel wiring)', () => {
  beforeEach(() => {
    h.getTunnels.mockResolvedValue(MOCK_TUNNELS)
    h.tunnelClose.mockResolvedValue(undefined)
    h.tunnelOpen.mockResolvedValue('new-tun-id')
    h.listen.mockResolvedValue(() => {})
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    h.getTunnels.mockClear()
    h.tunnelClose.mockClear()
    h.tunnelOpen.mockClear()
    h.listen.mockClear()
  })

  it('renders tunnels returned by getTunnels', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => {
      expect(screen.getByText('prod-orders')).toBeTruthy()
      expect(screen.getByText('SOCKS proxy')).toBeTruthy()
    })
    expect(h.getTunnels).toHaveBeenCalledWith('sess-1')
  })

  it('calls tunnelClose with the tunnel id when toggled OFF', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    // Find the first Toggle (role=switch) and click it to toggle OFF
    const toggles = screen.getAllByRole('switch')
    fireEvent.click(toggles[0])

    await waitFor(() => {
      expect(h.tunnelClose).toHaveBeenCalledWith('tun-1')
    })
  })

  it('shows empty state when no sessionId provided', async () => {
    // Without sessionId, panel renders PanelEmpty — getTunnels is NOT called
    wrap(<TunnelsPanel onClose={() => {}} />)
    await waitFor(() => {
      // Match the noSessionHint text (zh locale in tests)
      expect(screen.getByText(/无活动会话/)).toBeTruthy()
    })
    expect(h.getTunnels).not.toHaveBeenCalled()
  })

  it('does not render tunnel rows when no sessionId', async () => {
    wrap(<TunnelsPanel onClose={() => {}} />)
    // Allow effects to settle
    await new Promise(r => setTimeout(r, 50))
    // No tunnel rows — no toggles visible (empty state shown instead)
    expect(screen.queryByText('prod-orders')).toBeNull()
    expect(h.tunnelClose).not.toHaveBeenCalled()
  })
})
