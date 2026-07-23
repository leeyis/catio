import { describe, it, expect } from 'vitest'
import { dbLogo, osLogo } from './logos'

describe('dbLogo', () => {
  it('resolves bundled engines to their public logo path', () => {
    expect(dbLogo('postgres')).toBe('/logos/db/postgres.svg')
    expect(dbLogo('rqlite')).toBe('/logos/db/rqlite.png')
  })
  it('maps the mock "mongo" alias to mongodb', () => {
    expect(dbLogo('mongo')).toBe('/logos/db/mongodb.svg')
  })
  it('returns null for unknown / missing engines', () => {
    expect(dbLogo('nope')).toBeNull()
    expect(dbLogo(undefined)).toBeNull()
    expect(dbLogo(null)).toBeNull()
  })
})

describe('osLogo', () => {
  it('resolves a known OS to a url + tint colour', () => {
    expect(osLogo('ubuntu')).toEqual({ url: '/logos/os/ubuntu.png', color: undefined })
    expect(osLogo('linux')).toEqual({ url: '/logos/os/linux.png', color: undefined })
    expect(osLogo('macos')).toEqual({ url: '/logos/os/apple.svg', color: '#A2AAAD' })
  })
  it('returns null for unknown / missing OS', () => {
    expect(osLogo('plan9')).toBeNull()
    expect(osLogo(undefined)).toBeNull()
  })
})
