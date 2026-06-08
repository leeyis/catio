/* ported from ref-ui/_extract/blob11.txt — verbatim per plan T1-T7 */
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented, Toggle, ConnGlyph } from '../atoms'
import { useData } from '../../state/DataContext'
import type { AuthMethod } from '../../services/ssh'
import type { DbType } from '../../services/db'
import { dbConnect, testConnection } from '../../services/db'
import { saveDbConnection, setActiveDbConnection, generateProfileId } from '../../state/dbConnections'
import type { DbProfile } from '../../state/dbConnections'

// ---- Prop types ----

export interface NewConnectionModalProps {
  onClose: () => void
  /** Default connection kind, derived from the sidebar's active filter tab. */
  initialKind?: 'host' | 'db'
  /** Called on a successful live DB connect (Tauri) with the saved profile, so the
   *  caller can immediately open the workbench for it. Not called in non-Tauri dev. */
  onConnected?: (profile: DbProfile) => void
  /** When set, the modal opens in EDIT mode pre-filled with this DB profile. Saving
   *  upserts under the SAME id (update, not a new entry). */
  editProfile?: DbProfile
}

interface FieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  w?: number
  mono?: boolean
  type?: string
  /** When set, restrict input to digits only (e.g. port numbers). */
  numeric?: boolean
}

