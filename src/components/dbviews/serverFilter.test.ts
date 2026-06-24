import { describe, it, expect } from 'vitest'
import { supportsServerFilter } from './serverFilter'

describe('supportsServerFilter', () => {
  it('SQL 引擎放行(可用服务端 WHERE/ORDER BY)', () => {
    for (const e of ['postgres', 'mysql', 'sqlite', 'duckdb', 'sqlserver', 'clickhouse', 'rqlite', 'jdbc']) {
      expect(supportsServerFilter(e)).toBe(true)
    }
  })

  it('非 SQL 引擎(MongoDB/Redis/Elasticsearch)不放行 —— 否则触发后端 Unsupported 报错', () => {
    expect(supportsServerFilter('mongodb')).toBe(false)
    expect(supportsServerFilter('redis')).toBe(false)
    expect(supportsServerFilter('elasticsearch')).toBe(false)
  })

  it('缺省 engine 按 SQL 引擎放行(mock/demo 默认可用)', () => {
    expect(supportsServerFilter(undefined)).toBe(true)
  })
})
