import { describe, it, expect } from 'vitest'
import {
  normalizeImportColumnName, autoMapImportColumns, IMPORT_SKIP_TARGET,
  engineSupportsImportTransaction,
} from './tableImport'

describe('engineSupportsImportTransaction', () => {
  it('returns true for transactional relational engines', () => {
    for (const e of ['postgres', 'mysql', 'sqlite', 'sqlserver', 'duckdb']) {
      expect(engineSupportsImportTransaction(e)).toBe(true)
    }
  })

  it('returns false for non-transactional engines (no rollback on truncate)', () => {
    for (const e of ['clickhouse', 'rqlite', 'redis', 'mongodb', 'elasticsearch', 'jdbc']) {
      expect(engineSupportsImportTransaction(e)).toBe(false)
    }
  })

  it('is case-insensitive and treats unknown/undefined engines as transactional (no scary warning)', () => {
    expect(engineSupportsImportTransaction('PostgreSQL')).toBe(true)
    expect(engineSupportsImportTransaction(undefined)).toBe(true)
    expect(engineSupportsImportTransaction('')).toBe(true)
  })
})

describe('normalizeImportColumnName', () => {
  it('lowercases and collapses separators to a single space', () => {
    expect(normalizeImportColumnName('  User_ID ')).toBe('user id')
    expect(normalizeImportColumnName('display-Name')).toBe('display name')
    expect(normalizeImportColumnName('a__b--c')).toBe('a b c')
  })
})

describe('autoMapImportColumns', () => {
  it('maps exact source→target names', () => {
    const map = autoMapImportColumns(['id', 'name'], ['id', 'name', 'extra'])
    expect(map).toEqual({ id: 'id', name: 'name' })
  })

  it('maps via normalized name when not an exact match', () => {
    const map = autoMapImportColumns(['User_ID', 'Display-Name'], ['user_id', 'display_name'])
    expect(map).toEqual({ User_ID: 'user_id', 'Display-Name': 'display_name' })
  })

  it('leaves unmatched source columns as skip', () => {
    const map = autoMapImportColumns(['id', 'junk'], ['id', 'name'])
    expect(map).toEqual({ id: 'id', junk: IMPORT_SKIP_TARGET })
  })

  it('prefers an exact match over a normalized one', () => {
    // both "id" (exact) and "I_D" (normalizes to "i d") exist in targets;
    // exact source "id" must keep its exact target.
    const map = autoMapImportColumns(['id'], ['id', 'i_d'])
    expect(map.id).toBe('id')
  })
})
