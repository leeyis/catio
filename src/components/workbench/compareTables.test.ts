import { describe, it, expect } from 'vitest'
import { computeDiff, genSyncSql, valuesEqual, qval } from './compareTables'

describe('computeDiff', () => {
  it('classifies insert / update / delete by primary key', () => {
    const d = computeDiff({
      srcColumns: ['id', 'name'],
      srcRows: [[1, 'a'], [2, 'B'], [3, 'c']], // 1 unchanged, 2 changed, 3 new
      tgtColumns: ['id', 'name'],
      tgtRows: [[1, 'a'], [2, 'b'], [4, 'd']], // 4 only in target
      pkNames: ['id'],
    })
    expect(d.error).toBeUndefined()
    expect(d.inserts).toEqual([[3, 'c']])
    expect(d.updates.map(u => u.src)).toEqual([[2, 'B']])
    expect(d.deletes).toEqual([[4, 'd']])
  })

  it('realigns target rows to source column order by name', () => {
    // target columns are in a DIFFERENT order than source
    const d = computeDiff({
      srcColumns: ['id', 'name', 'age'],
      srcRows: [[1, 'a', 30]],
      tgtColumns: ['name', 'age', 'id'],
      tgtRows: [['a', 30, 1]], // same logical row, shuffled columns → NOT a diff
      pkNames: ['id'],
    })
    expect(d.inserts).toEqual([])
    expect(d.updates).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('does not collide composite keys (1,23) vs (12,3)', () => {
    const d = computeDiff({
      srcColumns: ['a', 'b', 'v'],
      srcRows: [[1, 23, 'x'], [12, 3, 'y']],
      tgtColumns: ['a', 'b', 'v'],
      tgtRows: [[1, 23, 'x'], [12, 3, 'y']],
      pkNames: ['a', 'b'],
    })
    expect(d.inserts).toEqual([])
    expect(d.updates).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('treats NULL distinct from the literal "NULL" in keys', () => {
    const d = computeDiff({
      srcColumns: ['id', 'v'],
      srcRows: [[null, 'x'], ['NULL', 'y']],
      tgtColumns: ['id', 'v'],
      tgtRows: [[null, 'x'], ['NULL', 'y']],
      pkNames: ['id'],
    })
    expect(d.inserts).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('matches cross-engine number 1 vs string "1" (no false update)', () => {
    const d = computeDiff({
      srcColumns: ['id', 'n'],
      srcRows: [[1, 5]],
      tgtColumns: ['id', 'n'],
      tgtRows: [['1', '5']], // same logical values as strings
      pkNames: ['id'],
    })
    expect(d.updates).toEqual([])
    expect(d.inserts).toEqual([])
    expect(d.deletes).toEqual([])
  })

  it('flags column-set mismatch instead of misaligning', () => {
    const d = computeDiff({
      srcColumns: ['id', 'name'],
      srcRows: [[1, 'a']],
      tgtColumns: ['id', 'email'],
      tgtRows: [[1, 'a']],
      pkNames: ['id'],
    })
    expect(d.error).toBe('columns-mismatch')
  })

  it('flags missing primary key', () => {
    const d = computeDiff({ srcColumns: ['id'], srcRows: [], tgtColumns: ['id'], tgtRows: [], pkNames: ['nope'] })
    expect(d.error).toBe('pk-missing')
  })
})

describe('valuesEqual', () => {
  it('compares objects by JSON, numbers numerically', () => {
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(valuesEqual(1, '1')).toBe(true)
    expect(valuesEqual(null, null)).toBe(true)
    expect(valuesEqual(null, '')).toBe(false)
  })
})

describe('qval escaping', () => {
  it('escapes single quotes for all engines', () => {
    expect(qval("O'Brien", 'postgres')).toBe("'O''Brien'")
  })
  it('escapes backslash for MySQL-likes only', () => {
    expect(qval('a\\b', 'mysql')).toBe("'a\\\\b'")
    expect(qval('a\\b', 'postgres')).toBe("'a\\b'")
  })
  it('quotes scientific-notation numbers, NULLs non-finite', () => {
    expect(qval(1e21)).toBe("'1e+21'")
    expect(qval(NaN)).toBe('NULL')
    expect(qval(42)).toBe('42')
  })
  it('emits dialect booleans', () => {
    expect(qval(true, 'mysql')).toBe('1')
    expect(qval(false, 'sqlserver')).toBe('0')
    expect(qval(true, 'postgres')).toBe('TRUE')
  })
})

describe('genSyncSql', () => {
  const diff = computeDiff({
    srcColumns: ['id', 'name'],
    srcRows: [[2, 'B'], [3, 'c']],
    tgtColumns: ['id', 'name'],
    tgtRows: [[2, 'b'], [4, 'd']],
    pkNames: ['id'],
  })

  it('generates INSERT/UPDATE/DELETE and excludes PK from SET', () => {
    const sql = genSyncSql(diff, 'public', 't', { engine: 'postgres', allowDelete: true })
    expect(sql).toContain('INSERT INTO "public"."t" ("id", "name") VALUES (3, \'c\');')
    expect(sql).toContain('UPDATE "public"."t" SET "name" = \'B\' WHERE "id" = 2;')
    expect(sql).not.toContain('SET "id"')
    expect(sql).toContain('DELETE FROM "public"."t" WHERE "id" = 4;')
  })

  it('suppresses DELETE when not allowed', () => {
    const sql = genSyncSql(diff, 'public', 't', { engine: 'postgres', allowDelete: false })
    expect(sql).not.toContain('DELETE')
    expect(sql).toContain('INSERT')
  })
})
