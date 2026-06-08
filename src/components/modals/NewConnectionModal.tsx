/* ported from ref-ui/_extract/blob11.txt — verbatim per plan T1-T7 */
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented, Toggle, ConnGlyph } from '../atoms'
import { useData } from '../../state/DataContext'
import { saveProfile } from '../../state/connections'
import type { ConnectionProfile } from '../../state/connections'
import type { AuthMethod, SshConnectArgs, SshTestResult } from '../../services/ssh'
import { sshTest } from '../../services/ssh'

// ---- Prop types ----

export interface NewConnectionModalProps {
  onClose: () => void
  /** ORCH: emit a live connect request for a HOST/SSH connection. */
  onConnect?: (args: SshConnectArgs, display: { name: string }) => void
  /** When set, the modal runs in EDIT mode: prefill + save (no auto-connect). */
  editProfile?: ConnectionProfile
  /** Called after a successful save in edit mode (App uses it to reloadProfiles). */
  onSaved?: () => void
}

interface FieldProps {
  label: string
  value?: string
  placeholder?: string
  w?: number
  mono?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  onInput?: React.FormEventHandler<HTMLInputElement>
}

// Hoisted to module scope so it keeps a stable component identity across
// re-renders — otherwise inputs would remount (and lose focus/value) whenever
// the modal re-renders (e.g. when the test result or canTest state changes).
function Field({ label, value, placeholder, w, mono, inputRef, onInput }: FieldProps) {
  return (
    <label className="col" style={{ gap: 5, flex: w || 1 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
      <input ref={inputRef} defaultValue={value} placeholder={placeholder} onInput={onInput} className={mono ? 'mono' : ''}
        style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
    </label>
  )
}

// ---- Constants ----

const DB_ENGINES = [
  { id: 'postgres', label: 'PostgreSQL', short: 'PG' },
  { id: 'mysql', label: 'MySQL', short: 'SQL' },
  { id: 'redis', label: 'Redis', short: 'RDS' },
  { id: 'mongo', label: 'MongoDB', short: 'MGO' },
  { id: 'clickhouse', label: 'ClickHouse', short: 'CH' },
  { id: 'sqlite', label: 'SQLite', short: 'LITE' },
  { id: 'duckdb', label: 'DuckDB', short: 'DUCK' },
]

// ---- Component ----

export function NewConnectionModal({ onClose, onConnect, editProfile, onSaved }: NewConnectionModalProps) {
  const D = useData()
  const { t } = useTranslation()
  const isEdit = !!editProfile
  const nameRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLInputElement>(null)
  const portRef = useRef<HTMLInputElement>(null)
  const userRef = useRef<HTMLInputElement>(null)
  const PROTOS = [
    { id: 'ssh', label: 'SSH' }, { id: 'mosh', label: 'Mosh' },
    { id: 'telnet', label: 'Telnet' }, { id: 'serial', label: 'Serial' },
    { id: 'local', label: t('modals.protoLocal') },
  ]
  // Saved profiles are always SSH hosts → edit mode opens on the host tab.
  const [kind, setKind] = useState(isEdit ? 'host' : 'db')
  const [engine, setEngine] = useState('postgres')
  const [engineOpen, setEngineOpen] = useState(false)
  const engineRef = useRef<HTMLDivElement>(null)
  const [proto, setProto] = useState('ssh')
  const [authMethod, setAuthMethod] = useState<AuthMethod['method']>(editProfile?.auth.method ?? 'password')
  const [keyPath, setKeyPath] = useState(editProfile?.auth.method === 'keyFile' ? editProfile.auth.path : '')
  // In-memory secret only: password (password auth) or key passphrase (key-file auth).
  // Never prefilled (secrets are not persisted) and never written to a profile.
  const [secret, setSecret] = useState('')
  // ProxyJump / SSH-tunnel toggle — defaults OFF. Not wired to any backend behavior yet.
  const [tunnel, setTunnel] = useState(false)
  const [via, setVia] = useState('h-bastion')
  // Real connection-test state (replaces the old fake "tested" badge).
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<SshTestResult | null>(null)
  // Reactive enablement for the Test button — host & user must be non-empty.
  // host/user are uncontrolled refs; recompute on their input events.
  const [canTest, setCanTest] = useState(isEdit ? !!editProfile.host && !!editProfile.user : false)
  const recomputeCanTest = () =>
    setCanTest(!!(hostRef.current?.value || '').trim() && !!(userRef.current?.value || '').trim())
  const [color, setColor] = useState('var(--signal-rose)')
  const hosts = D.connections.filter(c => c.kind === 'host' && c.proto !== 'local')

  // Build the auth descriptor (non-secret) from the current form.
  function currentAuth(): AuthMethod {
    return authMethod === 'keyFile'
      ? { method: 'keyFile', path: keyPath.trim() }
      : { method: 'password' }
  }

  // Build live connect/test args from the form, INCLUDING the in-memory secret.
  function currentArgs(): SshConnectArgs {
    const host = (hostRef.current?.value || '').trim()
    const user = (userRef.current?.value || '').trim()
    const port = Number(portRef.current?.value) || 22
    // password auth → password; key-file auth → optional passphrase. Empty → undefined.
    const sec = secret.length > 0 ? secret : undefined
    return { host, port, user, auth: currentAuth(), secret: sec }
  }

  async function runTest() {
    const args = currentArgs()
    if (!args.host || !args.user || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await sshTest(args)
      setTestResult(result)
    } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? String(err)
      setTestResult({ ok: false, latencyMs: 0, error: message })
    } finally {
      setTesting(false)
    }
  }

  function handleSave() {
    // EDIT mode: update the existing profile in place (same id), no auto-connect.
    if (isEdit && editProfile) {
      const host = (hostRef.current?.value || '').trim()
      const user = (userRef.current?.value || '').trim()
      const port = Number(portRef.current?.value) || 22
      const name = (nameRef.current?.value || '').trim() || host
      const auth = currentAuth()
      try {
        saveProfile({ id: editProfile.id, name, host, port, user, auth })
      } catch { /* localStorage unavailable — ignore */ }
      onSaved?.()
      onClose()
      return
    }
    // SSH/host connections drive the live connect flow (ORCH).
    // DB connections (sub-project 3) keep the prototype's close-only behavior.
    if (kind === 'host' && proto === 'ssh' && onConnect) {
      const host = (hostRef.current?.value || '').trim()
      const user = (userRef.current?.value || '').trim()
      const port = Number(portRef.current?.value) || 22
      const name = (nameRef.current?.value || '').trim() || host
      const auth = currentAuth()
      // args carries the in-memory secret so App can connect WITHOUT a 2nd prompt.
      const sec = secret.length > 0 ? secret : undefined
      const args: SshConnectArgs = { host, port, user, auth, secret: sec }
      // Persist the NON-secret profile only (best-effort). Secret never leaves memory.
      try {
        saveProfile({ id: `live-${host}:${port}-${user}`, name, host, port, user, auth })
      } catch { /* localStorage unavailable — ignore */ }
      onConnect(args, { name })
    }
    onClose()
  }

  useEffect(() => {
    if (!engineOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (engineRef.current && !engineRef.current.contains(e.target as Node)) {
        setEngineOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [engineOpen])

  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in" style={{ width: 620, maxHeight: '86%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px' }}>{isEdit ? t('modals.editTitle') : t('modals.newConnection')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{isEdit ? t('modals.editSub') : t('modals.newConnectionSub')}</span>
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* kind toggle */}
        <div className="row gap10" style={{ padding: '16px 20px 4px' }}>
          {[
            { id: 'host', icon: 'server', label: t('modals.kindHost'), sub: t('modals.kindHostSub') },
            { id: 'db',   icon: 'database', label: t('modals.kindDb'),   sub: t('modals.kindDbSub') },
          ].map(o => {
            const active = kind === o.id
            return (
              <button key={o.id} onClick={() => setKind(o.id)}
                style={{ flex: 1, textAlign: 'left', padding: 14, borderRadius: 14, border: active ? '2px solid var(--accent-primary)' : '1px solid var(--border-hairline)', background: active ? 'var(--accent-soft-alt)' : 'var(--surface-card)', boxShadow: active ? 'var(--glow-selected)' : 'none', transition: 'all .14s' }}>
                <div className="row gap10">
                  <div className="icon-badge" style={{ width: 36, height: 36, borderRadius: 10, background: active ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: active ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}><Icon name={o.icon} size={18} /></div>
                  <div className="col" style={{ lineHeight: 1.3 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{o.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{o.sub}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        {/* body */}
        <div className="grow" style={{ overflowY: 'auto', padding: '14px 20px 8px' }}>
          {/* engine / proto picker */}
          {kind === 'db' ? (
            <div className="col" style={{ gap: 6, marginBottom: 16 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.engine')}</span>
              <div ref={engineRef} style={{ position: 'relative' }}>
                {/* closed trigger */}
                <button
                  onClick={() => setEngineOpen(o => !o)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', cursor: 'pointer', textAlign: 'left' }}>
                  {(() => {
                    const sel = DB_ENGINES.find(e => e.id === engine) || DB_ENGINES[0]
                    const m = D.engineMeta[sel.id] || {}
                    return (
                      <>
                        <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: m.color, minWidth: 28 }}>{sel.short}</span>
                        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{sel.label}</span>
                        <Icon name="chevron-down" size={14} style={{ color: 'var(--text-faint)', transform: engineOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .14s' }} />
                      </>
                    )
                  })()}
                </button>
                {/* dropdown menu */}
                {engineOpen && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', maxHeight: 260, overflowY: 'auto' }}>
                    {DB_ENGINES.map(e => {
                      const active = engine === e.id
                      const m = D.engineMeta[e.id] || {}
                      return (
                        <button key={e.id}
                          onClick={() => { setEngine(e.id); setEngineOpen(false) }}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                          <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: m.color, minWidth: 28 }}>{e.short}</span>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{e.label}</span>
                          {active && <Icon name="check" size={13} style={{ color: 'var(--accent-primary)' }} />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="col" style={{ gap: 6, marginBottom: 16 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.protocol')}</span>
              <Segmented value={proto} onChange={setProto} options={PROTOS.map(p => ({ value: p.id, label: p.label }))} />
            </div>
          )}

          {/* base fields */}
          <div className="col gap10" style={{ marginBottom: 14 }}>
            <div className="row gap10">
              <Field label={t('modals.fieldName')} value={isEdit ? editProfile.name : ''} w={1.4} inputRef={nameRef} />
              <label className="col" style={{ gap: 5, flex: 1 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldGroup')}</span>
                <div className="row gap6" style={{ height: 36 }}>
                  {D.groups.map(g => <button key={g.id} onClick={() => setColor(g.color)} style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surface-sunken)', border: color === g.color ? `2px solid ${g.color}` : '1px solid var(--border-hairline)', display: 'grid', placeItems: 'center' }}><span className="dot" style={{ background: g.color, width: 9, height: 9 }} /></button>)}
                </div>
              </label>
            </div>
            <div className="row gap10">
              <Field label={t('modals.fieldHost')} value={isEdit ? editProfile.host : ''} mono w={2} inputRef={hostRef} onInput={recomputeCanTest} />
              <Field key={`port-${kind}-${engine}`} label={t('modals.fieldPort')} value={isEdit ? String(editProfile.port) : (kind === 'db' ? (engine === 'postgres' ? '5432' : engine === 'redis' ? '6379' : '3306') : '22')} mono w={0.8} inputRef={portRef} />
            </div>
            <div className="row gap10">
              <Field label={kind === 'db' ? t('modals.fieldUser') : t('modals.fieldUsername')} value={isEdit ? editProfile.user : ''} mono inputRef={userRef} onInput={recomputeCanTest} />
              {/* Secret field — coherent with the chosen auth method.
                  password auth → password; key-file auth → optional passphrase.
                  Controlled so it can feed sshTest / connect; never persisted. */}
              {authMethod === 'password' ? (
                <label className="col" style={{ gap: 5, flex: 1 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldPassword')}</span>
                  <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
                    <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
                    <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={t('modals.fieldPassword')} className="mono"
                      style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                  </div>
                </label>
              ) : (
                <label className="col" style={{ gap: 5, flex: 1 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldPassphrase')}</span>
                  <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
                    <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
                    <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={t('modals.fieldPassphrasePlaceholder')} className="mono"
                      style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                  </div>
                </label>
              )}
            </div>
          </div>

          {/* auth method — host/SSH only */}
          {kind === 'host' && (
            <div className="col gap10" style={{ marginBottom: 14 }}>
              <div className="col" style={{ gap: 6 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.authMethod')}</span>
                <Segmented
                  value={authMethod}
                  onChange={v => setAuthMethod(v as AuthMethod['method'])}
                  options={[
                    { value: 'password', label: t('modals.authPassword') },
                    { value: 'keyFile', label: t('modals.authKeyFile') },
                  ]}
                />
              </div>
              {authMethod === 'keyFile' && (
                <label className="col" style={{ gap: 5 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.keyPath')}</span>
                  <input
                    value={keyPath}
                    onChange={e => setKeyPath(e.target.value)}
                    placeholder={t('modals.keyPathPlaceholder')}
                    className="mono"
                    style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }}
                  />
                </label>
              )}
            </div>
          )}

          {/* tunnel / proxyjump — the integration bridge */}
          <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 14, overflow: 'hidden', marginBottom: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '12px 14px', background: tunnel ? 'var(--accent-soft-alt)' : 'var(--surface-subtle)' }}>
              <div className="row gap10">
                <div className="icon-badge" style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--surface-card)', color: tunnel ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}><Icon name="link" size={16} /></div>
                <div className="col" style={{ lineHeight: 1.3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{kind === 'db' ? t('modals.tunnelSshTitle') : t('modals.tunnelProxyTitle')}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{kind === 'db' ? t('modals.tunnelSshSub') : t('modals.tunnelProxySub')}</span>
                </div>
              </div>
              <Toggle on={tunnel} onChange={setTunnel} accent />
            </div>
            {tunnel && (
              <div className="col gap10" style={{ padding: 14, borderTop: '1px solid var(--border-hairline)' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.tunnelSelectHost')}</span>
                <div className="col gap6">
                  {hosts.map(h => {
                    const active = via === h.id
                    return (
                      <button key={h.id} onClick={() => setVia(h.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, border: active ? '1.5px solid var(--accent-primary)' : '1px solid var(--border-hairline)', background: active ? 'var(--accent-soft)' : 'var(--surface-card)' }}>
                        <ConnGlyph conn={h} size={28} radius={8} />
                        <div className="col" style={{ lineHeight: 1.25, textAlign: 'left' }}>
                          <span style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{h.name}</span>
                          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{h.sub}</span>
                        </div>
                        {active && <Icon name="check" size={15} style={{ marginLeft: 'auto', color: 'var(--accent-primary)' }} />}
                      </button>
                    )
                  })}
                </div>
                <div className="row gap8" style={{ padding: '8px 10px', background: 'var(--surface-sunken)', borderRadius: 10 }}>
                  <Icon name="git-commit" size={13} style={{ color: 'var(--text-faint)' }} />
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>localhost → {D.byId[via] ? D.byId[via].name : 'bastion'} → {kind === 'db' ? '10.0.4.2:5432' : 'target'}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '14px 20px', borderTop: '1px solid var(--border-hairline)' }}>
          <button className="btn btn-secondary" onClick={runTest}
            disabled={testing || !canTest}
            style={{ opacity: testing || !canTest ? 0.55 : 1, cursor: testing || !canTest ? 'not-allowed' : 'pointer' }}>
            {testing ? (
              <><Icon name="loader" size={15} className="spin" /> {t('modals.testing')}</>
            ) : testResult ? (
              testResult.ok ? (
                <><Icon name="circle-check" size={15} style={{ color: 'var(--signal-green)' }} /> <span style={{ color: 'var(--signal-green)' }}>{t('modals.testOk')} · {testResult.latencyMs}ms</span></>
              ) : (
                <><Icon name="alert-triangle" size={15} style={{ color: 'var(--danger-fg)' }} /> <span style={{ color: 'var(--danger-fg)' }}>{t('modals.testFail')} · {testResult.error}</span></>
              )
            ) : (
              <><Icon name="zap" size={15} /> {t('modals.testConn')}</>
            )}
          </button>
          <div className="row gap8">
            <Btn variant="ghost" onClick={onClose}>{t('modals.cancel')}</Btn>
            <Btn variant="primary" icon="check" onClick={handleSave}>{isEdit ? t('modals.save') : t('modals.saveAndConnect')}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
