import { describe, it, expect } from 'vitest'
import { tokenizeRedisLine, redisLineDiagnostics } from './redisDiagnostics'

describe('tokenizeRedisLine', () => {
  it('splits on whitespace, honors quotes, strips trailing ;', () => {
    const r = tokenizeRedisLine('SET "a b" cd;')
    expect(r.argv.map(t => t.value)).toEqual(['SET', 'a b', 'cd'])
    expect(r.unclosedQuote).toBe(false)
  })
  it('flags an unclosed quote', () => {
    expect(tokenizeRedisLine('GET "abc').unclosedQuote).toBe(true)
  })
})

describe('redisLineDiagnostics (strict / non-cursor line)', () => {
  it('flags wrong arity — too few args', () => {
    const d = redisLineDiagnostics('GET')
    expect(d[0].severity).toBe('error')
    expect(d[0].message).toMatch(/参数数量/)
  })
  it('flags wrong arity — too many args', () => {
    expect(redisLineDiagnostics('GET a b')[0].message).toMatch(/参数数量/)
  })
  it('accepts a correct-arity command', () => {
    expect(redisLineDiagnostics('GET mykey')).toEqual([])
  })
  it('flags an unknown command', () => {
    expect(redisLineDiagnostics('NOSUCHCMD x')[0].message).toMatch(/未知命令/)
  })
  it('does NOT flag a valid prefix being typed (GE → prefix of GET)', () => {
    expect(redisLineDiagnostics('GE')).toEqual([])
  })
  it('errors on a blocked command', () => {
    expect(redisLineDiagnostics('FLUSHALL')[0].message).toMatch(/已禁用/)
  })
  it('warns on a write command', () => {
    const d = redisLineDiagnostics('SET k v')
    expect(d[0].severity).toBe('warning')
    expect(d[0].message).toMatch(/写命令/)
  })
  it('errors on an unclosed quote', () => {
    expect(redisLineDiagnostics('GET "abc')[0].message).toMatch(/未闭合/)
  })
  it('blocked container command (and its subcommand form) errors as disabled', () => {
    expect(redisLineDiagnostics('CONFIG')[0].message).toMatch(/已禁用/)
    expect(redisLineDiagnostics('CONFIG GET maxmemory')[0].message).toMatch(/已禁用/)
  })
  it('ignores blank and comment lines', () => {
    expect(redisLineDiagnostics('')).toEqual([])
    expect(redisLineDiagnostics('# note')).toEqual([])
  })
})

describe('redisLineDiagnostics (lenient / cursor line)', () => {
  it('suppresses arity/unknown noise while typing', () => {
    expect(redisLineDiagnostics('GET', true)).toEqual([])
    expect(redisLineDiagnostics('NOSUCHCMD', true)).toEqual([])
    expect(redisLineDiagnostics('GET "abc', true)).toEqual([])
  })
  it('still surfaces a blocked command on the cursor line', () => {
    expect(redisLineDiagnostics('FLUSHALL', true)[0].message).toMatch(/已禁用/)
  })
})
