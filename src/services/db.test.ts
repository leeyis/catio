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

  it('testConnection forwards args to db_test_connection under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ version: 'PostgreSQL 16.2', latencyMs: 12 })
    const { testConnection } = await import('./db')
    const r = await testConnection({ dbType: 'postgres', host: 'h', port: 5432, user: 'u', secret: 'p' })
    expect(invokeMock).toHaveBeenCalledWith('db_test_connection', expect.objectContaining({ args: expect.any(Object) }))
    expect(r.version).toBe('PostgreSQL 16.2')
    expect(r.latencyMs).toBe(12)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('testConnection throws outside Tauri', async () => {
    const { testConnection } = await import('./db')
    await expect(testConnection({ dbType: 'postgres', host: 'h', port: 5432, user: 'u' }))
      .rejects.toThrow('Tauri')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('runQuery falls back to mock outside Tauri', async () => {
    const { runQuery } = await import('./db')
    const r = await runQuery('any', 'SELECT 1')
    expect(r.columns.length).toBeGreaterThan(0)
    expect(Array.isArray(r.rows)).toBe(true)
  })

  it('runQuery forwards default namespace under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ columns: [], rows: [] })
    const { runQuery } = await import('./db')
    await runQuery('conn-1', 'SELECT * FROM orders', 'dwd')
    expect(invokeMock).toHaveBeenCalledWith('db_query', {
      connId: 'conn-1',
      sql: 'SELECT * FROM orders',
      defaultNamespace: 'dwd',
    })
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('runQuery forwards connection meta (name/engine/profileId) under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ columns: [], rows: [] })
    const { runQuery } = await import('./db')
    await runQuery('conn-1', 'SELECT 1', undefined, { name: 'ttfund', engine: 'mongodb', profileId: 'db-7' })
    expect(invokeMock).toHaveBeenCalledWith('db_query', {
      connId: 'conn-1',
      sql: 'SELECT 1',
      connName: 'ttfund',
      engine: 'mongodb',
      profileId: 'db-7',
    })
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
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

  it('queryPage forwards default namespace under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({ columns: [], rows: [] })
    const { queryPage } = await import('./db')
    await queryPage('conn-1', 'SELECT * FROM orders', 100, 100, 'dwd')
    expect(invokeMock).toHaveBeenCalledWith('db_query_page', {
      connId: 'conn-1',
      sql: 'SELECT * FROM orders',
      limit: 100,
      offset: 100,
      defaultNamespace: 'dwd',
    })
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('getHistory falls back to mock (DATA.history) outside Tauri', async () => {
    const { getHistory } = await import('./db')
    const { DATA } = await import('./mockData')
    const r = await getHistory('any')
    expect(r).toEqual(DATA.history)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('schemaColumns returns [] outside Tauri (mock fallback)', async () => {
    const { schemaColumns } = await import('./db')
    const r = await schemaColumns('any', 'public')
    expect(r).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('schemaColumns forwards to db_schema_columns under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue([['orders', ['id', 'status']], ['customers', ['id', 'name']]])
    const { schemaColumns } = await import('./db')
    const r = await schemaColumns('conn-1', 'public')
    expect(invokeMock).toHaveBeenCalledWith('db_schema_columns', { connId: 'conn-1', schema: 'public' })
    expect(r).toEqual([['orders', ['id', 'status']], ['customers', ['id', 'name']]])
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('tableStructure threads column- and table-level comments from the backend', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({
      comment: '机构发行信息表',
      columns: [
        { name: 'id', typeName: 'int', nullable: false, default: null, key: 'PK', comment: '主键' },
        { name: 'secucode', typeName: 'varchar(20)', nullable: true, default: null, key: '', comment: '证券代码' },
      ],
      indexes: [],
      fks: [],
    })
    const { tableStructure } = await import('./db')
    const st = await tableStructure('conn-1', 'eastmoney', 'ods_org_issueinfo')
    expect(invokeMock).toHaveBeenCalledWith('db_table_structure', { connId: 'conn-1', schema: 'eastmoney', table: 'ods_org_issueinfo' })
    expect(st.comment).toBe('机构发行信息表')
    expect(st.columns[0].comment).toBe('主键')
    expect(st.columns[1].comment).toBe('证券代码')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('tableStructure defaults missing comments to empty strings (engines without native comments)', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockResolvedValue({
      columns: [{ name: 'id', typeName: 'int', nullable: false, default: null, key: 'PK' }],
      indexes: [],
      fks: [],
    })
    const { tableStructure } = await import('./db')
    const st = await tableStructure('conn-1', 'main', 't')
    expect(st.comment).toBe('')
    expect(st.columns[0].comment).toBe('')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
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
