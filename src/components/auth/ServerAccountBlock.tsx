//! Server-deploy account panel (M2), shown inside Settings → Security. Renders the signed-in
//! user + sign-out, and for admins a compact user-management list (create / delete). Renders
//! nothing in the desktop app / dev (where there is no server auth).

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useServerAuth, PW_KEY } from './ServerAuthGate'
import { ensureServerVault } from '../../state/vault'
import { userList, userCreate, userDelete, authChangePassword, type ServerUser } from '../../services/auth'

export function ServerAccountBlock() {
  const { t } = useTranslation()
  const { user, enabled, logout } = useServerAuth()
  const [users, setUsers] = useState<ServerUser[]>([])
  const [err, setErr] = useState('')
  const [nu, setNu] = useState('')
  const [np, setNp] = useState('')
  const [nAdmin, setNAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  // Self-service password change (any role).
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')

  const isAdmin = !!user?.isAdmin

  async function changePw() {
    setPwMsg('')
    if (newPw.length < 6) { setPwMsg(t('serverAuth.errPassTooShort')); return }
    setBusy(true)
    try {
      await authChangePassword(oldPw, newPw)
      // Re-key the vault stash to the new password so a reload still unlocks (the old stashed
      // password would no longer match the login). Secrets remembered under the old key become
      // unrecallable and are re-prompted once — acceptable for a password change.
      if (user) {
        try { sessionStorage.setItem(PW_KEY, newPw) } catch { /* ignore */ }
        await ensureServerVault(user.username, newPw)
      }
      setOldPw(''); setNewPw('')
      setPwMsg(t('serverAuth.pwChanged'))
    } catch (e) { setPwMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const reload = async () => {
    try { setUsers(await userList()) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { if (enabled && isAdmin) void reload() }, [enabled, isAdmin])

  if (!enabled || !user) return null

  async function addUser() {
    setErr('')
    if (!nu.trim() || np.length < 6) { setErr(t('serverAuth.errPassTooShort')); return }
    setBusy(true)
    try {
      await userCreate(nu.trim(), np, nAdmin)
      setNu(''); setNp(''); setNAdmin(false)
      await reload()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function removeUser(id: number) {
    setErr('')
    try { await userDelete(id); await reload() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const field: React.CSSProperties = { height: 34, padding: '0 10px', borderRadius: 9, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 12.5, color: 'var(--text-primary)', outline: 'none' }

  return (
    <div style={{ border: '1px solid var(--accent-border)', borderRadius: 14, overflow: 'hidden', marginBottom: 16, background: 'var(--accent-soft-alt)' }}>
      {/* current account row */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 16, padding: '14px 16px' }}>
        <div className="row gap10" style={{ alignItems: 'center' }}>
          <div style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center' }}>
            <Icon name="user" size={16} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div className="col" style={{ gap: 1 }}>
            <span className="row gap6" style={{ fontSize: 13.5, fontWeight: 600 }}>
              {user.username}
              {user.isAdmin && <span className="badge-accent">{t('serverAuth.isAdmin')}</span>}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{t('serverAuth.account')}</span>
          </div>
        </div>
        <Btn variant="secondary" size="sm" onClick={() => void logout()}>{t('serverAuth.logout')}</Btn>
      </div>

      {/* change own password (any role) */}
      <div className="col" style={{ borderTop: '1px solid var(--border-hairline)', padding: '12px 16px', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('serverAuth.changePassword')}</span>
        <div className="row gap6" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder={t('serverAuth.currentPassword')} style={{ ...field, flex: 1, minWidth: 130 }} />
          <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder={t('serverAuth.newPassword')} style={{ ...field, flex: 1, minWidth: 130 }} />
          <Btn variant="secondary" size="sm" disabled={busy} onClick={() => void changePw()}>{t('serverAuth.changePassword')}</Btn>
        </div>
        {pwMsg && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{pwMsg}</span>}
      </div>

      {/* admin: user management */}
      {isAdmin && (
        <div className="col" style={{ borderTop: '1px solid var(--border-hairline)', padding: '12px 16px', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('serverAuth.users')}</span>
          {users.map(x => (
            <div key={x.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="row gap6" style={{ fontSize: 12.5 }}>
                <Icon name="user" size={12} /> {x.username}
                {x.isAdmin && <span className="badge-accent">{t('serverAuth.isAdmin')}</span>}
              </span>
              {x.id !== user.id && (
                <button className="icon-btn danger" style={{ width: 28, height: 28, background: 'var(--danger-soft)', color: 'var(--danger-fg)' }}
                  title={t('serverAuth.delete')} onClick={() => void removeUser(x.id)}>
                  <Icon name="trash-2" size={14} />
                </button>
              )}
            </div>
          ))}
          {/* add user */}
          <div className="row gap6" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={nu} onChange={e => setNu(e.target.value)} placeholder={t('serverAuth.fieldUsername')} style={{ ...field, flex: 1, minWidth: 120 }} />
            <input type="password" value={np} onChange={e => setNp(e.target.value)} placeholder={t('serverAuth.fieldPassword')} style={{ ...field, flex: 1, minWidth: 120 }} />
            <label className="row gap5" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={nAdmin} onChange={e => setNAdmin(e.target.checked)} /> {t('serverAuth.isAdmin')}
            </label>
            <Btn variant="primary" size="sm" icon="plus" disabled={busy} onClick={() => void addUser()}>{t('serverAuth.addUser')}</Btn>
          </div>
        </div>
      )}

      {err && <div className="row gap6" style={{ margin: '0 16px 12px', padding: '7px 10px', borderRadius: 9, background: 'var(--danger-soft)', border: '1px solid var(--danger-border)', color: 'var(--danger-fg)', fontSize: 12 }}><Icon name="alert-triangle" size={13} /> {err}</div>}
    </div>
  )
}
