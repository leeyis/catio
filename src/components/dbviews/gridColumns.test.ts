import { describe, expect, it } from 'vitest'
import { uniqueGridColumns } from './gridColumns'
import { buildInsertSql, buildUpdateSql, sqlValue } from './copySql'

describe('lossless result-column identities', () => {
  it('keeps duplicate aliases distinct without shadowing existing suffixes', () => {
    const columns = uniqueGridColumns(['id', 'id', 'id (2)', 'id'].map(name => ({ name, type: 'int' })))
    expect(columns.map(column => column.name)).toEqual(['id', 'id (3)', 'id (2)', 'id (4)'])
    expect(columns[1].sourceName).toBe('id')
  })
  it('gives empty labels usable distinct export keys', () => {
    expect(uniqueGridColumns([{ name: '', type: '' }, { name: '', type: '' }]).map(c => c.name)).toEqual(['column_1', 'column_2'])
  })
})

describe('SQL clipboard safety', () => {
  it('never falls back to a whole-table UPDATE for missing or nullable keys', () => {
    expect(buildUpdateSql([[1, 'a'], [null, 'b']], 't', ['id', 'v'], 'postgres', undefined, ['id'])).toBe('')
    expect(buildUpdateSql([[1]], 't', ['id'], 'postgres', undefined, ['missing'])).toBe('')
    expect(buildUpdateSql([[1]], 't', ['id'], 'postgres', undefined, ['id'])).toBe('')
    expect(buildInsertSql([[1]], '', ['id'], 'postgres')).toBe('')
  })
  it('emits SQL Server Unicode, booleans and bracket escaping', () => {
    expect(sqlValue(true, 'sqlserver')).toBe('1')
    expect(sqlValue("中'文", 'sqlserver')).toBe("N'中''文'")
    expect(buildInsertSql([['中']], 'a]b', ['v'], 'sqlserver', 'dbo')).toBe("INSERT INTO [dbo].[a]]b] ([v]) VALUES (N'中');")
  })
  it('is independent of MySQL backslash mode for hostile text values', () => {
    const sql = buildInsertSql([["a\\';DROP TABLE t;--"]], 't', ['v'], 'mysql')
    expect(sql).toContain("CONVERT(X'")
    expect(sql).not.toContain('DROP TABLE')
    expect(sqlValue('a\\b', 'postgres')).toBe("E'a\\\\b'")
    expect(sqlValue('a\\b', 'sqlite')).toBe("'a\\b'")
  })
})
