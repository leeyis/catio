/* ported from ref-ui/_extract/blob16.txt — verbatim per plan T1-T7 */
import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, StatusDot, ConnGlyph, Segmented } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'

// ---- Prop types ----

export interface TitleBarProps {
  theme: string
  onToggleTheme?: React.MouseEventHandler<HTMLButtonElement>
  onOpenSettings?: React.MouseEventHandler<HTMLButtonElement>
  settingsActive?: boolean
  onSearch?: React.MouseEventHandler<HTMLButtonElement>
  view?: string
  onView?: (view: string) => void
}

export interface SidebarProps {
  activeId?: string
  onOpen: (conn: Connection) => void
  onDetail: (conn: Connection) => void
  onNew?: React.MouseEventHandler<HTMLButtonElement>
  collapsed?: boolean
  onToggleCollapse?: React.MouseEventHandler<HTMLButtonElement>
  conns?: Connection[]
  currentUser?: string
  authEnabled?: boolean
  onLock?: React.MouseEventHandler<HTMLButtonElement>
}

export interface ConnRowProps {
  conn: Connection
  active?: boolean
  onOpen: (conn: Connection) => void
  onDetail: (conn: Connection) => void
  nested?: boolean
}

export interface IconRailProps {
  active?: string
  onSelect?: (id: string) => void
  panelOpen?: boolean
}

// ---- buildSidebarTree return type ----

export type SidebarTreeNode =
  | { nested: true; host: Connection; dbs: Connection[] }
  | { nested?: false; conn: Connection }

// ---- Pure helper (no globals) ----

export function buildSidebarTree(items: Connection[], filter: string): SidebarTreeNode[] {
  if (filter !== 'all') return items.map(c => ({ conn: c }))
  const ids = new Set(items.map(c => c.id))
  const childrenOf: Record<string, Connection[]> = {}
  items.forEach(c => {
    if (c.kind === 'db' && c.tunnel && ids.has(c.tunnel)) {
      ;(childrenOf[c.tunnel] = childrenOf[c.tunnel] || []).push(c)
    }
  })
  const nestedDbIds = new Set(Object.values(childrenOf).flat().map(d => d.id))
  const out: SidebarTreeNode[] = []
  items.forEach(c => {
    if (nestedDbIds.has(c.id)) return // rendered under its host
    if (c.kind === 'host' && childrenOf[c.id]) out.push({ nested: true, host: c, dbs: childrenOf[c.id] })
    else out.push({ conn: c })
  })
  return out
}

// ---- TitleBar ----

export function TitleBar({ theme, onToggleTheme, onOpenSettings, settingsActive }: TitleBarProps) {
  const { t } = useTranslation()
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand">
        <div className="logo-mark">
          <span className="mono" style={{ fontSize: 13, fontWeight: 700, transform: 'translateY(-0.5px)' }}>&gt;_</span>
        </div>
        <div className="col" style={{ lineHeight: 1.05 }}>
          <span className="brand-name">Catio</span>
        </div>
      </div>
      <div className="tb-spacer" />
      <div className="row gap4">
        <button className="tb-iconbtn" title={t('shell.toggleTheme')} onClick={onToggleTheme}>
          <Icon name={theme === 'dawn' ? 'moon' : 'sun'} size={17} />
        </button>
        <button className="tb-iconbtn" title={t('shell.notifications')}>
          <Icon name="bell" size={17} />
        </button>
        <button className={`tb-iconbtn ${settingsActive ? 'active' : ''}`} title={t('shell.settings')} onClick={onOpenSettings}>
          <Icon name="settings" size={17} />
        </button>
        <div className="tb-divider" />
        <div className="win-controls">
          <button className="win-btn" title={t('shell.minimize')} onClick={() => {}}>{/* TODO(Task16): wire Tauri window API */}<Icon name="minus" size={15} /></button>
          <button className="win-btn" title={t('shell.maximize')} onClick={() => {}}>{/* TODO(Task16): wire Tauri window API */}<svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.2" y="1.2" width="8.6" height="8.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg></button>
          <button className="win-btn close" title={t('shell.close')} onClick={() => {}}>{/* TODO(Task16): wire Tauri window API */}<Icon name="x" size={16} /></button>
        </div>
      </div>
    </div>
  )
}

// ---- Sidebar ----

