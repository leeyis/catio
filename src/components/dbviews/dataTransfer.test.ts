import { describe, it, expect } from 'vitest'
import {
  engineSupportsNativeUpsert,
  availableTransferModes,
  transferReady,
} from './dataTransfer'

describe('dataTransfer pure logic', () => {
  it('knows which engines support native upsert', () => {
    for (const e of ['postgres', 'mysql', 'sqlite', 'duckdb', 'sqlserver']) {
      expect(engineSupportsNativeUpsert(e)).toBe(true)
    }
    for (const e of ['clickhouse', 'rqlite', 'redis', 'mongodb', 'elasticsearch', 'jdbc']) {
      expect(engineSupportsNativeUpsert(e)).toBe(false)
    }
    // 大小写不敏感；未知/缺省引擎按不支持处理（避免暴露会退化为 INSERT 的 upsert）。
    expect(engineSupportsNativeUpsert('PostgreSQL'.toLowerCase().startsWith('postgres') ? 'postgres' : 'x')).toBe(true)
    expect(engineSupportsNativeUpsert(undefined)).toBe(false)
  })

  it('offers append + overwrite always, upsert only when the target supports it', () => {
    expect(availableTransferModes('postgres')).toEqual(['append', 'overwrite', 'upsert'])
    expect(availableTransferModes('clickhouse')).toEqual(['append', 'overwrite'])
    expect(availableTransferModes(undefined)).toEqual(['append', 'overwrite'])
  })

  it('is ready only with a target table, at least one mapped column, and (for upsert) a valid key', () => {
    const baseMapping = { id: 'id', name: 'name' }
    // append: needs target table + >=1 mapped column.
    expect(transferReady({ targetTable: 'users', mapping: baseMapping, mode: 'append', upsertKeys: [] })).toBe(true)
    expect(transferReady({ targetTable: '', mapping: baseMapping, mode: 'append', upsertKeys: [] })).toBe(false)
    expect(transferReady({ targetTable: 'users', mapping: { id: '', name: '' }, mode: 'append', upsertKeys: [] })).toBe(false)

    // upsert: also needs >=1 key, and every key must be among the mapped target columns.
    expect(transferReady({ targetTable: 'users', mapping: baseMapping, mode: 'upsert', upsertKeys: ['id'] })).toBe(true)
    expect(transferReady({ targetTable: 'users', mapping: baseMapping, mode: 'upsert', upsertKeys: [] })).toBe(false)
    expect(transferReady({ targetTable: 'users', mapping: baseMapping, mode: 'upsert', upsertKeys: ['missing'] })).toBe(false)
    // a key mapped to a skipped (empty) target is not a valid key.
    expect(transferReady({ targetTable: 'users', mapping: { id: '', name: 'name' }, mode: 'upsert', upsertKeys: ['id'] })).toBe(false)
  })
})
