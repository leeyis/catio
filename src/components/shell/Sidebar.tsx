/* ported from ref-ui/_extract/blob16.txt — verbatim per plan T1-T7 */
import React, { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { BrandMark } from '../BrandMark'
import { IconBtn, ConnGlyph, Segmented } from '../atoms'
import { useData } from '../../state/DataContext'
import { useGroups, addGroup, removeGroup } from '../../state/groups'
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
  /** Primary card action. Wired by App to open the connection DETAILS panel. */
  onOpen: (conn: Connection) => void
  /** Opens the connection DETAILS panel. Used by DB cards (click) and the
   *  hover detail icon on host/SSH cards. */
  onDetail?: (conn: Connection) => void
  collapsed?: boolean
  onToggleCollapse?: React.MouseEventHandler<HTMLButtonElement>
  conns?: Connection[]
  currentUser?: string
  authEnabled?: boolean
  onLock?: React.MouseEventHandler<HTMLButtonElement>
  /** Active kind filter ('all' | 'host' | 'db'). Controlled by the parent so the
   *  New Connection modal can default its kind to match. Falls back to internal
   *  state when not provided (preserves standalone usage). */
  filter?: string
  onFilterChange?: (filter: string) => void
  onEnableAuth?: () => void
}

export interface ConnRowProps {
  conn: Connection
  active?: boolean
  onOpen: (conn: Connection) => void
  onDetail?: (conn: Connection) => void
  nested?: boolean
}

export interface IconRailProps {
  active?: string
  onSelect?: (id: string) => void
  panelOpen?: boolean
  /** 点击底部 ⌘ 按钮：一键直达 MCP 服务（设置 → MCP 区块）。 */
  onMcp?: () => void
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

// ---- Tauri window helpers (guarded: no-op in plain browser / jsdom) ----

// Window controls. We do NOT gate on a Tauri-detection flag — we just attempt the
// call: under Tauri it succeeds, in a plain browser/jsdom the dynamic import or the
// call throws and is caught + logged (never silently swallowed, so real failures are
// visible in devtools). Errors are logged, not hidden.
async function winAction(action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow()[action]()
  } catch (e) {
    console.error(`[titlebar] window ${action} failed:`, e)
  }
}
const onMin = () => winAction('minimize')
const onMax = () => winAction('toggleMaximize')
const onClose = () => winAction('close')

// ---- TitleBar ----

