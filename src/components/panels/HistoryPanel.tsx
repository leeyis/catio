/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, Segmented, ConnGlyph, Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Snippet, HistoryItem, Connection } from '../../services/types'
import { PanelShell } from './PanelShell'
import { ConfirmModal } from '../modals/ConfirmModal'

export interface HistoryPanelProps {
  onClose: () => void
  onAddSnippet?: (s: Snippet) => void
  /** Live history items from the real store (H4 will use this; H3 passes it in). */
  items?: HistoryItem[]
  /** Called when the user confirms clearing all history. */
  onClear?: () => void
  /** Called when the user clicks the insert button on a history row. */
  onInsert?: (text: string) => void
  /** Whether insert is currently possible (e.g. an active terminal exists). */
  canInsert?: boolean
  /** Called when the user deletes a single history row. */
  onDelete?: (h: HistoryItem) => void
}

interface MenuItemProps {
  active: boolean
  onClick: () => void
  conn?: Connection
  kind?: string
  icon?: string
  label: string
  count: number
}

function MenuItem({ active, onClick, conn, kind, icon, label, count }: MenuItemProps) {
  return (
    <button onClick={onClick} className="row gap8" style={{ width: '100%', padding: '7px 9px', borderRadius: 8, background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-sunken)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
      {conn ? <ConnGlyph conn={conn} size={20} radius={6} /> : <div className="icon-badge" style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }}><Icon name={icon || (kind === 'sql' ? 'database' : 'terminal')} size={12} /></div>}
      <span className="ell" style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, flex: 1, textAlign: 'left' }}>{label}</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{count}</span>
      {active && <Icon name="check" size={14} />}
    </button>
  )
}

interface HistoryRowProps {
  h: HistoryItem
  onSave: (h: HistoryItem) => void
  onInsert?: (text: string) => void
  canInsert?: boolean
  onDelete?: (h: HistoryItem) => void
}

