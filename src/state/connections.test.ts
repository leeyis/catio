import { describe, it, expect, beforeEach } from 'vitest'
import { loadProfiles, saveProfile, deleteProfile } from './connections'

beforeEach(() => localStorage.clear())

describe('connection profiles', () => {
  it('saves and loads non-secret profile', () => {
    saveProfile({ id: 'p1', name: 'prod', host: 'h', port: 22, user: 'u', auth: { method: 'password' } })
    const list = loadProfiles()
    expect(list).toHaveLength(1)
    expect(list[0].host).toBe('h')
    expect(JSON.stringify(list[0])).not.toContain('secret')
  })
  it('deletes a profile', () => {
    saveProfile({ id: 'p1', name: 'a', host: 'h', port: 22, user: 'u', auth: { method: 'password' } })
    deleteProfile('p1')
    expect(loadProfiles()).toHaveLength(0)
  })
})
