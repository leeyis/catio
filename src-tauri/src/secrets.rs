//! Server-side secret vault crypto (web head).
//!
//! Connection passwords for the browser deploy are stored ON THE SERVER (not in browser
//! WebCrypto, which is unavailable over plain-HTTP LAN access), encrypted at rest with a key
//! derived from `CATIO_MASTER_KEY` (spec §6). AES-256-GCM via `ring`; the per-user SQLite rows
//! are written by `auth::AuthDb`. Keeping the crypto here makes it a small, pure, testable unit.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::hkdf::{self, KeyType, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};

// HKDF domain-separation constants. The salt is non-secret + fixed (HKDF doesn't require a secret
// salt); `info` ties the derived key to this app + version so the same master key can't be reused
// across unrelated contexts. NOTE: CATIO_MASTER_KEY should still be a high-entropy random string —
// HKDF gives domain separation, not brute-force resistance for a weak operator key.
const HKDF_SALT: &[u8] = b"catio-secret-vault-salt-v1";
const HKDF_INFO: &[u8] = b"catio-conn-secret-aes256gcm-v1";

struct Key32;
impl KeyType for Key32 {
    fn len(&self) -> usize {
        32
    }
}

/// Derive a stable 256-bit AES key from the operator's master key via HKDF-SHA256.
pub fn derive_key(master: &str) -> [u8; 32] {
    let prk = hkdf::Salt::new(HKDF_SHA256, HKDF_SALT).extract(master.as_bytes());
    let okm = prk.expand(&[HKDF_INFO], Key32).expect("hkdf expand");
    let mut out = [0u8; 32];
    okm.fill(&mut out).expect("hkdf fill");
    out
}

/// Encrypt `plaintext`, returning `(nonce, ciphertext_with_tag)`. A fresh random nonce per call
/// means the same secret never yields the same ciphertext. `aad` is authenticated-but-not-encrypted
/// associated data — pass the canonical `(user, profile)` bytes so a blob can't be replayed into a
/// different row/user (GCM tag verification fails if the AAD doesn't match on decrypt).
pub fn encrypt(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "bad key".to_string())?;
    let sealing = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce_bytes).map_err(|_| "rng failed".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| "encrypt failed".to_string())?;
    Ok((nonce_bytes.to_vec(), in_out))
}

/// Decrypt a `(nonce, ciphertext_with_tag)` pair; returns None on any tamper / key mismatch / AAD
/// mismatch (e.g. a blob copied into a different user's row won't decrypt).
pub fn decrypt(key: &[u8; 32], aad: &[u8], nonce_bytes: &[u8], ciphertext: &[u8]) -> Option<String> {
    if nonce_bytes.len() != NONCE_LEN {
        return None;
    }
    let unbound = UnboundKey::new(&AES_256_GCM, key).ok()?;
    let opening = LessSafeKey::new(unbound);
    let mut nb = [0u8; NONCE_LEN];
    nb.copy_from_slice(nonce_bytes);
    let nonce = Nonce::assume_unique_for_key(nb);
    let mut in_out = ciphertext.to_vec();
    let plaintext = opening.open_in_place(nonce, Aad::from(aad), &mut in_out).ok()?;
    String::from_utf8(plaintext.to_vec()).ok()
}

/// Canonical AAD binding a stored secret to its owner + profile, so a ciphertext encrypted for one
/// (user, profile) can't be decrypted in another row.
pub fn secret_aad(user_id: i64, profile_id: &str) -> Vec<u8> {
    let mut v = b"catio-secret-v1\0".to_vec();
    v.extend_from_slice(user_id.to_string().as_bytes());
    v.push(0);
    v.extend_from_slice(profile_id.as_bytes());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_recovers_plaintext() {
        let key = derive_key("my-master-key");
        let aad = secret_aad(1, "p1");
        let (nonce, ct) = encrypt(&key, &aad, b"hunter2").unwrap();
        assert_ne!(ct, b"hunter2"); // actually encrypted
        assert_eq!(decrypt(&key, &aad, &nonce, &ct).as_deref(), Some("hunter2"));
    }

    #[test]
    fn wrong_key_fails_to_decrypt() {
        let aad = secret_aad(1, "p1");
        let (nonce, ct) = encrypt(&derive_key("key-A"), &aad, b"secret").unwrap();
        assert_eq!(decrypt(&derive_key("key-B"), &aad, &nonce, &ct), None);
    }

    #[test]
    fn wrong_aad_fails_to_decrypt() {
        // A blob sealed for (user 1, p1) must NOT decrypt under (user 2, p1) — prevents a
        // DB-write attacker replaying one user's ciphertext into another's row.
        let key = derive_key("k");
        let (nonce, ct) = encrypt(&key, &secret_aad(1, "p1"), b"secret").unwrap();
        assert_eq!(decrypt(&key, &secret_aad(2, "p1"), &nonce, &ct), None);
        assert_eq!(decrypt(&key, &secret_aad(1, "p2"), &nonce, &ct), None);
        assert_eq!(decrypt(&key, &secret_aad(1, "p1"), &nonce, &ct).as_deref(), Some("secret"));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = derive_key("k");
        let aad = secret_aad(1, "p1");
        let (nonce, mut ct) = encrypt(&key, &aad, b"secret").unwrap();
        ct[0] ^= 0xff;
        assert_eq!(decrypt(&key, &aad, &nonce, &ct), None);
    }

    #[test]
    fn fresh_nonce_each_call() {
        let key = derive_key("k");
        let aad = secret_aad(1, "p1");
        let (n1, c1) = encrypt(&key, &aad, b"same").unwrap();
        let (n2, c2) = encrypt(&key, &aad, b"same").unwrap();
        assert_ne!(n1, n2);
        assert_ne!(c1, c2);
    }

    #[test]
    fn derive_key_is_stable_and_distinct() {
        assert_eq!(derive_key("abc"), derive_key("abc"));
        assert_ne!(derive_key("abc"), derive_key("abd"));
    }
}
