/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConnGlyph, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import type { SchemaNamespace, SchemaTable } from '../../services/types'

export interface SchemaBrowserProps {
  onPick: (name: string) => void
  active: string | null
  onNewQuery: () => void
  onOpenER: () => void
  erActive: boolean
  sqlActive: boolean
  disabledSql?: boolean
  disabledEr?: boolean
  /**
   * When connected to a live backend, the real schema namespace to render the
   * tree from. Omitted on the mock/demo path → falls back to the seeded mock
   * schema so the demo stays pixel-identical.
   */
  namespace?: SchemaNamespace
}

export function SchemaBrowser({ onPick, active, onNewQuery, onOpenER, erActive, sqlActive, disabledSql, disabledEr, namespace }: SchemaBrowserProps) {
  const { t } = useTranslation()
  const D = useData()
  // Live path: render from the supplied namespace; mock path: seeded schema (pixel-identical).
  const s = namespace ?? D.schema.schemas[0]
  const [open, setOpen] = useState({ public: true, tables: true, views: false, fns: false })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ orders: false })
  const [q, setQ] = useState('')
  const tables: SchemaTable[] = s.tables.filter(tbl => tbl.name.includes(q.toLowerCase()))
  const keyTone: Record<string, string> = { PK: 'var(--signal-amber)', FK: 'var(--signal-blue)', UNI: 'var(--signal-violet)' }
  return (
    <div className="col" style={{ width: 248, flex: 'none', borderRight: '1px solid var(--border-hairline)', background: 'var(--surface-card)' }}>
      {/* header */}
      <div className="row" style={{ padding: '10px 10px 8px', justifyContent: 'space-between' }}>
        <div className="row gap6" style={{ minWidth: 0 }}><ConnGlyph conn={D.byId['d-orders']} size={24} radius={7} /><div className="col" style={{ lineHeight: 1.2, minWidth: 0 }}><span className="ell" style={{ fontSize: 12.5, fontWeight: 700 }}>prod-orders</span><span className="mono" style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>PostgreSQL 16.2</span></div></div>
        <div className="row gap2">
          <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('workbench.newQuery')} onClick={onNewQuery}><Icon name="plus" size={14} /></button>
          <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('workbench.refresh')}><Icon name="refresh-cw" size={13} /></button>
        </div>
      </div>
      {/* search */}
      <div className="row gap6" style={{ margin: '0 10px 8px', height: 30, padding: '0 9px', background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 9 }}>
        <Icon name="search" size={13} style={{ color: 'var(--text-faint)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('workbench.searchTablesViews')} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-primary)' }} />
      </div>
      {/* database-level actions */}
      <div className="row gap6" style={{ padding: '0 10px 8px' }}>
        <button onClick={onNewQuery} disabled={disabledSql} data-testid="btn-sql-console" className="row gap6" style={{ flex: 1, justifyContent: 'center', height: 30, borderRadius: 9, fontSize: 12, fontWeight: 600,
          color: sqlActive ? 'var(--accent-primary)' : 'var(--text-secondary)', background: sqlActive ? 'var(--accent-soft)' : 'var(--surface-sunken)', border: sqlActive ? '1px solid var(--accent-border)' : '1px solid transparent' }}>
          <Icon name="terminal" size={13} /> {t('workbench.newQuery')}
        </button>
        <button onClick={onOpenER} disabled={disabledEr} data-testid="btn-er-diagram" className="row gap6" style={{ flex: 1, justifyContent: 'center', height: 30, borderRadius: 9, fontSize: 12, fontWeight: 600,
          color: erActive ? 'var(--accent-primary)' : 'var(--text-secondary)', background: erActive ? 'var(--accent-soft)' : 'var(--surface-sunken)', border: erActive ? '1px solid var(--accent-border)' : '1px solid transparent' }}>
          <Icon name="network" size={13} /> {t('workbench.erDiagram')}
        </button>
      </div>
      {/* tree */}
      <div className="grow" style={{ overflowY: 'auto', padding: '0 6px 10px' }}>
        <TreeNode icon="database" iconColor="var(--signal-blue)" label={s.name} count={s.tables.length + ' tables'} open={open.public} onToggle={() => setOpen(o => ({ ...o, public: !o.public }))} depth={0} />
        {open.public && <>
          <TreeNode icon="folder" label={t('workbench.tables')} count={tables.length} open={open.tables} onToggle={() => setOpen(o => ({ ...o, tables: !o.tables }))} depth={1} />
          {open.tables && tables.map(tbl => {
            const st = D.tableStructures[tbl.name]
            const isOpen = expanded[tbl.name]
            const isActive = active === tbl.name
            return (
              <div key={tbl.name}>
                <div className="row treeleaf" style={{ alignItems: 'center', gap: 2, paddingLeft: 22, borderRadius: 8, background: isActive ? 'var(--accent-soft)' : 'transparent' }}>
                  <button onClick={() => setExpanded(e => ({ ...e, [tbl.name]: !e[tbl.name] }))} style={{ width: 18, height: 26, display: 'grid', placeItems: 'center', flex: 'none' }} title={t('workbench.expandColumns')}>
                    <Icon name="chevron-right" size={11} style={{ color: 'var(--text-faint)', transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none' }} />
                  </button>
                  <button onClick={() => onPick(tbl.name)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px 5px 0', minWidth: 0, color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                    <Icon name="table-2" size={13} style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-tertiary)', flex: 'none' }} />
                    <span className="ell mono" style={{ fontSize: 12, fontWeight: isActive ? 600 : 400 }}>{tbl.name}</span>
                    {tbl.pinned && <Icon name="star" size={10} style={{ color: 'var(--signal-amber)', fill: 'var(--signal-amber)', flex: 'none' }} />}
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--text-faint)', flex: 'none' }}>{tbl.rows}</span>
                  </button>
                </div>
                {isOpen && st && (
                  <div className="col" style={{ paddingLeft: 40, paddingBottom: 4 }}>
                    {st.columns.map(c => (
                      <div key={c.name} className="row gap6" style={{ padding: '3px 6px', minWidth: 0 }}>
                        <Icon name={c.key === 'PK' ? 'key' : c.key === 'FK' ? 'link' : 'hash'} size={10} style={{ color: c.key ? keyTone[c.key] : 'var(--text-disabled)', flex: 'none' }} />
                        <span className="ell mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.name}</span>
                        <span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--text-disabled)', flex: 'none' }}>{c.type.replace(/\(.*\)/, '')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <TreeNode icon="eye" label={t('workbench.views')} count={s.views.length} open={open.views} onToggle={() => setOpen(o => ({ ...o, views: !o.views }))} depth={1} />
          {open.views && s.views.map(v => (
            <button key={v.name} onClick={() => onPick(v.name)} className="treeleaf" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px 5px 40px', borderRadius: 8, color: 'var(--text-tertiary)' }}>
              <Icon name="eye" size={12} style={{ color: 'var(--signal-violet)' }} /><span className="ell mono" style={{ fontSize: 12 }}>{v.name}</span>
            </button>
          ))}
          <TreeNode icon="function-square" label={t('workbench.functions')} count={s.functions.length} open={open.fns} onToggle={() => setOpen(o => ({ ...o, fns: !o.fns }))} depth={1} />
          {open.fns && s.functions.map(f => (
            <div key={f.name} className="row gap7" style={{ padding: '5px 8px 5px 40px', color: 'var(--text-tertiary)' }}>
              <Icon name="function-square" size={12} style={{ color: 'var(--signal-green)' }} /><span className="ell mono" style={{ fontSize: 12 }}>{f.name}()</span>
            </div>
          ))}
        </>}
      </div>
      {/* footer */}
      <div className="row gap8" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)' }}>
        <StatusDot status="up" size={6} />
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('workbench.connectedFooter')}</span>
      </div>
    </div>
  )
}

interface TreeNodeProps {
  icon: string
  iconColor?: string
  label: string
  count: number | string
  open: boolean
  onToggle: () => void
  depth: number
}

function TreeNode({ icon, iconColor, label, count, open, onToggle, depth }: TreeNodeProps) {
  return (
    <button onClick={onToggle} className="treeleaf" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', paddingLeft: 6 + depth * 16, borderRadius: 8, color: 'var(--text-secondary)' }}>
      <Icon name="chevron-right" size={11} style={{ transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none', color: 'var(--text-faint)', flex: 'none' }} />
      <Icon name={icon} size={13} style={{ color: iconColor || 'var(--text-tertiary)', flex: 'none' }} />
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--text-faint)' }}>{count}</span>
    </button>
  )
}
