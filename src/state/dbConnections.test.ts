import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  listDbConnections, saveDbConnection, removeDbConnection,
  setActiveDbConnection, getActiveDbConnection, listActiveDbConnections, removeActiveDbConnection,
  useActiveDbConnections,
  generateProfileId, dbProfileToConnection,
} from './dbConnections'
import type { DbProfile } from './dbConnections'
import type { DbConnectResult } from '../services/db'
import { dialectFor } from '../components/dbviews/structureDdl'

beforeEach(() => {
  localStorage.clear()
  // Reset in-memory active store between tests by removing all entries
  for (const c of listActiveDbConnections()) {
    removeActiveDbConnection(c.connId)
  }
})

describe('DB connection profiles', () => {
  it('save/list round-trip persists to localStorage without secret', () => {
    const profile: DbProfile = {
      id: 'db-1',
      name: 'prod-orders',
      dbType: 'postgres',
      host: '10.0.4.2',
      port: 5432,
      user: 'app_ro',
      database: 'orders',
    }
    saveDbConnection(profile)

    // Verify raw localStorage key
    const raw = localStorage.getItem('catio-db-connections')
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('secret')

    const list = listDbConnections()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('db-1')
    expect(list[0].host).toBe('10.0.4.2')
    expect(list[0].port).toBe(5432)
    expect(list[0].user).toBe('app_ro')
    expect(list[0].database).toBe('orders')
    // TypeScript enforces no `secret` on DbProfile, but double-check at runtime
    expect('secret' in list[0]).toBe(false)
  })

  it('updates an existing profile by id (upsert)', () => {
    const p: DbProfile = { id: 'db-2', name: 'staging', dbType: 'mysql', host: 'h', port: 3306, user: 'u' }
    saveDbConnection(p)
    saveDbConnection({ ...p, host: 'h2' })
    const list = listDbConnections()
    expect(list).toHaveLength(1)
    expect(list[0].host).toBe('h2')
  })

  it('removeDbConnection deletes by id', () => {
    const p: DbProfile = { id: 'db-3', name: 'local', dbType: 'sqlite', host: ':memory:', port: 0, user: '' }
    saveDbConnection(p)
    expect(listDbConnections()).toHaveLength(1)
    removeDbConnection('db-3')
    expect(listDbConnections()).toHaveLength(0)
  })

  it('listDbConnections returns [] when storage is empty', () => {
    expect(listDbConnections()).toEqual([])
  })

  it('stores multiple profiles independently', () => {
    const a: DbProfile = { id: 'a', name: 'A', dbType: 'postgres', host: 'ha', port: 5432, user: 'ua' }
    const b: DbProfile = { id: 'b', name: 'B', dbType: 'mysql', host: 'hb', port: 3306, user: 'ub' }
    saveDbConnection(a)
    saveDbConnection(b)
    const list = listDbConnections()
    expect(list).toHaveLength(2)
    expect(list.map(p => p.id).sort()).toEqual(['a', 'b'])
  })
})

