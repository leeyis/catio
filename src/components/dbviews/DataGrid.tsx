/* ported from ref-ui/_extract/blob6.txt — verbatim per plan T1-T7; E3 adds edit→preview→apply + pagination */
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { previewDml, applyEdits, queryPage, tablePreview, dbErrMsg, type EditRequest } from '../../services/db'
import type { ResultColumn } from '../../services/types'

export interface DataGridProps {
  columns: ResultColumn[]
  rows: unknown[][]
  statusTones?: Record<string, string>
  density?: 'comfortable' | 'compact'
  /** Read-only engines (per capabilities.writable) disable cell editing + Save. Defaults true so mock/demo stays editable. */
  writable?: boolean
  /** When set, Save + pagination talk to the backend for this connection. */
  connId?: string
  /** Target table for generated DML (defaults to 'orders' to match the seeded mock). */
  table?: string
  /** Header label override (e.g. "Query result") — used when the grid shows ad-hoc
   * query output rather than a single table, so it doesn't show the mock 'orders'. */
  resultLabel?: string
  /** Optional schema qualifier for generated DML. */
  schema?: string
  /** Base SQL re-run for server-side pagination (when connId is set, legacy raw-SQL path). */
  sql?: string
  /**
   * When set, pagination uses the dialect-correct `tablePreview` (schema/table)
   * backend command instead of re-running a raw `sql`. Preferred for the live
   * table-data path so identifier quoting/qualification lives in one place.
   */
  livePreview?: boolean
  /** Called after a successful apply so the parent can re-fetch. */
  onRefresh?: () => void
  /** When true, `truncated` badge is shown (server reported a capped result). */
  truncated?: boolean
  /** Error message from the parent's data fetch — surfaced inline in the status bar. */
  loadError?: string
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

export function DataGrid({ columns, rows, statusTones = {}, density = 'comfortable', writable = true, connId, table = 'orders', schema, sql, livePreview, onRefresh, truncated, loadError, resultLabel }: DataGridProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState({ r: 2, c: 3 })
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [edits, setEdits] = useState<Record<string, string | number>>({})
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editVal, setEditVal] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  // server-side page rows (when connId set); null → use client-side slice of `rows`
  const [serverRows, setServerRows] = useState<unknown[][] | null>(null)
  const [serverTruncated, setServerTruncated] = useState(false)
  // preview gate
  const [preview, setPreview] = useState<{ reqs: EditRequest[]; sql: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState<string | null>(null)
  const [applyErr, setApplyErr] = useState<string | null>(null)
  const rowH = density === 'compact' ? 30 : 36
  const PAGE = pageSize

  // The pk column(s) of the result — needed to safely key UPDATEs. Empty → not editable per-row.
  const pkCols = useMemo(() => columns.filter(c => c.pk).map(c => c.name), [columns])
  const canEdit = writable && pkCols.length > 0

  // Find the index of sortCol in columns for indexed-value sort
  const sortColIdx = useMemo(() => {
    if (!sortCol) return -1
    return columns.findIndex(c => c.name === sortCol)
  }, [columns, sortCol])

  // base rows: server page (if fetched) else the full client-side set
  const baseRows = serverRows ?? rows

  // Tag each row with its original (unsorted) index so keys and edits are stable under sort.
  const tagged = useMemo(() => baseRows.map((row, i) => ({ row, origIdx: i })), [baseRows])

  const sorted = useMemo(() => {
    if (!sortCol || sortColIdx < 0) return tagged
    const idx = sortColIdx
    return [...tagged].sort((a, b) => {
      const av = a.row[idx]
      const bv = b.row[idx]
      if (av === bv) return 0
      return ((av as string | number) > (bv as string | number) ? 1 : -1) * (sortDir === 'asc' ? 1 : -1)
    })
  }, [tagged, sortCol, sortColIdx, sortDir])

  // When serverRows is set, the rows are already the current page → no client slice.
  const pageRows = serverRows ? sorted : sorted.slice((page - 1) * PAGE, page * PAGE)
  const pages = serverRows ? page + (serverTruncated ? 1 : 0) : Math.max(1, Math.ceil(baseRows.length / PAGE))
  const showTruncated = serverRows ? serverTruncated : !!truncated

  // Fetch one server page. Prefer the dialect-correct tablePreview (schema/table)
  // when the parent opts in via `livePreview`; else fall back to the raw-SQL queryPage.
  const fetchPage = useMemo(() => {
    if (connId && livePreview) {
      return (limit: number, offset: number) => tablePreview(connId, schema, table, limit, offset)
    }
    if (connId && sql) {
      return (limit: number, offset: number) => queryPage(connId, sql, limit, offset)
    }
    return null
  }, [connId, livePreview, sql, schema, table])

  async function gotoPage(next: number) {
    if (next < 1) return
    if (fetchPage) {
      const res = await fetchPage(PAGE, (next - 1) * PAGE)
      setServerRows(res.rows)
      setServerTruncated(!!res.truncated)
      setPage(next)
    } else {
      setPage(Math.min(pages, Math.max(1, next)))
    }
  }

  function changePageSize(v: string) {
    const n = Number(v)
    setPageSize(n)
    setPage(1)
    if (fetchPage) {
      fetchPage(n, 0).then(res => { setServerRows(res.rows); setServerTruncated(!!res.truncated) })
    }
  }

  function toggleSort(name: string) {
    if (sortCol === name) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }
    else { setSortCol(name); setSortDir('asc') }
  }
  function cellKey(rowIdx: number, col: string) { return `${rowIdx}-${col}` }
  function startEdit(rIdx: number, cIdx: number, _rowIdx: number, _col: string, val: unknown) {
    if (!canEdit) return
    setEditing({ r: rIdx, c: cIdx }); setEditVal(String(val)); setSel({ r: rIdx, c: cIdx })
  }
  function commitEdit(rowIdx: number, col: string) {
    setEdits(e => ({ ...e, [cellKey(rowIdx, col)]: editVal }))
    setEditing(null)
  }