export function TitleBar({ theme, onToggleTheme, onOpenSettings, settingsActive }: TitleBarProps) {
  const { t } = useTranslation()

  // Detect macOS — default false so plain-browser / jsdom always shows Windows-style buttons.
  // Only set true when positively detected (navigator.platform contains 'Mac').
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    try {
      const p: string = (navigator as Navigator).platform ?? ''
      if (p.startsWith('Mac')) setIsMac(true)
    } catch { /* ignore */ }
  }, [])

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" style={isMac ? { paddingLeft: 70 } : undefined}>
        <BrandMark size={26} style={{ borderRadius: 8 }} />
        <div className="col" style={{ lineHeight: 1.05 }}>
          <span className="brand-name">Catio</span>
        </div>
      </div>
      <div className="tb-spacer" />
      {/* stopPropagation on mousedown so the titlebar's data-tauri-drag-region
          never captures clicks meant for these controls */}
      <div className="row gap4" onMouseDown={e => e.stopPropagation()}>
        <button className="tb-iconbtn" title={t('shell.toggleTheme')} onClick={onToggleTheme}>
          <Icon name={theme === 'dawn' ? 'moon' : 'sun'} size={17} />
        </button>
        <button className={`tb-iconbtn ${settingsActive ? 'active' : ''}`} title={t('shell.settings')} onClick={onOpenSettings}>
          <Icon name="settings" size={17} />
        </button>
        <div className="tb-divider" />
        {!isMac && (
          <div className="win-controls">
            <button className="win-btn" title={t('shell.minimize')} onClick={() => { void onMin() }}><Icon name="minus" size={15} /></button>
            <button className="win-btn" title={t('shell.maximize')} onClick={() => { void onMax() }}><svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.2" y="1.2" width="8.6" height="8.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg></button>
            <button className="win-btn close" title={t('shell.close')} onClick={() => { void onClose() }}><Icon name="x" size={16} /></button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Sidebar ----

export function Sidebar({ activeId, onOpen, onDetail, collapsed, onToggleCollapse, conns: vaultConns, currentUser, authEnabled, onLock, onEnableAuth, filter: filterProp, onFilterChange }: SidebarProps) {
  const { t } = useTranslation()
  const D = useData()
  const groups = useGroups()
  const allConns = vaultConns || D.connections
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // Inline "new group" composer — toggled by the header folder-plus button.
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const commitNewGroup = () => {
    const name = newGroupName.trim()
    if (name) { const g = addGroup(name); setOpenGroups(s => ({ ...s, [g.id]: true })) }
    setNewGroupName('')
    setAddingGroup(false)
  }
  // Controlled when the parent supplies `filter`; otherwise self-managed.
  const [filterState, setFilterState] = useState('all') // all | host | db
  const filter = filterProp ?? filterState
  const setFilter = (v: string) => { setFilterState(v); onFilterChange?.(v) }

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
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.4px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{t('shell.vault')}</span>
            <span className="badge-accent">{allConns.length}</span>
          </div>
          <div className="row gap4">
            <IconBtn name="folder-plus" size={15} variant="bare" title={t('shell.newGroup')} onClick={() => { setAddingGroup(true); setNewGroupName('') }} />
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
        {/* inline "new group" composer */}
        {addingGroup && (
          <div className="row gap6" style={{ padding: '6px 8px', marginBottom: 4 }}>
            <Icon name="folder-plus" size={14} style={{ color: 'var(--text-faint)' }} />
            <input autoFocus value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitNewGroup(); else if (e.key === 'Escape') { setAddingGroup(false); setNewGroupName('') } }}
              onBlur={commitNewGroup} placeholder={t('shell.newGroupPlaceholder')}
              style={{ flex: 1, height: 26, padding: '0 8px', border: '1px solid var(--accent-border)', borderRadius: 8, background: 'var(--surface-sunken)', fontSize: 12.5, color: 'var(--text-primary)', outline: 'none' }} />
          </div>
        )}
        {/* Connections with no group (or whose group was deleted) surface under a
            "未分组" section so the vault always renders. */}
        {(() => {
          const groupIds = new Set(groups.map(g => g.id))
          const ungrouped = conns.filter(c => !groupIds.has(c.group))
          if (!ungrouped.length) return null
          const open = openGroups.__saved !== false
          return (
            <div style={{ marginBottom: 6 }}>
              <button onClick={() => setOpenGroups(s => ({ ...s, __saved: s.__saved === false }))}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 8px', color: 'var(--text-tertiary)' }}>
                <Icon name="chevron-right" size={13} style={{ transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }} />
                <Icon name={open ? 'folder-open' : 'folder'} size={13} style={{ color: 'var(--text-faint)' }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{t('shell.ungrouped')}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>{ungrouped.length}</span>
              </button>
              {open && (
                <div className="col" style={{ gap: 1 }}>
                  {buildSidebarTree(ungrouped, filter).map(node => (
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
        })()}
        {groups.map(g => {
          const items = conns.filter(c => c.group === g.id)
          // Show every user group even when empty, so it's a real drop target the
          // modal's group dropdown can assign into. Default open.
          const open = openGroups[g.id] !== false
          return (
            <div key={g.id} className="group-head-row" style={{ marginBottom: 6 }}>
              <div className="row" style={{ alignItems: 'center', gap: 7, padding: '7px 8px', color: 'var(--text-tertiary)', cursor: 'pointer' }}
                onClick={() => setOpenGroups(s => ({ ...s, [g.id]: s[g.id] === false }))}>
                <Icon name="chevron-right" size={13} style={{ transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }} />
                <Icon name={open ? 'folder-open' : 'folder'} size={13} style={{ color: g.color }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase' }}>{g.name}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>{items.length}</span>
                <button className="icon-btn bare group-del" title={t('shell.deleteGroup')}
                  onClick={e => { e.stopPropagation(); removeGroup(g.id) }}
                  style={{ width: 20, height: 20 }}><Icon name="trash-2" size={12} /></button>
              </div>
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
          <div className="col" style={{ alignItems: 'center', gap: 10, padding: '32px 16px', textAlign: 'center' }}>
            <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name={query ? 'search' : 'plug'} size={20} /></div>
            <div className="col" style={{ gap: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{query ? t('shell.noMatchingConns') : t('shell.vaultEmptyTitle')}</span>
              {!query && <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('shell.vaultEmptyHint')}</span>}
            </div>
          </div>
        )}
      </div>

      {/* footer status */}
      <div className="row" style={{ padding: '10px 12px', borderTop: '1px solid var(--border-hairline)', gap: 8 }}>
        <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
          <Icon name={authEnabled ? 'user' : 'shield'} size={14} />
        </div>
        {authEnabled ? (
          <>
            <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0 }}>
              <span className="ell" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{currentUser}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('shell.localLoginIsolated')}</span>
            </div>
            <button className="icon-btn bare" title={t('shell.lockWorkspace')} onClick={onLock}><Icon name="lock" size={15} /></button>
          </>
        ) : (
          <>
            <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0 }}>
              <span className="ell" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('shell.authDisabled')}</span>
              <button style={{ background: 'none', border: 'none', padding: 0, fontSize: 10.5, color: 'var(--accent-primary)', cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap', alignSelf: 'flex-start' }} onClick={() => onEnableAuth?.()}>{t('shell.enableAuth')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---- ConnRow ----

export function ConnRow({ conn, active, onOpen, onDetail, nested }: ConnRowProps) {
  const D = useData()
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)
  // DB cards open the details panel on click (no workbench, no detail icon).
  // Host/SSH cards keep the original behavior: click → workbench, hover → detail icon.
  // (onOpen is wired by the parent; Connect moves to the DetailsPanel's Connect button.)
  const isDb = conn.kind === 'db'
  const handlePrimary = () => (isDb ? onDetail?.(conn) : onOpen(conn))
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={handlePrimary} onDoubleClick={handlePrimary}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: nested ? '6px 9px' : '7px 9px', borderRadius: 10, cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : hover ? 'var(--surface-sunken)' : 'transparent',
        transition: 'background .12s',
      }}>
      <ConnGlyph conn={conn} size={nested ? 26 : 30} radius={nested ? 7 : 8} />
      <div className="col grow" style={{ lineHeight: 1.25, minWidth: 0 }}>
        <div className="row gap6" style={{ minWidth: 0, alignItems: 'center' }}>
          <span className="ell" style={{ fontSize: nested ? 12.5 : 13, fontWeight: active ? 600 : 500, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{conn.name}</span>
          {conn.needsAuth && (
            <span className="badge-accent" title={t('vault.needsAuthHint')}
              style={{ flexShrink: 0, background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color: 'var(--signal-amber)' }}>
              <Icon name="lock" size={9} /> {t('vault.needsAuth')}
            </span>
          )}
        </div>
        <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{nested ? (D.engineMeta[conn.engine ?? ''] || {}).label : conn.sub}</span>
      </div>
    </div>
  )
}

// ---- IconRail ----

interface RailItem {
  id: string
  icon: string
  label: string
}

export function IconRail({ active, onSelect, panelOpen, onMcp }: IconRailProps) {
  const { t } = useTranslation()

  const top: RailItem[] = [
    { id: 'ai', icon: 'wand', label: t('shell.railAi') },
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
        <button title={t('shell.railMcp')} onClick={onMcp} style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-sunken)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Icon name="command" size={17} />
        </button>
      </div>
    </div>
  )
}
