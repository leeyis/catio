/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface SftpPanelProps {
  onClose: () => void
  conn?: Connection
}

export function SftpPanel({ onClose, conn }: SftpPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  return (
    <PanelShell icon="folder" title={`SFTP · ${conn ? conn.name : 'prod-web-01'}`} sub={D.sftp.path} onClose={onClose}
      actions={<><IconBtn name="upload" size={15} variant="bare" title={t('panels.upload')} /><IconBtn name="refresh-cw" size={15} variant="bare" title={t('panels.refresh')} /></>}>
      <div className="row gap6" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <Icon name="folder-open" size={13} style={{ color: 'var(--signal-amber)' }} />
        <span className="mono ell">{D.sftp.path}</span>
      </div>
      <div className="grow" style={{ overflowY: 'auto', padding: 6 }}>
        {D.sftp.items.map((it, i) => (
          <div key={i} className="row gap8" style={{ padding: '7px 8px', borderRadius: 8, cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-sunken)'} onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}>
            <Icon name={it.type === 'up' ? 'corner-down-right' : it.type === 'dir' ? 'folder' : it.name.endsWith('.log') ? 'file' : it.name.endsWith('.js') || it.name.endsWith('.json') ? 'file-code' : 'file'}
              size={15} style={{ color: it.type === 'dir' ? 'var(--signal-amber)' : it.type === 'up' ? 'var(--text-faint)' : 'var(--text-tertiary)', flex: 'none' }} />
            <span className="ell mono" style={{ fontSize: 12.5, color: it.type === 'up' ? 'var(--text-faint)' : 'var(--text-secondary)', flex: 1 }}>{it.name}</span>
            {it.size && it.type !== 'up' && <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{it.size}</span>}
            {it.mod && it.type !== 'up' && <span style={{ fontSize: 10.5, color: 'var(--text-disabled)', width: 48, textAlign: 'right' }}>{it.mod}</span>}
          </div>
        ))}
      </div>
      <div className="row gap8" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)', fontSize: 11, color: 'var(--text-faint)' }}>
        <Icon name="info" size={12} /> {t('panels.sftpDropHint')}
      </div>
    </PanelShell>
  )
}
