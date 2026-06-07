/* ported from ref-ui/_extract/blob14.txt — verbatim per plan T1-T7 */
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'

// ---- Prop types ----

export interface AuthUser {
  username: string
  pass: string
  hint?: string
}

export interface AuthGateProps {
  users: AuthUser[]
  onLogin: (username: string) => void
  onCreate: (user: { username: string; pass: string; hint: string }) => void
}

// ---- Component ----

export function AuthGate({ users, onLogin, onCreate }: AuthGateProps) {
  const { t } = useTranslation()
  const firstRun = users.length === 0
  const [screen, setScreen] = useState(firstRun ? 'init' : 'login')
  const [u, setU] = useState(users[0] ? users[0].username : '')
  const [p, setP] = useState('')
  const [p2, setP2] = useState('')
  const [hint, setHint] = useState('')
  const [showHint, setShowHint] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const userObj = users.find(x => x.username === u)

  function submitLogin() {
    const found = users.find(x => x.username.toLowerCase() === u.trim().toLowerCase())
    if (!found) { setErr(t('auth.errUserNotFound')); return }
    if (found.pass !== p) { setErr(t('auth.errWrongPass')); return }
    onLogin(found.username)
  }
  function submitInit() {
    if (!u.trim()) { setErr(t('auth.errNoUsername')); return }
    if (p.length < 4) { setErr(t('auth.errPassTooShort')); return }
    if (p !== p2) { setErr(t('auth.errPassMismatch')); return }
    if (users.some(x => x.username.toLowerCase() === u.trim().toLowerCase())) { setErr(t('auth.errUserExists')); return }
    onCreate({ username: u.trim(), pass: p, hint: hint.trim() })
  }
  const isInit = screen === 'init'
  const field: React.CSSProperties = { height: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13.5, color: 'var(--text-primary)', outline: 'none', width: '100%' }
  const Label = ({ children }: { children: React.ReactNode }) => <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{children}</span>

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center',
      background: 'color-mix(in srgb, var(--cta-bg) 55%, transparent)', backdropFilter: 'blur(10px)' }}>
      <div className="pop-in col" style={{ width: 380, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 20, boxShadow: 'var(--shadow-window)', overflow: 'hidden' }}>
        {/* header */}
        <div className="col" style={{ alignItems: 'center', gap: 12, padding: '28px 28px 18px' }}>
          <div className="logo-mark" style={{ width: 52, height: 52, borderRadius: 16, position: 'relative' }}>
            <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>&gt;_</span>
            <div style={{ position: 'absolute', right: -4, bottom: -4, width: 24, height: 24, borderRadius: 999, background: 'var(--surface-card)', display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-card)' }}>
              <Icon name={isInit ? 'user' : 'lock'} size={13} style={{ color: 'var(--accent-primary)' }} />
            </div>
          </div>
          <div className="col" style={{ alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>{isInit ? t('auth.initTitle') : t('auth.lockTitle')}</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center', textWrap: 'pretty' }}>
              {isInit ? t('auth.initSub') : t('auth.lockSub')}
            </span>
          </div>
        </div>

        {/* user chips (login, multiple users) */}
        {!isInit && users.length > 1 && (
          <div className="row gap6" style={{ padding: '0 24px 4px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {users.map(x => (
              <button key={x.username} onClick={() => { setU(x.username); setP(''); setErr(''); setShowHint(false) }}
                className="row gap6" style={{ padding: '5px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                  border: u === x.username ? '1.5px solid var(--accent-primary)' : '1px solid var(--border-hairline-alt)',
                  background: u === x.username ? 'var(--accent-soft)' : 'var(--surface-card)', color: u === x.username ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                <Icon name="user" size={12} /> {x.username}
              </button>
            ))}
          </div>
        )}

        {/* form */}
        <div className="col gap12" style={{ padding: '12px 28px 4px' }}>
          {(isInit || users.length <= 1) && (
            <label className="col gap5">
              <Label>{t('auth.fieldUsername')}</Label>
              <input value={u} onChange={e => { setU(e.target.value); setErr('') }} placeholder={t('auth.fieldUsernamePlaceholder')} style={field} autoFocus={isInit} />
            </label>
          )}
          <label className="col gap5">
            <Label>{t('auth.fieldPassword')}</Label>
            <div className="row" style={{ position: 'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={p} onChange={e => { setP(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter') (isInit ? submitInit() : submitLogin()) }}
                placeholder={isInit ? t('auth.fieldPasswordInitPlaceholder') : t('auth.fieldPasswordLoginPlaceholder')} style={field} autoFocus={!isInit} />
              <button className="icon-btn bare" style={{ position: 'absolute', right: 4, top: 4, width: 32, height: 32 }} onClick={() => setShowPw(s => !s)} tabIndex={-1}>
                <Icon name={showPw ? 'eye-off' : 'eye'} size={15} />
              </button>
            </div>
          </label>
          {isInit && (
            <>
              <label className="col gap5">
                <Label>{t('auth.fieldConfirmPassword')}</Label>
                <input type="password" value={p2} onChange={e => { setP2(e.target.value); setErr('') }}
                  onKeyDown={e => { if (e.key === 'Enter') submitInit() }} placeholder={t('auth.fieldConfirmPasswordPlaceholder')} style={field} />
              </label>
              <label className="col gap5">
                <Label>{t('auth.fieldHint')} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{t('auth.fieldHintOptional')}</span></Label>
                <input value={hint} onChange={e => setHint(e.target.value)} placeholder={t('auth.fieldHintPlaceholder')} style={field} />
              </label>
            </>
          )}
          {/* hint reveal (login) */}
          {!isInit && (
            <div className="row" style={{ justifyContent: 'flex-end', minHeight: 18 }}>
              {userObj && userObj.hint
                ? (showHint
                    ? <span className="row gap5" style={{ fontSize: 11.5, color: 'var(--signal-amber)' }}><Icon name="info" size={12} /> {t('auth.hintPrefix')}{userObj.hint}</span>
                    : <button onClick={() => setShowHint(true)} style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('auth.forgotPass')}</button>)
                : <span style={{ fontSize: 11.5, color: 'var(--text-disabled)' }}>{t('auth.noHint')}</span>}
            </div>
          )}
          {err && <div className="row gap6" style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--danger-soft)', border: '1px solid var(--danger-border)', color: 'var(--danger-fg)', fontSize: 12 }}><Icon name="alert-triangle" size={13} /> {err}</div>}
        </div>

        {/* actions */}
        <div className="col gap10" style={{ padding: '12px 28px 18px' }}>
          <button className="btn btn-primary lg" style={{ width: '100%' }} onClick={isInit ? submitInit : submitLogin}>
            <Icon name={isInit ? 'check' : 'lock'} size={16} /> {isInit ? t('auth.btnCreate') : t('auth.btnUnlock')}
          </button>
          {isInit
            ? (users.length > 0 && <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => { setScreen('login'); setErr('') }}>{t('auth.backToLogin')}</button>)
            : <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => { setScreen('init'); setU(''); setP(''); setP2(''); setHint(''); setErr('') }}><Icon name="plus" size={15} /> {t('auth.createNewUser')}</button>}
        </div>

        {/* footer note */}
        <div className="row gap8" style={{ padding: '12px 20px', borderTop: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', justifyContent: 'center' }}>
          <Icon name="shield" size={13} style={{ color: 'var(--signal-green)' }} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>{t('auth.footerNote')}</span>
        </div>
      </div>
    </div>
  )
}
