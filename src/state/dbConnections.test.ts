import { describe, it, expect, beforeEach } from 'vitest'
import {
  listDbConnections, saveDbConnection, removeDbConnection,
  setActiveDbConnection, getActiveDbConnection, listActiveDbConnections, removeActiveDbConnection,
  generateProfileId,
} from './dbConnections'
import type { DbProfile } from './dbConnections'
import type { DbConnectResult } from '../services/db'

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
