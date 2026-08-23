import React from 'react'
import { IconBtn } from '../atoms'

/** Centered modal used by the automation panels (tasks / skills / MCP). */
export function AutoModal({
  title,
  onClose,
  children,
  footer,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(10,12,14,0.4)' }} />
      <div className="pop-in card-surface col"
        style={{ position: 'relative', width: 460, maxHeight: '84vh', borderRadius: 12, boxShadow: 'var(--shadow-window)', overflow: 'hidden' }}>
        <div className="row" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-hairline)' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
          <span className="grow" />
          <IconBtn name="x" size={15} variant="bare" onClick={onClose} />
        </div>
        <div className="col" style={{ padding: '16px 18px', overflowY: 'auto', gap: 14 }}>{children}</div>
        <div className="row gap10" style={{ padding: '14px 18px', borderTop: '1px solid var(--border-hairline)' }}>{footer}</div>
      </div>
    </div>
  )
}
