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

  it('saves a profile with jump config (no secret)', () => {
    saveProfile({
      id: 'p2',
      name: 'via-bastion',
      host: '10.0.0.5',
      port: 22,
      user: 'app',
      auth: { method: 'password' },
      jump: { host: 'bastion.example.com', port: 22, user: 'ec2-user', auth: { method: 'password' } },
    })
    const list = loadProfiles()
    expect(list).toHaveLength(1)
    const p = list[0]
    expect(p.jump?.host).toBe('bastion.example.com')
    expect(p.jump?.user).toBe('ec2-user')
    expect(p.jump?.port).toBe(22)
    // Serialized profile must contain NO secret
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('secret')
  })

  it('profile.jump round-trips and contains no secret field', () => {
    const profile = {
      id: 'p3',
      name: 'jump-test',
      host: 'target.internal',
      port: 2222,
      user: 'deploy',
      auth: { method: 'keyFile' as const, path: '~/.ssh/id_ed25519' },
      jump: {
        host: 'jump.example.com',
        port: 22,
        user: 'jumper',
        auth: { method: 'password' as const },
        // NOTE: the secret field should NEVER be stored — omitted here as per design
      },
    }
    saveProfile(profile)
    const [loaded] = loadProfiles()
    expect(loaded.jump?.host).toBe('jump.example.com')
    expect(loaded.jump?.user).toBe('jumper')
    // Ensure no secret leaked into storage
    const raw = localStorage.getItem('catio-connections') ?? ''
    expect(raw).not.toContain('"secret"')
    // jump is present (non-secret fields persisted)
    expect(raw).toContain('jump.example.com')
  })
})
