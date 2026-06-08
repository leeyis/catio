/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBtn, ConnGlyph, Btn } from '../atoms'
import { Icon } from '../Icon'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface DetailsPanelProps {
  onClose: () => void
  conn?: Connection
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

export function DetailsPanel({ conn, onClose, onConnect, onEdit, onCopy, onDelete, onCloseSession, connected }: DetailsPanelProps) {
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
          <Row k={t('panels.detailType')} v={c.kind === 'db' ? (D.engineMeta[c.engine ?? ''] || {}).label ?? '' : t('panels.hostProto', { proto: (c.proto || 'ssh').toUpperCase() })} />
          <Row k={t('panels.detailStatus')} v={c.status === 'up' ? t('panels.statusOnline') : c.status === 'idle' ? t('panels.statusIdle') : t('panels.statusOffline')} />
          {c.tunnel && D.byId[c.tunnel] && <Row k={t('panels.detailViaTunnel')} v={D.byId[c.tunnel].name} mono />}
          {c.stats && <Row k={t('panels.detailCpuMem')} v={`${c.stats.cpu}% · ${c.stats.mem}%`} mono />}
          {c.stats && <Row k={t('panels.detailUptime')} v={c.stats.up} mono />}
          {c.lastUsed && <Row k={t('panels.detailLastUsed')} v={t('panels.lastUsedAgo', { time: c.lastUsed })} />}
          <Row k={t('panels.detailCredentials')} v={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="lock" size={12} style={{ color: 'var(--text-faint)' }} />keychain · XChaCha20</span>} />
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
