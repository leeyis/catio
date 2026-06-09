import { describe, it, expect } from 'vitest'
import { DB_ENGINES, ENGINE_GROUP_ORDER, enginesByGroup, findEngine, matchEngineId } from './dbEngines'

describe('DB_ENGINES catalog', () => {
  it('has unique ids', () => {
    const ids = DB_ENGINES.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only references known backend protocol families', () => {
    const families = new Set([
      'postgres', 'mysql', 'sqlite', 'duckdb', 'sqlserver',
      'clickhouse', 'elasticsearch', 'rqlite', 'mongodb', 'redis', 'jdbc',
    ])
    for (const e of DB_ENGINES) expect(families.has(e.dbType)).toBe(true)
  })

  it('all JDBC-family engines carry a driverProfile (the engine selector)', () => {
    for (const e of DB_ENGINES.filter(e => e.dbType === 'jdbc')) {
      expect(e.driverProfile, `${e.id} needs a driverProfile`).toBeTruthy()
    }
  })

  it('every engine belongs to a known group', () => {
    for (const e of DB_ENGINES) expect(ENGINE_GROUP_ORDER).toContain(e.group)
  })

  it('maps protocol-family variants to the right dbType + profile', () => {
    expect(findEngine('cockroachdb')).toMatchObject({ dbType: 'postgres', driverProfile: 'cockroachdb', defaultPort: 26257 })
    expect(findEngine('tidb')).toMatchObject({ dbType: 'mysql', driverProfile: 'tidb', defaultPort: 4000 })
    expect(findEngine('oceanbase-oracle')).toMatchObject({ dbType: 'mysql', driverProfile: 'oceanbase-oracle' })
    expect(findEngine('kingbase')).toMatchObject({ dbType: 'postgres', driverProfile: 'kingbase' })
  })

  it('plain family engines carry no driverProfile', () => {
    expect(findEngine('postgres')?.driverProfile).toBeUndefined()
    expect(findEngine('mysql')?.driverProfile).toBeUndefined()
  })

  it('file-based engines have port 0', () => {
    expect(findEngine('sqlite')?.defaultPort).toBe(0)
    expect(findEngine('duckdb')?.defaultPort).toBe(0)
  })
})

describe('enginesByGroup', () => {
  it('partitions every engine exactly once, in group order', () => {
    const grouped = enginesByGroup()
    expect(grouped.map(g => g.group)).toEqual(ENGINE_GROUP_ORDER)
    const flat = grouped.flatMap(g => g.engines)
    expect(flat.length).toBe(DB_ENGINES.length)
  })
})

describe('matchEngineId (reverse lookup for legacy profiles)', () => {
  it('resolves a dbType+profile back to its catalog id', () => {
    expect(matchEngineId('postgres', 'cockroachdb')).toBe('cockroachdb')
    expect(matchEngineId('mysql', 'mariadb')).toBe('mariadb')
  })
  it('resolves a bare family (no profile) to the plain engine', () => {
    expect(matchEngineId('postgres')).toBe('postgres')
    expect(matchEngineId('mysql', undefined)).toBe('mysql')
  })
  it('returns undefined for an unknown combination', () => {
    expect(matchEngineId('postgres', 'no-such-profile')).toBeUndefined()
    expect(matchEngineId(undefined)).toBeUndefined()
  })
})
