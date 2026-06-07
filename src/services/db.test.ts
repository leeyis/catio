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

  it('previewDml forwards to db_preview_dml under Tauri and returns the SQL', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue('UPDATE public.orders SET status = $1 WHERE id = $2')
    const { previewDml } = await import('./db')
    const req = {
      table: 'orders', schema: 'public', kind: 'update' as const,
      pk: [['id', 11] as [string, unknown]],
      cells: [['status', 'shipped'] as [string, unknown]],
    }
    const sql = await previewDml('conn-1', req)
    expect(invokeMock).toHaveBeenCalledWith('db_preview_dml', { connId: 'conn-1', req })
    expect(sql).toBe('UPDATE public.orders SET status = $1 WHERE id = $2')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('queryPage falls back to mock outside Tauri', async () => {
    const { queryPage } = await import('./db')
    const r = await queryPage('any', 'SELECT 1', 50, 0)
    expect(r.columns.length).toBeGreaterThan(0)
  })

  it('getHistory falls back to mock (DATA.history) outside Tauri', async () => {
    const { getHistory } = await import('./db')
    const { DATA } = await import('./mockData')
    const r = await getHistory('any')
    expect(r).toEqual(DATA.history)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('getHistory forwards to db_history under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue([{ id: 'hist-1', kind: 'sql', target: 'conn-1', text: 'SELECT 1', when: '0', dur: '1ms' }])
    const { getHistory } = await import('./db')
    const r = await getHistory('conn-1')
    expect(invokeMock).toHaveBeenCalledWith('db_history', { connId: 'conn-1' })
    expect(r[0].id).toBe('hist-1')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })
})