// Defined at module scope (NOT inside the component) so its identity is stable
// across renders — otherwise React remounts the <input> on every keystroke and
// the field loses focus mid-typing.
function Field({ label, value, onChange, placeholder, w, mono, type, numeric }: FieldProps) {
  return (
    <label className="col" style={{ gap: 5, flex: w || 1 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
      <input value={value}
        onChange={e => onChange(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)}
        placeholder={placeholder}
        {...(numeric ? { inputMode: 'numeric' as const } : {})}
        type={type ?? 'text'}
        className={mono ? 'mono' : ''}
        style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
    </label>
  )
}

// ---- Constants ----

const DB_ENGINES: { id: DbType; label: string; short: string; defaultPort: number }[] = [
  { id: 'postgres',      label: 'PostgreSQL',    short: 'PG',   defaultPort: 5432  },
  { id: 'mysql',         label: 'MySQL',          short: 'SQL',  defaultPort: 3306  },
  { id: 'redis',         label: 'Redis',          short: 'RDS',  defaultPort: 6379  },
  { id: 'mongodb',       label: 'MongoDB',        short: 'MGO',  defaultPort: 27017 },
  { id: 'clickhouse',    label: 'ClickHouse',     short: 'CH',   defaultPort: 8123  },
  { id: 'sqlite',        label: 'SQLite',         short: 'LITE', defaultPort: 0     },
  { id: 'duckdb',        label: 'DuckDB',         short: 'DUCK', defaultPort: 0     },
  { id: 'sqlserver',     label: 'SQL Server',     short: 'MSSQL',defaultPort: 1433  },
  { id: 'elasticsearch', label: 'Elasticsearch',  short: 'ES',   defaultPort: 9200  },
  { id: 'rqlite',        label: 'rqlite',         short: 'RQL',  defaultPort: 4001  },
]

// Trim a verbose server version banner to a compact label for the test-passed
// pill. e.g. "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by ..." → "PostgreSQL 16.2".
function shortVersion(v: string): string {
  if (!v) return ''
  const firstLine = v.split('\n')[0].trim()
  const m = firstLine.match(/^([A-Za-z][A-Za-z ]*?\s*v?[\d][\d.]*)/)
  return (m ? m[1] : firstLine).trim()
}

// ---- Component ----

export function NewConnectionModal({ onClose, initialKind = 'db', onConnected, editProfile }: NewConnectionModalProps) {
  const D = useData()
  const { t } = useTranslation()
  const isEdit = !!editProfile
  const PROTOS = [
    { id: 'ssh', label: 'SSH' }, { id: 'mosh', label: 'Mosh' },
    { id: 'telnet', label: 'Telnet' }, { id: 'serial', label: 'Serial' },
    { id: 'local', label: t('modals.protoLocal') },
  ]
  const [kind, setKind] = useState<string>(editProfile ? 'db' : initialKind)
  const [engine, setEngine] = useState<DbType>(editProfile?.dbType ?? 'postgres')
  const [engineOpen, setEngineOpen] = useState(false)
  const engineRef = useRef<HTMLDivElement>(null)
  const [proto, setProto] = useState('ssh')
  const [authMethod, setAuthMethod] = useState<AuthMethod['method']>('password')
  const [keyPath, setKeyPath] = useState('')
  const [tunnel, setTunnel] = useState(false)
  const [via, setVia] = useState('h-bastion')
  const [tested, setTested] = useState(false)
  const [testResult, setTestResult] = useState<{ version: string; latencyMs: number } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [color, setColor] = useState('var(--signal-rose)')
  const hosts = D.connections.filter(c => c.kind === 'host' && c.proto !== 'local')

  // DB-specific controlled state — empty by default (or pre-filled from editProfile).
  const [dbName, setDbName] = useState(editProfile?.name ?? '')
  const [dbHost, setDbHost] = useState(editProfile?.host ?? '')
  const [dbPort, setDbPort] = useState(editProfile ? String(editProfile.port) : '5432')
  const [dbUser, setDbUser] = useState(editProfile?.user ?? '')
  const [dbDatabase, setDbDatabase] = useState(editProfile?.database ?? '')
  const [dbSecret, setDbSecret] = useState('')
  const [dbConnecting, setDbConnecting] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)

  // Reset port to the new engine's default whenever the engine changes, so the
  // port field always reflects the selected engine (never a stale value from a
  // previous engine). File-based engines (defaultPort 0) clear the field —
  // their port is irrelevant.
  const handleEngineChange = (id: DbType) => {
    setEngine(id)
    setEngineOpen(false)
    const eng = DB_ENGINES.find(e => e.id === id)
    if (eng) setDbPort(eng.defaultPort > 0 ? String(eng.defaultPort) : '')
    // Connection params changed — any prior test result is stale.
    setTested(false)
    setTestResult(null)
    setTestError(null)
  }

  // Any change to connection params invalidates a prior test result.
  useEffect(() => {
    setTested(false)
    setTestResult(null)
    setTestError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbHost, dbPort, dbUser, dbDatabase, dbSecret])

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

  // Real, ephemeral connection test (DB kind). Builds the same args as
  // save-and-connect, pings the server, and surfaces version + latency.
  const handleTestConnection = async () => {
    setTested(false)
    setTestResult(null)
    setTestError(null)
    setTesting(true)
    try {
      const result = await testConnection({
        dbType: engine,
        host: dbHost,
        port: Number(dbPort),
        user: dbUser,
        ...(dbDatabase ? { database: dbDatabase } : {}),
        secret: dbSecret || undefined,
      })
      setTestResult(result)
      setTested(true)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const handleDbSaveAndConnect = async () => {
    setDbError(null)
    setDbConnecting(true)
    // EDIT mode reuses the existing profile id so saveDbConnection upserts (updates)
    // the same entry instead of creating a new one.
    const id = editProfile ? editProfile.id : generateProfileId()
    const profile = {
      id,
      ...(editProfile?.group ? { group: editProfile.group } : {}),
      name: dbName,
      dbType: engine,
      host: dbHost,
      port: Number(dbPort),
      user: dbUser,
      ...(dbDatabase ? { database: dbDatabase } : {}),
    }
    // Persist profile WITHOUT secret. Triggers the reactive store's notify(), so the
    // sidebar / home connection list updates immediately — the connection never
    // silently vanishes.
    saveDbConnection(profile)
    // Attempt live connection (only works in Tauri runtime; throws outside)
    try {
      const result = await dbConnect({ ...profile, secret: dbSecret || undefined })
      // Store connId + capabilities for D3 (capabilities-gated UI) to consume
      setActiveDbConnection(result, profile)
      setDbSecret('') // discard secret from memory
      setDbConnecting(false)
      // Success: hand the saved profile back so the caller opens its workbench with
      // real data, then close the modal.
      onConnected?.(profile)
      onClose()
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('Tauri runtime')) {
        // Real connection failure: keep the modal OPEN and surface the error.
        setDbError(msg)
        setDbConnecting(false)
        return
      }
      // Non-Tauri dev ("requires the Tauri runtime"): the profile is saved and now
      // appears in the list; there is no active backend connection (fine in dev).
      setDbSecret('')
      setDbConnecting(false)
      onClose()
    }
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div className="pop-in" style={{ width: 620, maxHeight: '86%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px' }}>{isEdit ? t('modals.editConnection') : t('modals.newConnection')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('modals.newConnectionSub')}</span>
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
                          onClick={() => handleEngineChange(e.id)}
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
              {kind === 'db'
                ? <Field label={t('modals.fieldName')} value={dbName} onChange={setDbName} placeholder="my-database" w={1.4} />
                : <Field label={t('modals.fieldName')} value="prod-web-01" onChange={() => undefined} w={1.4} />}
              <label className="col" style={{ gap: 5, flex: 1 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldGroup')}</span>
                <div className="row gap6" style={{ height: 36 }}>
                  {D.groups.map(g => <button key={g.id} onClick={() => setColor(g.color)} style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surface-sunken)', border: color === g.color ? `2px solid ${g.color}` : '1px solid var(--border-hairline)', display: 'grid', placeItems: 'center' }}><span className="dot" style={{ background: g.color, width: 9, height: 9 }} /></button>)}
                </div>
              </label>
            </div>
            <div className="row gap10">
              {kind === 'db'
                ? <Field label={t('modals.fieldHost')} value={dbHost} onChange={setDbHost} placeholder="127.0.0.1" mono w={2} />
                : <Field label={t('modals.fieldHost')} value="10.0.1.21" onChange={() => undefined} mono w={2} />}
              {kind === 'db'
                ? <Field label={t('modals.fieldPort')} value={dbPort} onChange={setDbPort} numeric mono w={0.8} />
                : <Field label={t('modals.fieldPort')} value="22" onChange={() => undefined} mono w={0.8} />}
            </div>
            <div className="row gap10">
              {kind === 'db'
                ? <Field label={t('modals.fieldUser')} value={dbUser} onChange={setDbUser} placeholder={t('modals.fieldUserPlaceholder')} mono />
                : <Field label={t('modals.fieldUsername')} value="deploy" onChange={() => undefined} mono />}
              {kind === 'db' ? (
                <label className="col" style={{ gap: 5, flex: 1 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldPasswordKey')}</span>
                  <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
                    <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
                    <input value={dbSecret} onChange={e => setDbSecret(e.target.value)}
                      type="password" placeholder={t('modals.fieldPasswordPlaceholder')} className="mono"
                      style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                  </div>
                </label>
              ) : (
                <label className="col" style={{ gap: 5, flex: 1 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldPasswordKey')}</span>
                  <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
                    <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
                    <input defaultValue="" placeholder={t('modals.fieldPasswordPlaceholder')} className="mono"
                      style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                  </div>
                </label>
              )}
            </div>
            {/* Database name field — DB kind only */}
            {kind === 'db' && (
              <Field label={t('modals.fieldDatabase')} value={dbDatabase} onChange={setDbDatabase} placeholder="e.g. orders" />
            )}
            {/* Error message */}
            {kind === 'db' && dbError && (
              <span style={{ fontSize: 12, color: 'var(--danger-fg)' }}>{dbError}</span>
            )}
            {kind === 'db' && testError && (
              <span style={{ fontSize: 12, color: 'var(--danger-fg)' }}>{testError}</span>
            )}
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
          {kind === 'db' ? (
            <button className="btn btn-secondary" onClick={handleTestConnection} disabled={testing}>
              {testing ? (
                <><Icon name="zap" size={15} /> {t('modals.testing')}</>
              ) : tested && testResult ? (
                <><Icon name="circle-check" size={15} style={{ color: 'var(--signal-green)' }} /> {t('modals.testPassed', { version: shortVersion(testResult.version), latency: testResult.latencyMs })}</>
              ) : testError ? (
                <><Icon name="alert-triangle" size={15} style={{ color: 'var(--danger-fg)' }} /> {t('modals.testFailed')}</>
              ) : (
                <><Icon name="zap" size={15} /> {t('modals.testConnection')}</>
              )}
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={() => setTested(true)}>
              {tested ? <><Icon name="circle-check" size={15} style={{ color: 'var(--signal-green)' }} /> {t('modals.testPassed', { version: '', latency: 28 })}</> : <><Icon name="zap" size={15} /> {t('modals.testConnection')}</>}
            </button>
          )}
          <div className="row gap8">
            <Btn variant="ghost" onClick={onClose}>{t('modals.cancel')}</Btn>
            {kind === 'db'
              ? <Btn variant="primary" icon="check" onClick={handleDbSaveAndConnect} disabled={dbConnecting}>
                  {dbConnecting ? t('modals.connecting') ?? 'Connecting…' : isEdit ? t('modals.save') : t('modals.saveAndConnect')}
                </Btn>
              : <Btn variant="primary" icon="check">{t('modals.saveAndConnect')}</Btn>}
          </div>
        </div>
      </div>
    </div>
  )
}
