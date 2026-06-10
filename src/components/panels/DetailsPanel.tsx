/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 (DB path reworked for real data + actions) */
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBtn, ConnGlyph, Btn } from '../atoms'
import { Icon } from '../Icon'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'
import { PanelShell } from './PanelShell'
import { ConnectSecretPrompt } from '../modals/ConnectSecretPrompt'
import {
  listDbConnections,
  listActiveDbConnections,
  type DbProfile,
} from '../../state/dbConnections'
import { dbErrMsg } from '../../services/db'
import { findEngine } from '../../services/dbEngines'

export interface DetailsPanelProps {
  onClose: () => void
  conn?: Connection

  // ---- DB-specific actions (operate on the real saved DbProfile) ----
  /** Open the edit modal pre-filled with this DB profile. */
  onEditDb?: (profile: DbProfile) => void
  /** Confirmed delete (caller removes profile + active conn, then closes the panel). */
  onDeleteDb?: (profile: DbProfile) => void
  /** Connect to the DB profile with the supplied secret (empty/already-active → open
   *  workbench directly without re-prompting). Caller drives dbConnect + navigation. */
  onConnectDb?: (profile: DbProfile, secret: string) => Promise<void>
  /** Disconnect the active live connection(s) for this DB profile. */
  onDisconnectDb?: (profile: DbProfile) => void
  /** Try connecting with a cached secret; resolves true if it connected (skip prompt). */
  onTryConnectDb?: (profile: DbProfile) => Promise<boolean>

  // ---- Host / SSH actions (operate on the Connection) ----
  /** Run the real connect flow for this connection. */
  onConnect?: (conn: Connection) => void
  /** Open the edit modal prefilled from this connection's profile. */
  onEdit?: (conn: Connection) => void
  /** Duplicate this connection profile. */
  onCopy?: (conn: Connection) => void
  /** Request deletion — opens the styled confirm modal. */
  onDelete?: (conn: Connection) => void
  /** Close/disconnect the live session for this connection. */
  onCloseSession?: (conn: Connection) => void
  /** Whether this connection has an active live session. */
  connected?: boolean
}

interface RowProps {
  k: string
  v: ReactNode
  mono?: boolean
}

function Row({ k, v, mono }: RowProps) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{k}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{v}</span>
    </div>
  )
}

export function DetailsPanel({
  conn,
  onClose,
  onEditDb,
  onDeleteDb,
  onConnectDb,
  onDisconnectDb,
  onTryConnectDb,
  onConnect,
  onEdit,
  onCopy,
  onDelete,
  onCloseSession,
  connected,
}: DetailsPanelProps) {
  const isDb = conn?.kind === 'db'
  if (isDb && conn) {
    return <DbDetails conn={conn} onClose={onClose} onEdit={onEditDb} onDelete={onDeleteDb} onConnect={onConnectDb} onDisconnect={onDisconnectDb} onTryConnect={onTryConnectDb} />
  }
  return (
    <HostDetails
      conn={conn}
      onClose={onClose}
      onConnect={onConnect}
      onEdit={onEdit}
      onCopy={onCopy}
      onDelete={onDelete}
      onCloseSession={onCloseSession}
      connected={connected}
    />
  )
}

// ---- Host / SSH details (real saved profile + working actions) ----

