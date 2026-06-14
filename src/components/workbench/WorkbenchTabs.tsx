/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { useData } from '../../state/DataContext'
import type { Tab } from '../../services/types'

export interface WorkbenchTabsProps {
  tabs: Tab[]
  activeTab: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseAll: () => void
  onNew: () => void
  onDuplicate: (id: string) => void
  onRename: (id: string, title: string) => void
}

interface ContextMenu {
  tabId: string
  x: number
  y: number
}

export function WorkbenchTabs({ tabs, activeTab, onActivate, onClose, onCloseOthers, onCloseAll, onNew, onDuplicate, onRename }: WorkbenchTabsProps) {
  const { t } = useTranslation()
  const D = useData()
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const closeMenu = useCallback(() => setContextMenu(null), [])

  function startRename(tabId: string) {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) return
    setRenaming({ id: tabId, value: tab.title })
  }

  function confirmRename() {
    if (!renaming) return
    const trimmed = renaming.value.trim()
    if (!trimmed) return
    onRename(renaming.id, trimmed)
    setRenaming(null)
  }

  function cancelRename() {
    setRenaming(null)
  }

  useEffect(() => {
    if (renaming) renameInputRef.current?.select()
  }, [renaming])

  useEffect(() => {
    if (!contextMenu) return
    function onClickOutside() { setContextMenu(null) }
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('click', onClickOutside)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onClickOutside)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  function handleContextMenu(e: React.MouseEvent, tabId: string) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ tabId, x: e.clientX, y: e.clientY })
  }

  return (
    <div className="row" style={{ height: 40, flex: 'none', gap: 4, padding: '0 8px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-card)', overflowX: 'auto' }}>
      {tabs.map(tab => {
        const conn = D.byId[tab.connId];
        const active = tab.id === activeTab;
        return (
          <div key={tab.id} onClick={() => onActivate(tab.id)}
            onContextMenu={e => handleContextMenu(e, tab.id)}
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

      {/* context menu */}
      {contextMenu && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 200,
            background: 'var(--surface-card)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-dropdown)',
            padding: '4px 0',
            minWidth: 160,
          }}>
          {[
            { label: t('workbench.duplicateTab'), action: () => { onDuplicate(contextMenu.tabId); closeMenu() } },
            { label: t('workbench.renameTab'), action: () => { startRename(contextMenu.tabId); closeMenu() } },
            { separator: true as const },
            { label: t('workbench.closeCurrent'), action: () => { onClose(contextMenu.tabId); closeMenu() } },
            { label: t('workbench.closeOthers'), action: () => { onCloseOthers(contextMenu.tabId); closeMenu() } },
            { label: t('workbench.closeAll'), action: () => { onCloseAll(); closeMenu() } },
          ].map((item, i) => (
            'separator' in item ? (
              <div key={`sep-${i}`} style={{ height: 1, margin: '4px 0', background: 'var(--border-hairline)' }} />
            ) : (
            <button
              key={item.label}
              onClick={item.action}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '7px 14px',
                border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-soft)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              {item.label}
            </button>
            )
          ))}
        </div>
      )}

      {/* rename modal */}
      {renaming && (
        <div
          onClick={cancelRename}
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.35)',
          }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              minWidth: 320,
              background: 'var(--surface-card)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 12,
              boxShadow: 'var(--shadow-dropdown)',
              padding: 18,
              color: 'var(--text-primary)',
            }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('workbench.renameTitle')}</div>
            <input
              ref={renameInputRef}
              autoFocus
              value={renaming.value}
              placeholder={t('workbench.renamePlaceholder')}
              onChange={e => setRenaming(r => (r ? { ...r, value: e.target.value } : r))}
              onFocus={e => e.currentTarget.select()}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
                else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
              }}
              style={{
                width: '100%', boxSizing: 'border-box', height: 34, padding: '0 10px',
                borderRadius: 8, border: '1px solid var(--border-hairline)',
                background: 'var(--surface-input, transparent)', color: 'var(--text-primary)',
                fontSize: 13, outline: 'none',
              }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={cancelRename}
                style={{
                  height: 32, padding: '0 14px', borderRadius: 8,
                  border: '1px solid var(--border-hairline)', background: 'transparent',
                  color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
                }}
              >
                {t('workbench.renameCancel')}
              </button>
              <button
                onClick={confirmRename}
                style={{
                  height: 32, padding: '0 14px', borderRadius: 8,
                  border: '1px solid var(--accent-border)', background: 'var(--accent-soft)',
                  color: 'var(--accent-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t('workbench.renameConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
