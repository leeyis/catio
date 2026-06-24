import { describe, it, expect } from 'vitest'
import { formatSql, formatterLanguage } from './sqlFormatter'

describe('formatterLanguage — 引擎 → sql-formatter 方言映射', () => {
  it('已知引擎映射到对应方言', () => {
    expect(formatterLanguage('mysql')).toBe('mysql')
    expect(formatterLanguage('postgres')).toBe('postgresql')
    expect(formatterLanguage('sqlite')).toBe('sqlite')
    expect(formatterLanguage('duckdb')).toBe('duckdb')
    expect(formatterLanguage('sqlserver')).toBe('transactsql')
    expect(formatterLanguage('clickhouse')).toBe('clickhouse')
  })

  it('未知/缺省引擎回落到通用 sql 方言', () => {
    expect(formatterLanguage(undefined)).toBe('sql')
    expect(formatterLanguage('jdbc')).toBe('sql')
    expect(formatterLanguage('rqlite')).toBe('sql')
  })
})

describe('formatSql — 纯函数格式化', () => {
  it('空输入或纯空白原样返回(不抛错)', () => {
    expect(formatSql('', 'postgres')).toBe('')
    expect(formatSql('   \n  ', 'postgres')).toBe('   \n  ')
  })

  it('关键字大写并缩进单条语句', () => {
    const out = formatSql('select a,b from t where x=1', 'postgres')
    expect(out).toContain('SELECT')
    expect(out).toContain('FROM')
    expect(out).toContain('WHERE')
    // 列被拆到多行缩进
    expect(out).toMatch(/SELECT\n\s+a,/)
  })

  it('保留并格式化多条语句(分号分隔)', () => {
    const out = formatSql('select 1; select 2', 'postgres')
    const selects = out.match(/SELECT/g) || []
    expect(selects.length).toBe(2)
    expect(out).toContain(';')
  })

  it('方言差异:MySQL 反引号标识符不被破坏', () => {
    const out = formatSql('select `id` from `user`', 'mysql')
    expect(out).toContain('`id`')
    expect(out).toContain('`user`')
  })

  it('语法非法时原样返回输入(不抛错)', () => {
    const garbage = 'this is (not ; valid sql ))'
    expect(formatSql(garbage, 'postgres')).toBe(garbage)
  })
})
