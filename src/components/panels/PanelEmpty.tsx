import { Icon } from '../Icon'

export interface PanelEmptyProps { icon: string; text: string }

export function PanelEmpty({ icon, text }: PanelEmptyProps) {
  return (
    <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-faint)', padding: 24 }}>
      <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--surface-sunken)' }}><Icon name={icon} size={20} /></div>
      <span style={{ fontSize: 12.5, textAlign: 'center' }}>{text}</span>
    </div>
  )
}
