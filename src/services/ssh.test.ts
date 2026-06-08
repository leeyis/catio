import { describe, it, expect, vi, beforeEach } from 'vitest'

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

  it('getSftp returns empty state outside Tauri (no mock fallback)', async () => {
    const { getSftp } = await import('./ssh')
    // Outside Tauri (no __TAURI_INTERNALS__), getSftp returns empty regardless of sessionId
    const s = await getSftp('any')
    expect(s.items.length).toBe(0)
    expect(s.path).toBe('')
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
})