  /** Group the pending `edits` map into one UPDATE EditRequest per edited row. */
  function buildEditRequests(): EditRequest[] {
    const byRow = new Map<number, [string, unknown][]>()
    for (const key of Object.keys(edits)) {
      const dash = key.indexOf('-')
      const origIdx = Number(key.slice(0, dash))
      const colName = key.slice(dash + 1)
      const list = byRow.get(origIdx) ?? []
      list.push([colName, edits[key]])
      byRow.set(origIdx, list)
    }
    const reqs: EditRequest[] = []
    for (const [origIdx, cells] of byRow) {
      const entry = tagged.find(e => e.origIdx === origIdx)
      if (!entry) continue
      const pk: [string, unknown][] = pkCols.map(name => {
        const ci = columns.findIndex(c => c.name === name)
        return [name, entry.row[ci]] as [string, unknown]
      })
      reqs.push({ schema, table, kind: 'update', pk, cells })
    }
    return reqs
  }

  async function openPreview() {
    const reqs = buildEditRequests()
    if (reqs.length === 0) return
    // Render each statement; previewDml returns a stub outside Tauri.
    const stmts = await Promise.all(reqs.map(r => previewDml(connId ?? '', r)))
    setApplyMsg(null)
    setApplyErr(null)
    setPreview({ reqs, sql: stmts.join(';\n') + ';' })
  }

  async function confirmApply() {
    if (!preview) return
    setApplying(true)
    setApplyErr(null)
    try {
      const affected = await applyEdits(connId ?? '', preview.reqs)
      setApplyMsg(t('dbviews.rowsAffected', { count: affected }))
      setEdits({})
      setPreview(null)
      if (fetchPage) {
        const res = await fetchPage(PAGE, (page - 1) * PAGE)
        setServerRows(res.rows)
        setServerTruncated(!!res.truncated)
      }
      onRefresh?.()
    } catch (e) {
      // Surface the failure inline in the preview gate instead of failing silently.
      setApplyErr(t('dbviews.applyError', { message: dbErrMsg(e) }))
    } finally {
      setApplying(false)
    }
  }