function HistoryRow({ h, onSave, onInsert, canInsert, onDelete }: HistoryRowProps) {
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const isSql = h.kind === 'sql'
  const hasFailed = h.exitCode != null && h.exitCode !== 0
  function copy(e: React.MouseEvent) {
    e.stopPropagation()
    if (navigator.clipboard) navigator.clipboard.writeText(h.text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  function run(e: React.MouseEvent) {
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: h.kind, text: h.text } }))
  }
  // Insert routes by kind via the same event bus as run: SQL → active SQL editor,
  // shell → active terminal. Always shown (no canInsert gate); a no-op if there's
  // no matching active target, exactly like the run action.
  function insert(e: React.MouseEvent) {
    e.stopPropagation()
    if (onInsert && !isSql && canInsert) onInsert(h.text)
    else window.dispatchEvent(new CustomEvent('catio-insert', { detail: { kind: h.kind, text: h.text } }))
  }
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="col" style={{ padding: '9px 10px', borderRadius: 10, gap: 6, cursor: 'pointer', background: hover ? 'var(--surface-sunken)' : 'transparent' }}>
      <div className="row gap6" style={{ minWidth: 0 }}>
        <Icon name={h.kind === 'sql' ? 'database' : 'terminal'} size={12} style={{ color: h.kind === 'sql' ? 'var(--signal-blue)' : 'var(--signal-amber)', flex: 'none' }} />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{h.target}</span>
        <span className="grow" />
        <span className="mono" style={{ fontSize: 10, color: h.dur === 'live' ? 'var(--signal-green)' : 'var(--text-faint)' }}>{h.dur}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-disabled)' }}>{h.when}</span>
      </div>
      <div className="row gap6" style={{ minWidth: 0 }}>
        <span className="ell mono" style={{ fontSize: 11.5, color: hasFailed ? 'var(--danger-fg)' : 'var(--text-secondary)', flex: 1 }}>{h.text}</span>
        {hasFailed && (
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--danger-fg)', background: 'color-mix(in srgb, var(--danger-fg) 12%, transparent)', borderRadius: 4, padding: '1px 5px', flex: 'none' }}>
            exit {h.exitCode}
          </span>
        )}
        {/* action order (per spec): 复制 / 插入 / 执行(运行) / 保存 / 删除 */}
        <div className="row gap2" style={{ flex: 'none', opacity: hover || copied ? 1 : 0, transition: 'opacity .12s' }}>
          <button className="icon-btn bare" style={{ width: 22, height: 22, color: copied ? 'var(--signal-green)' : 'var(--text-tertiary)' }} title={copied ? t('panels.copied') : t('panels.copy')} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} title={isSql ? t('panels.insertEditor') : t('panels.insertTerminal')} onClick={insert}>
            <Icon name={isSql ? 'arrow-right-to-line' : 'terminal'} size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} title={isSql ? t('panels.execSql') : t('panels.runItem')} onClick={run}>
            <Icon name="play" size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} title={isSql ? t('panels.saveToSnippets') : t('panels.saveToCodeLib')} onClick={e => { e.stopPropagation(); onSave && onSave(h) }}>
            <Icon name="snippet" size={13} />
          </button>
          {onDelete && (
            <button className="icon-btn bare" style={{ width: 22, height: 22, color: 'var(--danger-fg)' }} title={t('panels.deleteHistoryItem')} onClick={e => { e.stopPropagation(); onDelete(h) }}>
              <Icon name="trash-2" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

interface SaveSnippetModalProps {
  row: HistoryItem
  onClose: () => void
  onSave: (s: Omit<Snippet, 'id'>) => void
}

function SaveSnippetModal({ row, onClose, onSave }: SaveSnippetModalProps) {
  const { t } = useTranslation()
  const isSql = row.kind === 'sql'
  const [desc, setDesc] = useState('')
  const [code, setCode] = useState(row.text)
  const field: React.CSSProperties = { height: 36, padding: '0 11px', borderRadius: 9, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none', width: '100%' }
  function save() {
    if (!code.trim()) return
    onSave({ desc: desc.trim(), scope: isSql ? 'SQL' : 'Shell', icon: isSql ? 'database' : 'terminal', code })
  }
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="pop-in col" style={{ width: '100%', maxWidth: 320, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 16, boxShadow: 'var(--shadow-window)', overflow: 'hidden' }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '14px 16px 10px' }}>
          <div className="row gap8">
            <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="snippet" size={15} /></div>
            <div className="col" style={{ lineHeight: 1.2 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{t('panels.saveToSnippetsTitle')}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{isSql ? 'SQL' : 'Shell'} · {t('panels.saveFromTarget', { target: row.target })}</span>
            </div>
          </div>
          <IconBtn name="x" size={15} variant="bare" onClick={onClose} />
        </div>
        <div className="col gap10" style={{ padding: '4px 16px 8px' }}>
          <label className="col gap5"><span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{isSql ? t('panels.sqlCodeLabel') : t('panels.shellCommandLabel')}</span>
            <textarea autoFocus value={code} onChange={e => setCode(e.target.value)} rows={3} className="mono" style={{ ...field, height: 'auto', padding: '8px 11px', lineHeight: 1.5, resize: 'none' }} /></label>
          <label className="col gap5"><span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('panels.descLabel')} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({t('panels.descOptional')})</span></span>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('panels.descPlaceholder')} style={field}
              onKeyDown={e => { if (e.key === 'Enter') save() }} /></label>
        </div>
        <div className="row gap8" style={{ padding: '10px 16px 14px', justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="sm" onClick={onClose}>{t('panels.cancel')}</Btn>
          <Btn variant="primary" size="sm" icon="check" onClick={save}>{t('panels.confirm')}</Btn>
        </div>
      </div>
    </div>
  )
}

export function HistoryPanel({ onClose, onAddSnippet, items, onClear, onInsert, canInsert, onDelete }: HistoryPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all') // all | sql | shell
  const [target, setTarget] = useState('all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [saveRow, setSaveRow] = useState<HistoryItem | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const byName = useMemo(() => Object.fromEntries(D.connections.map(c => [c.name, c])), [D.connections])
  // Prefer real store items passed in; fall back to mock D.history (demo / H4 not yet wired).
  const historyItems = items ?? D.history
  // distinct targets present in history
  const targets = useMemo(() => {
    const seen: Array<{ name: string; kind: string }> = []
    historyItems.forEach(h => { if (!seen.find(t2 => t2.name === h.target)) seen.push({ name: h.target, kind: h.kind }) })
    return seen
  }, [historyItems])
  const rows = historyItems.filter(h => {
    if (kind !== 'all' && h.kind !== kind) return false
    if (target !== 'all' && h.target !== target) return false
    if (q && !(h.text.toLowerCase().includes(q.toLowerCase()) || h.target.toLowerCase().includes(q.toLowerCase()))) return false
    return true
  })
  return (
    <PanelShell icon="history" title={t('panels.historyTitle')} sub={t('panels.historySub')} onClose={onClose}
      actions={<IconBtn name="download" size={15} variant="bare" title={t('panels.export')} />}>
      {/* search + filters */}
      <div style={{ padding: '8px 12px 8px', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="row gap6" style={{ height: 30, padding: '0 10px', background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 9, marginBottom: 8 }}>
          <Icon name="search" size={13} style={{ color: 'var(--text-faint)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('panels.historySearch')} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--text-primary)' }} />
          {q && <button className="icon-btn bare" style={{ width: 20, height: 20 }} onClick={() => setQ('')}><Icon name="x" size={12} /></button>}
        </div>
        <div className="row gap8">
          {/* kind filter */}
          <Segmented size="sm" value={kind} onChange={setKind} options={[
            { value: 'all', label: t('panels.filterAll') },
            { value: 'sql', label: t('panels.filterDb'), icon: 'database' },
            { value: 'shell', label: t('panels.filterHost'), icon: 'terminal' },
          ]} />
          {/* connection dropdown */}
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button onClick={() => setMenuOpen(o => !o)} className="row gap6"
              style={{ width: '100%', height: 30, padding: '0 8px 0 10px', background: 'var(--surface-sunken)', border: `1px solid ${menuOpen ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 9, color: 'var(--text-secondary)' }}>
              {target === 'all'
                ? <><Icon name="filter" size={12} style={{ color: 'var(--text-faint)' }} /><span style={{ fontSize: 12, fontWeight: 500 }}>{t('panels.allConnections')}</span></>
                : <>{byName[target] ? <ConnGlyph conn={byName[target]} size={16} radius={5} /> : null}<span className="ell" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{target}</span></>}
              <span className="grow" />
              <Icon name="chevron-down" size={13} style={{ color: 'var(--text-faint)', transition: 'transform .15s', transform: menuOpen ? 'rotate(180deg)' : 'none' }} />
            </button>
            {menuOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                <div className="pop-in" style={{ position: 'absolute', top: 34, left: 0, right: 0, zIndex: 50, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', padding: 5, maxHeight: 260, overflowY: 'auto' }}>
                  <MenuItem active={target === 'all'} onClick={() => { setTarget('all'); setMenuOpen(false) }} icon="filter" label={t('panels.allConnections')} count={historyItems.length} />
                  {targets.map(t2 => {
                    const conn = byName[t2.name]
                    const n = historyItems.filter(h => h.target === t2.name).length
                    return <MenuItem key={t2.name} active={target === t2.name} onClick={() => { setTarget(t2.name); setMenuOpen(false) }} conn={conn} kind={t2.kind} label={t2.name} count={n} />
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* list */}
      <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.length ? rows.map(h => <HistoryRow key={h.id} h={h} onSave={setSaveRow} onInsert={onInsert} canInsert={canInsert} onDelete={onDelete} />) : (
          <div className="col" style={{ alignItems: 'center', justifyContent: 'center', padding: '30px 0', gap: 8, color: 'var(--text-faint)' }}>
            <Icon name="search" size={22} /><span style={{ fontSize: 12.5 }}>{t('panels.noHistory')}</span>
          </div>
        )}
      </div>
      {/* footer count */}
      <div className="row gap6" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)', fontSize: 11, color: 'var(--text-faint)' }}>
        <Icon name="history" size={12} /> {t('panels.showingCount', { shown: rows.length, total: historyItems.length })}
        {(kind !== 'all' || target !== 'all' || q) && <button className="btn btn-ghost sm" style={{ height: 22, padding: '0 8px', fontSize: 11 }} onClick={() => { setKind('all'); setTarget('all'); setQ('') }}>{t('panels.clearFilters')}</button>}
        {onClear && historyItems.length > 0 && (
          <button className="btn btn-ghost sm" style={{ marginLeft: 'auto', height: 22, padding: '0 8px', fontSize: 11, color: 'var(--danger-fg)' }} onClick={() => setConfirmClear(true)}>
            {t('panels.clearHistory')}
          </button>
        )}
      </div>
      {saveRow && <SaveSnippetModal row={saveRow} onClose={() => setSaveRow(null)} onSave={(s) => { onAddSnippet && onAddSnippet(s as Snippet); setSaveRow(null) }} />}
      {confirmClear && (
        <ConfirmModal
          title={t('panels.clearHistoryTitle')}
          message={t('panels.clearHistoryMsg')}
          confirmLabel={t('panels.clearHistory')}
          danger
          onConfirm={() => { setConfirmClear(false); onClear?.() }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </PanelShell>
  )
}
