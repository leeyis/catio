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

  it('getSftp falls back to mock DATA outside Tauri', async () => {
    const { getSftp } = await import('./ssh')
    const s = await getSftp('any')
    expect(s.items.length).toBeGreaterThan(0)
  })
})
