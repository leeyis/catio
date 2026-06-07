import { describe, it, expect, beforeEach } from 'vitest'
import { listDbConnections, saveDbConnection, removeDbConnection } from './dbConnections'
import type { DbProfile } from './dbConnections'

beforeEach(() => localStorage.clear())

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
