import { describe, it, expect } from 'vitest'
import { toCsv, toJson } from './exportResults'
import type { ScanRow } from './types'

function mkHostRow(over: Partial<ScanRow> = {}): ScanRow {
  return {
    rowId: '10.0.0.1:22',
    selected: true,
    existing: false,
    scanId: 's1',
    ip: '10.0.0.1',
    port: 22,
    address: '10.0.0.1:22',
    kind: 'host',
    os: 'Linux',
    version: 'OpenSSH 8.9',
    status: 'authed',
    hitUser: 'root',
    hitSecret: 'sup3r-secret',
    hitAuthKind: 'password',
    ...over,
  }
}

function mkDbRow(over: Partial<ScanRow> = {}): ScanRow {
  return {
    rowId: '10.0.0.2:5432#postgres',
    selected: true,
    existing: false,
    scanId: 's1',
    ip: '10.0.0.2',
    port: 5432,
    address: '10.0.0.2:5432',
    kind: 'db',
    engineId: 'postgres',
    dbType: 'postgres',
    version: 'PostgreSQL 16',
    status: 'authed',
    hitUser: 'admin',
    hitSecret: 'pg-secret',
    hitAuthKind: 'password',
    ...over,
  }
}

describe('toCsv', () => {
  it('表头为 地址,引擎/OS,版本,命中用户,状态', () => {
    const csv = toCsv([])
    expect(csv).toBe('地址,引擎/OS,版本,命中用户,状态')
  })

  it('host 行输出 OS，db 行输出 engineId', () => {
    const csv = toCsv([mkHostRow(), mkDbRow()])
    const lines = csv.split('\n')
    expect(lines[1]).toBe('10.0.0.1:22,Linux,OpenSSH 8.9,root,authed')
    expect(lines[2]).toBe('10.0.0.2:5432,postgres,PostgreSQL 16,admin,authed')
  })

  it('不导出明文 hitSecret', () => {
    const csv = toCsv([mkHostRow()])
    expect(csv).not.toContain('sup3r-secret')
  })

  it('CSV 转义含逗号/引号的字段', () => {
    const csv = toCsv([mkHostRow({ version: 'a, "b"', os: 'X' })])
    const lines = csv.split('\n')
    expect(lines[1]).toContain('"a, ""b"""')
  })

  it('只导出传入的行', () => {
    expect(toCsv([mkHostRow()]).split('\n').length).toBe(2)
  })
})

describe('toJson', () => {
  it('不含 hitSecret 字段', () => {
    const json = toJson([mkHostRow(), mkDbRow()])
    expect(json).not.toContain('hitSecret')
    expect(json).not.toContain('sup3r-secret')
    expect(json).not.toContain('pg-secret')
  })

  it('保留其他字段', () => {
    const parsed = JSON.parse(toJson([mkHostRow()]))
    expect(parsed[0].address).toBe('10.0.0.1:22')
    expect(parsed[0].hitUser).toBe('root')
    expect('hitSecret' in parsed[0]).toBe(false)
  })
})
