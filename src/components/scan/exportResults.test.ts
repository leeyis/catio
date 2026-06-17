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
  it('表头为 地址,引擎/OS,版本,命中用户,密码,认证方式,状态', () => {
    const csv = toCsv([])
    expect(csv).toBe('地址,引擎/OS,版本,命中用户,密码,认证方式,状态')
  })

  it('host 行输出 OS + 明文密码，db 行输出 engineId + 明文密码', () => {
    const csv = toCsv([mkHostRow(), mkDbRow()])
    const lines = csv.split('\n')
    expect(lines[1]).toBe('10.0.0.1:22,Linux,OpenSSH 8.9,root,sup3r-secret,password,authed')
    expect(lines[2]).toBe('10.0.0.2:5432,postgres,PostgreSQL 16,admin,pg-secret,password,authed')
  })

  it('导出明文 hitSecret 到密码列', () => {
    const csv = toCsv([mkHostRow()])
    expect(csv).toContain('sup3r-secret')
  })

  it('私钥命中导出密钥名而非密码', () => {
    const csv = toCsv([mkHostRow({ hitAuthKind: 'key', hitSecret: undefined, hitKeyName: 'id_rsa' })])
    expect(csv).toContain('🔑id_rsa')
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
  it('含明文 password 字段', () => {
    const parsed = JSON.parse(toJson([mkHostRow(), mkDbRow()]))
    expect(parsed[0].password).toBe('sup3r-secret')
    expect(parsed[1].password).toBe('pg-secret')
  })

  it('整洁对象：保留业务字段、去掉 UI 内部字段', () => {
    const parsed = JSON.parse(toJson([mkHostRow()]))
    expect(parsed[0].address).toBe('10.0.0.1:22')
    expect(parsed[0].user).toBe('root')
    expect(parsed[0].password).toBe('sup3r-secret')
    expect('rowId' in parsed[0]).toBe(false)
    expect('selected' in parsed[0]).toBe(false)
    expect('hitSecret' in parsed[0]).toBe(false)
  })
})
