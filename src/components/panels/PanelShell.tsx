/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import React from 'react'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'

export interface PanelShellProps {
  icon: string
  title: React.ReactNode
  sub?: React.ReactNode
  onClose: () => void
  children?: React.ReactNode
  actions?: React.ReactNode
}

export function PanelShell({ icon, title, sub, onClose, children, actions }: PanelShellProps) {
  return (
    <div className="card-surface col" style={{ width: 'var(--panel-w, 340px)', flex: 'none', overflow: 'hidden' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '12px 12px 12px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="row gap8" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name={icon} size={15} /></div>
          <div className="col" style={{ lineHeight: 1.2, minWidth: 0 }}>
            <span className="ell" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.2px' }}>{title}</span>
            {sub && <span className="ell" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{sub}</span>}
          </div>
        </div>
        <div className="row gap4">{actions}<IconBtn name="x" size={15} variant="bare" onClick={onClose} /></div>
      </div>
      {children}
    </div>
  )
}
