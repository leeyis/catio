import React, { useState } from 'react'
import { Icon } from '../Icon'
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

export interface TargetOption {
  id: string
  name: string
  kind?: 'host' | 'db'
}

/** Searchable single-select for target host/database connections. */
export function SearchSelect({ options, value, onChange, placeholder }: {
  options: TargetOption[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const cur = options.find(o => o.id === value)
  const filtered = options.filter(o => !q || o.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="col" style={{ gap: 4, position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width: '100%', height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="search" size={13} style={{ color: 'var(--text-faint)' }} />
        <span style={{ flex: 1, textAlign: 'left', color: cur ? 'var(--text-primary)' : 'var(--text-faint)' }}>{cur?.name ?? placeholder ?? '选择目标…'}</span>
        <Icon name="chevron-down" size={13} style={{ color: 'var(--text-faint)' }} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="pop-in" style={{ position: 'absolute', top: 36, left: 0, right: 0, zIndex: 50, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', padding: 5, maxHeight: 220, overflowY: 'auto' }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="搜索连接…"
              style={{ width: '100%', height: 30, padding: '0 8px', borderRadius: 7, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, outline: 'none' }} />
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {filtered.map(o => (
                <button key={o.id} type="button" onClick={() => { onChange(o.id); setOpen(false); setQ('') }}
                  className="row gap6" style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, background: o.id === value ? 'var(--accent-soft)' : 'transparent' }}>
                  <span style={{ fontSize: 12.5 }}>{o.name}</span>
                  {o.kind && <span className="chip">{o.kind === 'host' ? '主机' : '数据库'}</span>}
                </button>
              ))}
              {filtered.length === 0 && <span style={{ padding: 6, fontSize: 11, color: 'var(--text-faint)' }}>无匹配连接</span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
