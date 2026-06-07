import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('services/db', () => {
  beforeEach(() => { invokeMock.mockReset() })

  it('dbConnect forwards args to invoke under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ connId: 'conn-1', version: 'PostgreSQL 16', capabilities: {} })
    const { dbConnect } = await import('./db')
    const r = await dbConnect({ dbType: 'postgres', host: 'h', port: 5432, user: 'u', secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('db_connect', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.connId).toBe('conn-1')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('runQuery falls back to mock outside Tauri', async () => {
    const { runQuery } = await import('./db')
    const r = await runQuery('any', 'SELECT 1')
    expect(r.columns.length).toBeGreaterThan(0)
    expect(Array.isArray(r.rows)).toBe(true)
  })
})
