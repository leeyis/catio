// Encrypted, identity-gated secret vault.
//
// When user identity verification (auth) is enabled, a successful login derives
// an AES-GCM key from the login password (PBKDF2) and holds it in memory for the
// session. Connection secrets (SSH/DB passwords) can then be persisted encrypted
// at rest under that key — so reconnecting (even after a restart + re-login) does
// not re-prompt. The login password itself is NEVER stored: only a per-user salt
// and an encrypted verifier blob are kept, so the at-rest data reveals nothing
// without the password.
//
// Crypto via the platform WebCrypto (SubtleCrypto) — no plaintext-key theatre.

const enc = new TextEncoder()
const dec = new TextDecoder()

const PBKDF2_ITERATIONS = 200_000
const MARKER = 'catio-vault-marker-v1'
const SECRETS_KEY = 'catio-secrets'

// In-memory derived key — set on unlock/create, cleared on lock. Never persisted.
let vaultKey: CryptoKey | null = null

// ---- base64 <-> bytes ----

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Copy into a fresh ArrayBuffer so the value satisfies WebCrypto's BufferSource
// (a generic Uint8Array<ArrayBufferLike> may be SharedArrayBuffer-backed).
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength)
  new Uint8Array(out).set(u)
  return out
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', ab(enc.encode(password)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ab(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---- lock state ----

export function isVaultUnlocked(): boolean {
  return vaultKey !== null
}

export function lockVault(): void {
  vaultKey = null
}

// ---- credential creation / unlock ----

/** Persisted-at-rest auth material for a user (no password, no key). */
export interface VaultCredential {
  salt: string
  verifier: string
  iv: string
}

/** Create a new credential from a password; sets the in-memory key. */
export async function createVaultCredential(password: string): Promise<VaultCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(enc.encode(MARKER)))
  vaultKey = key
  return { salt: bytesToB64(salt), verifier: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) }
}

/** Verify a password against a stored credential; on success sets the key. */
export async function unlockVault(password: string, cred: VaultCredential): Promise<boolean> {
  try {
    const key = await deriveKey(password, b64ToBytes(cred.salt))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(b64ToBytes(cred.iv)) }, key, ab(b64ToBytes(cred.verifier)))
    if (dec.decode(pt) === MARKER) {
      vaultKey = key
      return true
    }
    return false
  } catch {
    return false
  }
}

// ---- secret store (per user, per profile) ----

interface SecretBlob {
  iv: string
  ct: string
}
type SecretStore = Record<string, Record<string, SecretBlob>>

function loadSecrets(): SecretStore {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(SECRETS_KEY) ?? '{}') as SecretStore
  } catch {
    return {}
  }
}

function saveSecrets(store: SecretStore): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SECRETS_KEY, JSON.stringify(store))
  } catch { /* ignore quota */ }
}

/** Encrypt and persist a connection secret for (user, profileId). No-op if locked. */
export async function rememberSecret(user: string, profileId: string, secret: string): Promise<void> {
  if (!vaultKey || !secret) return
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, vaultKey, ab(enc.encode(secret)))
  const store = loadSecrets()
  store[user] = store[user] ?? {}
  store[user][profileId] = { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) }
  saveSecrets(store)
}

/** Decrypt a cached secret, or null if absent / locked / undecryptable. */
export async function recallSecret(user: string, profileId: string): Promise<string | null> {
  if (!vaultKey) return null
  const blob = loadSecrets()[user]?.[profileId]
  if (!blob) return null
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(b64ToBytes(blob.iv)) }, vaultKey, ab(b64ToBytes(blob.ct)))
    return dec.decode(pt)
  } catch {
    return null
  }
}

/** Drop the cached secret for one profile (e.g. after it stops working). */
export function forgetSecret(user: string, profileId: string): void {
  const store = loadSecrets()
  if (store[user]) {
    delete store[user][profileId]
    saveSecrets(store)
  }
}

/** Wipe every cached connection secret (清除凭据). */
export function forgetAllSecrets(): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(SECRETS_KEY) } catch { /* ignore */ }
}
