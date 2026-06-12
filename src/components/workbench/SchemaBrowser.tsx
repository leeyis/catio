/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; live multi-schema tree wired in E-series */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConnGlyph, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection, SchemaNamespace, SchemaTable } from '../../services/types'

export interface SchemaBrowserProps {
  /** Pick a table/view — carries BOTH the schema namespace and the object name (names are ambiguous across schemas). */
  onPick: (schema: string, name: string) => void
  /** Pick a view / function / procedure to show its definition (DDL/source) in the main panel. */
  onPickObject?: (schema: string, name: string, kind: 'view' | 'function' | 'procedure') => void
  /** Currently-selected object as schema+table, or null when not viewing a table. */
  active: { schema: string; table: string } | null
  onNewQuery: (schema?: string) => void
  /** Open the ER diagram. With no arg → current namespace; with a schema name → that schema's ER. */
  onOpenER: (schema?: string) => void
  /** Open a fresh query tab seeded with a CREATE TABLE/VIEW template for the given schema. */
  onNewObjectTemplate?: (schema: string, kind: 'table' | 'view') => void
  /** Re-introspect the schema tree (drives both the header refresh button and the per-schema 刷新). */
  onRefresh?: () => void
  erActive: boolean
  sqlActive: boolean
  disabledSql?: boolean
  disabledEr?: boolean
  /**
   * When connected to a live backend, ALL real schema namespaces to render the
   * tree from (each becomes its own collapsible top-level DB node). Omitted on
   * the mock/demo path → falls back to the seeded mock schema so the demo stays
   * pixel-identical.
   */
  schemas?: SchemaNamespace[]
  /** Real connection (live path) — drives the header name + engine label. Omitted on mock. */
  conn?: Connection
  /** True when connected to a live backend (hides the mock column-expansion affordance). */
  live?: boolean
  /** True while the schema tree is being re-introspected — spins the refresh icon. */
  refreshing?: boolean
  /** True while the INITIAL introspection is in flight — shows a skeleton instead of a blank tree. */
  loading?: boolean
}

export function SchemaBrowser({ onPick, onPickObject, active, onNewQuery, onOpenER, onNewObjectTemplate, onRefresh, schemas, conn, live, refreshing, loading }: SchemaBrowserProps) {
  const { t } = useTranslation()
  const D = useData()
  // Live path: render every supplied namespace; mock path: the single seeded schema (pixel-identical).
  const namespaces: SchemaNamespace[] = schemas ?? D.schema.schemas
  const [q, setQ] = useState('')
  const query = q.toLowerCase()

  // Header: real connection when available, else the demo connection / text.
  const headerName = conn?.name ?? 'prod-orders'
  const headerEngine = conn ? (conn.engine ?? conn.sub) : 'PostgreSQL 16.2'
  const headerGlyph = conn ?? D.byId['d-orders']

  return (
    <div className="col" style={{ width: 248, flex: 'none', borderRight: '1px solid var(--border-hairline)', background: 'var(--surface-card)' }}>
      {/* header */}
      <div className="row" style={{ padding: '10px 10px 8px', justifyContent: 'space-between' }}>
        <div className="row gap6" style={{ minWidth: 0 }}><ConnGlyph conn={headerGlyph} size={24} radius={7} /><div className="col" style={{ lineHeight: 1.2, minWidth: 0 }}><span className="ell" style={{ fontSize: 12.5, fontWeight: 700 }}>{headerName}</span><span className="mono ell" style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>{headerEngine}</span></div></div>
        <div className="row gap2">
          <button className="icon-btn bare" data-testid="wb-new-query" style={{ width: 26, height: 26 }}
            title={t('workbench.newQuery')} onClick={() => onNewQuery()}>
            <Icon name="terminal-square" size={15} style={{ color: 'var(--accent-primary)' }} />
          </button>
          <button className="icon-btn bare" data-testid="wb-refresh" style={{ width: 26, height: 26 }} title={t('workbench.refresh')} onClick={onRefresh} disabled={refreshing}>
            <Icon name="refresh-cw" size={13} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
          </button>
        </div>
      </div>
      {/* search */}
      <div className="row gap6" style={{ margin: '0 10px 8px', height: 30, padding: '0 9px', background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 9 }}>
        <Icon name="search" size={13} style={{ color: 'var(--text-faint)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('workbench.searchTablesViews')} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-primary)' }} />
      </div>
      {/* New query / ER moved into each schema's "⋯" hover menu (see SchemaNode). */}
      {/* tree — one collapsible top-level DB node per schema namespace.
          Live connection: skeleton while introspecting, empty-state when it returns
          nothing, otherwise the real tree. Mock path always has namespaces. */}
      <div className="grow" style={{ overflowY: 'auto', padding: '0 6px 10px' }}>
        {loading && namespaces.length === 0 ? (
          <div className="col" style={{ gap: 9, padding: '8px 6px' }} aria-busy="true" data-testid="schema-skeleton">
            {[0, 1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="row gap8" style={{ alignItems: 'center', paddingLeft: i % 3 === 0 ? 0 : 22 }}>
                <div className="skel" style={{ width: 13, height: 13, borderRadius: 4, flex: 'none' }} />
                <div className="skel" style={{ height: 10, width: i % 3 === 0 ? 110 : 140, maxWidth: '70%' }} />
              </div>
            ))}
          </div>
        ) : live && namespaces.length === 0 ? (
          <div className="col" style={{ alignItems: 'center', justifyContent: 'center', gap: 6, padding: '34px 12px', color: 'var(--text-faint)', textAlign: 'center' }}>
            <Icon name="database" size={22} />
            <span style={{ fontSize: 11.5 }}>{t('workbench.noSchemas')}</span>
          </div>
        ) : namespaces.map(ns => (
          <SchemaNode key={ns.name} ns={ns} query={query} active={active} onPick={onPick} onPickObject={onPickObject} live={!!live}
            onNewQuery={onNewQuery} onOpenER={onOpenER} onNewObjectTemplate={onNewObjectTemplate} onRefresh={onRefresh} />
        ))}
      </div>
      {/* footer */}
      <div className="row gap8" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)' }}>
        <StatusDot status="up" size={6} />
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('workbench.connectedFooter')}</span>
      </div>
    </div>
  )
}

