import type { AuthMethod } from '../services/ssh'
import { storeLoad, storeUpsert, storeRemove, type StoreItem } from '../services/userStore'

/** Non-secret jump/bastion host config stored with the profile. Secret is NEVER persisted. */
export interface JumpProfile {
  host: string
  port: number
  user: string
  auth: AuthMethod
}

export interface ConnectionProfile extends StoreItem {
  id: string
  name: string
  host: string
  port: number
  user: string
  auth: AuthMethod
  /** Terminal protocol. Absent → treated as 'ssh' (legacy profiles). Non-SSH
   *  terminals (local/serial/telnet/mosh) persist so they appear in the Vault and
   *  can be reopened; for them host/port/user/auth may be placeholders. */
  proto?: 'ssh' | 'local' | 'serial' | 'telnet' | 'mosh'
  /** Serial device (proto === 'serial'), e.g. "/dev/ttyUSB0" / "COM3". */
  serialPort?: string
  /** Serial baud rate (proto === 'serial'). */
  baud?: number
  /** ProxyJump bastion config — secrets are never stored here. */
  jump?: JumpProfile
  /** Vault group id (from state/groups). Absent → renders under "未分组". */
  group?: string
  /** User-maintained non-secret notes shown in connection details. */
  notes?: string
  /** Detected OS id (ubuntu/debian/alpine/…), set after a successful connect so
   *  the sidebar glyph shows the real OS logo. Absent → generic host icon. */
  os?: string
}

const STORE = 'connections'
const KEY = 'catio-connections'

export function loadProfiles(): ConnectionProfile[] {
  return storeLoad<ConnectionProfile>(STORE, KEY)
}

export function saveProfile(p: ConnectionProfile): void {
  storeUpsert(STORE, KEY, p)
}

export function deleteProfile(id: string, ownerId?: number): void {
  storeRemove<ConnectionProfile>(STORE, KEY, id, ownerId)
}