export function Sidebar({ activeId, onOpen, onDetail, onNew, collapsed, onToggleCollapse, conns: vaultConns, currentUser, authEnabled, onLock }: SidebarProps) {
  const { t } = useTranslation()
  const D = useData()
  const allConns = vaultConns || D.connections
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ prod: true, staging: true, local: true })
  const [filter, setFilter] = useState('all') // all | host | db

  const conns = useMemo(() => {
    return allConns.filter(c => {
      if (filter !== 'all' && c.kind !== filter) return false
      if (!query) return true
      const q = query.toLowerCase()
      return c.name.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q) || (c.tags || []).some(tag => tag.includes(q))
    })
  }, [query, filter, allConns])

  if (collapsed) {
    return (
      <div className="card-surface col" style={{ width: 56, flex: 'none', padding: '12px 8px', alignItems: 'center', gap: 8 }}>
        <button className="icon-btn bare" title={t('shell.expandSidebar')} onClick={onToggleCollapse}><Icon name="panel-left" size={17} /></button>
        <div style={{ height: 1, width: 24, background: 'var(--border-hairline)', margin: '4px 0' }} />
        {allConns.slice(0, 8).map(c => (
          <button key={c.id} className="icon-btn bare" onClick={() => onOpen(c)} title={c.name}
            style={{ width: 38, height: 38, borderRadius: 10, background: activeId === c.id ? 'var(--accent-soft)' : 'transparent' }}>
            <ConnGlyph conn={c} size={30} radius={8} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="card-surface col" style={{ width: 256, flex: 'none', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ padding: '14px 12px 10px' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="row gap8">
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.4px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Vault</span>
            <span className="badge-accent">{allConns.length}</span>
          </div>
          <div className="row gap4">
            <IconBtn name="plus" size={15} variant="bare" title={t('common.newConnection')} onClick={onNew} />
            <IconBtn name="panel-left" size={15} variant="bare" title={t('shell.collapseSidebar')} onClick={onToggleCollapse} />
          </div>
        </div>
        {/* search */}
        <div className="row gap8" style={{ height: 32, padding: '0 10px', background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 10, marginBottom: 8 }}>
          <Icon name="search" size={14} style={{ color: 'var(--text-faint)' }} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('shell.filterPlaceholder')}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)' }} />
          {query && <button className="icon-btn bare" style={{ width: 20, height: 20 }} onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}
        </div>
        {/* kind filter */}
        <div className="row gap6">
          <Segmented size="sm" value={filter} onChange={setFilter} options={[
            { value: 'all', label: t('shell.all') },
            { value: 'host', label: t('shell.hosts'), icon: 'server' },
            { value: 'db', label: t('shell.databases'), icon: 'database' },
          ]} />
        </div>
      </div>

      {/* list */}
      <div className="grow" style={{ overflowY: 'auto', padding: '2px 8px 10px' }}>
        {D.groups.map(g => {
          const items = conns.filter(c => c.group === g.id)
          if (!items.length) return null
          const open = openGroups[g.id]
          return (
            <div key={g.id} style={{ marginBottom: 6 }}>
              <button onClick={() => setOpenGroups(s => ({ ...s, [g.id]: !s[g.id] }))}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 8px', color: 'var(--text-tertiary)' }}>
                <Icon name="chevron-right" size={13} style={{ transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }} />
                <span className="dot" style={{ background: g.color }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{g.name}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>{items.length}</span>
              </button>
              {open && (
                <div className="col" style={{ gap: 1 }}>
                  {buildSidebarTree(items, filter).map(node => (
                    node.nested ? (
                      <div key={node.host.id} className="col" style={{ gap: 1 }}>
                        <ConnRow conn={node.host} active={activeId === node.host.id} onOpen={onOpen} onDetail={onDetail} />
                        <div className="col" style={{ gap: 1, marginLeft: 19, paddingLeft: 11, borderLeft: '1.5px solid var(--border-hairline)' }}>
                          {node.dbs.map((c) => (
                            <div key={c.id} style={{ position: 'relative' }}>
                              <span style={{ position: 'absolute', left: -11, top: 18, width: 8, height: 1.5, background: 'var(--border-hairline)' }} />
                              <ConnRow conn={c} active={activeId === c.id} onOpen={onOpen} onDetail={onDetail} nested />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <ConnRow key={node.conn.id} conn={node.conn} active={activeId === node.conn.id} onOpen={onOpen} onDetail={onDetail} />
                    )
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!conns.length && (
          <div className="col" style={{ alignItems: 'center', gap: 10, padding: '28px 16px', textAlign: 'center' }}>
            <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name="lock" size={20} /></div>
            <div className="col" style={{ gap: 3 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{query ? t('shell.noMatchingConns') : t('shell.privateWorkspace')}</span>
              {!query && <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('shell.vaultEmptyHint', { user: currentUser })}<br />{t('shell.newConnToStart')}</span>}
            </div>
            {!query && <button className="btn btn-cta sm" onClick={onNew}><Icon name="plus" size={14} /> {t('common.newConnection')}</button>}
          </div>
        )}
      </div>

      {/* footer status */}
      <div className="row" style={{ padding: '10px 12px', borderTop: '1px solid var(--border-hairline)', gap: 8 }}>
        <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
          <Icon name="user" size={14} />
        </div>
        <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0 }}>
          <span className="ell" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{currentUser || 'skyler'}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{authEnabled ? t('shell.localLoginIsolated') : t('shell.activeStatus')}</span>
        </div>
        {authEnabled
          ? <button className="icon-btn bare" title={t('shell.lockWorkspace')} onClick={onLock}><Icon name="lock" size={15} /></button>
          : <StatusDot status="up" size={7} />}
      </div>
    </div>
  )
}

// ---- ConnRow ----

export function ConnRow({ conn, active, onOpen, onDetail, nested }: ConnRowProps) {
  const { t } = useTranslation()
  const D = useData()
  const [hover, setHover] = useState(false)
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(conn)} onDoubleClick={() => onOpen(conn)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: nested ? '6px 9px' : '7px 9px', borderRadius: 10, cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : hover ? 'var(--surface-sunken)' : 'transparent',
        boxShadow: active ? 'inset 2px 0 0 var(--accent-primary)' : 'none',
        transition: 'background .12s',
      }}>
      <ConnGlyph conn={conn} size={nested ? 26 : 30} radius={nested ? 7 : 8} />
      <div className="col grow" style={{ lineHeight: 1.25, minWidth: 0 }}>
        <div className="row gap6" style={{ minWidth: 0 }}>
          <span className="ell" style={{ fontSize: nested ? 12.5 : 13, fontWeight: active ? 600 : 500, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{conn.name}</span>
        </div>
        <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{nested ? (D.engineMeta[conn.engine ?? ''] || {}).label : conn.sub}</span>
      </div>
      {hover ? (
        <button className="icon-btn bare" style={{ width: 22, height: 22 }} onClick={(e) => { e.stopPropagation(); onDetail(conn) }} title={t('shell.details')}>
          <Icon name="info" size={14} />
        </button>
      ) : (
        <StatusDot status={conn.status} size={6} />
      )}
    </div>
  )
}

// ---- IconRail ----

interface RailItem {
  id: string
  icon: string
  label: string
}

export function IconRail({ active, onSelect, panelOpen }: IconRailProps) {
  const { t } = useTranslation()

  const top: RailItem[] = [
    { id: 'ai', icon: 'sparkles', label: t('shell.railAi') },
    { id: 'sftp', icon: 'folder', label: t('shell.railSftp') },
    { id: 'monitor', icon: 'gauge', label: t('shell.railMonitor') },
    { id: 'tunnels', icon: 'link', label: t('shell.railTunnels') },
    { id: 'snippets', icon: 'snippet', label: t('shell.railSnippets') },
    { id: 'history', icon: 'history', label: t('shell.railHistory') },
  ]
  const bottom: RailItem[] = [
    { id: 'details', icon: 'info', label: t('shell.details') },
  ]

  const Item = ({ it }: { it: RailItem }) => {
    const on = active === it.id && panelOpen
    return (
      <button onClick={() => onSelect && onSelect(it.id)} title={it.label}
        style={{
          width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
          color: on ? 'var(--accent-primary)' : 'var(--text-tertiary)',
          background: on ? 'var(--accent-soft)' : 'transparent',
          border: on ? '1px solid var(--accent-border)' : '1px solid transparent',
          transition: 'all .14s',
        }}
        onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-sunken)' }}
        onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}>
        <Icon name={it.icon} size={17} />
      </button>
    )
  }

  return (
    <div className="card-surface col" style={{ width: 48, flex: 'none', alignItems: 'center', padding: '14px 8px', justifyContent: 'space-between' }}>
      <div className="col" style={{ gap: 10, alignItems: 'center' }}>
        {top.map(it => <Item key={it.id} it={it} />)}
        <div style={{ width: 22, height: 1, background: 'var(--border-hairline)', margin: '2px 0' }} />
        {bottom.map(it => <Item key={it.id} it={it} />)}
      </div>
      <div className="col" style={{ gap: 10, alignItems: 'center' }}>
        <button title={t('shell.railMcp')} style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-sunken)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Icon name="command" size={17} />
        </button>
      </div>
    </div>
  )
}
