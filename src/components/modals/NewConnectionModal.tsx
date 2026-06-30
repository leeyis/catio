/* ported from ref-ui/_extract/blob11.txt — verbatim per plan T1-T7 */
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented, Toggle, ConnGlyph } from '../atoms'
import { useData } from '../../state/DataContext'
import type { AuthMethod, SshConnectArgs, SshTestResult } from '../../services/ssh'
import { sshTest, serialListPorts } from '../../services/ssh'
import { isServer } from '../../services/transport'
import { dbConnect, testConnection, dbErrMsg } from '../../services/db'
import { enginesByGroup, findEngine, matchEngineId } from '../../services/dbEngines'
import { jdbcDriverStatus, downloadJdbcDriver, openJdbcDriversDir, importJdbcDriver, JDBC_DOWNLOADABLE, type JdbcDriverStatus } from '../../services/jdbcDrivers'
import { dbLogo } from '../../services/logos'
import { saveProfile } from '../../state/connections'
import type { ConnectionProfile, JumpProfile } from '../../state/connections'
import { saveDbConnection, setActiveDbConnection, generateProfileId } from '../../state/dbConnections'
import type { DbProfile } from '../../state/dbConnections'
import { useGroups } from '../../state/groups'
import { ConnectingOverlay } from './ConnectingOverlay'
import { ImportConnectionsModal } from './ImportConnectionsModal'

// ---- Prop types ----

export interface NewConnectionModalProps {
  onClose: () => void
  /** Default connection kind, derived from the sidebar's active filter tab. */
  initialKind?: 'host' | 'db'
  /** ORCH: emit a live connect request for a HOST/SSH connection. */
  onConnect?: (args: SshConnectArgs, display: { name: string; profileId?: string }) => void
  /** Open a non-SSH terminal (local/serial/telnet/mosh) instead of starting an SSH session. */
  onOpenTerminal?: (desc: { proto: 'local' | 'serial' | 'telnet' | 'mosh'; name: string; host?: string; port?: number; user?: string; serialPort?: string; baud?: number }) => void
  /** Save a VNC connection (reusable sidebar record) and open the embedded VNC session. */
  onSaveVnc?: (desc: { name: string; host: string; port: number; password: string; group: string }) => void
  /** Save an RDP connection (reusable sidebar record) and launch the system RDP client. */
  onSaveRdp?: (desc: { name: string; host: string; port: number; user: string; group: string }) => void
  /** Called on a successful live DB connect (Tauri) with the saved profile, so the
   *  caller can immediately open the workbench for it. Not called in non-Tauri dev. */
  onConnected?: (profile: DbProfile, secret?: string) => void
  /** When set, the modal opens in EDIT mode pre-filled with this profile. A
   *  ConnectionProfile edits an SSH/host connection; a DbProfile edits a DB
   *  connection. Saving upserts under the SAME id (update, not a new entry). */
  editProfile?: ConnectionProfile | DbProfile
  /** Called after a successful save in host/SSH edit mode (App uses it to reloadProfiles). */
  onSaved?: () => void
}

// `editProfile` is a union — DbProfile carries `dbType`, ConnectionProfile carries `auth`.
function isDbProfile(p: ConnectionProfile | DbProfile | undefined): p is DbProfile {
  return !!p && 'dbType' in p
}

interface FieldProps {
  label: string
  value: string
  placeholder?: string
  w?: number
  mono?: boolean
  type?: string
  /** Controlled change handler (DB kind). When provided the input is controlled
   *  via `value`; otherwise the input is uncontrolled (SSH kind, via `inputRef`). */
  onChange?: (v: string) => void
  /** When set, restrict input to digits only (e.g. port numbers). */
  numeric?: boolean
  /** Uncontrolled-mode ref (SSH kind) — lets handlers read the value on submit. */
  inputRef?: React.Ref<HTMLInputElement>
  onInput?: React.FormEventHandler<HTMLInputElement>
}

// Hoisted to module scope so it keeps a stable component identity across
// re-renders — otherwise React remounts the <input> on every render and inputs
// lose focus/value mid-typing (e.g. when the test result or canTest state changes).
//
// Dual-mode: pass `onChange` for a controlled field (DB kind), or `inputRef`
// (+ optional `onInput`) for an uncontrolled field (SSH/host kind).
function Field({ label, value, onChange, placeholder, w, mono, type, numeric, inputRef, onInput }: FieldProps) {
  const controlled = typeof onChange === 'function'
  return (
    <label className="col" style={{ gap: 5, flex: w || 1 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
      <input
        {...(controlled
          ? { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange!(numeric ? e.target.value.replace(/\D/g, '') : e.target.value) }
          : { ref: inputRef, defaultValue: value, onInput })}
        placeholder={placeholder}
        {...(numeric ? { inputMode: 'numeric' as const } : {})}
        type={type ?? 'text'}
        className={mono ? 'mono' : ''}
        style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
    </label>
  )
}

// Engine glyph: real brand logo when bundled, else the colour-coded short code.
// Fixed width so the dropdown rows stay aligned regardless of which form shows.
function EngineGlyph({ id, short, color }: { id: string; short: string; color: string }) {
  const logo = dbLogo(id)
  return (
    <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flex: 'none' }}>
      {logo
        ? <img src={logo} alt={short} style={{ width: 18, height: 18, objectFit: 'contain' }} />
        : <span className="mono" style={{ fontSize: 10, fontWeight: 700, color }}>{short}</span>}
    </span>
  )
}