  const editCount = Object.keys(edits).length
  // Toolbar table chip: live path uses the real schema/table (no bogus `public.`);
  // mock/demo path keeps the original `public.orders` label for pixel parity.
  const toolbarLabel = resultLabel ?? (connId ? (schema ? `${schema}.${table}` : table) : 'public.orders')
  // Row count shown in the toolbar: live path reflects the loaded page rows; mock keeps rows.length.
  const rowCount = connId ? baseRows.length : rows.length
  // Fixed per-column widths so the row is exactly as wide as the sum of its
  // columns and the grid scrolls horizontally — no flex/1fr stretch that would
  // blow up a couple of columns to fill the viewport and hide the rest.
  const gridTemplate = '46px ' + columns.map(c => c.name === 'channel' || c.name === 'currency' ? '92px' : c.name === 'created_at' || c.name === 'updated_at' ? '150px' : c.name === 'customer_id' ? '150px' : '160px').join(' ')

  return (
    <div className="col" style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      {/* result toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 10 }}>
        <div className="row gap8">
          <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-primary)', fontWeight: 600 }}>
            <Icon name="table-2" size={12} /> {toolbarLabel}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}><b className="mono" style={{ color: 'var(--text-secondary)' }}>{rowCount}</b> {t('dbviews.rows')}{connId ? '' : <> · <span className="mono">42 ms</span></>}</span>
          {editCount > 0 && (
            <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color: 'var(--signal-amber)', fontWeight: 600 }}>
              <Icon name="pencil" size={11} /> {editCount} {t('dbviews.unsavedEdits')}
            </span>
          )}
        </div>
        <div className="row gap6">
          {canEdit && editCount > 0 && <Btn size="sm" variant="primary" icon="save" onClick={openPreview}>{t('dbviews.saveEdits')}</Btn>}
          <button className="icon-btn bare" title={t('dbviews.filter')}><Icon name="filter" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.sort')}><Icon name="arrow-up-down" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.refresh')} onClick={() => gotoPage(page)}><Icon name="refresh-cw" size={15} /></button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <Btn size="sm" variant="secondary" icon="download" iconR="chevron-down">{t('dbviews.export')}</Btn>
        </div>
      </div>

      {/* grid */}
      <div className="grow mono" style={{ overflow: 'auto', fontSize: 12.5 }}>
        <div style={{ minWidth: 'max-content' }}>
          {/* header */}
          <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline-alt)' }}>
            <div style={{ ...thStyle, justifyContent: 'center', color: 'var(--text-faint)', position: 'sticky', left: 0, zIndex: 3, background: 'var(--surface-subtle)' }}>#</div>
            {columns.map((col) => (
              <div key={col.name} style={thStyle} onClick={() => toggleSort(col.name)} className="gridhead">
                <Icon name={col.icon ?? colIcon(col)} size={12} style={{ color: col.pk ? 'var(--signal-amber)' : col.fk ? 'var(--signal-blue)' : 'var(--text-faint)' }} />
                <span className="ell" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{col.name}</span>
                {col.pk && <span style={{ fontSize: 9, color: 'var(--signal-amber)', fontWeight: 700 }}>PK</span>}
                {sortCol === col.name && <Icon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} style={{ color: 'var(--accent-primary)', marginLeft: 'auto' }} />}
              </div>
            ))}
          </div>
          {/* body */}
          {pageRows.map(({ row, origIdx }, ri) => {
            const globalIdx = (page - 1) * PAGE + ri
            return (
              <div key={origIdx} style={{ display: 'grid', gridTemplateColumns: gridTemplate, height: rowH, background: ri % 2 ? 'var(--surface-subtle)' : 'transparent' }}
                className="gridrow">
                <div style={{ ...tdStyle, justifyContent: 'center', color: 'var(--text-faint)', fontSize: 11, background: 'var(--surface-sunken)', borderRight: '1px solid var(--border-hairline)', position: 'sticky', left: 0, zIndex: 1 }}>{globalIdx + 1}</div>
                {columns.map((col, ci) => {
                  const k = cellKey(origIdx, col.name)
                  const isEdited = edits[k] !== undefined
                  const val = isEdited ? edits[k] : row[ci]
                  const isSel = sel.r === origIdx && sel.c === ci
                  const isEditing = editing && editing.r === origIdx && editing.c === ci
                  return (
                    <div key={col.name} onClick={() => setSel({ r: origIdx, c: ci })}
                      onDoubleClick={() => startEdit(origIdx, ci, origIdx, col.name, val)}
                      style={{
                        ...tdStyle,
                        cursor: canEdit ? 'cell' : 'default',
                        background: isEditing ? 'var(--surface-card)' : isEdited ? 'color-mix(in srgb, var(--signal-amber) 14%, transparent)' : isSel ? 'var(--accent-soft-alt)' : 'transparent',
                        boxShadow: isSel && !isEditing ? 'inset 0 0 0 1.5px var(--accent-primary)' : isEdited ? 'inset 0 0 0 1px color-mix(in srgb, var(--signal-amber) 40%, transparent)' : 'none',
                        color: 'var(--text-secondary)',
                      }}>
                      {isEditing ? (
                        <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                          onBlur={() => commitEdit(origIdx, col.name)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEdit(origIdx, col.name); if (e.key === 'Escape') setEditing(null) }}
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
          <span>{t('dbviews.cell')}: <span className="mono" style={{ color: 'var(--text-secondary)' }}>{(() => { const entry = sorted.find(e => e.origIdx === sel.r); const col = columns[sel.c]; if (!entry || !col) return '—'; const k = cellKey(sel.r, col.name); return String(edits[k] !== undefined ? edits[k] : entry.row[sel.c]); })()}</span></span>
          {showTruncated && <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color: 'var(--signal-amber)', fontWeight: 600 }}>{t('dbviews.truncated')}</span>}
          {applyMsg && <span style={{ color: 'var(--signal-green)' }}>{applyMsg}</span>}
          {loadError && <span className="row gap6" style={{ color: 'var(--danger-fg)' }}><Icon name="alert-triangle" size={12} /> {t('dbviews.loadError', { message: loadError })}</span>}
        </div>
        <div className="row gap8">
          <span className="mono" style={{ color: 'var(--signal-green)' }}>● 0 new</span>
          <span className="mono" style={{ color: 'var(--signal-amber)' }}>● {editCount} edited</span>
          <span className="mono" style={{ color: 'var(--danger-fg)' }}>● 0 deleted</span>
          <div style={{ width: 1, height: 14, background: 'var(--border-hairline)' }} />
          <Segmented size="sm" value={String(pageSize)} onChange={changePageSize}
            options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '500', label: '500' }]} />
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} onClick={() => gotoPage(page - 1)}><Icon name="chevron-left" size={14} /></button>
          <span className="mono">{page} / {pages}</span>
          <button className="icon-btn bare" style={{ width: 22, height: 22 }} onClick={() => gotoPage(page + 1)}><Icon name="chevron-right" size={14} /></button>
        </div>
      </div>

      {/* DML preview gate — mirrors modals/ConnectSecretPrompt visual language */}
      {preview && (
        <div onClick={() => !applying && setPreview(null)}
          style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 540, maxWidth: '90%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.previewTitle')}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('dbviews.previewSubtitle', { count: preview.reqs.length })}</span>
              </div>
              <IconBtn name="x" size={16} variant="bare" onClick={() => !applying && setPreview(null)} />
            </div>
            <div className="col" style={{ gap: 10, padding: '16px 20px 20px' }}>
              <pre className="mono" style={{ margin: 0, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.6, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{preview.sql}</pre>
              {applyErr && (
                <div className="row gap6" style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12 }}>
                  <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
                  <span>{applyErr}</span>
                </div>
              )}
              <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 2 }}>
                <Btn variant="ghost" onClick={() => setPreview(null)} disabled={applying}>{t('dbviews.cancel')}</Btn>
                <Btn variant="primary" icon="check" onClick={confirmApply} disabled={applying}>{applying ? t('dbviews.applying') : t('dbviews.applyChanges')}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