function HostDetails({
  conn,
  onClose,
  onConnect,
  onEdit,
  onCopy,
  onDelete,
  onCloseSession,
  connected,
}: {
  conn?: Connection
  onClose: () => void
  onConnect?: (conn: Connection) => void
  onEdit?: (conn: Connection) => void
  onCopy?: (conn: Connection) => void
  onDelete?: (conn: Connection) => void
  onCloseSession?: (conn: Connection) => void
  connected?: boolean
}) {
  const { t } = useTranslation()
  const D = useData()
  const c = conn

  if (!c) {
    return (
      <PanelShell icon="info" title={t('panels.detailsTitle')} onClose={onClose}>
        <div className="col" style={{ alignItems: 'center', justifyContent: 'center', padding: '40px 16px', gap: 8, color: 'var(--text-faint)' }}>
          <Icon name="info" size={22} />
          <span style={{ fontSize: 12.5 }}>{t('shell.privateWorkspace')}</span>
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell
      icon="info"
      title={t('panels.detailsTitle')}
      sub={c.name}
      onClose={onClose}
      actions={
        <>
          <IconBtn name="pencil" size={15} variant="bare" title={t('panels.edit')} onClick={() => onEdit?.(c)} />
          <IconBtn name="trash-2" size={15} variant="bare" title={t('panels.delete')} onClick={() => onDelete?.(c)} />
        </>
      }
    >
      <div className="grow" style={{ overflowY: 'auto', padding: 14 }}>
        <div className="row gap10" style={{ marginBottom: 14 }}>
          <ConnGlyph conn={c} size={48} radius={14} />
          <div className="col" style={{ lineHeight: 1.3 }}>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px' }}>{c.name}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.sub}</span>
          </div>
        </div>
        <div className="row gap6" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          {(c.tags || []).map(tag => <span key={tag} className="chip mono">{tag}</span>)}
        </div>
        <div className="col">
          <Row k={t('panels.detailType')} v={t('panels.hostProto', { proto: (c.proto || 'ssh').toUpperCase() })} />
          <Row k={t('panels.detailStatus')} v={c.status === 'up' ? t('panels.statusOnline') : c.status === 'idle' ? t('panels.statusIdle') : t('panels.statusOffline')} />
          {c.tunnel && D.byId[c.tunnel] && <Row k={t('panels.detailViaTunnel')} v={D.byId[c.tunnel].name} mono />}
          {c.stats && <Row k={t('panels.detailCpuMem')} v={`${c.stats.cpu}% · ${c.stats.mem}%`} mono />}
          {c.stats && <Row k={t('panels.detailUptime')} v={c.stats.up} mono />}
          {c.lastUsed && <Row k={t('panels.detailLastUsed')} v={t('panels.lastUsedAgo', { time: c.lastUsed })} />}
          <Row k={t('panels.detailCredentials')} v={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="lock" size={12} style={{ color: 'var(--text-faint)' }} />{t('panels.credentialsValue')}</span>} />
        </div>
        <div className="row gap8" style={{ marginTop: 16 }}>
          {connected ? (
            <Btn variant="danger" icon="x" style={{ flex: 1 }} onClick={() => onCloseSession?.(c)}>{t('panels.closeSession')}</Btn>
          ) : (
            <Btn variant="cta" icon="play" style={{ flex: 1 }} onClick={() => onConnect?.(c)}>{t('panels.connect')}</Btn>
          )}
          <Btn variant="secondary" icon="copy" onClick={() => onCopy?.(c)}>{t('panels.copy')}</Btn>
        </div>
      </div>
    </PanelShell>
  )
}

// ---- DB details (real saved profile + working actions) ----

function DbDetails({ conn, onClose, onEdit, onDelete, onConnect, onDisconnect, onTryConnect }: {
  conn: Connection
  onClose: () => void
  onEdit?: (profile: DbProfile) => void
  onDelete?: (profile: DbProfile) => void
  onConnect?: (profile: DbProfile, secret: string) => Promise<void>
  onDisconnect?: (profile: DbProfile) => void
  onTryConnect?: (profile: DbProfile) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const D = useData()
  // Look up the real saved profile by the connection id.
  const profile = listDbConnections().find(p => p.id === conn.id)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [promptConnect, setPromptConnect] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  // No matching saved profile → empty state (no mock fallback for DB).
  if (!profile) {
    return (
      <PanelShell icon="info" title={t('panels.detailsTitle')} onClose={onClose}>
        <div className="col" style={{ alignItems: 'center', gap: 8, padding: '28px 16px', textAlign: 'center', color: 'var(--text-faint)' }}>
          <Icon name="database" size={22} />
          <span style={{ fontSize: 12.5 }}>{t('shell.noMatchingConns')}</span>
        </div>
      </PanelShell>
    )
  }

  const isActive = listActiveDbConnections().some(a => a.profileId === profile.id)
  // Prefer the engine catalog's name for the specific engine variant (e.g.
  // "CockroachDB") rather than the bare protocol family ("PostgreSQL").
  const engineLabel = findEngine(profile.engineId ?? profile.dbType)?.label
    ?? (D.engineMeta[profile.engineId ?? profile.dbType] || {}).label
    ?? profile.dbType

  const descriptor = `${profile.dbType}://${profile.user}@${profile.host}:${profile.port}/${profile.database ?? ''}`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(descriptor)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch (e) {
      console.error('[details] copy failed:', e)
    }
  }

  async function handleConnectClick() {
    setConnectError(null)
    // Already active → open workbench directly, no password prompt.
    if (isActive) {
      void onConnect?.(profile!, '')
      return
    }
    // Auth-gated cached secret → connect without prompting. Show a connecting
    // state so the button isn't dead while the connect is in flight.
    setConnecting(true)
    try {
      if (onTryConnect && (await onTryConnect(profile!))) { setConnecting(false); return }
    } catch { /* fall through to the password prompt */ }
    setConnecting(false)
    setPromptConnect(true)
  }

  async function handleSubmitSecret(secret: string) {
    setConnectError(null)
    setConnecting(true)
    try {
      await onConnect?.(profile!, secret)
      setConnecting(false)
      setPromptConnect(false)
    } catch (err) {
      setConnecting(false)
      const msg = dbErrMsg(err)
      // Humanise the common auth failure (i18n), mirroring the connect modals.
      setConnectError(/auth|password/i.test(msg) ? t('modals.connectErrorAuth') : msg)
      // keep the prompt open so the user can retry
    }
  }

  return (
    <PanelShell icon="info" title={t('panels.detailsTitle')} sub={profile.name} onClose={onClose}
      actions={isActive ? undefined : <IconBtn name="pencil" size={15} variant="bare" title={t('panels.edit')} onClick={() => onEdit?.(profile)} />}>
      <div className="grow" style={{ overflowY: 'auto', padding: 14 }}>
        <div className="row gap10" style={{ marginBottom: 14 }}>
          <ConnGlyph conn={conn} size={48} radius={14} />
          <div className="col" style={{ lineHeight: 1.3 }}>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px' }}>{profile.name}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{profile.dbType} · {profile.host}:{profile.port}</span>
          </div>
        </div>
        <div className="col">
          <Row k={t('panels.detailEngine')} v={engineLabel} />
          <Row k={t('panels.detailStatus')} v={isActive ? t('panels.statusConnected') : t('panels.statusNotConnected')} />
          <Row k={t('panels.detailHost')} v={profile.host} mono />
          <Row k={t('panels.detailPort')} v={profile.port} mono />
          <Row k={t('panels.detailUser')} v={profile.user} mono />
          {profile.database && <Row k={t('panels.detailDatabase')} v={profile.database} mono />}
        </div>

        {copied && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--signal-green)' }}>{t('panels.copied')}</div>
        )}

        <div className="row gap8" style={{ marginTop: 16 }}>
          {isActive ? (
            <Btn variant="danger" icon="x" style={{ flex: 1 }} onClick={() => onDisconnect?.(profile!)}>{t('panels.closeConnection')}</Btn>
          ) : (
            <Btn variant="cta" icon="play" style={{ flex: 1 }} onClick={handleConnectClick} disabled={connecting}>{connecting ? (t('modals.connecting') ?? t('panels.connect')) : t('panels.connect')}</Btn>
          )}
          <Btn variant="secondary" icon="copy" onClick={handleCopy}>{copied ? t('panels.copied') : t('panels.copy')}</Btn>
        </div>
        {/* Profile-management actions are hidden while a live connection is open
            (editing/deleting an in-use connection is disallowed). */}
        {!isActive && (
          <>
            <div className="row gap8" style={{ marginTop: 8 }}>
              <Btn variant="secondary" icon="pencil" style={{ flex: 1 }} onClick={() => onEdit?.(profile)}>{t('panels.edit')}</Btn>
              <Btn variant="danger" icon="trash-2" style={{ flex: 1 }} onClick={() => setConfirmDelete(true)}>{t('panels.delete')}</Btn>
            </div>
            <div className="row gap8" style={{ marginTop: 8 }}>
              <Btn variant="ghost" icon="x" style={{ flex: 1 }} onClick={onClose}>{t('panels.close')}</Btn>
            </div>
          </>
        )}
      </div>

      {confirmDelete && (
        <DeleteConfirm name={profile.name}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDelete?.(profile) }} />
      )}

      {promptConnect && (
        <ConnectSecretPrompt
          title={t('panels.connectPromptTitle', { name: profile.name })}
          label={t('panels.connectPromptLabel')}
          error={connectError}
          onSubmit={(s) => { if (!connecting) void handleSubmitSecret(s) }}
          onCancel={() => { if (!connecting) { setPromptConnect(false); setConnectError(null) } }}
        />
      )}
    </PanelShell>
  )
}

// ---- Delete confirm dialog (mirrors the modal-overlay styling) ----

function DeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'absolute', inset: 0, zIndex: 70,
        background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)',
        backdropFilter: 'blur(3px)',
        display: 'grid', placeItems: 'center',
      }}>
      <div
        onClick={e => e.stopPropagation()}
        className="pop-in"
        style={{
          width: 340,
          background: 'var(--surface-card)',
          borderRadius: 18,
          border: '1px solid var(--border-hairline)',
          boxShadow: 'var(--shadow-window)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('panels.deleteConfirmTitle')}</span>
          <IconBtn name="x" size={16} variant="bare" onClick={onCancel} />
        </div>
        <div className="col" style={{ gap: 14, padding: '16px 20px 20px' }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('panels.deleteConfirmBody', { name })}</span>
          <div className="row gap8" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={onCancel}>{t('panels.deleteCancel')}</Btn>
            <Btn variant="danger" icon="trash-2" onClick={onConfirm}>{t('panels.deleteConfirm')}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
