import { describe, it, expect } from 'vitest'
import { redisCompletionPlan, resolveRedisDoc, isRedisContainer } from './redisCompletion'

const KEYS = ['user:1', 'user:2', 'order:99', 'session:abc']

describe('redisCompletionPlan — commands', () => {
  it('completes command names at line start, prefix-filtered', () => {
    const labels = redisCompletionPlan('HG', KEYS)!.options.map(o => o.label)
    expect(labels).toContain('HGET')
    expect(labels).toContain('HGETALL')
    expect(labels).not.toContain('GET')
  })

  it('command apply carries a trailing space; info carries the official signature + summary', () => {
    const get = redisCompletionPlan('GET', KEYS)!.options.find(o => o.label === 'GET')!
    expect(get.apply).toBe('GET ')
    expect(get.info).toContain('GET key') // signature
    expect(get.info!.length).toBeGreaterThan('GET key'.length) // + summary/meta
  })

  it('rich SET signature includes optional flag groups', () => {
    const set = redisCompletionPlan('SET', KEYS)!.options.find(o => o.label === 'SET')!
    expect(set.info).toContain('NX | XX')
    expect(set.info).toMatch(/EX seconds/)
  })

  it('returns the full command set on an empty line (370 incl. subcommands)', () => {
    const opts = redisCompletionPlan('', KEYS)!.options
    expect(opts.length).toBeGreaterThan(150)
    expect(opts.map(o => o.label)).toContain('SCAN')
  })

  it('KEEPS blocked/admin commands but flags them (not hidden — dbx parity + clarity)', () => {
    const flush = redisCompletionPlan('FLUSH', KEYS)!.options.find(o => o.label === 'FLUSHALL')!
    expect(flush).toBeTruthy()
    expect(flush.detail).toContain('⛔')
    expect(flush.info).toContain('禁用')
  })
})

describe('redisCompletionPlan — subcommands', () => {
  it('completes container subcommands (CONFIG GET/SET/…)', () => {
    const subs = redisCompletionPlan('CONFIG ', KEYS)!.options.map(o => o.label)
    expect(subs).toContain('GET')
    expect(subs).toContain('SET')
  })

  it('completes XINFO subcommands', () => {
    const subs = redisCompletionPlan('XINFO ', KEYS)!.options.map(o => o.label)
    expect(subs).toContain('STREAM')
  })
})

describe('redisCompletionPlan — key arguments', () => {
  it('offers key names at the first key slot of a key command', () => {
    const opts = redisCompletionPlan('GET ', KEYS)!.options
    expect(opts.map(o => o.label)).toEqual(KEYS)
    expect(opts.every(o => o.detail === 'key')).toBe(true)
  })

  it('filters keys by the partial being typed', () => {
    const opts = redisCompletionPlan('GET user', KEYS)!.options
    expect(opts.map(o => o.label)).toEqual(['user:1', 'user:2'])
  })

  it('does NOT suggest keys past the single key slot (GET)', () => {
    expect(redisCompletionPlan('GET user:1 ', KEYS)).toBeNull()
  })

  it('keeps suggesting keys for variadic key commands (MGET/DEL)', () => {
    expect(redisCompletionPlan('MGET user:1 ', KEYS)!.options.map(o => o.label)).toEqual(KEYS)
    expect(redisCompletionPlan('DEL user:1 ', KEYS)!.options.map(o => o.label)).toEqual(KEYS)
  })

  it('does NOT suggest keys for commands without a key argument (PING)', () => {
    expect(redisCompletionPlan('PING ', KEYS)).toBeNull()
  })
})

describe('resolveRedisDoc / isRedisContainer', () => {
  it('resolves "MAIN SUB" over "MAIN"', () => {
    expect(resolveRedisDoc(['CONFIG', 'GET'])?.sub).toBe('GET')
    expect(resolveRedisDoc(['GET'])?.takesKey).toBe(true)
  })
  it('knows container commands', () => {
    expect(isRedisContainer('config')).toBe(true)
    expect(isRedisContainer('get')).toBe(false)
  })
})
