/* ported from ref-ui/_extract/blob6.txt — verbatim per plan T1-T7 */
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import type { ResultColumn } from '../../services/types'

export interface DataGridProps {
  columns: ResultColumn[]
  rows: unknown[][]
  statusTones?: Record<string, string>
  density?: 'comfortable' | 'compact'
}

const thStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', height: 34, cursor: 'pointer', borderRight: '1px solid var(--border-hairline)', userSelect: 'none' }
const tdStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRight: '1px solid var(--border-hairline)', overflow: 'hidden', whiteSpace: 'nowrap' }

/** Derive a column icon from its type/pk/fk flags (mirrors the mock ordersColumns icons). */
function colIcon(col: ResultColumn): string {
  if (col.pk) return 'hash'
  if (col.fk) return 'link'
  const t = col.type.toLowerCase()
  if (t.includes('time') || t.includes('date') || t.includes('timestamp')) return 'calendar'
  if (t === 'char' || t.startsWith('char(') || t.includes('varchar') || t.includes('text') || t.includes('string')) return 'type'
  if (t.includes('int') || t.includes('numeric') || t.includes('decimal') || t.includes('float') || t.includes('double') || t.includes('real') || t.includes('serial')) return 'hash'
  return 'type'
}

export function DataGrid({ columns, rows, statusTones = {}, density = 'comfortable' }: DataGridProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState({ r: 2, c: 3 })
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [edits, setEdits] = useState<Record<string, string | number>>({ '5-total_cents': 4990, '11-status': 'shipped' })
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editVal, setEditVal] = useState('')
  const [page, setPage] = useState(1)
  const rowH = density === 'compact' ? 30 : 36
  const PAGE = 100

  // Find the index of sortCol in columns for indexed-value sort
  const sortColIdx = useMemo(() => {
    if (!sortCol) return -1
    return columns.findIndex(c => c.name === sortCol)
  }, [columns, sortCol])

  const sorted = useMemo(() => {
    if (!sortCol || sortColIdx < 0) return rows
    const idx = sortColIdx
    const arr = [...rows].sort((a, b) => {
      const av = a[idx]
      const bv = b[idx]
      if (av === bv) return 0
      return ((av as string | number) > (bv as string | number) ? 1 : -1) * (sortDir === 'asc' ? 1 : -1)
    })
    return arr
  }, [rows, sortCol, sortColIdx, sortDir])

  const pageRows = sorted.slice((page - 1) * PAGE, page * PAGE)
  const pages = Math.ceil(rows.length / PAGE)

  function toggleSort(name: string) {
    if (sortCol === name) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }
    else { setSortCol(name); setSortDir('asc') }
  }
  function cellKey(rowIdx: number, col: string) { return `${rowIdx}-${col}` }
  function startEdit(rIdx: number, cIdx: number, _rowIdx: number, _col: string, val: unknown) {
    setEditing({ r: rIdx, c: cIdx }); setEditVal(String(val)); setSel({ r: rIdx, c: cIdx })
  }
  function commitEdit(rowIdx: number, col: string) {
    setEdits(e => ({ ...e, [cellKey(rowIdx, col)]: editVal }))
    setEditing(null)
  }

  const editCount = Object.keys(edits).length
  const gridTemplate = '46px ' + columns.map(c => c.name === 'channel' || c.name === 'currency' ? '92px' : c.name === 'created_at' || c.name === 'updated_at' ? '150px' : c.name === 'customer_id' ? '150px' : 'minmax(96px, 1fr)').join(' ')

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      {/* result toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 10 }}>
        <div className="row gap8">
          <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-primary)', fontWeight: 600 }}>
            <Icon name="table-2" size={12} /> public.orders
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}><b className="mono" style={{ color: 'var(--text-secondary)' }}>{rows.length}</b> {t('dbviews.rows')} · <span className="mono">42 ms</span></span>
          {editCount > 0 && (
            <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color: 'var(--signal-amber)', fontWeight: 600 }}>
              <Icon name="pencil" size={11} /> {editCount} {t('dbviews.unsavedEdits')}
            </span>
          )}
        </div>
        <div className="row gap6">
          {editCount > 0 && <Btn size="sm" variant="primary" icon="save">{t('dbviews.saveEdits')}</Btn>}
          <button className="icon-btn bare" title={t('dbviews.filter')}><Icon name="filter" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.sort')}><Icon name="arrow-up-down" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.refresh')}><Icon name="refresh-cw" size={15} /></button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <Btn size="sm" variant="secondary" icon="download" iconR="chevron-down">{t('dbviews.export')}</Btn>
        </div>
      </div>

      {/* grid */}
      <div className="grow mono" style={{ overflow: 'auto', fontSize: 12.5 }}>
        <div style={{ minWidth: 'max-content' }}>
          {/* header */}
          <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline-alt)' }}>
            <div style={{ ...thStyle, justifyContent: 'center', color: 'var(--text-faint)' }}>#</div>
            {columns.map((col) => (
              <div key={col.name} style={thStyle} onClick={() => toggleSort(col.name)} className="gridhead">
                <Icon name={colIcon(col)} size={12} style={{ color: col.pk ? 'var(--signal-amber)' : col.fk ? 'var(--signal-blue)' : 'var(--text-faint)' }} />
                <span className="ell" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{col.name}</span>
                {col.pk && <span style={{ fontSize: 9, color: 'var(--signal-amber)', fontWeight: 700 }}>PK</span>}
                {sortCol === col.name && <Icon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} style={{ color: 'var(--accent-primary)', marginLeft: 'auto' }} />}
              </div>
            ))}
          </div>
          {/* body */}
          {pageRows.map((row, ri) => {
            const globalIdx = (page - 1) * PAGE + ri
            return (
              <div key={globalIdx} style={{ display: 'grid', gridTemplateColumns: gridTemplate, height: rowH, background: ri % 2 ? 'var(--surface-subtle)' : 'transparent' }}
                className="gridrow">
                <div style={{ ...tdStyle, justifyContent: 'center', color: 'var(--text-faint)', fontSize: 11, background: 'var(--surface-sunken)', borderRight: '1px solid var(--border-hairline)' }}>{globalIdx + 1}</div>
                {columns.map((col, ci) => {
                  const k = cellKey(globalIdx, col.name)
                  const isEdited = edits[k] !== undefined
                  const val = isEdited ? edits[k] : row[ci]
                  const isSel = sel.r === globalIdx && sel.c === ci
                  const isEditing = editing && editing.r === globalIdx && editing.c === ci
                  return (
                    <div key={col.name} onClick={() => setSel({ r: globalIdx, c: ci })}
                      onDoubleClick={() => startEdit(globalIdx, ci, globalIdx, col.name, val)}
                      style={{
                        ...tdStyle,
                        cursor: 'cell',
                        background: isEditing ? 'var(--surface-card)' : isEdited ? 'color-mix(in srgb, var(--signal-amber) 14%, transparent)' : isSel ? 'var(--accent-soft-alt)' : 'transparent',
                        boxShadow: isSel && !isEditing ? 'inset 0 0 0 1.5px var(--accent-primary)' : isEdited ? 'inset 0 0 0 1px color-mix(in srgb, var(--signal-amber) 40%, transparent)' : 'none',
                        color: 'var(--text-secondary)',
                      }}>
                      {isEditing ? (
                        <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                          onBlur={() => commitEdit(globalIdx, col.name)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEdit(globalIdx, col.name); if (e.key === 'Escape') setEditing(null) }}
                          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', font: 'inherit', color: 'var(--text-primary)' }} />
                      ) : col.name === 'status' ? (
                        <span className="row gap6" style={{ minWidth: 0 }}>
                          <span className="dot" style={{ background: statusTones[String(val)] || 'var(--text-faint)' }} />
                          <span className="ell" style={{ color: 'var(--text-primary)' }}>{String(val)}</span>
                        </span>
                      ) : col.name === 'total_cents' ? (
                        <span className="ell" style={{ color: isEdited ? 'var(--signal-amber)' : 'var(--text-primary)', fontWeight: 500, marginLeft: 'auto' }}>{Number(val).toLocaleString()}</span>
                      ) : col.name === 'id' ? (
                        <span className="ell" style={{ color: 'var(--text-tertiary)' }}>{String(val)}</span>
                      ) : col.name === 'customer_id' ? (
                        <span className="ell" style={{ color: 'var(--signal-blue)' }}>{String(val)}</span>
                      ) : (
                        <span className="ell">{String(val)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* status bar / pagination */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderTop: '1px solid var(--border-hairline)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <div className="row gap10">
          <span>R{sel.r + 1} · C{sel.c + 1}</span>
          <span className="metadot" />
          <span>{t('dbviews.cell')}: <span className="mono" style={{ color: 'var(--text-secondary)' }}>{(() => { const row = sorted[sel.r]; const col = columns[sel.c]; if (!row || !col) return '—'; const k = cellKey(sel.r, col.name); return String(edits[k] !== undefined ? edits[k] : row[sel.c]); })()}</span></span>
        </div>
        <div className="row gap8">
          <span className="mono" style={{ color: 'var(--signal-green)' }}>● 0 new</span>
          <span className="mono" style={{ color: 'var(--signal-amber)' }}>● {editCount} edited</span>
          <span className="mono" style={{ color: 'var(--danger-fg)' }}>● 0 deleted</span>
          <div style={{ width: 1, height: 14, background: 'var(--border-hairline)' }} />
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} onClick={() => setPage(p => Math.max(1, p - 1))}><Icon name="chevron-left" size={14} /></button>
          <span className="mono">{page} / {pages}</span>
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} onClick={() => setPage(p => Math.min(pages, p + 1))}><Icon name="chevron-right" size={14} /></button>
        </div>
      </div>
    </div>
  )
}
