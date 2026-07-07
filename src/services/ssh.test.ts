import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('services/ssh', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('sshConnect forwards args to invoke under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ sessionId: 'sess-1', hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true })
    const { sshConnect } = await import('./ssh')
    const r = await sshConnect({ host: 'h', port: 22, user: 'u', auth: { method: 'password' }, secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('ssh_connect', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.sessionId).toBe('sess-1')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('sftpList returns empty state outside Tauri (no mock fallback)', async () => {
    const { sftpList } = await import('./ssh')
    // Outside Tauri (no __TAURI_INTERNALS__), sftpList returns [] regardless of sessionId
    const items = await sftpList('any', '.')
    expect(items.length).toBe(0)
  })

  it('sshTest forwards args to invoke under Tauri and returns the result', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ ok: true, latencyMs: 42 })
    const { sshTest } = await import('./ssh')
    const r = await sshTest({ host: 'h', port: 22, user: 'u', auth: { method: 'password' }, secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('ssh_test', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.ok).toBe(true)
    expect(r.latencyMs).toBe(42)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('sshTest returns a non-success desktop-only result outside Tauri', async () => {
    const { sshTest } = await import('./ssh')
    const r = await sshTest({ host: 'h', port: 22, user: 'u', auth: { method: 'password' } })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('desktop-only')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('sshSysinfo returns empty string outside Tauri', async () => {
    // Ensure no Tauri environment is present.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__TAURI__
    const { sshSysinfo } = await import('./ssh')
    const result = await sshSysinfo('sess-1')
    expect(result).toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('sshSysinfo invokes ssh_sysinfo under Tauri and returns the result', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue('## OS\nUbuntu 22.04')
    const { sshSysinfo } = await import('./ssh')
    const result = await sshSysinfo('sess-2')
    expect(invokeMock).toHaveBeenCalledWith('ssh_sysinfo', { sessionId: 'sess-2' })
    expect(result).toBe('## OS\nUbuntu 22.04')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('detects SSH session-loss errors without treating ordinary SFTP errors as disconnects', async () => {
    const { isSshSessionLostError, sshErrorMessage } = await import('./ssh')

    expect(isSshSessionLostError({ kind: 'NotFound', message: 'session not found: sess-1' })).toBe(true)
    expect(isSshSessionLostError(new Error('channel closed'))).toBe(true)
    expect(isSshSessionLostError(new Error('io error: connection reset by peer'))).toBe(true)
    expect(isSshSessionLostError(new Error('sftp error: Permission denied'))).toBe(false)
    expect(sshErrorMessage({ message: 'session not found: sess-1' })).toBe('session not found: sess-1')
  })
})

// Port-forwarding (tunnels) must route over the HTTP transport in server (web) mode — the original
// bug was these three calling Tauri `invoke` directly, so in the browser they rejected silently.
describe('services/ssh — tunnels route over HTTP in server mode', () => {
  const fetchMock = vi.fn()
  const okJson = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })

  beforeEach(() => {
    invokeMock.mockReset()
    fetchMock.mockReset()
    ;(globalThis as unknown as Record<string, unknown>).fetch = fetchMock
    ;(window as unknown as Record<string, unknown>).__CATIO_SERVER__ = true
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__CATIO_SERVER__
  })

  it('tunnelOpen POSTs tunnel_open through /api/invoke (not Tauri invoke)', async () => {
    fetchMock.mockResolvedValue(okJson('tun-1'))
    const { tunnelOpen } = await import('./ssh')
    const id = await tunnelOpen('sess-1', { kind: 'L', bind: '127.0.0.1:8080', target: '10.0.4.2:5432' })
    expect(id).toBe('tun-1')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('/api/invoke', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      cmd: 'tunnel_open',
      args: { sessionId: 'sess-1', spec: { kind: 'L', bind: '127.0.0.1:8080', target: '10.0.4.2:5432' } },
    })
  })

  it('getTunnels lists tunnel_list and maps the wire shape', async () => {
    fetchMock.mockResolvedValue(okJson([
      { id: 'tun-1', kind: 'L', bind: '127.0.0.1:8080', target: '10.0.4.2:5432', bytesUp: 1024, bytesDown: 0, status: 'up' },
    ]))
    const { getTunnels } = await import('./ssh')
    const list = await getTunnels('sess-1')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ id: 'tun-1', type: 'L', local: '127.0.0.1:8080', remote: '10.0.4.2:5432', status: 'up' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.cmd).toBe('tunnel_list')
  })

  it('tunnelClose closes through /api/invoke', async () => {
    fetchMock.mockResolvedValue(okJson(null))
    const { tunnelClose } = await import('./ssh')
    await tunnelClose('tun-1')
    expect(invokeMock).not.toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ cmd: 'tunnel_close', args: { tunnelId: 'tun-1' } })
  })
})