describe('active DB connection store (in-memory)', () => {
  const mockResult: DbConnectResult = {
    connId: 'conn-abc-123',
    version: '16.2',
    capabilities: {
      writable: true,
      transactions: true,
      schemas: true,
      sqlConsole: true,
      er: true,
      structureEdit: true,
      views: true,
      functions: true,
    },
  }
  const mockProfile = { id: 'db-profile-1', name: 'prod-orders', dbType: 'postgres' as const }

  it('set → get round-trip stores connId and capabilities', () => {
    setActiveDbConnection(mockResult, mockProfile)
    const stored = getActiveDbConnection('conn-abc-123')
    expect(stored).toBeDefined()
    expect(stored!.connId).toBe('conn-abc-123')
    expect(stored!.capabilities.writable).toBe(true)
    expect(stored!.capabilities.sqlConsole).toBe(true)
  })

  it('set → list includes the connection', () => {
    setActiveDbConnection(mockResult, mockProfile)
    const list = listActiveDbConnections()
    expect(list).toHaveLength(1)
    expect(list[0].connId).toBe('conn-abc-123')
    expect(list[0].profileId).toBe('db-profile-1')
    expect(list[0].dbType).toBe('postgres')
    expect(list[0].name).toBe('prod-orders')
  })

  it('stored entry contains no secret field', () => {
    setActiveDbConnection(mockResult, mockProfile)
    const stored = getActiveDbConnection('conn-abc-123')
    expect(stored).toBeDefined()
    expect('secret' in stored!).toBe(false)
    expect(JSON.stringify(stored)).not.toContain('secret')
  })

  it('removeActiveDbConnection deletes by connId', () => {
    setActiveDbConnection(mockResult, mockProfile)
    expect(listActiveDbConnections()).toHaveLength(1)
    removeActiveDbConnection('conn-abc-123')
    expect(listActiveDbConnections()).toHaveLength(0)
    expect(getActiveDbConnection('conn-abc-123')).toBeUndefined()
  })

  it('multiple connections stored independently', () => {
    const result2: DbConnectResult = { connId: 'conn-xyz-999', version: '8.0', capabilities: { ...mockResult.capabilities, writable: false } }
    const profile2 = { id: 'db-profile-2', name: 'catalog-stg', dbType: 'mysql' as const }
    setActiveDbConnection(mockResult, mockProfile)
    setActiveDbConnection(result2, profile2)
    const list = listActiveDbConnections()
    expect(list).toHaveLength(2)
    expect(list.map(c => c.connId).sort()).toEqual(['conn-abc-123', 'conn-xyz-999'])
  })

  // 回归(codex P2):跨库迁移的连接候选必须在「workbench 已挂载后」新连接接入时刷新。
  // useActiveDbConnections 须在 set/remove 后通知订阅者重渲染。
  it('useActiveDbConnections re-renders when a NEW connection is added after subscribe', () => {
    const { result } = renderHook(() => useActiveDbConnections())
    expect(result.current).toHaveLength(0)

    act(() => { setActiveDbConnection(mockResult, mockProfile) })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].connId).toBe('conn-abc-123')

    // 第二个连接(模拟在源 workbench 打开之后才连上的目标库)。
    const result2: DbConnectResult = { connId: 'conn-target', version: '16', capabilities: mockResult.capabilities }
    act(() => { setActiveDbConnection(result2, { id: 'db-profile-2', name: 'target-pg', dbType: 'postgres' }) })
    expect(result.current).toHaveLength(2)
    expect(result.current.map(c => c.connId)).toContain('conn-target')
  })

  it('useActiveDbConnections re-renders when a connection is removed', () => {
    setActiveDbConnection(mockResult, mockProfile)
    const { result } = renderHook(() => useActiveDbConnections())
    expect(result.current).toHaveLength(1)
    act(() => { removeActiveDbConnection('conn-abc-123') })
    expect(result.current).toHaveLength(0)
  })
})

describe('dbProfileToConnection — engine family vs catalog id', () => {
  // Regression (codex P1): a MySQL-wire variant must report the protocol family
  // as `engine` so structureDdl.dialectFor() picks the MySQL dialect; the catalog
  // id rides separately in `engineId` for the brand glyph.
  it('maps a MySQL-wire variant to engine=mysql (+ engineId) and selects the MySQL DDL dialect', () => {
    const p: DbProfile = {
      id: 'db-1', name: 'gd', dbType: 'mysql', driverProfile: 'goldendb',
      engineId: 'goldendb', host: 'h', port: 3306, user: 'u',
    }
    const c = dbProfileToConnection(p)
    expect(c.engine).toBe('mysql')        // family → correct DDL quoting
    expect(c.engineId).toBe('goldendb')   // variant → brand logo
    expect(dialectFor(c.engine)).toBe('mysql')
  })

  it('keeps engine as the family for a PG-wire variant too', () => {
    const p: DbProfile = {
      id: 'db-2', name: 'crdb', dbType: 'postgres', driverProfile: 'cockroachdb',
      engineId: 'cockroachdb', host: 'h', port: 26257, user: 'u',
    }
    const c = dbProfileToConnection(p)
    expect(c.engine).toBe('postgres')
    expect(c.engineId).toBe('cockroachdb')
    expect(dialectFor(c.engine)).toBe('postgres')
  })
})

describe('generateProfileId', () => {
  it('returns a string starting with db-', () => {
    const id = generateProfileId()
    expect(typeof id).toBe('string')
    expect(id.startsWith('db-')).toBe(true)
  })

  it('generates unique ids on repeated calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateProfileId()))
    expect(ids.size).toBe(20)
  })
})