// ---- Constants ----

// The engine catalog (all selectable engines + protocol-family variants) lives
// in services/dbEngines.ts. Each catalog entry maps its id → { dbType,
// driverProfile, defaultPort } so the modal can thread the right protocol family
// AND profile through to the backend.

// Trim a verbose server version banner to a compact label for the test-passed
// pill. e.g. "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by ..." → "PostgreSQL 16.2".
function shortVersion(v: string): string {
  if (!v) return ''
  const firstLine = v.split('\n')[0].trim()
  const m = firstLine.match(/^([A-Za-z][A-Za-z ]*?\s*v?[\d][\d.]*)/)
  return (m ? m[1] : firstLine).trim()
}

// ---- Component ----

export function NewConnectionModal({ onClose, initialKind = 'db', onConnect, onOpenTerminal, onSaveVnc, onSaveRdp, onConnected, editProfile, onSaved }: NewConnectionModalProps) {
  const D = useData()
  const { t } = useTranslation()
  const isEdit = !!editProfile
  const editDb = isDbProfile(editProfile)
  // SSH/host profile, when editing a host connection (narrowed for prefill below).
  const editHost: ConnectionProfile | undefined = isEdit && !editDb ? (editProfile as ConnectionProfile) : undefined
  // DB profile, when editing a DB connection.
  const editDbProfile: DbProfile | undefined = editDb ? (editProfile as DbProfile) : undefined
  // Uncontrolled SSH/host field refs (preserve focus across re-renders).
  const nameRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLInputElement>(null)
  const portRef = useRef<HTMLInputElement>(null)
  const serialPortRef = useRef<HTMLInputElement>(null)
  const userRef = useRef<HTMLInputElement>(null)
  const ALL_PROTOS = [
    { id: 'ssh', label: 'SSH' }, { id: 'mosh', label: 'Mosh' },
    { id: 'telnet', label: 'Telnet' }, { id: 'serial', label: 'Serial' },
    { id: 'vnc', label: 'VNC' }, { id: 'rdp', label: 'RDP' },
    { id: 'local', label: t('modals.protoLocal') },
  ]
  // Browser deploy: RDP is disabled (no desktop to launch), and Serial / Local terminals are
  // host-machine hardware/shells that don't translate to a remote server — hide them.
  const PROTOS = isServer() ? ALL_PROTOS.filter(p => !['rdp', 'local', 'serial'].includes(p.id)) : ALL_PROTOS
  // Edit mode opens on the tab matching the profile kind; otherwise the sidebar tab.
  const [kind, setKind] = useState<string>(isEdit ? (editDb ? 'db' : 'host') : initialKind)
  // `engine` is a catalog id (e.g. "cockroachdb"), NOT a bare DbType — it resolves
  // to { dbType, driverProfile } via findEngine(). Edit mode pre-selects from the
  // saved engineId, else best-effort matches the saved dbType+driverProfile, else
  // falls back to the bare dbType (legacy profiles), else postgres.
  const initialEngine =
    editDbProfile?.engineId
    ?? matchEngineId(editDbProfile?.dbType, editDbProfile?.driverProfile)
    ?? 'postgres'
  const [engine, setEngine] = useState<string>(initialEngine)
  // JDBC engines need a driver JAR; surface install-status + one-click download.
  const currentEngine = findEngine(engine)
  const isJdbc = currentEngine?.dbType === 'jdbc'
  const jdbcProfile = currentEngine?.driverProfile
  const [driverStatus, setDriverStatus] = useState<JdbcDriverStatus | null>(null)
  const [driverBusy, setDriverBusy] = useState(false)
  const [driverErr, setDriverErr] = useState<string | null>(null)
  const [engineOpen, setEngineOpen] = useState(false)
  const engineRef = useRef<HTMLDivElement>(null)
  const [proto, setProto] = useState('ssh')
  // Serial config (proto === 'serial'): baud + discovered port list.
  const [baud, setBaud] = useState('115200')
  const [serialPorts, setSerialPorts] = useState<string[]>([])
  useEffect(() => {
    if (proto === 'serial') serialListPorts().then(setSerialPorts).catch(() => { /* none */ })
  }, [proto])
  // Default the port to each protocol's standard when creating a new host connection
  // (the port field is uncontrolled, so set it imperatively on protocol change).
  useEffect(() => {
    if (kind !== 'host' || isEdit) return
    const defs: Record<string, string> = { ssh: '22', mosh: '22', telnet: '23', vnc: '5900', rdp: '3389' }
    const d = defs[proto]
    if (d && portRef.current) portRef.current.value = d
  }, [proto, kind, isEdit])
  const [authMethod, setAuthMethod] = useState<AuthMethod['method']>(editHost?.auth.method ?? 'password')
  const [keyPath, setKeyPath] = useState(editHost?.auth.method === 'keyFile' ? editHost.auth.path : '')
  // In-memory secret only: password (password auth) or key passphrase (key-file auth).
  // Never prefilled (secrets are not persisted) and never written to a profile.
  const [secret, setSecret] = useState('')
  // ProxyJump / SSH-tunnel toggle — defaults OFF.
  const [tunnel, setTunnel] = useState(isEdit ? !!editHost?.jump : false)
  const [via, setVia] = useState('h-bastion')
  // Jump host config fields
  const jumpHostRef = useRef<HTMLInputElement>(null)
  const jumpPortRef = useRef<HTMLInputElement>(null)
  const jumpUserRef = useRef<HTMLInputElement>(null)
  const [jumpAuthMethod, setJumpAuthMethod] = useState<AuthMethod['method']>(
    editHost?.jump?.auth.method ?? 'password'
  )
  const [jumpKeyPath, setJumpKeyPath] = useState(
    editHost?.jump?.auth.method === 'keyFile' ? editHost.jump.auth.path : ''
  )
  // In-memory jump secret — never stored, cleared after use.
  const [jumpSecret, setJumpSecret] = useState('')
  // Real SSH connection-test state (host kind).
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<SshTestResult | null>(null)
  // Reactive enablement for the SSH Test button — host & user must be non-empty.
  // host/user are uncontrolled refs; recompute on their input events.
  const [canTest, setCanTest] = useState(editHost ? !!editHost.host && !!editHost.user : false)
  const recomputeCanTest = () =>
    setCanTest(!!(hostRef.current?.value || '').trim() && !!(userRef.current?.value || '').trim())
  // Vault group selection — persisted to the profile (SSH + DB). '' = 未分组.
  const groups = useGroups()
  const [group, setGroup] = useState<string>(
    (isEdit ? (editDb ? editDbProfile?.group : editHost?.group) : '') ?? ''
  )
  const hosts = D.connections.filter(c => c.kind === 'host' && c.proto !== 'local')

  // DB-specific controlled state — empty by default (or pre-filled from editProfile).
  const [dbName, setDbName] = useState(editDbProfile?.name ?? '')
  const [dbHost, setDbHost] = useState(editDbProfile?.host ?? '')
  const [dbPort, setDbPort] = useState(editDbProfile ? String(editDbProfile.port) : '5432')
  const [dbUser, setDbUser] = useState(editDbProfile?.user ?? '')
  const [dbDatabase, setDbDatabase] = useState(editDbProfile?.database ?? '')
  // Advanced connection params (URL query string), e.g. MongoDB
  // "authSource=admin&directConnection=true".
  const [dbOptions, setDbOptions] = useState(editDbProfile?.options ?? '')
  // SSL/TLS options (DB kind). ssl 开关 + 可选自定义 CA 路径 + 是否校验证书。
  const [dbSsl, setDbSsl] = useState(editDbProfile?.ssl ?? false)
  const [dbCaCertPath, setDbCaCertPath] = useState(editDbProfile?.caCertPath ?? '')
  // sslRejectUnauthorized 缺省视为校验(true);UI 用反向的"不校验"复选框表达。
  const [dbSslNoVerify, setDbSslNoVerify] = useState(editDbProfile?.sslRejectUnauthorized === false)
  const [dbSecret, setDbSecret] = useState('')
  const [dbConnecting, setDbConnecting] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  // Real DB connection-test state (db kind) — version + latency.
  const [dbTested, setDbTested] = useState(false)
  const [dbTestResult, setDbTestResult] = useState<{ version: string; latencyMs: number } | null>(null)
  const [dbTesting, setDbTesting] = useState(false)
  const [dbTestError, setDbTestError] = useState<string | null>(null)
  // 「从 DBeaver / Navicat 导入连接」子对话框开关（仅新建模式、DB kind 提供入口）。
  const [showImport, setShowImport] = useState(false)

  // Reset port to the new engine's default whenever the engine changes, so the
  // port field always reflects the selected engine (never a stale value from a
  // previous engine). File-based engines (defaultPort 0) clear the field —
  // their port is irrelevant.
  const handleEngineChange = (id: string) => {
    setEngine(id)
    setEngineOpen(false)
    const eng = findEngine(id)
    if (eng) setDbPort(eng.defaultPort > 0 ? String(eng.defaultPort) : '')
    // Connection params changed — any prior test result is stale.
    setDbTested(false)
    setDbTestResult(null)
    setDbTestError(null)
  }

  // Fetch JDBC driver install-status whenever a JDBC engine is selected.
  useEffect(() => {
    if (!isJdbc || !jdbcProfile) { setDriverStatus(null); setDriverErr(null); return }
    let cancelled = false
    setDriverErr(null)
    jdbcDriverStatus(jdbcProfile).then(s => { if (!cancelled) setDriverStatus(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [isJdbc, jdbcProfile])

  const handleDownloadDriver = async () => {
    if (!jdbcProfile) return
    setDriverBusy(true); setDriverErr(null)
    try {
      setDriverStatus(await downloadJdbcDriver(jdbcProfile))
    } catch (e) {
      setDriverErr(dbErrMsg(e))
    } finally {
      setDriverBusy(false)
    }
  }

  const handleImportDriver = async () => {
    if (!jdbcProfile) return
    setDriverBusy(true); setDriverErr(null)
    try {
      setDriverStatus(await importJdbcDriver(jdbcProfile))
    } catch (e) {
      setDriverErr(dbErrMsg(e))
    } finally {
      setDriverBusy(false)
    }
  }

  const handleOpenDriversDir = async () => {
    try { await openJdbcDriversDir() } catch (e) { setDriverErr(dbErrMsg(e)) }
  }

  // Any change to DB connection params invalidates a prior test result.
  useEffect(() => {
    setDbTested(false)
    setDbTestResult(null)
    setDbTestError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbHost, dbPort, dbUser, dbDatabase, dbOptions, dbSecret])

  // Build the auth descriptor (non-secret) from the current form.
  function currentAuth(): AuthMethod {
    return authMethod === 'keyFile'
      ? { method: 'keyFile', path: keyPath.trim() }
      : { method: 'password' }
  }

  // Build the jump auth descriptor (non-secret).
  function currentJumpAuth(): AuthMethod {
    return jumpAuthMethod === 'keyFile'
      ? { method: 'keyFile', path: jumpKeyPath.trim() }
      : { method: 'password' }
  }

  // Build the non-secret jump profile for persistence.
  function currentJumpProfile(): JumpProfile | undefined {
    if (!tunnel) return undefined
    const jHost = (jumpHostRef.current?.value || '').trim()
    const jUser = (jumpUserRef.current?.value || '').trim()
    const jPort = Number(jumpPortRef.current?.value) || 22
    if (!jHost) return undefined
    return { host: jHost, port: jPort, user: jUser, auth: currentJumpAuth() }
  }

  // Build live connect/test args from the form, INCLUDING the in-memory secret.
  function currentArgs(): SshConnectArgs {
    const host = (hostRef.current?.value || '').trim()
    const user = (userRef.current?.value || '').trim()
    const port = Number(portRef.current?.value) || 22
    // password auth → password; key-file auth → optional passphrase. Empty → undefined.
    const sec = secret.length > 0 ? secret : undefined
    // Jump config — include secret only when present.
    let jump: SshConnectArgs['jump'] | undefined
    if (tunnel) {
      const jHost = (jumpHostRef.current?.value || '').trim()
      const jUser = (jumpUserRef.current?.value || '').trim()
      const jPort = Number(jumpPortRef.current?.value) || 22
      if (jHost) {
        const jSec = jumpSecret.length > 0 ? jumpSecret : undefined
        jump = { host: jHost, port: jPort, user: jUser, auth: currentJumpAuth(), secret: jSec }
      }
    }
    return { host, port, user, auth: currentAuth(), secret: sec, jump }
  }

  // Real SSH connection test (host kind).
  async function runTest() {
    const args = currentArgs()
    if (!args.host || !args.user || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await sshTest(args)
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: dbErrMsg(err) })
    } finally {
      setTesting(false)
    }
  }

  // SSH/host save + connect (and host edit-mode save).
  function handleSave() {
    // EDIT mode (host): update the existing profile in place (same id), no auto-connect.
    if (isEdit && editHost) {
      const host = (hostRef.current?.value || '').trim()
      const user = (userRef.current?.value || '').trim()
      const port = Number(portRef.current?.value) || 22
      const name = (nameRef.current?.value || '').trim() || host
      const auth = currentAuth()
      // Persist jump WITHOUT secret. Preserve the detected OS across edits.
      const jump = currentJumpProfile()
      try {
        saveProfile({ id: editHost.id, name, host, port, user, auth, jump, ...(group ? { group } : {}), ...(editHost.os ? { os: editHost.os } : {}) })
      } catch { /* localStorage unavailable — ignore */ }
      onSaved?.()
      onClose()
      return
    }
    // RDP:保存为可复用连接记录,并委托系统 RDP 客户端(mstsc/xfreerdp)启动。
    if (kind === 'host' && proto === 'rdp' && onSaveRdp) {
      const host = (hostRef.current?.value || '').trim()
      if (!host) { hostRef.current?.focus(); return }
      const name = (nameRef.current?.value || '').trim() || host
      const user = (userRef.current?.value || '').trim()
      const port = Number(portRef.current?.value) || 3389
      onSaveRdp({ name, host, port, user, group })
      onClose()
      return
    }
    // VNC:保存为可复用连接记录,并打开内嵌远程桌面(口令存会话内存 + vault,不落明文)。
    if (kind === 'host' && proto === 'vnc' && onSaveVnc) {
      const host = (hostRef.current?.value || '').trim()
      if (!host) { hostRef.current?.focus(); return }
      const name = (nameRef.current?.value || '').trim() || host
      const port = Number(portRef.current?.value) || 5900
      onSaveVnc({ name, host, port, password: secret, group })
      onClose()
      return
    }
    // 本地/串口/Telnet/Mosh:不建内置 SSH 会话,直接开终端标签。必填为空时保持弹窗并聚焦,不静默关闭。
    if (kind === 'host' && (proto === 'local' || proto === 'serial' || proto === 'telnet' || proto === 'mosh') && onOpenTerminal) {
      const name = (nameRef.current?.value || '').trim()
      if (proto === 'telnet') {
        const host = (hostRef.current?.value || '').trim()
        if (!host) { hostRef.current?.focus(); return }
        onOpenTerminal({ proto: 'telnet', name: name || host, host, port: Number(portRef.current?.value) || 23 })
      } else if (proto === 'mosh') {
        const host = (hostRef.current?.value || '').trim()
        const user = (userRef.current?.value || '').trim()
        if (!host) { hostRef.current?.focus(); return }
        onOpenTerminal({ proto: 'mosh', name: name || host, host, user })
      } else if (proto === 'serial') {
        const sp = (serialPortRef.current?.value || '').trim()
        if (!sp) { serialPortRef.current?.focus(); return }
        onOpenTerminal({ proto: 'serial', name: name || sp, serialPort: sp, baud: Number(baud) || 115200 })
      } else {
        onOpenTerminal({ proto: 'local', name: name || 'Local' })
      }
      onClose()
      return
    }
    // SSH/host connections drive the live connect flow (ORCH).
    if (kind === 'host' && proto === 'ssh' && onConnect) {
      const host = (hostRef.current?.value || '').trim()
      const user = (userRef.current?.value || '').trim()
      const port = Number(portRef.current?.value) || 22
      const name = (nameRef.current?.value || '').trim() || host
      const auth = currentAuth()
      // args carries the in-memory secret so App can connect WITHOUT a 2nd prompt.
      // jump.secret also rides in args (in-memory only, never persisted).
      const args = currentArgs()
      // Persist the NON-secret profile only (best-effort). Secret never leaves memory.
      const jump = currentJumpProfile()
      const profileId = `live-${host}:${port}-${user}`
      try {
        saveProfile({ id: profileId, name, host, port, user, auth, jump, ...(group ? { group } : {}) })
      } catch { /* localStorage unavailable — ignore */ }
      onConnect(args, { name, profileId })
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

  // Real, ephemeral connection test (DB kind). Builds the same args as
  // save-and-connect, pings the server, and surfaces version + latency.
  const handleTestConnection = async () => {
    setDbTested(false)
    setDbTestResult(null)
    setDbTestError(null)
    setDbTesting(true)
    try {
      const eng = findEngine(engine)
      const result = await testConnection({
        dbType: eng?.dbType ?? 'postgres',
        ...(eng?.driverProfile ? { driverProfile: eng.driverProfile } : {}),
        host: dbHost,
        port: Number(dbPort),
        user: dbUser,
        ...(dbDatabase ? { database: dbDatabase } : {}),
        ...(dbOptions.trim() ? { options: dbOptions.trim() } : {}),
        ...(dbSsl ? { ssl: true } : {}),
        ...(dbSsl && dbCaCertPath.trim() ? { caCertPath: dbCaCertPath.trim() } : {}),
        ...(dbSsl && dbSslNoVerify ? { sslRejectUnauthorized: false } : {}),
        secret: dbSecret || undefined,
      })
      setDbTestResult(result)
      setDbTested(true)
    } catch (err) {
      setDbTestError(dbErrMsg(err))
    } finally {
      setDbTesting(false)
    }
  }

  const handleDbSaveAndConnect = async () => {
    setDbError(null)
    setDbConnecting(true)
    // EDIT mode reuses the existing profile id so saveDbConnection upserts (updates)
    // the same entry instead of creating a new one.
    const id = editDbProfile ? editDbProfile.id : generateProfileId()
    const eng = findEngine(engine)
    const profile = {
      id,
      ...(group ? { group } : {}),
      name: dbName,
      dbType: eng?.dbType ?? 'postgres',
      // Persist the catalog id + driver profile so reconnect/edit resolve the
      // exact engine variant (e.g. CockroachDB vs plain Postgres).
      engineId: engine,
      ...(eng?.driverProfile ? { driverProfile: eng.driverProfile } : {}),
      host: dbHost,
      port: Number(dbPort),
      user: dbUser,
      ...(dbDatabase ? { database: dbDatabase } : {}),
      ...(dbOptions.trim() ? { options: dbOptions.trim() } : {}),
      ...(dbSsl ? { ssl: true } : {}),
      ...(dbSsl && dbCaCertPath.trim() ? { caCertPath: dbCaCertPath.trim() } : {}),
      ...(dbSsl && dbSslNoVerify ? { sslRejectUnauthorized: false } : {}),
    }
    // Persist profile WITHOUT secret. Triggers the reactive store's notify(), so the
    // sidebar / home connection list updates immediately — the connection never
    // silently vanishes.
    saveDbConnection(profile)
    // Attempt live connection (only works in Tauri runtime; throws outside)
    try {
      const result = await dbConnect({ ...profile, secret: dbSecret || undefined }, profile.name)
      // Store connId + capabilities for D3 (capabilities-gated UI) to consume
      setActiveDbConnection(result, profile)
      const usedSecret = dbSecret
      setDbSecret('') // discard secret from memory
      setDbConnecting(false)
      // Success: hand the saved profile (and the secret, so it can be cached) back
      // so the caller opens its workbench with real data, then close the modal.
      onConnected?.(profile, usedSecret)
      onClose()
      return
    } catch (err) {
      const msg = dbErrMsg(err)
      if (!msg.includes('Tauri runtime')) {
        // Real connection failure: keep the modal OPEN and surface the error.
        // Humanise the common auth failure, mirroring the SSH host flow.
        setDbError(/auth|password/i.test(msg) ? t('modals.connectErrorAuth') : msg)
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
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px' }}>{isEdit ? t('modals.editTitle') : t('modals.newConnection')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{isEdit ? t('modals.editSub') : t('modals.newConnectionSub')}</span>
          </div>
          <div className="row gap8" style={{ alignItems: 'center' }}>
            {/* 从 DBeaver / Navicat 导入连接 — 仅新建模式、数据库选项卡提供 */}
            {!isEdit && kind === 'db' && (
              <button className="btn btn-ghost" onClick={() => setShowImport(true)} title={t('importConn.title')}>
                <Icon name="download" size={14} /> {t('modals.importConnections')}
              </button>
            )}
            <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
          </div>
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
                    const sel = findEngine(engine) || findEngine('postgres')!
                    const m = D.engineMeta[sel.id] || {}
                    return (
                      <>
                        <EngineGlyph id={sel.id} short={sel.short} color={m.color || 'var(--text-secondary)'} />
                        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{sel.label}</span>
                        <Icon name="chevron-down" size={14} style={{ color: 'var(--text-faint)', transform: engineOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .14s' }} />
                      </>
                    )
                  })()}
                </button>
                {/* dropdown menu — grouped by engine family */}
                {engineOpen && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', maxHeight: 320, overflowY: 'auto' }}>
                    {enginesByGroup().map(({ group, engines }) => (
                      <div key={group}>
                        <div style={{ padding: '7px 12px 3px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                          {t(`modals.engineGroup.${group}` as const)}
                        </div>
                        {engines.map(e => {
                          const active = engine === e.id
                          const m = D.engineMeta[e.id] || {}
                          return (
                            <button key={e.id}
                              onClick={() => handleEngineChange(e.id)}
                              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                              <EngineGlyph id={e.id} short={e.short} color={m.color || 'var(--text-secondary)'} />
                              <span style={{ flex: 1, fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{e.label}</span>
                              {active && <Icon name="check" size={13} style={{ color: 'var(--accent-primary)' }} />}
                            </button>
                          )
                        })}
                      </div>
                    ))}
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

          {/* Serial config (proto === 'serial'): device port + baud rate */}
          {kind === 'host' && proto === 'serial' && (
            <div className="row gap10" style={{ marginBottom: 14 }}>
              <label className="col" style={{ gap: 5, flex: 2 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.serialPort')}</span>
                <input key={`sp-${serialPorts.length}`} ref={serialPortRef} list="catio-serial-ports" defaultValue={serialPorts[0] ?? ''} placeholder="COM3 / /dev/ttyUSB0"
                  className="mono" style={{ height: 36, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                <datalist id="catio-serial-ports">{serialPorts.map(p => <option key={p} value={p} />)}</datalist>
              </label>
              <label className="col" style={{ gap: 5, flex: 1 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.serialBaud')}</span>
                <select value={baud} onChange={e => setBaud(e.target.value)} aria-label={t('modals.serialBaud')}
                  style={{ height: 36, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                  {['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            </div>
          )}

          {/* JDBC driver row — install-status + one-click download / manual import */}
          {kind === 'db' && isJdbc && (
            <div className="col" style={{ gap: 8, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)' }}>
              <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                <Icon name={driverStatus?.installed ? 'circle-check' : 'hard-drive'} size={16}
                  style={{ color: driverStatus?.installed ? 'var(--signal-green)' : 'var(--text-tertiary)', flex: 'none' }} />
                <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {driverStatus?.installed
                      ? t('modals.jdbcDriverReady')
                      : driverStatus?.downloadable ?? JDBC_DOWNLOADABLE.has(jdbcProfile ?? '')
                        ? t('modals.jdbcDriverMissing')
                        : t('modals.jdbcDriverManual')}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {driverStatus?.installed
                      ? driverStatus.fileName
                      : driverStatus && !driverStatus.downloadable
                        ? t('modals.jdbcDriverManualHint', { cls: driverStatus.driverClass ?? '' })
                        : (driverStatus?.driverClass ?? currentEngine?.label)}
                  </span>
                  {driverErr && <span style={{ fontSize: 11, color: 'var(--danger-fg)' }}>{driverErr}</span>}
                </div>
                {!driverStatus?.installed && (driverStatus?.downloadable ?? JDBC_DOWNLOADABLE.has(jdbcProfile ?? '')) && (
                  <button className="btn btn-secondary" onClick={handleDownloadDriver} disabled={driverBusy} style={{ flex: 'none' }}>
                    {driverBusy
                      ? <><Icon name="refresh-cw" size={14} className="spin" /> {t('modals.jdbcDriverDownloading')}</>
                      : <><Icon name="arrow-down" size={14} /> {t('modals.jdbcDriverDownload')}</>}
                  </button>
                )}
              </div>
              {/* 驱动目录路径 + 手动导入/打开目录 */}
              {driverStatus?.driversDir && (
                <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: 'none' }}>{t('modals.jdbcDriverDir')}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all' }} title={driverStatus.driversDir}>
                    {driverStatus.driversDir}
                  </span>
                  <button className="btn btn-ghost" onClick={handleOpenDriversDir} style={{ flex: 'none' }}>
                    <Icon name="folder-open" size={13} /> {t('modals.jdbcOpenDir')}
                  </button>
                  <button className="btn btn-ghost" onClick={handleImportDriver} disabled={driverBusy} style={{ flex: 'none' }}>
                    {driverBusy
                      ? <><Icon name="refresh-cw" size={13} className="spin" /> {t('modals.jdbcImporting')}</>
                      : <><Icon name="folder-plus" size={13} /> {t('modals.jdbcImportJar')}</>}
                  </button>
                </div>
              )}
              {/* 目录内已有的 jar */}
              {driverStatus && !driverStatus.installed && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {driverStatus.jars.length > 0 ? driverStatus.jars.join('  ·  ') : t('modals.jdbcDriverJarsEmpty')}
                </span>
              )}
            </div>
          )}

          {/* base fields */}
          <div className="col gap10" style={{ marginBottom: 14 }}>
            <div className="row gap10">
              {kind === 'db'
                ? <Field label={t('modals.fieldName')} value={dbName} onChange={setDbName} placeholder="my-database" w={1.4} />
                : <Field key={`name-${kind}`} label={t('modals.fieldName')} value={editHost ? editHost.name : ''} w={1.4} inputRef={nameRef} />}
              <label className="col" style={{ gap: 5, flex: 1 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldGroup')}</span>
                <select value={group} onChange={e => setGroup(e.target.value)} aria-label={t('modals.fieldGroup')}
                  style={{ height: 36, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                  <option value="">{t('modals.groupNone')}</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            </div>
            <div className="row gap10">
              {kind === 'db'
                ? <Field label={t('modals.fieldHost')} value={dbHost} onChange={setDbHost} placeholder="127.0.0.1" mono w={2} />
                : <Field key={`host-${kind}`} label={t('modals.fieldHost')} value={editHost ? editHost.host : ''} mono w={2} inputRef={hostRef} onInput={recomputeCanTest} />}
              {kind === 'db'
                ? <Field label={t('modals.fieldPort')} value={dbPort} onChange={setDbPort} numeric mono w={0.8} />
                : <Field key={`port-${kind}`} label={t('modals.fieldPort')} value={editHost ? String(editHost.port) : '22'} numeric mono w={0.8} inputRef={portRef} />}
            </div>
            <div className="row gap10">
              {kind === 'db'
                ? <Field label={t('modals.fieldUser')} value={dbUser} onChange={setDbUser} placeholder={t('modals.fieldUserPlaceholder')} mono />
                : <Field key={`user-${kind}`} label={t('modals.fieldUsername')} value={editHost ? editHost.user : ''} mono inputRef={userRef} onInput={recomputeCanTest} />}
              {/* Secret field.
                  DB kind: password/key field, controlled, never persisted.
                  Host kind: coherent with the chosen auth method —
                    password auth → password; key-file auth → optional passphrase.
                    Controlled so it can feed sshTest / connect; never persisted. */}
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
              ) : authMethod === 'password' ? (
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
            {/* Database name field — DB kind only */}
            {kind === 'db' && (
              <Field label={t('modals.fieldDatabase')} value={dbDatabase} onChange={setDbDatabase} placeholder="e.g. orders" />
            )}
            {/* Advanced connection params — DB kind only */}
            {kind === 'db' && (
              <label className="col" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldOptions')}</span>
                <input value={dbOptions} onChange={e => setDbOptions(e.target.value)}
                  placeholder={t('modals.fieldOptionsPlaceholder')} className="mono"
                  style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('modals.fieldOptionsHint')}</span>
              </label>
            )}
            {/* SSL/TLS — DB kind only */}
            {kind === 'db' && (
              <div className="col" style={{ gap: 8 }}>
                <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={dbSsl} onChange={e => setDbSsl(e.target.checked)}
                    aria-label={t('modals.fieldSsl')} style={{ cursor: 'pointer' }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('modals.fieldSsl')}</span>
                </label>
                {dbSsl && (
                  <div className="col" style={{ gap: 8, paddingLeft: 22 }}>
                    <label className="col" style={{ gap: 5 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.fieldCaCert')}</span>
                      <input value={dbCaCertPath} onChange={e => setDbCaCertPath(e.target.value)}
                        placeholder={t('modals.fieldCaCertPlaceholder')} className="mono"
                        style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />
                    </label>
                    <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={dbSslNoVerify} onChange={e => setDbSslNoVerify(e.target.checked)}
                        aria-label={t('modals.fieldSslNoVerify')} style={{ cursor: 'pointer' }} />
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('modals.fieldSslNoVerify')}</span>
                    </label>
                    <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('modals.fieldSslNoVerifyHint')}</span>
                  </div>
                )}
              </div>
            )}
            {/* Error message */}
            {kind === 'db' && dbError && (
              <span style={{ fontSize: 12, color: 'var(--danger-fg)' }}>{dbError}</span>
            )}
            {kind === 'db' && dbTestError && (
              <span style={{ fontSize: 12, color: 'var(--danger-fg)' }}>{dbTestError}</span>
            )}
          </div>

          {/* auth method — SSH only (VNC/RDP/telnet/serial/local don't use it) */}
          {kind === 'host' && proto === 'ssh' && (
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

          {/* tunnel / proxyjump — SSH host & DB-over-SSH only (irrelevant for VNC/RDP/etc.) */}
          {(kind === 'db' || proto === 'ssh') && (
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
            {tunnel && kind === 'host' && (
              <div className="col gap10" style={{ padding: 14, borderTop: '1px solid var(--border-hairline)' }}>
                {/* Jump host connection fields */}
                <div className="row gap10">
                  <Field
                    label={t('modals.proxyJumpHost')}
                    value={editHost?.jump?.host ?? ''}
                    placeholder="bastion.example.com"
                    mono
                    w={2}
                    inputRef={jumpHostRef}
                  />
                  <Field
                    label={t('modals.fieldPort')}
                    value={String(editHost?.jump?.port ?? 22)}
                    mono
                    w={0.8}
                    inputRef={jumpPortRef}
                  />
                </div>
                <div className="row gap10">
                  <Field
                    label={t('modals.proxyJumpUser')}
                    value={editHost?.jump?.user ?? ''}
                    placeholder="ec2-user"
                    mono
                    inputRef={jumpUserRef}
                  />
                  {/* Jump secret — password or passphrase, never persisted */}
                  <label className="col" style={{ gap: 5, flex: 1 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.proxyJumpSecret')}</span>
                    <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
                      <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
                      <input
                        type="password"
                        value={jumpSecret}
                        onChange={e => setJumpSecret(e.target.value)}
                        placeholder={t('modals.proxyJumpSecret')}
                        aria-label={t('modals.proxyJumpSecret')}
                        className="mono"
                        style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }}
                      />
                    </div>
                  </label>
                </div>
                {/* Jump auth method */}
                <div className="col" style={{ gap: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.authMethod')}</span>
                  <Segmented
                    value={jumpAuthMethod}
                    onChange={v => setJumpAuthMethod(v as AuthMethod['method'])}
                    options={[
                      { value: 'password', label: t('modals.authPassword') },
                      { value: 'keyFile', label: t('modals.authKeyFile') },
                    ]}
                  />
                </div>
                {jumpAuthMethod === 'keyFile' && (
                  <label className="col" style={{ gap: 5 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('modals.keyPath')}</span>
                    <input
                      value={jumpKeyPath}
                      onChange={e => setJumpKeyPath(e.target.value)}
                      placeholder={t('modals.keyPathPlaceholder')}
                      className="mono"
                      style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }}
                    />
                  </label>
                )}
                {/* Jump chain preview */}
                <div className="row gap8" style={{ padding: '8px 10px', background: 'var(--surface-sunken)', borderRadius: 10 }}>
                  <Icon name="git-commit" size={13} style={{ color: 'var(--text-faint)' }} />
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    localhost → {(jumpHostRef.current?.value || '').trim() || 'bastion'} → {(hostRef.current?.value || '').trim() || 'target'}
                  </span>
                </div>
              </div>
            )}
            {tunnel && kind === 'db' && (
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
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>localhost → {D.byId[via] ? D.byId[via].name : 'bastion'} → 10.0.4.2:5432</span>
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        {/* footer */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '14px 20px', borderTop: '1px solid var(--border-hairline)' }}>
          {kind === 'db' ? (
            // DB kind: real db_test_connection returning version + latency.
            <button className="btn btn-secondary" onClick={handleTestConnection} disabled={dbTesting}>
              {dbTesting ? (
                <><Icon name="zap" size={15} /> {t('modals.testing')}</>
              ) : dbTested && dbTestResult ? (
                <><Icon name="circle-check" size={15} style={{ color: 'var(--signal-green)' }} /> {t('modals.testPassed', { version: shortVersion(dbTestResult.version), latency: dbTestResult.latencyMs })}</>
              ) : dbTestError ? (
                <><Icon name="alert-triangle" size={15} style={{ color: 'var(--danger-fg)' }} /> {t('modals.testFailed')}</>
              ) : (
                <><Icon name="zap" size={15} /> {t('modals.testConnection')}</>
              )}
            </button>
          ) : proto === 'ssh' ? (
            // Host/SSH kind: real sshTest with latency + ok/error. Only SSH can be tested;
            // VNC/RDP/telnet/serial/local connect directly (no test step).
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
          ) : null}
          <div className="row gap8">
            <Btn variant="ghost" onClick={onClose}>{t('modals.cancel')}</Btn>
            {kind === 'db'
              ? <Btn variant="primary" icon="check" onClick={handleDbSaveAndConnect} disabled={dbConnecting}>
                  {dbConnecting ? t('modals.connecting') ?? 'Connecting…' : isEdit ? t('modals.save') : t('modals.saveAndConnect')}
                </Btn>
              : <Btn variant="primary" icon="check" onClick={handleSave}>{isEdit ? t('modals.save') : (kind === 'host' && proto !== 'ssh' && proto !== 'rdp' && proto !== 'vnc' ? t('modals.connect') : t('modals.saveAndConnect'))}</Btn>}
          </div>
        </div>
      </div>
      {/* Connecting feedback — same overlay as the SSH host flow. */}
      {dbConnecting && <ConnectingOverlay name={dbName || dbHost} />}
      {/* 导入连接子对话框：解析 → 勾选 → 写库后关闭本模态（列表已响应式刷新）。 */}
      {showImport && (
        <ImportConnectionsModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); onClose() }}
        />
      )}
    </div>
  )
}
