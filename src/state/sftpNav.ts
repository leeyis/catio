// Per-session SFTP browse state.
//
// Remembers each SFTP session's last browsed directory and its listing, at module
// scope — independent of the panel component. This is the fix for the bug where
// switching tabs/panels unmounted <SftpPanel/> and remounting reset the view back
// to the home directory, losing where the user was. Now the panel restores the
// remembered directory + listing instantly (no reload flicker) instead.

import type { SftpItem } from '../services/types'

export interface SftpNavState {
  path: string
  items: SftpItem[]
}

const cache: Record<string, SftpNavState> = {}

/** Last remembered directory + listing for a session, or undefined if never visited. */
export function getSftpNav(sessionId: string): SftpNavState | undefined {
  return cache[sessionId]
}

/** Remember a session's current directory + listing. */
export function setSftpNav(sessionId: string, state: SftpNavState): void {
  cache[sessionId] = state
}

/** Forget one session (pass an id) or all sessions (no arg). */
export function clearSftpNav(sessionId?: string): void {
  if (sessionId) delete cache[sessionId]
  else for (const k of Object.keys(cache)) delete cache[k]
}
