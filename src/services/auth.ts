//! Web-head authentication client (M2). Only meaningful in server mode (the browser deploy):
//! the desktop app is single-user and never gates. Every call goes through `rpc`, so the
//! session cookie set by the server rides along automatically (`credentials: 'include'`).

import { rpc, isServer } from './transport'

/** A server user account (mirrors Rust `auth::User`, camelCase). */
export interface ServerUser {
  id: number
  username: string
  isAdmin: boolean
  createdAt: number
}

/** Current auth status. `user` is null when logged out; `needsBootstrap` is true on first run
 *  (no users exist yet) so the UI shows the "create first admin" form. */
export interface AuthStatus {
  user: ServerUser | null
  needsBootstrap: boolean
}

/** Who am I? Safe to call unauthenticated — returns `{ user: null }`. */
export async function authMe(): Promise<AuthStatus> {
  if (!isServer()) return { user: null, needsBootstrap: false }
  return rpc<AuthStatus>('auth_me', {})
}

/** Log in; on success the server sets the session cookie. Throws with the server message on 401. */
export async function authLogin(username: string, password: string): Promise<ServerUser> {
  const r = await rpc<{ user: ServerUser }>('auth_login', { username, password })
  return r.user
}

/** Create the first admin on a fresh server (only valid when no users exist), then auto-login. */
export async function authBootstrap(username: string, password: string): Promise<ServerUser> {
  const r = await rpc<{ user: ServerUser }>('auth_bootstrap', { username, password })
  return r.user
}

/** Log out; clears the session cookie server-side. */
export async function authLogout(): Promise<void> {
  await rpc('auth_logout', {})
}

// ---- User management (admin) ----

export async function userList(): Promise<ServerUser[]> {
  return rpc<ServerUser[]>('user_list', {})
}

export async function userCreate(username: string, password: string, isAdmin: boolean): Promise<ServerUser> {
  return rpc<ServerUser>('user_create', { username, password, isAdmin })
}

export async function userDelete(id: number): Promise<void> {
  await rpc('user_delete', { id })
}
