import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

type Win = Record<string, unknown>
function setTauri(on: boolean) {
  if (on) (window as unknown as Win).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Win).__TAURI_INTERNALS__
}
function setServer(on: boolean) {
  if (on) (window as unknown as Win).__CATIO_SERVER__ = true
  else delete (window as unknown as Win).__CATIO_SERVER__
}

describe('services/transport', () => {
  beforeEach(() => { invokeMock.mockReset(); setTauri(false); setServer(false) })
  afterEach(() => { setTauri(false); setServer(false); vi.unstubAllGlobals() })

  it('isTauri / isServer reflect the window flags', async () => {
    const { isTauri, isServer } = await import('./transport')
    expect(isTauri()).toBe(false)
    expect(isServer()).toBe(false)
    setTauri(true); expect(isTauri()).toBe(true)
    setTauri(false); setServer(true); expect(isServer()).toBe(true)
  })

  it('rpc routes to Tauri invoke under Tauri', async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ ok: 1 })
    const { rpc } = await import('./transport')
    const r = await rpc('db_query', { connId: 'c1', sql: 'SELECT 1' })
    expect(invokeMock).toHaveBeenCalledWith('db_query', { connId: 'c1', sql: 'SELECT 1' })
    expect(r).toEqual({ ok: 1 })
  })

  it('rpc POSTs to /api/invoke under server mode and returns parsed json', async () => {
    setServer(true)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ rows: [[1]] })),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rpc } = await import('./transport')
    const r = await rpc('db_query', { connId: 'c1', sql: 'SELECT 1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/invoke')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body)).toEqual({ cmd: 'db_query', args: { connId: 'c1', sql: 'SELECT 1' } })
    expect(r).toEqual({ rows: [[1]] })
  })

  it('rpc throws the server-supplied error message on non-2xx', async () => {
    setServer(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ error: 'connection not found' })),
    }))
    const { rpc } = await import('./transport')
    await expect(rpc('db_query', {})).rejects.toThrow('connection not found')
  })

  it('rpc throws when neither transport is active (mock path is the callers responsibility)', async () => {
    const { rpc } = await import('./transport')
    await expect(rpc('db_query', {})).rejects.toThrow(/no transport|mock/i)
  })

  it('rpc surfaces the HTTP status (not a JSON parse error) when a proxy returns HTML', async () => {
    setServer(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 502,
      text: () => Promise.resolve('<html><body>502 Bad Gateway</body></html>'),
    }))
    const { rpc } = await import('./transport')
    await expect(rpc('db_query', {})).rejects.toThrow('HTTP 502')
  })
})
