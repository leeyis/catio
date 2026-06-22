import { describe, it, expect } from 'vitest'
import { redisCompletionPlan } from './redisCompletion'

const KEYS = ['user:1', 'user:2', 'order:99', 'session:abc']

describe('redisCompletionPlan', () => {
  it('completes command names at the start of a line, prefix-filtered', () => {
    const plan = redisCompletionPlan('HG', KEYS)
    const labels = plan!.options.map(o => o.label)
    expect(labels).toContain('HGET')
    expect(labels).toContain('HGETALL')
    // unrelated commands are filtered out
    expect(labels).not.toContain('GET')
    expect(plan!.replaceLen).toBe(2)
  })

  it('command apply carries a trailing space to flow into the first argument', () => {
    const plan = redisCompletionPlan('GET', KEYS)
    const get = plan!.options.find(o => o.label === 'GET')
    expect(get!.apply).toBe('GET ')
  })

  it('offers key names at the first key argument of a key command', () => {
    const plan = redisCompletionPlan('GET ', KEYS)
    expect(plan!.options.map(o => o.label)).toEqual(KEYS)
    expect(plan!.options.every(o => o.detail === 'key')).toBe(true)
  })

  it('filters key suggestions by the partial key being typed', () => {
    const plan = redisCompletionPlan('GET user', KEYS)
    expect(plan!.options.map(o => o.label)).toEqual(['user:1', 'user:2'])
    expect(plan!.replaceLen).toBe(4)
  })

  it('does NOT suggest keys past the single key slot (GET takes one key)', () => {
    expect(redisCompletionPlan('GET user:1 ', KEYS)).toBeNull()
  })

  it('keeps suggesting keys for variadic key commands (MGET)', () => {
    const plan = redisCompletionPlan('MGET user:1 ', KEYS)
    expect(plan!.options.map(o => o.label)).toEqual(KEYS)
  })

  it('does NOT suggest keys for commands without a key argument (PING)', () => {
    expect(redisCompletionPlan('PING ', KEYS)).toBeNull()
  })

  it('returns the full command set on an empty line', () => {
    const plan = redisCompletionPlan('', KEYS)
    expect(plan!.options.length).toBeGreaterThan(50)
    expect(plan!.options.map(o => o.label)).toContain('SCAN')
  })

  it('does not offer blocked/admin commands (FLUSHALL/CONFIG/EVAL)', () => {
    const all = redisCompletionPlan('', KEYS)!.options.map(o => o.label)
    expect(all).not.toContain('FLUSHALL')
    expect(all).not.toContain('CONFIG')
    expect(all).not.toContain('EVAL')
  })
})
