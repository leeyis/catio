//! Web-head authentication (M2). User accounts with argon2-hashed passwords live in a SQLite
//! file under the data volume (`<data_dir>/catio.db`); sessions are an in-memory token→user
//! map (a restart logs everyone out, acceptable for the Phase-1 small-team LAN model).
//!
//! Phase 1 is ACCESS CONTROL only — it decides *who may use this server*. All logged-in users
//! still share one workspace (`ConnManager` etc.); per-user state/credential isolation is
//! Future. The desktop (Tauri) binary never touches this module.

use std::path::Path;
use std::sync::Mutex;

use argon2::password_hash::{
    rand_core::{OsRng, RngCore},
    PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

/// A user as exposed to the frontend (never carries the password hash).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub created_at: i64,
}

/// The user store. A single connection behind a Mutex — auth traffic is tiny, so this avoids a
/// pool while keeping writes serialized.
pub struct AuthDb {
    conn: Mutex<Connection>,
}

impl AuthDb {
    /// Open (creating if needed) the auth DB at `path` and ensure the schema.
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    /// In-memory store for tests.
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conn_secrets (
                user_id INTEGER NOT NULL,
                profile_id TEXT NOT NULL,
                nonce BLOB NOT NULL,
                ciphertext BLOB NOT NULL,
                PRIMARY KEY (user_id, profile_id)
            );
            -- Per-user data layer (web multi-user): connections / groups / snippets / history /
            -- tunnels. `store` names the collection, `item_id` the item's frontend id, `payload`
            -- the item JSON. Owned by a user; admins can see/manage all (see store_* methods).
            CREATE TABLE IF NOT EXISTS user_store (
                owner_user_id INTEGER NOT NULL,
                store TEXT NOT NULL,
                item_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_user_id, store, item_id)
            );
            CREATE INDEX IF NOT EXISTS idx_user_store_store ON user_store(store);",
        )
        .map_err(|e| e.to_string())?;
        Ok(AuthDb { conn: Mutex::new(conn) })
    }

    pub fn user_count(&self) -> Result<i64, String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)).map_err(|e| e.to_string())
    }

    /// Create a user with an argon2-hashed password. Rejects empty names, short passwords, and
    /// duplicate usernames (case-insensitive).
    pub fn create_user(&self, username: &str, password: &str, is_admin: bool) -> Result<User, String> {
        let username = username.trim();
        if username.is_empty() {
            return Err("用户名不能为空".into());
        }
        if password.len() < 6 {
            return Err("口令至少 6 位".into());
        }
        let hash = hash_password(password)?;
        let now = now_secs();
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![username, hash, is_admin as i64, now],
        )
        .map_err(|e| {
            let s = e.to_string();
            if s.contains("UNIQUE") { format!("用户名已存在: {username}") } else { s }
        })?;
        Ok(User { id: c.last_insert_rowid(), username: username.to_string(), is_admin, created_at: now })
    }

    /// Atomically create the FIRST admin. Holds the connection lock across BOTH the count check
    /// and the insert, so two concurrent first-run requests on a multi-threaded runtime cannot
    /// both succeed (a `user_count()` then `create_user()` TOCTOU would let two admins through —
    /// the UNIQUE(username) constraint only blocks identical names, not "two different admins").
    pub fn bootstrap_admin(&self, username: &str, password: &str) -> Result<User, String> {
        let username = username.trim();
        if username.is_empty() {
            return Err("用户名不能为空".into());
        }
        if password.len() < 6 {
            return Err("口令至少 6 位".into());
        }
        // Hash before taking the lock (argon2 is deliberately slow); we don't want to serialize
        // every concurrent attempt on the hash.
        let hash = hash_password(password)?;
        let now = now_secs();
        let c = self.conn.lock().unwrap();
        let count: i64 = c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if count != 0 {
            return Err("已存在用户,无法重复初始化".into());
        }
        c.execute(
            "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?1, ?2, 1, ?3)",
            rusqlite::params![username, hash, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(User { id: c.last_insert_rowid(), username: username.to_string(), is_admin: true, created_at: now })
    }

    /// Verify username + password. Returns the user on success; a single generic error on any
    /// failure (no username/password oracle).
    pub fn verify_login(&self, username: &str, password: &str) -> Result<User, String> {
        let c = self.conn.lock().unwrap();
        let row = c
            .query_row(
                "SELECT id, username, password_hash, is_admin, created_at FROM users WHERE username = ?1 COLLATE NOCASE",
                rusqlite::params![username.trim()],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (id, uname, hash, is_admin, created_at) = row.ok_or("用户名或口令错误")?;
        verify_password(password, &hash).map_err(|_| "用户名或口令错误".to_string())?;
        Ok(User { id, username: uname, is_admin: is_admin != 0, created_at })
    }

    /// Change a user's own password: verify the old password, then store a new argon2 hash.
    pub fn change_password(&self, user_id: i64, old_password: &str, new_password: &str) -> Result<(), String> {
        if new_password.len() < 6 {
            return Err("口令至少 6 位".into());
        }
        let new_hash = hash_password(new_password)?;
        let c = self.conn.lock().unwrap();
        let hash: Option<String> = c
            .query_row("SELECT password_hash FROM users WHERE id = ?1", rusqlite::params![user_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let hash = hash.ok_or("用户不存在")?;
        verify_password(old_password, &hash).map_err(|_| "当前密码错误".to_string())?;
        c.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", rusqlite::params![new_hash, user_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Per-user connection-secret vault (web head). Stores already-encrypted blobs; the AES-GCM
    //    seal/open with the master key happens in the command layer (see secrets.rs). ──

    /// Upsert the encrypted secret for (user, profile).
    pub fn store_secret(&self, user_id: i64, profile_id: &str, nonce: &[u8], ciphertext: &[u8]) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO conn_secrets (user_id, profile_id, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, profile_id) DO UPDATE SET nonce = excluded.nonce, ciphertext = excluded.ciphertext",
            rusqlite::params![user_id, profile_id, nonce, ciphertext],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Load the encrypted (nonce, ciphertext) for (user, profile), or None if absent.
    pub fn load_secret(&self, user_id: i64, profile_id: &str) -> Result<Option<(Vec<u8>, Vec<u8>)>, String> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT nonce, ciphertext FROM conn_secrets WHERE user_id = ?1 AND profile_id = ?2",
            rusqlite::params![user_id, profile_id],
            |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Delete one stored secret (no error if it didn't exist).
    pub fn delete_secret(&self, user_id: i64, profile_id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM conn_secrets WHERE user_id = ?1 AND profile_id = ?2", rusqlite::params![user_id, profile_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Per-user data store (connections / groups / snippets / history / tunnels) ──
    // Access rule: a normal user sees/edits only their own items; an admin sees/manages ALL
    // (each returned item carries `__ownerId`/`__ownerName` so the UI can show + target the owner).

    /// List a store's items: admin → every user's; normal user → only their own. Each item is its
    /// stored JSON with `__ownerId`/`__ownerName` injected.
    pub fn store_list(&self, store: &str, caller_id: i64, is_admin: bool) -> Result<Vec<serde_json::Value>, String> {
        let c = self.conn.lock().unwrap();
        let mut out = Vec::new();
        let mut push = |owner_id: i64, owner_name: String, payload: String| {
            let mut v: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
            if let serde_json::Value::Object(ref mut m) = v {
                m.insert("__ownerId".into(), serde_json::json!(owner_id));
                m.insert("__ownerName".into(), serde_json::json!(owner_name));
            }
            out.push(v);
        };
        if is_admin {
            let mut stmt = c.prepare(
                "SELECT s.owner_user_id, u.username, s.payload FROM user_store s \
                 JOIN users u ON u.id = s.owner_user_id WHERE s.store = ?1 ORDER BY s.updated_at",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![store], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                .map_err(|e| e.to_string())?;
            for row in rows { let (a, b, d) = row.map_err(|e| e.to_string())?; push(a, b, d); }
        } else {
            let mut stmt = c.prepare(
                "SELECT s.owner_user_id, u.username, s.payload FROM user_store s \
                 JOIN users u ON u.id = s.owner_user_id WHERE s.store = ?1 AND s.owner_user_id = ?2 ORDER BY s.updated_at",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![store, caller_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                .map_err(|e| e.to_string())?;
            for row in rows { let (a, b, d) = row.map_err(|e| e.to_string())?; push(a, b, d); }
        }
        Ok(out)
    }

    /// Upsert one item into `(owner, store)`. The caller layer decides `owner` (self, or any user
    /// when an admin targets someone else's row).
    pub fn store_set(&self, owner_user_id: i64, store: &str, item_id: &str, payload: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO user_store (owner_user_id, store, item_id, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(owner_user_id, store, item_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            rusqlite::params![owner_user_id, store, item_id, payload, now_secs()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete one item from `(owner, store)` (no error if absent).
    pub fn store_delete(&self, owner_user_id: i64, store: &str, item_id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "DELETE FROM user_store WHERE owner_user_id = ?1 AND store = ?2 AND item_id = ?3",
            rusqlite::params![owner_user_id, store, item_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete ALL of `(owner, store)` (e.g. "clear history").
    pub fn store_clear(&self, owner_user_id: i64, store: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM user_store WHERE owner_user_id = ?1 AND store = ?2", rusqlite::params![owner_user_id, store])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_users(&self) -> Result<Vec<User>, String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT id, username, is_admin, created_at FROM users ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(User {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    is_admin: r.get::<_, i64>(2)? != 0,
                    created_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Delete a user by id. Refuses to delete the last remaining admin (would lock everyone out).
    pub fn delete_user(&self, id: i64) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        let target_admin: Option<bool> = c
            .query_row("SELECT is_admin FROM users WHERE id = ?1", rusqlite::params![id], |r| {
                Ok(r.get::<_, i64>(0)? != 0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if target_admin == Some(true) {
            let admins: i64 = c
                .query_row("SELECT COUNT(*) FROM users WHERE is_admin = 1", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if admins <= 1 {
                return Err("不能删除最后一个管理员".into());
            }
        }
        // Delete the user AND their stored connection secrets atomically — either both go or
        // neither, so a mid-failure can't leave orphaned encrypted secrets behind.
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM users WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM conn_secrets WHERE user_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM user_store WHERE owner_user_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify_password(password: &str, hash: &str) -> Result<(), String> {
    let parsed = PasswordHash::new(hash).map_err(|e| e.to_string())?;
    Argon2::default().verify_password(password.as_bytes(), &parsed).map_err(|e| e.to_string())
}

/// A 256-bit random session token, hex-encoded, from the OS CSPRNG.
pub fn new_session_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_login_and_reject_bad_password() {
        let db = AuthDb::open_in_memory().unwrap();
        assert_eq!(db.user_count().unwrap(), 0);
        let u = db.create_user("Alice", "secret123", true).unwrap();
        assert!(u.is_admin);
        assert_eq!(db.user_count().unwrap(), 1);

        // Correct password logs in; username is case-insensitive.
        let logged = db.verify_login("alice", "secret123").unwrap();
        assert_eq!(logged.id, u.id);
        // Wrong password is rejected with the generic error (no oracle).
        assert!(db.verify_login("alice", "nope").is_err());
        // Unknown user yields the SAME generic error.
        assert!(db.verify_login("bob", "secret123").is_err());
    }

    #[test]
    fn rejects_duplicate_username_and_short_password() {
        let db = AuthDb::open_in_memory().unwrap();
        db.create_user("alice", "secret123", false).unwrap();
        assert!(db.create_user("ALICE", "another1", false).is_err(), "case-insensitive dup must fail");
        assert!(db.create_user("bob", "12345", false).is_err(), "short password must fail");
    }

    #[test]
    fn delete_user_protects_last_admin() {
        let db = AuthDb::open_in_memory().unwrap();
        let admin = db.create_user("admin", "secret123", true).unwrap();
        let bob = db.create_user("bob", "secret123", false).unwrap();
        // Deleting the only admin is refused.
        assert!(db.delete_user(admin.id).is_err());
        // A non-admin deletes fine.
        db.delete_user(bob.id).unwrap();
        // With a second admin present, the first can go.
        let admin2 = db.create_user("admin2", "secret123", true).unwrap();
        db.delete_user(admin.id).unwrap();
        assert_eq!(db.list_users().unwrap().len(), 1);
        assert_eq!(db.list_users().unwrap()[0].id, admin2.id);
    }

    #[test]
    fn bootstrap_admin_is_first_only() {
        let db = AuthDb::open_in_memory().unwrap();
        let a = db.bootstrap_admin("admin", "secret123").unwrap();
        assert!(a.is_admin);
        // A second bootstrap is refused once any user exists (atomic count-then-insert).
        assert!(db.bootstrap_admin("admin2", "secret123").is_err());
        assert_eq!(db.user_count().unwrap(), 1);
    }

    #[test]
    fn change_password_verifies_old_then_updates() {
        let db = AuthDb::open_in_memory().unwrap();
        let u = db.create_user("bob", "secret123", false).unwrap();
        // Wrong old password is rejected.
        assert!(db.change_password(u.id, "wrong", "newsecret").is_err());
        // Correct old password updates; new password now logs in, old no longer does.
        db.change_password(u.id, "secret123", "newsecret").unwrap();
        assert!(db.verify_login("bob", "newsecret").is_ok());
        assert!(db.verify_login("bob", "secret123").is_err());
        // New password must meet the length rule.
        assert!(db.change_password(u.id, "newsecret", "123").is_err());
    }

    #[test]
    fn session_tokens_are_unique_and_long() {
        let a = new_session_token();
        let b = new_session_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
