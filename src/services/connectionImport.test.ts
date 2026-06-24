import { describe, it, expect } from 'vitest'
import {
  parseDbeaverConnections,
  parseNavicatConnections,
  parseImportFile,
} from './connectionImport'

// ---- DBeaver: data-sources.json (raw, no credentials) ----

describe('parseDbeaverConnections', () => {
  it('maps a MySQL connection from configuration host/port/user', () => {
    const json = JSON.stringify({
      connections: {
        'mysql-1': {
          provider: 'mysql',
          name: 'prod-mysql',
          configuration: {
            host: 'db.example.com',
            port: '3306',
            'database-name': 'orders',
            user: 'appuser',
          },
        },
      },
    })
    const drafts = parseDbeaverConnections(json)
    expect(drafts).toHaveLength(1)
    const d = drafts[0]
    expect(d.name).toBe('prod-mysql')
    expect(d.dbType).toBe('mysql')
    expect(d.engineId).toBe('mysql')
    expect(d.host).toBe('db.example.com')
    expect(d.port).toBe(3306)
    expect(d.user).toBe('appuser')
    expect(d.database).toBe('orders')
    // No password available in a raw data-sources.json → draft needs auth.
    expect(d.needsAuth).toBe(true)
  })

  it('maps PostgreSQL provider to postgres engine', () => {
    const json = JSON.stringify({
      connections: {
        c1: {
          provider: 'postgresql',
          name: 'pg',
          configuration: { host: '10.0.0.5', port: '5432', user: 'postgres' },
        },
      },
    })
    const [d] = parseDbeaverConnections(json)
    expect(d.dbType).toBe('postgres')
    expect(d.engineId).toBe('postgres')
    expect(d.port).toBe(5432)
  })

  it('parses host/port/database out of a JDBC url when configuration lacks them', () => {
    const json = JSON.stringify({
      connections: {
        c1: {
          provider: 'postgresql',
          name: 'via-url',
          configuration: { url: 'jdbc:postgresql://urlhost:6432/mydb' },
        },
      },
    })
    const [d] = parseDbeaverConnections(json)
    expect(d.host).toBe('urlhost')
    expect(d.port).toBe(6432)
    expect(d.database).toBe('mydb')
  })

  it('maps a domestic engine (dameng) to the jdbc dameng profile', () => {
    const json = JSON.stringify({
      connections: {
        c1: {
          provider: 'dm',
          name: 'dm-server',
          configuration: { host: 'dmhost', port: '5236', user: 'SYSDBA' },
        },
      },
    })
    const [d] = parseDbeaverConnections(json)
    expect(d.dbType).toBe('jdbc')
    expect(d.engineId).toBe('dameng')
    expect(d.driverProfile).toBe('dameng')
  })

  it('falls back to the engine default port when none is given', () => {
    const json = JSON.stringify({
      connections: {
        c1: { provider: 'mysql', name: 'noport', configuration: { host: 'h' } },
      },
    })
    const [d] = parseDbeaverConnections(json)
    expect(d.port).toBe(3306)
  })

  it('deduplicates identical connections', () => {
    const entry = {
      provider: 'mysql',
      name: 'dup',
      configuration: { host: 'h', port: '3306', user: 'u', 'database-name': 'd' },
    }
    const json = JSON.stringify({ connections: { a: entry, b: entry } })
    expect(parseDbeaverConnections(json)).toHaveLength(1)
  })

  it('returns [] for non-DBeaver JSON', () => {
    expect(parseDbeaverConnections('{"foo":1}')).toEqual([])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseDbeaverConnections('not json')).toThrow()
  })
})

// ---- Navicat: .ncx XML ----

describe('parseNavicatConnections', () => {
  it('maps a MySQL connection from a Navicat .ncx attribute node', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Connections>
        <Connection ConnectionName="nav-mysql" ConnType="MySQL"
          Host="mysql.local" Port="3306" UserName="root" Database="shop"/>
      </Connections>`
    const drafts = parseNavicatConnections(xml)
    expect(drafts).toHaveLength(1)
    const d = drafts[0]
    expect(d.name).toBe('nav-mysql')
    expect(d.dbType).toBe('mysql')
    expect(d.host).toBe('mysql.local')
    expect(d.port).toBe(3306)
    expect(d.user).toBe('root')
    expect(d.database).toBe('shop')
    expect(d.needsAuth).toBe(true)
  })

  it('maps a PostgreSQL Navicat connection', () => {
    const xml = `<Connections>
      <Connection ConnectionName="nav-pg" ConnType="PostgreSQL" Host="pg.local" Port="5432" UserName="postgres"/>
    </Connections>`
    const [d] = parseNavicatConnections(xml)
    expect(d.dbType).toBe('postgres')
    expect(d.engineId).toBe('postgres')
  })

  it('falls back to the engine default port when Port is absent', () => {
    const xml = `<Connections>
      <Connection ConnectionName="nav" ConnType="MySQL" Host="h" UserName="u"/>
    </Connections>`
    const [d] = parseNavicatConnections(xml)
    expect(d.port).toBe(3306)
  })

  it('skips non-database connection types (ssh/ftp)', () => {
    const xml = `<Connections>
      <Connection ConnectionName="tunnel" ConnType="SSH" Host="h" UserName="u"/>
    </Connections>`
    expect(parseNavicatConnections(xml)).toEqual([])
  })

  it('throws on invalid XML', () => {
    expect(() => parseNavicatConnections('<broken')).toThrow()
  })
})

// ---- Auto-detect dispatcher ----

describe('parseImportFile', () => {
  it('detects DBeaver JSON by extension/content', () => {
    const json = JSON.stringify({
      connections: { c1: { provider: 'mysql', name: 'a', configuration: { host: 'h' } } },
    })
    const r = parseImportFile('data-sources.json', json)
    expect(r.source).toBe('dbeaver')
    expect(r.drafts).toHaveLength(1)
  })

  it('detects Navicat XML by extension/content', () => {
    const xml = `<Connections><Connection ConnectionName="a" ConnType="MySQL" Host="h" UserName="u"/></Connections>`
    const r = parseImportFile('export.ncx', xml)
    expect(r.source).toBe('navicat')
    expect(r.drafts).toHaveLength(1)
  })
})
