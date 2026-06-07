/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useTranslation } from 'react-i18next'
import { IconBtn, ConnGlyph, Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface DetailsPanelProps {
  onClose: () => void
  conn?: Connection
}

interface RowProps {
  k: string
  v: string
  mono?: boolean
}

export function DetailsPanel({ conn, onClose }: DetailsPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const c = conn || D.byId['d-orders']

  function Row({ k, v, mono }: RowProps) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-hairline)' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{k}</span>
        <span className={mono ? 'mono' : ''} style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{v}</span>
      </div>
    )
  }

  return (
    <PanelShell icon="info" title={t('panels.detailsTitle')} sub={c.name} onClose={onClose} actions={<IconBtn name="pencil" size={15} variant="bare" />}>
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
          {c.tunnel && <Row k={t('panels.detailViaTunnel')} v={D.byId[c.tunnel].name} mono />}
          {c.stats && <Row k={t('panels.detailCpuMem')} v={`${c.stats.cpu}% · ${c.stats.mem}%`} mono />}
          {c.stats && <Row k={t('panels.detailUptime')} v={c.stats.up} mono />}
          <Row k={t('panels.detailLastUsed')} v={t('panels.lastUsedAgo', { time: c.lastUsed })} />
          <Row k={t('panels.detailCredentials')} v="🔒 keychain · XChaCha20" />
        </div>
        <div className="row gap8" style={{ marginTop: 16 }}>
          <Btn variant="cta" icon="play" style={{ flex: 1 }}>{t('panels.connect')}</Btn>
          <Btn variant="secondary" icon="copy">{t('panels.copy')}</Btn>
        </div>
      </div>
    </PanelShell>
  )
}
