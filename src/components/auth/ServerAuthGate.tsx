//! Web-deploy authentication gate (M2). Distinct from the desktop `AuthGate` (a local app-lock):
//! this gates the BROWSER session against the server's user accounts. Active only in server mode
//! (`__CATIO_SERVER__`); in the desktop app and in dev/test it renders children straight through,
//! so nothing about the desktop flow changes.
//!
//! It also publishes the signed-in user + a logout/refresh API via context, so a Settings panel
//! can show the account and (for admins) manage users.

import React, { createContext, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isServer } from '../../services/transport'
import { authMe, authLogin, authBootstrap, authLogout, type ServerUser } from '../../services/auth'
import { hydrateUserStores, clearUserStores, clearEphemeralServerState, USER_STORES } from '../../services/userStore'

import { Icon } from '../Icon'
import { BrandMark } from '../BrandMark'

// NOTE: server-mode connection secrets live on the SERVER (services/secrets.ts, encrypted with
// CATIO_MASTER_KEY) — NOT in the browser WebCrypto vault, which is unavailable over plain-HTTP LAN
// access. So login here does NOT touch state/vault.ts at all.

interface ServerAuthCtx {
  /** Signed-in user, or null in desktop/dev (where there is no server auth). */
  user: ServerUser | null
  /** True only in the browser/server deploy. */
  enabled: boolean
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<ServerAuthCtx>({ user: null, enabled: false, logout: async () => {}, refresh: async () => {} })

/** Access the server-auth state (current user, logout). Safe to call anywhere under the gate. */
export function useServerAuth(): ServerAuthCtx {
  return useContext(Ctx)
}

type Phase = 'loading' | 'login' | 'bootstrap' | 'ready'

export function ServerAuthGate({ children }: { children: React.ReactNode }) {
  // Desktop / dev / test: no server auth at all — pass through untouched.
  if (!isServer()) return <>{children}</>
  return <ServerAuthGateImpl>{children}</ServerAuthGateImpl>
}

function ServerAuthGateImpl({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [user, setUser] = useState<ServerUser | null>(null)

  const refresh = async () => {
    try {
      const s = await authMe()
      if (s.user) {
        // Wipe the previous user's ephemeral per-browser UI state (open tabs / recent sessions),
        // then load THIS user's connections/groups/snippets/history/conversations/tunnels from the
        // server BEFORE showing the workbench — so nothing of the previous user is ever visible.
        clearEphemeralServerState()
        try { await hydrateUserStores([...USER_STORES]) } catch { /* show workbench anyway */ }
        setUser(s.user)
        setPhase('ready')
      } else {
        clearUserStores()
        setUser(null); setPhase(s.needsBootstrap ? 'bootstrap' : 'login')
      }
    } catch {
      // If auth_me itself fails (network), fall back to the login screen.
      setUser(null); setPhase('login')
    }
  }

  useEffect(() => { void refresh() }, [])

  const logout = async () => {
    try { await authLogout() } finally {
      clearUserStores() // drop the previous user's data so the next login starts clean
      clearEphemeralServerState() // + open-tabs / recent-sessions
      setUser(null)
      setPhase('login')
    }
  }

  if (phase === 'ready' && user) {
    return <Ctx.Provider value={{ user, enabled: true, logout, refresh }}>{children}</Ctx.Provider>
  }

  if (phase === 'loading') {
    return (
      <div style={overlay}>
        <div className="col" style={{ alignItems: 'center', gap: 12 }}>
          <BrandMark size={48} style={{ borderRadius: 14 }} />
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('serverAuth.loading')}</span>
        </div>
      </div>
    )
  }

  return <AuthForm mode={phase === 'bootstrap' ? 'bootstrap' : 'login'} onDone={refresh} />
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200, display: 'grid', placeItems: 'center',
  background: 'var(--app-bg, #0b0d12)',
}

function AuthForm({ mode, onDone }: { mode: 'login' | 'bootstrap'; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const init = mode === 'bootstrap'
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [p2, setP2] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setErr('')
    if (!u.trim()) { setErr(t('serverAuth.errNoUsername')); return }
    if (init) {
      if (p.length < 6) { setErr(t('serverAuth.errPassTooShort')); return }
      if (p !== p2) { setErr(t('serverAuth.errPassMismatch')); return }
    }
    setBusy(true)
    try {
      if (init) await authBootstrap(u.trim(), p)
      else await authLogin(u.trim(), p)
      await onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const field: React.CSSProperties = { height: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13.5, color: 'var(--text-primary)', outline: 'none', width: '100%' }
  const Label = ({ children }: { children: React.ReactNode }) => <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{children}</span>

  return (
    <div style={overlay}>
      <div className="pop-in col" style={{ width: 380, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 20, boxShadow: 'var(--shadow-window)', overflow: 'hidden' }}>
        {/* header */}
        <div className="col" style={{ alignItems: 'center', gap: 12, padding: '28px 28px 18px' }}>
          <div style={{ width: 52, height: 52, position: 'relative' }}>
            <BrandMark size={52} style={{ borderRadius: 16 }} />
            <div style={{ position: 'absolute', right: -4, bottom: -4, width: 24, height: 24, borderRadius: 999, background: 'var(--surface-card)', display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-card)' }}>
              <Icon name={init ? 'user' : 'lock'} size={13} style={{ color: 'var(--accent-primary)' }} />
            </div>
          </div>
          <div className="col" style={{ alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>{init ? t('serverAuth.bootstrapTitle') : t('serverAuth.loginTitle')}</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center', textWrap: 'pretty' }}>
              {init ? t('serverAuth.bootstrapSub') : t('serverAuth.loginSub')}
            </span>
          </div>
        </div>

        {/* form */}
        <div className="col gap12" style={{ padding: '12px 28px 4px' }}>
          <label className="col gap5">
            <Label>{t('serverAuth.fieldUsername')}</Label>
            <input value={u} onChange={e => { setU(e.target.value); setErr('') }} placeholder={t('serverAuth.fieldUsernamePlaceholder')} style={field} autoFocus />
          </label>
          <label className="col gap5">
            <Label>{t('serverAuth.fieldPassword')}</Label>
            <div className="row" style={{ position: 'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={p} onChange={e => { setP(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter' && !init) submit() }}
                placeholder={t('serverAuth.fieldPasswordPlaceholder')} style={field} />
              <button className="icon-btn bare" style={{ position: 'absolute', right: 4, top: 4, width: 32, height: 32 }} onClick={() => setShowPw(s => !s)} tabIndex={-1}>
                <Icon name={showPw ? 'eye-off' : 'eye'} size={15} />
              </button>
            </div>
          </label>
          {init && (
            <label className="col gap5">
              <Label>{t('serverAuth.fieldConfirmPassword')}</Label>
              <input type="password" value={p2} onChange={e => { setP2(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter') submit() }} placeholder={t('serverAuth.fieldConfirmPasswordPlaceholder')} style={field} />
            </label>
          )}
          {err && <div className="row gap6" style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--danger-soft)', border: '1px solid var(--danger-border)', color: 'var(--danger-fg)', fontSize: 12 }}><Icon name="alert-triangle" size={13} /> {err}</div>}
        </div>

        {/* actions */}
        <div className="col gap10" style={{ padding: '12px 28px 18px' }}>
          <button className="btn btn-primary lg" style={{ width: '100%', opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
            <Icon name={init ? 'check' : 'lock'} size={16} /> {init ? t('serverAuth.btnCreate') : t('serverAuth.btnSignIn')}
          </button>
        </div>

        {/* footer note */}
        <div className="row gap8" style={{ padding: '12px 20px', borderTop: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', justifyContent: 'center' }}>
          <Icon name="shield" size={13} style={{ color: 'var(--signal-green)' }} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>{t('serverAuth.footerNote')}</span>
        </div>
      </div>
    </div>
  )
}
