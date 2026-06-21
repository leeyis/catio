import { describe, it, expect, beforeEach } from 'vitest'
import { readHiddenSchemas, writeHiddenSchemas } from './schemaFilter'

describe('state/schemaFilter', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to nothing hidden for an unknown connection', () => {
    expect(readHiddenSchemas('conn-x')).toEqual([])
  })

  it('persists and reads back hidden schemas per connection', () => {
    writeHiddenSchemas('conn-a', ['esales', 'mes'])
    expect(readHiddenSchemas('conn-a')).toEqual(['esales', 'mes'])
    // isolated per connection key
    expect(readHiddenSchemas('conn-b')).toEqual([])
  })

  it('clearing (empty set) removes the entry', () => {
    writeHiddenSchemas('conn-a', ['esales'])
    writeHiddenSchemas('conn-a', [])
    expect(readHiddenSchemas('conn-a')).toEqual([])
    expect(localStorage.getItem('catio-hidden-schemas')).toBe('{}')
  })

  it('tolerates corrupt storage', () => {
    localStorage.setItem('catio-hidden-schemas', 'not json{')
    expect(readHiddenSchemas('conn-a')).toEqual([])
  })
})
