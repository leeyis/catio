/* ported from ref-ui/_extract/blob6.txt — verbatim per plan T1-T7; E3 adds edit→preview→apply + pagination */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { previewDml, applyEdits, queryPage, tablePreview, exportFile, dbErrMsg, type EditRequest } from '../../services/db'
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
  /**
   * Per-row stable key values aligned to `rows` (one entry per row, same order).
   * Used to key UPDATE/DELETE when the table has NO primary key — e.g. Postgres
   * `ctid`. The parent strips the `__ctid` column out of `columns`/`rows` and
   * passes its values here. Only meaningful together with `keyColumn`.
   */
  rowKeys?: string[]
  /**
   * The column name to key edits on when there's no primary key (e.g. 'ctid').
   * When set together with `rowKeys`, editing is enabled and UPDATE/DELETE WHERE
   * clauses are built as `<keyColumn> = <rowKeys[origIdx]>`.
   */
  keyColumn?: string
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

export function DataGrid({ columns, rows, statusTones = {}, density = 'comfortable', writable = true, connId, table = 'orders', schema, sql, livePreview, onRefresh, truncated, loadError, resultLabel, rowKeys, keyColumn }: DataGridProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState({ r: 2, c: 3 })
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [edits, setEdits] = useState<Record<string, string | number>>({})
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editVal, setEditVal] = useState('')
  // Pending new rows: each is a map of column-name → value. Keyed by a negative
  // synthetic index (-1, -2, …) so cell-edit keys never collide with existing rows.
  const [newRows, setNewRows] = useState<{ id: number; cells: Record<string, string | number> }[]>([])
  const newRowSeq = useRef(0)
  // Original indexes (into baseRows) of existing rows marked for deletion.
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [exportErr, setExportErr] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  // server-side page rows (when connId set); null → use client-side slice of `rows`
  const [serverRows, setServerRows] = useState<unknown[][] | null>(null)
  const [serverTruncated, setServerTruncated] = useState(false)
  // server-side per-row keys for the ctid path (aligned to serverRows), when the
  // grid paginates a PK-less Postgres table itself. Null → use the prop `rowKeys`.
  const [serverRowKeys, setServerRowKeys] = useState<string[] | null>(null)
  // toolbar: refresh / filter / sort / export UI state
  const [refreshing, setRefreshing] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  // preview gate
  const [preview, setPreview] = useState<{ reqs: EditRequest[]; sql: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState<string | null>(null)
  const [applyErr, setApplyErr] = useState<string | null>(null)
  const rowH = density === 'compact' ? 30 : 36
  const PAGE = pageSize

  // The pk column(s) of the result — needed to safely key UPDATEs. Empty → not editable per-row.
  const pkCols = useMemo(() => columns.filter(c => c.pk).map(c => c.name), [columns])
  // Active per-row keys for the no-PK (ctid) path: server page keys take precedence
  // over the parent-provided first-page keys, mirroring serverRows ?? rows.
  const activeRowKeys = serverRowKeys ?? rowKeys ?? null
  // Editable when there's a PK, OR a key column + per-row keys (ctid fallback).
  const canEdit = writable && (pkCols.length > 0 || !!(keyColumn && activeRowKeys))

  // Find the index of sortCol in columns for indexed-value sort
  const sortColIdx = useMemo(() => {
    if (!sortCol) return -1
    return columns.findIndex(c => c.name === sortCol)
  }, [columns, sortCol])

  // base rows: server page (if fetched) else the full client-side set
  const baseRows = serverRows ?? rows

  // Tag each row with its original (unsorted) index so keys and edits are stable under sort.
  const tagged = useMemo(() => baseRows.map((row, i) => ({ row, origIdx: i })), [baseRows])

  // Client-side text filter: keep rows where ANY cell's string value contains the
  // (case-insensitive) filter text. Empty / closed filter → all rows.
  const filtered = useMemo(() => {
    const q = filterOpen ? filterText.trim().toLowerCase() : ''
    if (!q) return tagged
    return tagged.filter(({ row }) =>
      row.some(v => v != null && String(v).toLowerCase().includes(q)),
    )
  }, [tagged, filterOpen, filterText])

  const sorted = useMemo(() => {
    if (!sortCol || sortColIdx < 0) return filtered
    const idx = sortColIdx
    return [...filtered].sort((a, b) => {
      const av = a.row[idx]
      const bv = b.row[idx]
      if (av === bv) return 0
      return ((av as string | number) > (bv as string | number) ? 1 : -1) * (sortDir === 'asc' ? 1 : -1)
    })
  }, [filtered, sortCol, sortColIdx, sortDir])

  // When serverRows is set, the rows are already the current page → no client slice.
  // Filtering applies to the displayed rows; with a filter active we render the
  // filtered set directly (no client paging math on a partial page).
  const filterActive = filterOpen && filterText.trim().length > 0
  const pageRows = (serverRows || filterActive) ? sorted : sorted.slice((page - 1) * PAGE, page * PAGE)
  const pages = serverRows ? page + (serverTruncated ? 1 : 0) : Math.max(1, Math.ceil(filtered.length / PAGE))
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

  // Apply a freshly-fetched server page. On the ctid path the live preview still
  // returns a leading `__ctid` system column; strip it from the displayed rows and
  // capture its values as the server-side per-row keys (aligned to the page). On
  // the PK path there is no `__ctid` column and rowKeys stay null.
  function applyServerPage(res: { rows: unknown[][]; truncated?: boolean }) {
    if (keyColumn) {
      const k = res.rows.map(r => String(r[0]))
      setServerRows(res.rows.map(r => r.slice(1)))
      setServerRowKeys(k)
    } else {
      setServerRows(res.rows)
    }
    setServerTruncated(!!res.truncated)
  }

  async function gotoPage(next: number) {
    if (next < 1) return
    if (fetchPage) {
      const res = await fetchPage(PAGE, (next - 1) * PAGE)
      applyServerPage(res)
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
      fetchPage(n, 0).then(applyServerPage)
    }
  }

  function toggleSort(name: string) {
    if (sortCol === name) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }
    else { setSortCol(name); setSortDir('asc') }
  }

  // Refresh: re-fetch the current page from the server when possible, else ask the
  // parent to refresh. Brief spinner while the fetch is in flight.
  async function refresh() {
    if (refreshing) return
    if (fetchPage) {
      setRefreshing(true)
      try {
        const res = await fetchPage(PAGE, (page - 1) * PAGE)
        applyServerPage(res)
      } finally {
        setRefreshing(false)
      }
    } else {
      onRefresh?.()
    }
  }

  // CSV-escape a single value: empty for null/undefined; quote+double-quote when the
  // value contains a comma, quote, or newline.
  function csvEscape(v: unknown): string {
    if (v == null) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  function triggerDownload(text: string, type: string, filename: string) {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const isTauri = () =>
    typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

  // Build the export text (CSV or JSON) from the CURRENTLY displayed rows
  // (after filter + sort) and columns.
  function buildExport(format: 'csv' | 'json'): { text: string; type: string } {
    const displayRows = pageRows.map(({ row }) => row)
    if (format === 'csv') {
      const header = columns.map(c => csvEscape(c.name)).join(',')
      const lines = displayRows.map(row => columns.map((_, ci) => csvEscape(row[ci])).join(','))
      return { text: [header, ...lines].join('\n'), type: 'text/csv' }
    }
    const objs = displayRows.map(row => {
      const o: Record<string, unknown> = {}
      columns.forEach((c, ci) => { o[c.name] = row[ci] ?? null })
      return o
    })
    return { text: JSON.stringify(objs, null, 2), type: 'application/json' }
  }

  // Export the displayed rows. Inside Tauri the webview `<a download>` is a no-op,
  // so pick a destination via the dialog plugin and write the file through the
  // backend. Outside Tauri keep the Blob download so the demo still works.
  async function exportAs(format: 'csv' | 'json') {
    setExportMenuOpen(false)
    setExportErr(null)
    const { text, type } = buildExport(format)
    if (!isTauri()) {
      triggerDownload(text, type, `export.${format}`)
      return
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: `export.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      })
      if (path) await exportFile(path, text)
    } catch (e) {
      setExportErr(t('dbviews.applyError', { message: dbErrMsg(e) }))
    }
  }
  function cellKey(rowIdx: number, col: string) { return `${rowIdx}-${col}` }

  // The ORIGINAL (unedited) value of an existing cell, looked up from baseRows by
  // its origIdx. Used by change-detection so an edit is only recorded when the
  // committed value actually differs from what's in the underlying data.
  function originalCellValue(origIdx: number, colName: string): unknown {
    const entry = tagged.find(e => e.origIdx === origIdx)
    if (!entry) return undefined
    const ci = columns.findIndex(c => c.name === colName)
    return ci < 0 ? undefined : entry.row[ci]
  }

  // --- typed editors --------------------------------------------------------
  // Classify a column type into the native input it should use when editing.
  function editorKind(type: string | undefined): 'date' | 'datetime' | 'time' | 'text' {
    const t = (type ?? '').toLowerCase()
    if (/timestamp|datetime/.test(t)) return 'datetime'
    if (/date/.test(t)) return 'date'
    if (/time/.test(t)) return 'time'
    return 'text'
  }

  // Map a stored string value into the format a native picker expects. Best-effort:
  // if the value can't be parsed into the expected shape, keep it as-is so the user
  // never loses data (the picker may then show empty, but the raw text is preserved
  // on commit when untouched).
  function toEditorValue(kind: 'date' | 'datetime' | 'time' | 'text', raw: string): string {
    if (kind === 'text' || !raw) return raw
    if (kind === 'date') {
      const m = raw.match(/^(\d{4}-\d{2}-\d{2})/)
      return m ? m[1] : raw
    }
    if (kind === 'datetime') {
      // datetime-local wants YYYY-MM-DDTHH:mm — accept space or T separators.
      const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
      return m ? `${m[1]}T${m[2]}` : raw
    }
    // time → HH:mm[:ss]
    const m = raw.match(/^(\d{2}:\d{2}(?::\d{2})?)/)
    return m ? m[1] : raw
  }

  // Map a native-picker value back to a string suitable for SQL. datetime-local
  // returns YYYY-MM-DDTHH:mm — normalise the `T` to a space for SQL timestamps.
  function fromEditorValue(kind: 'date' | 'datetime' | 'time' | 'text', val: string): string {
    if (kind === 'datetime') return val.replace('T', ' ')
    return val
  }

  function startEdit(rIdx: number, cIdx: number, _rowIdx: number, _col: string, val: unknown) {
    if (!canEdit) return
    const kind = editorKind(columns[cIdx]?.type)
    setEditing({ r: rIdx, c: cIdx }); setEditVal(toEditorValue(kind, String(val ?? ''))); setSel({ r: rIdx, c: cIdx })
  }
  // Commit an edit. Existing rows (origIdx >= 0) write into the `edits` map; new
  // rows (encoded as r = -(rowId + 1)) write into their own `cells` map.
  // For existing rows, change-detection: only record the edit when the committed
  // value DIFFERS (string-compare) from the original cell value; if it's reverted
  // to the original (or unchanged), remove any existing edit entry for that cell.
  function commitEdit(rowIdx: number, col: string) {
    const kind = editorKind(columns.find(c => c.name === col)?.type)
    const value = fromEditorValue(kind, editVal)
    if (rowIdx < 0) {
      const id = -rowIdx - 1
      setNewRows(rs => rs.map(r => r.id === id ? { ...r, cells: { ...r.cells, [col]: value } } : r))
    } else {
      const orig = originalCellValue(rowIdx, col)
      const k = cellKey(rowIdx, col)
      setEdits(e => {
        if (value === String(orig ?? '')) {
          if (e[k] === undefined) return e
          const next = { ...e }
          delete next[k]
          return next
        }
        return { ...e, [k]: value }
      })
    }
    setEditing(null)
  }

  // Revert an already-committed edit on an existing cell back to its original value.
  function revertCell(origIdx: number, col: string) {
    const k = cellKey(origIdx, col)
    setEdits(e => {
      if (e[k] === undefined) return e
      const next = { ...e }
      delete next[k]
      return next
    })
  }

  // Discard ALL pending changes: edits, new rows, and pending deletes. Restores
  // the grid to the originally-loaded view.
  function discardChanges() {
    setEdits({})
    setNewRows([])
    setDeleted(new Set())
    setEditing(null)
  }

  // Add an empty pending row (tracked separately; becomes an INSERT on Save).
  function addRow() {
    if (!canEdit) return
    const id = newRowSeq.current++
    setNewRows(rs => [...rs, { id, cells: {} }])
  }
  function removeNewRow(id: number) {
    setNewRows(rs => rs.filter(r => r.id !== id))
    if (editing && editing.r === -(id + 1)) setEditing(null)
  }
  // Toggle an existing row (by its origIdx) in/out of the pending-delete set.
  function toggleDelete(origIdx: number) {
    if (!canEdit) return
    setDeleted(d => {
      const next = new Set(d)
      if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx)
      return next
    })
  }

  /**
   * Build the full set of pending statements: one UPDATE per edited existing row,
   * one INSERT per non-empty new row, and one DELETE per row marked for deletion.
   */
  function buildEditRequests(): EditRequest[] {
    const reqs: EditRequest[] = []

    // --- UPDATEs (skip rows that are also marked for deletion) ---
    const byRow = new Map<number, [string, unknown][]>()
    for (const key of Object.keys(edits)) {
      const dash = key.indexOf('-')
      const origIdx = Number(key.slice(0, dash))
      const colName = key.slice(dash + 1)
      const list = byRow.get(origIdx) ?? []
      list.push([colName, edits[key]])
      byRow.set(origIdx, list)
    }
    for (const [origIdx, cells] of byRow) {
      if (deleted.has(origIdx)) continue
      const entry = tagged.find(e => e.origIdx === origIdx)
      if (!entry) continue
      const pk = rowPk(origIdx, entry.row)
      if (pk.length === 0) continue
      reqs.push({ schema, table, kind: 'update', pk, cells })
    }

    // --- INSERTs (one per new row that has at least one filled cell) ---
    for (const nr of newRows) {
      const cells = Object.entries(nr.cells).filter(([, v]) => String(v).length > 0) as [string, unknown][]
      if (cells.length === 0) continue
      reqs.push({ schema, table, kind: 'insert', pk: [], cells })
    }

    // --- DELETEs (one per marked existing row) ---
    for (const origIdx of deleted) {
      const entry = tagged.find(e => e.origIdx === origIdx)
      if (!entry) continue
      const pk = rowPk(origIdx, entry.row)
      if (pk.length === 0) continue
      reqs.push({ schema, table, kind: 'delete', pk, cells: [] })
    }

    return reqs
  }

  /**
   * Build the WHERE-clause key pairs for an existing row. Prefer the table's real
   * primary key column(s). With no PK, fall back to the ctid-style row key:
   * `[[keyColumn, activeRowKeys[origIdx]]]`. Returns [] when no usable key exists.
   */
  function rowPk(origIdx: number, row: unknown[]): [string, unknown][] {
    if (pkCols.length > 0) {
      return pkCols.map(name => {
        const ci = columns.findIndex(c => c.name === name)
        return [name, row[ci]] as [string, unknown]
      })
    }
    if (keyColumn && activeRowKeys && activeRowKeys[origIdx] != null) {
      return [[keyColumn, activeRowKeys[origIdx]]]
    }
    return []
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
      setNewRows([])
      setDeleted(new Set())
      setPreview(null)
      if (fetchPage) {
        const res = await fetchPage(PAGE, (page - 1) * PAGE)
        applyServerPage(res)
      }
      onRefresh?.()
    } catch (e) {
      // Surface the failure inline in the preview gate instead of failing silently.
      setApplyErr(t('dbviews.applyError', { message: dbErrMsg(e) }))
    } finally {
      setApplying(false)
    }
  }

  // Close the sort/export dropdowns on an outside click.
  useEffect(() => {
    if (!sortMenuOpen && !exportMenuOpen) return
    function onDocClick(e: MouseEvent) {
      const tgt = e.target as Node
      if (sortMenuOpen && sortMenuRef.current && !sortMenuRef.current.contains(tgt)) setSortMenuOpen(false)
      if (exportMenuOpen && exportMenuRef.current && !exportMenuRef.current.contains(tgt)) setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortMenuOpen, exportMenuOpen])

  // Footer counters. "edited" = existing rows with at least one changed cell that
  // are NOT also marked for deletion; "new" = pending insert rows; "deleted" =
  // existing rows marked for deletion. `pendingTotal` gates Save + the chip.
  const editedRowIdxs = useMemo(() => {
    const s = new Set<number>()
    for (const key of Object.keys(edits)) s.add(Number(key.slice(0, key.indexOf('-'))))
    for (const idx of deleted) s.delete(idx)
    return s
  }, [edits, deleted])
  const editedCount = editedRowIdxs.size
  const newCount = newRows.length
  const deletedCount = deleted.size
  const pendingTotal = editedCount + newCount + deletedCount
  // Kept for the in-toolbar "unsaved edits" chip wording (cell-level count).
  const editCount = pendingTotal
  // Toolbar table chip: live path uses the real schema/table (no bogus `public.`);
  // mock/demo path keeps the original `public.orders` label for pixel parity.
  const toolbarLabel = resultLabel ?? (connId ? (schema ? `${schema}.${table}` : table) : 'public.orders')
  // Row count shown in the toolbar: when a filter is active, reflect the filtered
  // count; otherwise live path reflects the loaded page rows, mock keeps rows.length.
  const rowCount = filterActive ? filtered.length : (connId ? baseRows.length : rows.length)
  // Fixed per-column widths so the row is exactly as wide as the sum of its
  // columns and the grid scrolls horizontally — no flex/1fr stretch that would
  // blow up a couple of columns to fill the viewport and hide the rest.
  const gridTemplate = '46px ' + columns.map(c => c.name === 'channel' || c.name === 'currency' ? '92px' : c.name === 'created_at' || c.name === 'updated_at' ? '150px' : c.name === 'customer_id' ? '150px' : '160px').join(' ') + (canEdit ? ' 44px' : '')

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
          {canEdit && <Btn size="sm" variant="secondary" icon="plus" onClick={addRow}>{t('dbviews.addRow')}</Btn>}
          {canEdit && pendingTotal > 0 && <Btn size="sm" variant="ghost" icon="rotate-ccw" onClick={discardChanges}>{t('dbviews.discardChanges')}</Btn>}
          {canEdit && pendingTotal > 0 && <Btn size="sm" variant="primary" icon="save" onClick={openPreview}>{t('dbviews.saveEdits')}</Btn>}
          <button className="icon-btn bare" title={t('dbviews.filter')} data-active={filterOpen ? '1' : undefined}
            onClick={() => setFilterOpen(o => !o)}><Icon name="filter" size={15} /></button>
          <div ref={sortMenuRef} style={{ position: 'relative' }}>
            <button className="icon-btn bare" title={t('dbviews.sort')} data-active={sortMenuOpen || sortCol ? '1' : undefined}
              onClick={() => { setSortMenuOpen(o => !o); setExportMenuOpen(false) }}><Icon name="arrow-up-down" size={15} /></button>
            {sortMenuOpen && (
              <div className="pop-in" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, minWidth: 180, maxHeight: 320, overflow: 'auto', background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-window)', padding: 4 }}>
                {columns.map(col => {
                  const isActive = sortCol === col.name
                  return (
                    <button key={col.name} className="row" onClick={() => { toggleSort(col.name); setSortMenuOpen(false) }}
                      style={{ width: '100%', justifyContent: 'space-between', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: isActive ? 'var(--accent-soft)' : 'transparent', color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                      <span className="ell">{col.name}</span>
                      {isActive && <Icon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size={13} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <button className="icon-btn bare" title={t('dbviews.refresh')} disabled={refreshing} onClick={refresh}>
            <Icon name="refresh-cw" size={15} style={refreshing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
          </button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <div ref={exportMenuRef} style={{ position: 'relative' }}>
            <Btn size="sm" variant="secondary" icon="download" iconR="chevron-down"
              onClick={() => { setExportMenuOpen(o => !o); setSortMenuOpen(false) }}>{t('dbviews.export')}</Btn>
            {exportMenuOpen && (
              <div className="pop-in" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, minWidth: 120, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-window)', padding: 4 }}>
                {(['csv', 'json'] as const).map(fmt => (
                  <button key={fmt} className="row" onClick={() => exportAs(fmt)}
                    style={{ width: '100%', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                    <Icon name={fmt === 'csv' ? 'table-2' : 'file-code'} size={13} />
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* client-side filter row (toggled by the funnel button) */}
      {filterOpen && (
        <div className="row gap8" style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)' }}>
          <Icon name="filter" size={13} style={{ color: 'var(--text-faint)' }} />
          <input autoFocus value={filterText} onChange={e => setFilterText(e.target.value)}
            placeholder={t('dbviews.filter')}
            onKeyDown={e => { if (e.key === 'Escape') { setFilterText(''); setFilterOpen(false) } }}
            style={{ flex: 1, border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 8px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12.5, outline: 'none' }} />
          {filterActive && (
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              <b className="mono" style={{ color: 'var(--text-secondary)' }}>{filtered.length}</b> {t('dbviews.rows')}
            </span>
          )}
          <button className="icon-btn bare" style={{ width: 22, height: 22 }}
            title={t('dbviews.cancel')} onClick={() => { setFilterText(''); setFilterOpen(false) }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

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
            {canEdit && <div style={{ ...thStyle, justifyContent: 'center', borderRight: 'none' }} />}
          </div>
          {/* body */}
          {pageRows.map(({ row, origIdx }, ri) => {
            const globalIdx = (page - 1) * PAGE + ri
            const isDel = deleted.has(origIdx)
            return (
              <div key={origIdx} style={{ display: 'grid', gridTemplateColumns: gridTemplate, height: rowH, background: isDel ? 'color-mix(in srgb, var(--danger-fg) 12%, transparent)' : ri % 2 ? 'var(--surface-subtle)' : 'transparent', opacity: isDel ? 0.6 : 1, textDecoration: isDel ? 'line-through' : 'none' }}
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
                        <input autoFocus type={(() => { const ek = editorKind(col.type); return ek === 'datetime' ? 'datetime-local' : ek })()}
                          value={editVal} onChange={e => setEditVal(e.target.value)}
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
                      {isEdited && !isEditing && (
                        <button className="icon-btn bare cell-revert" style={{ width: 18, height: 18, marginLeft: 'auto', flex: 'none' }}
                          title={t('dbviews.revertCell')}
                          onClick={e => { e.stopPropagation(); revertCell(origIdx, col.name) }}>
                          <Icon name="rotate-ccw" size={12} style={{ color: 'var(--signal-amber)' }} />
                        </button>
                      )}
                    </div>
                  )
                })}
                {canEdit && (
                  <div style={{ ...tdStyle, justifyContent: 'center', borderRight: 'none', textDecoration: 'none' }}>
                    <button className="icon-btn bare" style={{ width: 22, height: 22 }}
                      title={isDel ? t('dbviews.undoDelete') : t('dbviews.deleteRow')}
                      onClick={() => toggleDelete(origIdx)}>
                      <Icon name={isDel ? 'rotate-ccw' : 'trash-2'} size={13}
                        style={{ color: isDel ? 'var(--text-faint)' : 'var(--danger-fg)' }} />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {/* pending new rows (rendered after existing rows; become INSERTs on Save) */}
          {canEdit && newRows.map(nr => {
            const r = -(nr.id + 1)
            return (
              <div key={`new-${nr.id}`} style={{ display: 'grid', gridTemplateColumns: gridTemplate, height: rowH, background: 'color-mix(in srgb, var(--signal-green) 12%, transparent)' }}
                className="gridrow">
                <div style={{ ...tdStyle, justifyContent: 'center', color: 'var(--signal-green)', fontSize: 11, background: 'var(--surface-sunken)', borderRight: '1px solid var(--border-hairline)', position: 'sticky', left: 0, zIndex: 1 }}>+</div>
                {columns.map((col, ci) => {
                  const val = nr.cells[col.name] ?? ''
                  const isEditing = editing && editing.r === r && editing.c === ci
                  return (
                    <div key={col.name} onClick={() => setSel({ r, c: ci })}
                      onDoubleClick={() => startEdit(r, ci, r, col.name, val)}
                      style={{ ...tdStyle, cursor: 'cell', background: isEditing ? 'var(--surface-card)' : 'transparent', color: 'var(--text-secondary)' }}>
                      {isEditing ? (
                        <input autoFocus type={(() => { const ek = editorKind(col.type); return ek === 'datetime' ? 'datetime-local' : ek })()}
                          value={editVal} onChange={e => setEditVal(e.target.value)}
                          onBlur={() => commitEdit(r, col.name)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEdit(r, col.name); if (e.key === 'Escape') setEditing(null) }}
                          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', font: 'inherit', color: 'var(--text-primary)' }} />
                      ) : (
                        <span className="ell" style={{ color: String(val).length ? 'var(--text-primary)' : 'var(--text-faint)' }}>{String(val).length ? String(val) : '—'}</span>
                      )}
                    </div>
                  )
                })}
                <div style={{ ...tdStyle, justifyContent: 'center', borderRight: 'none' }}>
                  <button className="icon-btn bare" style={{ width: 22, height: 22 }}
                    title={t('dbviews.removeRow')} onClick={() => removeNewRow(nr.id)}>
                    <Icon name="x" size={13} style={{ color: 'var(--text-faint)' }} />
                  </button>
                </div>
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
          {exportErr && <span className="row gap6" style={{ color: 'var(--danger-fg)' }}><Icon name="alert-triangle" size={12} /> {exportErr}</span>}
        </div>
        <div className="row gap8">
          <span className="mono" style={{ color: 'var(--signal-green)' }}>● {newCount} new</span>
          <span className="mono" style={{ color: 'var(--signal-amber)' }}>● {editedCount} edited</span>
          <span className="mono" style={{ color: 'var(--danger-fg)' }}>● {deletedCount} deleted</span>
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
