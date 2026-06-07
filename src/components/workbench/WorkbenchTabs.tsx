/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { useData } from '../../state/DataContext'
import type { Tab } from '../../services/types'

export interface WorkbenchTabsProps {
  tabs: Tab[]
  activeTab: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function WorkbenchTabs({ tabs, activeTab, onActivate, onClose, onNew }: WorkbenchTabsProps) {
  const { t } = useTranslation()
  const D = useData()
  return (
    <div className="row" style={{ height: 40, flex: 'none', gap: 4, padding: '0 8px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-card)', overflowX: 'auto' }}>
      {tabs.map(tab => {
        const conn = D.byId[tab.connId];
        const active = tab.id === activeTab;
        return (
          <div key={tab.id} onClick={() => onActivate(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px', borderRadius: 9, cursor: 'pointer', flex: 'none',
              background: active ? 'var(--accent-soft)' : 'transparent',
              border: active ? '1px solid var(--accent-border)' : '1px solid transparent',
            }}>
            <Icon name={tab.kind === 'terminal' ? (conn && conn.proto === 'local' ? 'terminal' : 'globe') : 'table-2'} size={14}
              style={{ color: active ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
            <span className="ell" style={{ maxWidth: 150, fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{tab.title}</span>
            {tab.kind === 'terminal' && <span className="dot" style={{ background: 'var(--signal-green)' }} />}
            <button className="icon-btn bare" style={{ width: 18, height: 18 }} onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}><Icon name="x" size={12} /></button>
          </div>
        );
      })}
      <button className="icon-btn bare" style={{ width: 28, height: 28, marginLeft: 2 }} onClick={onNew} title={t('workbench.newTab')}><Icon name="plus" size={16} /></button>
      <div className="grow" />
    </div>
  );
}