interface SchemaNodeProps {
  ns: SchemaNamespace
  query: string
  active: { schema: string; table: string } | null
  onPick: (schema: string, name: string) => void
  onPickObject?: (schema: string, name: string, kind: 'view' | 'function' | 'procedure') => void
  live: boolean
  onNewQuery: (schema?: string) => void
  onOpenER: (schema?: string) => void
  onNewObjectTemplate?: (schema: string, kind: 'table' | 'view') => void
  onRefresh?: () => void
}

/** One schema namespace rendered as a collapsible DB tree node (Tables / Views / Functions). */
function SchemaNode({ ns, query, active, onPick, onPickObject, live, onNewQuery, onOpenER, onNewObjectTemplate, onRefresh }: SchemaNodeProps) {
  const { t } = useTranslation()
  const D = useData()
  // Default-open the first schema's section so a freshly-connected DB shows tables immediately.
  const [open, setOpen] = useState({ schema: true, tables: true, views: false, fns: false })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Hover reveals the "..." action button; the schema-management dropdown opens from it.
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const tables: SchemaTable[] = ns.tables.filter(tbl => tbl.name.toLowerCase().includes(query))
  const keyTone: Record<string, string> = { PK: 'var(--signal-amber)', FK: 'var(--signal-blue)', UNI: 'var(--signal-violet)' }

  // Close the menu on any outside mousedown.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const menuItems: { icon: string; label: string; action: () => void }[] = [
    { icon: 'terminal', label: t('workbench.newQuery'), action: () => onNewQuery(ns.name) },
    { icon: 'network', label: t('workbench.erDiagram'), action: () => onOpenER(ns.name) },
    ...(onNewObjectTemplate ? [
      { icon: 'table-2', label: t('workbench.newTable'), action: () => onNewObjectTemplate(ns.name, 'table') },
      { icon: 'eye', label: t('workbench.newView'), action: () => onNewObjectTemplate(ns.name, 'view') },
    ] : []),
    ...(onRefresh ? [{ icon: 'refresh-cw', label: t('workbench.refresh'), action: () => onRefresh() }] : []),
  ]

  return (
    <>
      <div className="row" style={{ position: 'relative', alignItems: 'center' }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TreeNode icon="database" iconColor="var(--signal-blue)" label={ns.name} count={ns.tables.length + ' tables'} open={open.schema} onToggle={() => setOpen(o => ({ ...o, schema: !o.schema }))} depth={0} />
        </div>
        <button className="icon-btn bare" title={t('workbench.schemaMenu')} aria-label={t('workbench.schemaMenu')}
          onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
          style={{ width: 22, height: 22, flex: 'none', marginRight: 4, opacity: hover || menuOpen ? 1 : 0, transition: 'opacity .12s' }}>
          <Icon name="more-horizontal" size={14} />
        </button>
        {menuOpen && (
          <div ref={menuRef} onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', top: '100%', right: 4, zIndex: 200, marginTop: 2,
              background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10,
              boxShadow: 'var(--shadow-dropdown)', padding: '4px 0', minWidth: 150 }}>
            {menuItems.map(item => (
              <button key={item.label} onClick={() => { item.action(); setMenuOpen(false) }}
                className="row gap8"
                style={{ width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none', background: 'transparent',
                  fontSize: 12.5, color: 'var(--text-primary)', cursor: 'pointer', alignItems: 'center' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-soft)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
                <Icon name={item.icon} size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
                <span className="ell">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {open.schema && <>
        <TreeNode icon="folder" label={t('workbench.tables')} count={tables.length} open={open.tables} onToggle={() => setOpen(o => ({ ...o, tables: !o.tables }))} depth={1} />
        {open.tables && tables.map(tbl => {
          const st = D.tableStructures[tbl.name]
          const isOpen = expanded[tbl.name]
          const isActive = active != null && active.schema === ns.name && active.table === tbl.name
          // In live mode we never show mock column expansion (the Structure tab covers columns).
          const showExpand = !live && !!st
          return (
            <div key={tbl.name}>
              <div className="row treeleaf" style={{ alignItems: 'center', gap: 2, paddingLeft: 22, borderRadius: 8, background: isActive ? 'var(--accent-soft)' : 'transparent' }}>
                {showExpand
                  ? <button onClick={() => setExpanded(e => ({ ...e, [tbl.name]: !e[tbl.name] }))} style={{ width: 18, height: 26, display: 'grid', placeItems: 'center', flex: 'none' }} title={t('workbench.expandColumns')}>
                      <Icon name="chevron-right" size={11} style={{ color: 'var(--text-faint)', transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none' }} />
                    </button>
                  : <span style={{ width: 18, height: 26, flex: 'none' }} />}
                <button onClick={() => onPick(ns.name, tbl.name)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px 5px 0', minWidth: 0, color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                  <Icon name="table-2" size={13} style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-tertiary)', flex: 'none' }} />
                  <span className="ell mono" style={{ fontSize: 12, fontWeight: isActive ? 600 : 400 }}>{tbl.name}</span>
                  {tbl.pinned && <Icon name="star" size={10} style={{ color: 'var(--signal-amber)', fill: 'var(--signal-amber)', flex: 'none' }} />}
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--text-faint)', flex: 'none' }}>{tbl.rows}</span>
                </button>
              </div>
              {showExpand && isOpen && st && (
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
        <TreeNode icon="eye" label={t('workbench.views')} count={ns.views.length} open={open.views} onToggle={() => setOpen(o => ({ ...o, views: !o.views }))} depth={1} />
        {open.views && ns.views.map(v => {
          const isActive = active != null && active.schema === ns.name && active.table === v.name
          return (
            <button key={v.name} onClick={() => onPickObject?.(ns.name, v.name, 'view')} className="treeleaf" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px 5px 40px', borderRadius: 8, background: isActive ? 'var(--accent-soft)' : 'transparent', color: isActive ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>
              <Icon name="eye" size={12} style={{ color: 'var(--signal-violet)' }} /><span className="ell mono" style={{ fontSize: 12 }}>{v.name}</span>
            </button>
          )
        })}
        <TreeNode icon="function-square" label={t('workbench.functions')} count={ns.functions.length} open={open.fns} onToggle={() => setOpen(o => ({ ...o, fns: !o.fns }))} depth={1} />
        {open.fns && ns.functions.map(f => (
          <button key={f.name} onClick={() => onPickObject?.(ns.name, f.name, 'function')} className="treeleaf" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px 5px 40px', borderRadius: 8, background: 'transparent', color: 'var(--text-tertiary)' }}>
            <Icon name="function-square" size={12} style={{ color: 'var(--signal-green)' }} /><span className="ell mono" style={{ fontSize: 12 }}>{f.name}()</span>
          </button>
        ))}
      </>}
    </>
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
