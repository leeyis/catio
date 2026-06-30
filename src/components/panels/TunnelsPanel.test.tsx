import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { ConnectionProfile } from '../../state/connections'

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

const PROFILES_WITH_JUMP: ConnectionProfile[] = [
  {
    id: 'conn-with-jump',
    name: 'prod-web-01',
    host: '10.0.0.5',
    port: 22,
    user: 'app',
    auth: { method: 'password' },
    jump: {
      host: 'bastion.example.com',
      port: 22,
      user: 'ec2-user',
      auth: { method: 'password' },
    },
  },
]

const PROFILES_WITHOUT_JUMP: ConnectionProfile[] = [
  {
    id: 'conn-direct',
    name: 'direct-host',
    host: '10.0.0.10',
    port: 22,
    user: 'deploy',
    auth: { method: 'password' },
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

  it('surfaces a tunnelOpen failure instead of silently doing nothing', async () => {
    h.tunnelOpen.mockRejectedValue(new Error('tcpip_forward 127.0.0.1:8080: address already in use'))
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    // Open the new-forward overlay (the "+" action carries the localized "新建转发" title).
    fireEvent.click(screen.getByTitle('新建转发'))
    // Fill bind + target, then submit.
    fireEvent.change(screen.getByPlaceholderText('localhost:8080'), { target: { value: '127.0.0.1:8080' } })
    fireEvent.change(screen.getByPlaceholderText('10.0.4.2:5432'), { target: { value: '10.0.4.2:5432' } })
    fireEvent.click(screen.getByText('添加'))

    // The backend error must be shown to the user (the original bug swallowed it).
    await waitFor(() => expect(screen.getByText(/address already in use/)).toBeTruthy())
    expect(h.tunnelOpen).toHaveBeenCalled()
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

describe('TunnelsPanel — jump chain', () => {
  beforeEach(() => {
    h.getTunnels.mockResolvedValue([])
    h.listen.mockResolvedValue(() => {})
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    h.getTunnels.mockClear()
    h.listen.mockClear()
  })

  it('shows local → jump → target chain when profile has a jump', async () => {
    wrap(
      <TunnelsPanel
        onClose={() => {}}
        sessionId="sess-jump"
        activeConnId="conn-with-jump"
        profiles={PROFILES_WITH_JUMP}
      />
    )
    await waitFor(() => {
      // Local node
      expect(screen.getByText('本地')).toBeTruthy()
      // Jump node
      expect(screen.getByText('bastion.example.com')).toBeTruthy()
      // Target node
      expect(screen.getByText('prod-web-01')).toBeTruthy()
    })
  })

  it('shows local → target chain when profile has no jump', async () => {
    wrap(
      <TunnelsPanel
        onClose={() => {}}
        sessionId="sess-direct"
        activeConnId="conn-direct"
        profiles={PROFILES_WITHOUT_JUMP}
      />
    )
    await waitFor(() => {
      // Local node
      expect(screen.getByText('本地')).toBeTruthy()
      // Target node
      expect(screen.getByText('direct-host')).toBeTruthy()
    })
    // No jump node
    expect(screen.queryByText('bastion.example.com')).toBeNull()
  })
})
