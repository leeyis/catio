//! Server-side connection-secret vault client (web head only).
//!
//! In the browser deploy, connection passwords are kept ON THE SERVER (encrypted with
//! CATIO_MASTER_KEY, keyed by the logged-in user) — not in browser WebCrypto, which is
//! unavailable over plain-HTTP LAN access. So a saved connection can be opened password-free
//! after login. Desktop keeps using the local encrypted vault (state/vault.ts).

import { rpc, isServer } from './transport'

/** Persist (encrypt) the current user's secret for a connection profile. Returns true on success.
 *  On failure (e.g. server has no CATIO_MASTER_KEY → 503) it warns rather than failing silently,
 *  so a "saved but not really persisted" state is at least visible in devtools. */
export async function secretRemember(profileId: string, secret: string): Promise<boolean> {
  if (!isServer() || !profileId || !secret) return false
  try {
    await rpc('secret_remember', { profileId, secret })
    return true
  } catch (e) {
    console.warn('[secrets] 连接密码未能保存到服务器(可能未配置 CATIO_MASTER_KEY):', e)
    return false
  }
}

/** Recall (decrypt) the current user's secret for a profile, or null if none / unavailable. */
export async function secretRecall(profileId: string): Promise<string | null> {
  if (!isServer() || !profileId) return null
  try {
    const r = await rpc<{ secret: string | null }>('secret_recall', { profileId })
    return r.secret ?? null
  } catch {
    return null
  }
}

/** Forget the current user's stored secret for a profile (e.g. after it stops working). */
export async function secretForget(profileId: string): Promise<void> {
  if (!isServer() || !profileId) return
  try { await rpc('secret_forget', { profileId }) } catch { /* ignore */ }
}
