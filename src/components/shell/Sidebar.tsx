/* ported from ref-ui/_extract/blob16.txt — verbatim per plan T1-T7 */
import React, { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { BrandMark } from '../BrandMark'
import { IconBtn, ConnGlyph, Segmented } from '../atoms'
import { useData } from '../../state/DataContext'
import { useGroups, addGroup, removeGroup } from '../../state/groups'
import { toggleConnectionFavorite, useConnectionFavorites } from '../../state/connectionFavorites'
import type { Connection } from '../../services/types'
import { isServer } from '../../services/transport'
import { useServerAuth } from '../auth/ServerAuthGate'

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
  /** Active filter ('favorite' | 'host' | 'db'). Controlled by the parent so the
   *  New Connection modal can default its kind to match. Falls back to internal
   *  state when not provided (preserves standalone usage). */
  filter?: string
  onFilterChange?: (filter: string) => void
  onEnableAuth?: () => void
  /** 批量维护：把选中的连接移动到目标分组（groupId='' 表示移出到未分组）。 */
  onBatchMove?: (conns: Connection[], groupId: string) => void
  /** 批量维护：删除选中的连接（由 App 弹确认框后执行）。 */
  onBatchDelete?: (conns: Connection[]) => void
}

export interface ConnRowProps {
  conn: Connection
  active?: boolean
  onOpen: (conn: Connection) => void
  onDetail?: (conn: Connection) => void
  nested?: boolean
  /** 批量维护模式：显示勾选框，行点击切换选中而非打开详情。 */
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (conn: Connection) => void
  favorite?: boolean
  onFavoriteToggle?: (conn: Connection) => void
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
        {/* OS window controls — DESKTOP only. In the browser deploy there's no window to
            minimize/maximize/close, and logout lives in the sidebar footer, so we render nothing
            here (avoids a duplicate logout icon). */}
        {!isServer() && !isMac && (
          <>
            <div className="tb-divider" />
            <div className="win-controls">
              <button className="win-btn" title={t('shell.minimize')} onClick={() => { void onMin() }}><Icon name="minus" size={15} /></button>
              <button className="win-btn" title={t('shell.maximize')} onClick={() => { void onMax() }}><svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.2" y="1.2" width="8.6" height="8.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg></button>
              <button className="win-btn close" title={t('shell.close')} onClick={() => { void onClose() }}><Icon name="x" size={16} /></button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---- Sidebar ----

export function Sidebar({ activeId, onOpen, onDetail, collapsed, onToggleCollapse, conns: vaultConns, currentUser, authEnabled, onLock, onEnableAuth, filter: filterProp, onFilterChange, onBatchMove, onBatchDelete }: SidebarProps) {
  const { t } = useTranslation()
  const serverAuth = useServerAuth()
  const D = useData()
  const groups = useGroups()
  const allConns = vaultConns || D.connections
  const favoriteIds = useConnectionFavorites()
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  // ---- 批量维护 ----
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [moveTarget, setMoveTarget] = useState('') // 目标分组 id（''=未分组）
  const exitBatch = () => { setBatchMode(false); setSelectedIds(new Set()); setMoveTarget('') }
  const toggleSelect = (conn: Connection) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(conn.id)) next.delete(conn.id); else next.add(conn.id)
      return next
    })
  }
  // 选中的连接（从当前列表过滤，自动剔除已删除的陈旧 id）。
  const selectedConns = allConns.filter(c => selectedIds.has(c.id))
  // 统一注入到每个 ConnRow 的公共 props（含批量勾选）。
  const rowProps = (conn: Connection) => ({
    conn,
    active: activeId === conn.id,
    onOpen, onDetail,
    selectable: batchMode,
    selected: selectedIds.has(conn.id),
    onSelectToggle: toggleSelect,
    favorite: favoriteSet.has(conn.id),
    onFavoriteToggle: (conn: Connection) => { toggleConnectionFavorite(conn.id) },
  })
  const handleBatchMove = () => {
    if (!selectedConns.length) return
    onBatchMove?.(selectedConns, moveTarget)
    setSelectedIds(new Set())
    setMoveTarget('')
  }
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
  const [filterState, setFilterState] = useState('favorite') // favorite | host | db
  const filter = filterProp ?? filterState
  const setFilter = (v: string) => { setFilterState(v); onFilterChange?.(v) }

  const conns = useMemo(() => {
    return allConns.filter(c => {
      if (filter === 'favorite' && !favoriteSet.has(c.id)) return false
      // RDP/VNC are remote-machine connections → show them under the "host" filter too.
      if (filter !== 'favorite' && c.kind !== filter && !(filter === 'host' && (c.kind === 'rdp' || c.kind === 'vnc'))) return false
      if (!query) return true
      const q = query.toLowerCase()
      return c.name.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q) || (c.tags || []).some(tag => tag.includes(q))
    })
  }, [query, filter, allConns, favoriteSet])

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
            <IconBtn name="check-check" size={15} variant="bare" title={t('shell.batchMode')} active={batchMode}
              onClick={() => (batchMode ? exitBatch() : setBatchMode(true))} />
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
            { value: 'favorite', label: t('shell.favorites'), icon: 'star' },
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
                        <ConnRow {...rowProps(node.host)} />
                        <div className="col" style={{ gap: 1, marginLeft: 19, paddingLeft: 11, borderLeft: '1.5px solid var(--border-hairline)' }}>
                          {node.dbs.map((c) => (
                            <div key={c.id} style={{ position: 'relative' }}>
                              <span style={{ position: 'absolute', left: -11, top: 18, width: 8, height: 1.5, background: 'var(--border-hairline)' }} />
                              <ConnRow {...rowProps(c)} nested />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <ConnRow key={node.conn.id} {...rowProps(node.conn)} />
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
                        <ConnRow {...rowProps(node.host)} />
                        <div className="col" style={{ gap: 1, marginLeft: 19, paddingLeft: 11, borderLeft: '1.5px solid var(--border-hairline)' }}>
                          {node.dbs.map((c) => (
                            <div key={c.id} style={{ position: 'relative' }}>
                              <span style={{ position: 'absolute', left: -11, top: 18, width: 8, height: 1.5, background: 'var(--border-hairline)' }} />
                              <ConnRow {...rowProps(c)} nested />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <ConnRow key={node.conn.id} {...rowProps(node.conn)} />
                    )
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!conns.length && (
          <div className="col" style={{ alignItems: 'center', gap: 10, padding: '32px 16px', textAlign: 'center' }}>
            <div className="icon-badge" style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name={query ? 'search' : filter === 'favorite' ? 'star' : 'plug'} size={20} /></div>
            <div className="col" style={{ gap: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{query ? t('shell.noMatchingConns') : filter === 'favorite' ? t('shell.favoriteEmptyTitle') : t('shell.vaultEmptyTitle')}</span>
              {!query && <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{filter === 'favorite' ? t('shell.favoriteEmptyHint') : t('shell.vaultEmptyHint')}</span>}
            </div>
          </div>
        )}
      </div>

      {/* 批量维护操作栏：选中计数 + 移动到分组 + 删除 + 退出 */}
      {batchMode && (
        <div className="col" style={{ gap: 8, padding: '10px 12px', borderTop: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('shell.batchSelected', { n: selectedConns.length })}
            </span>
            <button className="icon-btn bare" title={t('shell.batchExit')} onClick={exitBatch} style={{ width: 22, height: 22 }}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="row gap6" style={{ alignItems: 'center' }}>
            <select value={moveTarget} onChange={e => setMoveTarget(e.target.value)}
              style={{ flex: 1, minWidth: 0, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-card)', fontSize: 12.5, color: 'var(--text-primary)', outline: 'none' }}>
              <option value="">{t('shell.ungrouped')}</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button className="btn btn-secondary sm" disabled={!selectedConns.length} onClick={handleBatchMove}
              style={{ flexShrink: 0, ...(selectedConns.length ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>
              <Icon name="folder" size={14} /> {t('shell.batchMove')}
            </button>
          </div>
          <button className="btn btn-danger sm" disabled={!selectedConns.length}
            onClick={() => { if (selectedConns.length) onBatchDelete?.(selectedConns) }}
            style={{ width: '100%', ...(selectedConns.length ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>
            <Icon name="trash-2" size={14} /> {t('shell.batchDelete')}
          </button>
        </div>
      )}

      {/* footer status */}
      <div className="row" style={{ padding: '10px 12px', borderTop: '1px solid var(--border-hairline)', gap: 8 }}>
        <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
          <Icon name={(serverAuth.enabled || authEnabled) ? 'user' : 'shield'} size={14} />
        </div>
        {serverAuth.enabled && serverAuth.user ? (
          // Browser deploy: show the logged-in server account + a logout button (the desktop
          // local-lock affordance below doesn't apply — the server session IS the identity).
          <>
            <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0 }}>
              <span className="ell" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{serverAuth.user.username}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{serverAuth.user.isAdmin ? t('serverAuth.isAdmin') : t('serverAuth.account')}</span>
            </div>
            <button className="icon-btn bare" title={t('serverAuth.logout')} onClick={() => { void serverAuth.logout() }}><Icon name="x" size={15} /></button>
          </>
        ) : authEnabled ? (
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

export function ConnRow({ conn, active, onOpen, onDetail, nested, selectable, selected, onSelectToggle, favorite, onFavoriteToggle }: ConnRowProps) {
  const D = useData()
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)
  // DB cards open the details panel on click (no workbench, no detail icon).
  // Host/SSH cards keep the original behavior: click → workbench, hover → detail icon.
  // (onOpen is wired by the parent; Connect moves to the DetailsPanel's Connect button.)
  // 批量维护模式下，行点击改为切换选中（不打开详情/工作台）。
  const isDb = conn.kind === 'db'
  const handlePrimary = () => (selectable ? onSelectToggle?.(conn) : (isDb ? onDetail?.(conn) : onOpen(conn)))
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={handlePrimary} onDoubleClick={handlePrimary}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: nested ? '6px 9px' : '7px 9px', borderRadius: 10, cursor: 'pointer',
        background: active || (selectable && selected) ? 'var(--accent-soft)' : hover ? 'var(--surface-sunken)' : 'transparent',
        transition: 'background .12s',
      }}>
      {selectable && (
        <span style={{
          flexShrink: 0, width: 16, height: 16, borderRadius: 5, display: 'grid', placeItems: 'center',
          border: `1.5px solid ${selected ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`,
          background: selected ? 'var(--accent-primary)' : 'transparent',
          color: 'var(--on-accent)',
        }}>
          {selected && <Icon name="check" size={11} />}
        </span>
      )}
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
          {conn.ownerName && (
            // Admin viewing another user's connection — shows whose it is. Absent for own.
            <span className="chip" title={t('shell.ownedBy', { name: conn.ownerName })}
              style={{ flexShrink: 0, height: 16, fontSize: 9.5, gap: 3, color: 'var(--text-tertiary)' }}>
              <Icon name="user" size={9} /> {conn.ownerName}
            </span>
          )}
        </div>
        <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{nested ? (D.engineMeta[conn.engine ?? ''] || {}).label : conn.sub}</span>
      </div>
      {onFavoriteToggle && (hover || favorite) && (
        <button
          className="icon-btn bare"
          title={favorite ? t('shell.unfavorite') : t('shell.favorite')}
          aria-label={favorite ? t('shell.unfavorite') : t('shell.favorite')}
          onClick={e => { e.stopPropagation(); onFavoriteToggle(conn) }}
          style={{
            flexShrink: 0,
            width: 24,
            height: 24,
            color: favorite ? 'var(--signal-amber)' : 'var(--text-faint)',
            background: favorite ? 'color-mix(in srgb, var(--signal-amber) 12%, transparent)' : 'transparent',
          }}
        >
          <Icon name="star" size={14} fill={favorite ? 'currentColor' : 'none'} />
        </button>
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
          <Icon name="network" size={17} />
        </button>
      </div>
    </div>
  )
}
