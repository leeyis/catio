/* Cross-device encrypted config export/import (B3).
 *
 * Serializes the user's connections + settings (an allowlist of localStorage keys,
 * excluding device-local auth/session state), encrypts with AES-GCM under a key
 * derived from a passphrase via PBKDF2-SHA256, and emits a portable base64 bundle.
 * Import reverses it. Move the bundle between devices (e.g. a cloud-synced folder)
 * to carry your setup across machines. AES-GCM's auth tag detects tampering / wrong
 * passphrase. (Live server-backed sync is a separate, future feature.) */

/** localStorage keys included in a config bundle. Auth/session/secret/device keys
 *  are intentionally excluded — they don't belong on another device. */
const EXPORT_KEYS = [
  'catio-connections',
  'catio-db-connections',
  'catio-tunnel-connections',
  'catio-groups',
  'catio-sftp-favorites',
  'catio-snippets',
  'catio-prefs',
  'catio-theme',
  'catio-lang',
  'catio-hidden-schemas',
  // NOTE: catio-agent-config is intentionally NOT exported — it holds a plaintext
  // AI API key. Keeping it out makes the "no keys/secrets" promise truthful.
]

/** localStorage key holding a pre-import snapshot of the prior config (undo aid). */
const BACKUP_KEY = 'catio-config-backup'

const MAGIC = 'CATIOCFG1'
/** PBKDF2 iteration count — OWASP 2023 minimum for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERS = 600_000
/** Minimum passphrase length (the bundle may be stored on disk / cloud). */
const MIN_PASSPHRASE = 8

function u8ToB64(u8: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin)
}
function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

async function deriveKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt the allowlisted config into a portable base64 bundle. Throws on empty passphrase. */
export async function exportConfig(passphrase: string): Promise<string> {
  if (!passphrase) throw new Error('passphrase required')
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`)
  const data: Record<string, string> = {}
  for (const k of EXPORT_KEYS) {
    const v = localStorage.getItem(k)
    if (v != null) data[k] = v
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, ts: Date.now(), data }))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))

  const magic = new TextEncoder().encode(MAGIC)
  const out = new Uint8Array(magic.length + salt.length + iv.length + ct.length)
  out.set(magic, 0)
  out.set(salt, magic.length)
  out.set(iv, magic.length + salt.length)
  out.set(ct, magic.length + salt.length + iv.length)
  return u8ToB64(out)
}

export interface ImportResult {
  /** Number of config keys restored. */
  keys: number
  /** Bundle creation time (unix ms), 0 if absent. */
  ts: number
}

/** Decrypt a bundle and restore the config into localStorage. Throws on bad magic /
 *  wrong passphrase / tampered data. Caller should reload the app to apply. */
export async function importConfig(bundleB64: string, passphrase: string): Promise<ImportResult> {
  if (!passphrase) throw new Error('passphrase required')
  let raw: Uint8Array
  try {
    raw = b64ToU8(bundleB64.trim())
  } catch {
    throw new Error('invalid bundle encoding')
  }
  const magicLen = MAGIC.length
  if (raw.length < magicLen + 16 + 12 + 16 || new TextDecoder().decode(raw.slice(0, magicLen)) !== MAGIC) {
    throw new Error('not a catio config bundle')
  }
  const salt = raw.slice(magicLen, magicLen + 16)
  const iv = raw.slice(magicLen + 16, magicLen + 28)
  const ct = raw.slice(magicLen + 28)
  const key = await deriveKey(passphrase, salt)
  let ptBuf: ArrayBuffer
  try {
    ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  } catch {
    throw new Error('wrong passphrase or corrupted bundle')
  }
  let parsed: { data?: Record<string, string>; ts?: number }
  try {
    parsed = JSON.parse(new TextDecoder().decode(ptBuf))
  } catch {
    throw new Error('corrupted bundle payload')
  }
  const data = parsed.data ?? {}
  // Snapshot the current allowlisted values BEFORE overwriting, so a mis-import can
  // be recovered manually from localStorage[BACKUP_KEY].
  const prior: Record<string, string> = {}
  for (const k of EXPORT_KEYS) {
    const cur = localStorage.getItem(k)
    if (cur != null) prior[k] = cur
  }
  let n = 0
  for (const [k, v] of Object.entries(data)) {
    if (EXPORT_KEYS.includes(k) && typeof v === 'string') {
      localStorage.setItem(k, v)
      n++
    }
  }
  if (n > 0) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ ts: Date.now(), data: prior })) } catch { /* quota */ }
  }
  return { keys: n, ts: parsed.ts ?? 0 }
}
