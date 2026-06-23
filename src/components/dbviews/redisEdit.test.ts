import { describe, it, expect } from 'vitest'
import { buildRedisEditArgs, type RedisEdit } from './redisEdit'

describe('buildRedisEditArgs', () => {
  it('builds SET for string', () => {
    const e: RedisEdit = { kind: 'setString', key: 'k', value: 'v' }
    expect(buildRedisEditArgs(e)).toEqual(['SET', 'k', 'v'])
  })

  it('builds HSET / HDEL for hash', () => {
    expect(buildRedisEditArgs({ kind: 'hashSet', key: 'h', field: 'f', value: 'v' })).toEqual(['HSET', 'h', 'f', 'v'])
    expect(buildRedisEditArgs({ kind: 'hashDel', key: 'h', field: 'f' })).toEqual(['HDEL', 'h', 'f'])
  })

  it('builds RPUSH / LSET for list', () => {
    expect(buildRedisEditArgs({ kind: 'listPush', key: 'l', value: 'v' })).toEqual(['RPUSH', 'l', 'v'])
    expect(buildRedisEditArgs({ kind: 'listSet', key: 'l', index: 2, value: 'v' })).toEqual(['LSET', 'l', '2', 'v'])
  })

  it('builds SADD / SREM for set', () => {
    expect(buildRedisEditArgs({ kind: 'setAdd', key: 's', member: 'm' })).toEqual(['SADD', 's', 'm'])
    expect(buildRedisEditArgs({ kind: 'setRem', key: 's', member: 'm' })).toEqual(['SREM', 's', 'm'])
  })

  it('builds ZADD with score before member, and ZREM', () => {
    expect(buildRedisEditArgs({ kind: 'zadd', key: 'z', member: 'm', score: 1.5 })).toEqual(['ZADD', 'z', '1.5', 'm'])
    // integer score has no decimal point
    expect(buildRedisEditArgs({ kind: 'zadd', key: 'z', member: 'm', score: 3 })).toEqual(['ZADD', 'z', '3', 'm'])
    // whole-number score written as a float literal must still drop the decimal point
    expect(buildRedisEditArgs({ kind: 'zadd', key: 'z', member: 'm', score: 3.0 })).toEqual(['ZADD', 'z', '3', 'm'])
    expect(buildRedisEditArgs({ kind: 'zrem', key: 'z', member: 'm' })).toEqual(['ZREM', 'z', 'm'])
  })

  it('builds DEL', () => {
    expect(buildRedisEditArgs({ kind: 'delKey', key: 'k' })).toEqual(['DEL', 'k'])
  })

  it('builds EXPIRE for positive TTL and PERSIST otherwise', () => {
    expect(buildRedisEditArgs({ kind: 'setTtl', key: 'k', ttl: 60 })).toEqual(['EXPIRE', 'k', '60'])
    expect(buildRedisEditArgs({ kind: 'setTtl', key: 'k', ttl: 0 })).toEqual(['PERSIST', 'k'])
    expect(buildRedisEditArgs({ kind: 'setTtl', key: 'k', ttl: -1 })).toEqual(['PERSIST', 'k'])
  })

  it('throws on empty key', () => {
    expect(() => buildRedisEditArgs({ kind: 'setString', key: '', value: 'v' })).toThrow()
    expect(() => buildRedisEditArgs({ kind: 'delKey', key: '' })).toThrow()
  })
})
