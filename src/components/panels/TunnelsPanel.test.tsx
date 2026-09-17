import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { ConnectionProfile } from '../../state/connections'

// ---- ssh service mock ----
const h = vi.hoisted(() => ({
  getTunnels: vi.fn(),
  getTunnelDefaults: vi.fn(),
  tunnelClose: vi.fn(),
  tunnelOpen: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../services/ssh', () => ({
  getTunnels: h.getTunnels,
  getTunnelDefaults: h.getTunnelDefaults,
  tunnelClose: h.tunnelClose,
  tunnelOpen: h.tunnelOpen,
  listen: h.listen,
}))

vi.mock('../../services/clipboard', () => ({
  copyTextToClipboard: h.copyTextToClipboard,
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
    h.getTunnelDefaults.mockResolvedValue({ remoteHost: '10.0.0.12', localPort: 49152 })
    h.tunnelClose.mockResolvedValue(undefined)
    h.tunnelOpen.mockResolvedValue('new-tun-id')
    h.listen.mockResolvedValue(() => {})
    h.copyTextToClipboard.mockResolvedValue(true)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    h.getTunnels.mockClear()
    h.getTunnelDefaults.mockClear()
    h.tunnelClose.mockClear()
    h.tunnelOpen.mockClear()
    h.listen.mockClear()
    h.copyTextToClipboard.mockClear()
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
    // Local forwarding exposes the discovered remote host and both ports for explicit control.
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '5432' } })
    fireEvent.click(screen.getByText('添加'))

    // The backend error must be shown to the user (the original bug swallowed it).
    await waitFor(() => expect(screen.getByText(/address already in use/)).toBeTruthy())
    expect(h.tunnelOpen).toHaveBeenCalled()
  })

  it('opens exactly one tunnel for one add click', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    expect(screen.queryByPlaceholderText('localhost:8080')).toBeNull()
    await waitFor(() => expect(screen.getByPlaceholderText('10.0.4.2')).toHaveValue('10.0.0.12'))
    expect(screen.getByLabelText('本地映射端口')).toHaveValue(49152)
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '9999' } })
    fireEvent.change(screen.getByPlaceholderText('10.0.4.2'), { target: { value: '127.0.0.1' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })
    fireEvent.click(screen.getByText('添加'))

    await waitFor(() => expect(h.tunnelOpen).toHaveBeenCalled())
    expect(h.tunnelOpen).toHaveBeenCalledTimes(1)
    expect(h.tunnelOpen).toHaveBeenCalledWith('sess-1', { kind: 'L', bind: '9999', target: '127.0.0.1:8000' })
  })

  it('does not overwrite host or port edits when async defaults arrive later', async () => {
    let resolveDefaults: (value: { remoteHost: string; localPort: number }) => void = () => {}
    h.getTunnelDefaults.mockReturnValue(new Promise(resolve => { resolveDefaults = resolve }))
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    const localPort = screen.getByLabelText('本地映射端口')
    const remoteHost = screen.getByPlaceholderText('10.0.4.2')
    fireEvent.change(localPort, { target: { value: '62000' } })
    fireEvent.change(remoteHost, { target: { value: 'localhost' } })

    await act(async () => {
      resolveDefaults({ remoteHost: '10.0.0.12', localPort: 49152 })
      await Promise.resolve()
    })
    expect(localPort).toHaveValue(62000)
    expect(remoteHost).toHaveValue('localhost')
  })

  it('blocks repeated submissions while tunnelOpen is pending and allows retry after failure', async () => {
    let rejectOpen: (reason?: unknown) => void = () => {}
    h.tunnelOpen
      .mockReturnValueOnce(new Promise<string>((_, reject) => { rejectOpen = reject }))
      .mockResolvedValueOnce('retry-tunnel-id')
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })
    const add = screen.getByText('添加')
    const form = add.closest('form')
    expect(form).toBeTruthy()

    fireEvent.submit(form!)
    fireEvent.submit(form!)
    expect(h.tunnelOpen).toHaveBeenCalledTimes(1)
    expect(add).toBeDisabled()

    rejectOpen(new Error('temporary bind failure'))
    expect(await screen.findByRole('alert')).toHaveTextContent('temporary bind failure')
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    await waitFor(() => expect(h.tunnelOpen).toHaveBeenCalledTimes(2))
  })

  it('validates Local port boundaries before enabling Add', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    const add = screen.getByText('添加')
    const localPort = screen.getByLabelText('本地映射端口')
    const remotePort = screen.getByLabelText('远程服务端口')

    expect(add).toBeDisabled()
    fireEvent.change(localPort, { target: { value: '65536' } })
    fireEvent.change(remotePort, { target: { value: '8000' } })
    expect(add).toBeDisabled()

    fireEvent.change(localPort, { target: { value: '0' } })
    fireEvent.change(remotePort, { target: { value: '0' } })
    expect(add).toBeDisabled()

    fireEvent.change(remotePort, { target: { value: '65535' } })
    expect(add).toBeEnabled()
  })

  it('clears Local ports when switching modes and still submits a Remote forward', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })
    fireEvent.click(screen.getByRole('button', { name: '远程' }))

    const bind = screen.getByLabelText('绑定地址')
    const target = screen.getByLabelText('目标')
    expect(bind).toHaveValue('')
    expect(target).toHaveValue('')
    expect(h.tunnelOpen).not.toHaveBeenCalled()

    fireEvent.change(bind, { target: { value: '0.0.0.0:9000' } })
    fireEvent.change(target, { target: { value: 'localhost:3000' } })
    fireEvent.click(screen.getByText('添加'))

    await waitFor(() => expect(h.tunnelOpen).toHaveBeenCalledWith('sess-1', {
      kind: 'R',
      bind: '0.0.0.0:9000',
      target: 'localhost:3000',
    }))
  })

  it('submits a Dynamic forward without a target', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.click(screen.getByRole('button', { name: '动态' }))
    expect(screen.queryByLabelText('目标')).toBeNull()
    fireEvent.change(screen.getByLabelText('绑定地址'), { target: { value: 'localhost:1080' } })
    fireEvent.click(screen.getByText('添加'))

    await waitFor(() => expect(h.tunnelOpen).toHaveBeenCalledWith('sess-1', {
      kind: 'D',
      bind: 'localhost:1080',
      target: null,
    }))
  })

  it('saves a reusable connection without opening a tunnel and shows feedback', async () => {
    const onSaveProfile = vi.fn().mockResolvedValue(undefined)
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" onSaveProfile={onSaveProfile} />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })
    fireEvent.change(screen.getByPlaceholderText('例如 内网 PG'), { target: { value: 'API' } })
    fireEvent.click(screen.getByText('保存为连接'))

    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(onSaveProfile).toHaveBeenCalledWith('L', '9999', '10.0.0.12:8000', 'API')
    expect(h.tunnelOpen).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('API')
  })

  it('keeps the form open and shows an error when saving the connection fails', async () => {
    const onSaveProfile = vi.fn().mockRejectedValue(new Error('storage unavailable'))
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" onSaveProfile={onSaveProfile} />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })
    fireEvent.change(screen.getByPlaceholderText('例如 内网 PG'), { target: { value: 'API' } })
    fireEvent.click(screen.getByText('保存为连接'))

    expect(await screen.findByRole('alert')).toHaveTextContent('storage unavailable')
    expect(screen.getByText('保存为连接')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(h.tunnelOpen).not.toHaveBeenCalled()
  })

  it('clears the forward form and feedback when the active host changes', async () => {
    const panel = (sessionId: string, activeConnId: string) => (
      <LanguageProvider>
        <DataProvider>
          <TunnelsPanel onClose={() => {}} sessionId={sessionId} activeConnId={activeConnId} />
        </DataProvider>
      </LanguageProvider>
    )
    const { rerender } = render(panel('sess-a', 'conn-a'))
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByTitle('新建转发'))
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '9999' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '8000' } })

    rerender(panel('sess-b', 'conn-b'))
    await waitFor(() => expect(screen.queryByLabelText('本地映射端口')).toBeNull())

    fireEvent.click(screen.getByTitle('新建转发'))
    await waitFor(() => expect(screen.getByLabelText('本地映射端口')).toHaveValue(49152))
    expect(screen.getByPlaceholderText('10.0.4.2')).toHaveValue('10.0.0.12')
    expect(screen.getByLabelText('远程服务端口')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('本地映射端口'), { target: { value: '7777' } })
    fireEvent.change(screen.getByLabelText('远程服务端口'), { target: { value: '9000' } })
    fireEvent.click(screen.getByText('添加'))

    await waitFor(() => expect(h.tunnelOpen).toHaveBeenCalledWith('sess-b', {
      kind: 'L',
      bind: '7777',
      target: '10.0.0.12:9000',
    }))
  })

  it('hides the previous host tunnels immediately while the next host is loading', async () => {
    let resolveNextLoad: (tunnels: typeof MOCK_TUNNELS) => void = () => {}
    h.getTunnels
      .mockResolvedValueOnce(MOCK_TUNNELS)
      .mockReturnValueOnce(new Promise<typeof MOCK_TUNNELS>(resolve => { resolveNextLoad = resolve }))
    const panel = (sessionId: string) => (
      <LanguageProvider>
        <DataProvider><TunnelsPanel onClose={() => {}} sessionId={sessionId} /></DataProvider>
      </LanguageProvider>
    )
    const { rerender } = render(panel('sess-a'))
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    rerender(panel('sess-b'))
    await waitFor(() => expect(screen.queryByText('prod-orders')).toBeNull())
    expect(screen.queryByRole('switch')).toBeNull()

    resolveNextLoad([])
    await waitFor(() => expect(h.getTunnels).toHaveBeenCalledWith('sess-b'))
  })

  it('unsubscribes an event listener that resolves after a host switch', async () => {
    const unlisten = vi.fn()
    let resolveListen: (unlisten: () => void) => void = () => {}
    h.getTunnels.mockResolvedValueOnce([MOCK_TUNNELS[0]]).mockResolvedValueOnce([])
    h.listen.mockReturnValueOnce(new Promise(resolve => { resolveListen = resolve }))
    const panel = (sessionId: string) => (
      <LanguageProvider>
        <DataProvider><TunnelsPanel onClose={() => {}} sessionId={sessionId} /></DataProvider>
      </LanguageProvider>
    )
    const { rerender } = render(panel('sess-a'))
    await waitFor(() => expect(h.listen).toHaveBeenCalledWith('tunnel://tun-1', expect.any(Function)))

    rerender(panel('sess-b'))
    resolveListen(unlisten)
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })

  it('copies the local mapped address when it is clicked', async () => {
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '复制 localhost:5432' }))

    expect(h.copyTextToClipboard).toHaveBeenCalledWith('localhost:5432')
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制 localhost:5432' })).toHaveAttribute('title', '已复制'))
  })

  it('does not show copied feedback when copying the local address fails', async () => {
    h.copyTextToClipboard.mockResolvedValue(false)
    wrap(<TunnelsPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('prod-orders')).toBeTruthy())

    const copy = screen.getByRole('button', { name: '复制 localhost:5432' })
    fireEvent.click(copy)

    expect(h.copyTextToClipboard).toHaveBeenCalledWith('localhost:5432')
    expect(copy).toHaveAttribute('title', '复制')
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败')
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
    h.getTunnelDefaults.mockResolvedValue({ remoteHost: '10.0.0.12', localPort: 49152 })
    h.listen.mockResolvedValue(() => {})
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    h.getTunnels.mockClear()
    h.getTunnelDefaults.mockClear()
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
      // Local node (the ProxyJump chain node is a .mono span — scope to it so the
      // empty-state "本地" mode label doesn't make this ambiguous)
      expect(screen.getByText('本地', { selector: '.mono' })).toBeTruthy()
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
      // Local node (scope to the .mono ProxyJump span; empty-state also shows a "本地" label)
      expect(screen.getByText('本地', { selector: '.mono' })).toBeTruthy()
      // Target node
      expect(screen.getByText('direct-host')).toBeTruthy()
    })
    // No jump node
    expect(screen.queryByText('bastion.example.com')).toBeNull()
  })
})
