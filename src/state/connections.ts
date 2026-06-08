import type { AuthMethod } from '../services/ssh'

/** Non-secret jump/bastion host config stored with the profile. Secret is NEVER persisted. */
export interface JumpProfile {
  host: string
  port: number
  user: string
  auth: AuthMethod
}

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  user: string
  auth: AuthMethod
  /** ProxyJump bastion config — secrets are never stored here. */
  jump?: JumpProfile
}

const KEY = 'catio-connections'

export function loadProfiles(): ConnectionProfile[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ConnectionProfile[]) : []
  } catch {
    return []
  }
}

export function saveProfile(p: ConnectionProfile): void {
  const list = loadProfiles().filter(x => x.id !== p.id)
  list.push(p)
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function deleteProfile(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadProfiles().filter(x => x.id !== id)))
}
