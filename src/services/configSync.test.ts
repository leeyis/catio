import { describe, it, expect, beforeEach } from 'vitest'
import { exportConfig, importConfig } from './configSync'

describe('configSync encrypted export/import', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips allowlisted config through encrypt → decrypt', async () => {
    localStorage.setItem('catio-connections', JSON.stringify([{ id: 'a', name: 'host-a' }]))
    localStorage.setItem('catio-theme', 'grove')
    localStorage.setItem('catio-lang', 'en')
    // Not in the allowlist — must NOT be exported.
    localStorage.setItem('catio-secrets', 'super-secret')

    const bundle = await exportConfig('correct horse')
    expect(typeof bundle).toBe('string')
    expect(bundle.length).toBeGreaterThan(0)

    localStorage.clear()
    const res = await importConfig(bundle, 'correct horse')
    expect(res.keys).toBe(3)
    expect(localStorage.getItem('catio-connections')).toBe(JSON.stringify([{ id: 'a', name: 'host-a' }]))
    expect(localStorage.getItem('catio-theme')).toBe('grove')
    expect(localStorage.getItem('catio-lang')).toBe('en')
    // The excluded key was never in the bundle, so it stays absent after import.
    expect(localStorage.getItem('catio-secrets')).toBeNull()
  })

  it('rejects a wrong passphrase (AES-GCM auth tag)', async () => {
    localStorage.setItem('catio-theme', 'amber')
    const bundle = await exportConfig('right-pass')
    await expect(importConfig(bundle, 'wrong-pass')).rejects.toThrow(/passphrase|corrupted/i)
  })

  it('rejects a non-catio bundle (magic check)', async () => {
    await expect(importConfig('bm90LWEtYnVuZGxl', 'passphrase')).rejects.toThrow(/bundle/i)
  })

  it('rejects a tampered ciphertext via the GCM auth tag', async () => {
    localStorage.setItem('catio-theme', 'amber')
    const bundle = await exportConfig('right-pass-123')
    const bytes = Uint8Array.from(atob(bundle), c => c.charCodeAt(0))
    bytes[bytes.length - 1] ^= 0xff // flip the last ciphertext byte
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    await expect(importConfig(btoa(s), 'right-pass-123')).rejects.toThrow(/passphrase|corrupted/i)
  })

  it('requires a passphrase and enforces a minimum length', async () => {
    await expect(exportConfig('')).rejects.toThrow(/passphrase/i)
    await expect(exportConfig('short')).rejects.toThrow(/8|character/i)
  })
})
