/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, Toggle } from '../atoms'
import { useData } from '../../state/DataContext'
import { PanelShell } from './PanelShell'

export interface TunnelsPanelProps {
  onClose: () => void
}

export function TunnelsPanel({ onClose }: TunnelsPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const typeLabel: Record<string, string> = { L: 'Local', R: 'Remote', D: 'Dynamic' }
  return (
    <PanelShell icon="link" title={t('panels.tunnelsTitle')} sub={t('panels.tunnelsSub')} onClose={onClose} actions={<IconBtn name="plus" size={15} variant="bare" title={t('panels.newForward')} />}>
      {/* jump chain */}
      <div className="col" style={{ padding: '12px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('panels.proxyJump')}</span>
        <div className="row" style={{ gap: 0, flexWrap: 'wrap' }}>
          {D.jumpChain.map((h, i) => (
            <React.Fragment key={i}>
              <div className="row gap6" style={{ padding: '5px 9px', borderRadius: 8, background: h.kind === 'target' ? 'var(--accent-soft)' : 'var(--surface-sunken)' }}>
                <Icon name={h.kind === 'local' ? 'monitor' : h.kind === 'jump' ? 'shield' : 'database'} size={13} style={{ color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
                <span className="mono" style={{ fontSize: 11.5, color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-secondary)', fontWeight: h.kind === 'target' ? 600 : 400 }}>{h.name}</span>
              </div>
              {i < D.jumpChain.length - 1 && <Icon name="arrow-right" size={13} style={{ color: 'var(--text-disabled)', margin: '0 4px' }} />}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {D.tunnels.map(t2 => (
          <div key={t2.id} className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 11, gap: 8, background: 'var(--surface-card)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row gap8">
                <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }}><span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{t2.type}</span></div>
                <div className="col" style={{ lineHeight: 1.25 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t2.label}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{typeLabel[t2.type]} · via {t2.via}</span>
                </div>
              </div>
              <Toggle on={t2.status === 'up'} size="sm" />
            </div>
            <div className="row mono gap6" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              <span style={{ color: 'var(--signal-green)' }}>{t2.local}</span>
              <Icon name="arrow-right" size={11} />
              <span>{t2.remote}</span>
              <span className="grow" />
              <span style={{ color: 'var(--text-faint)' }}>{t2.bytes}</span>
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}
