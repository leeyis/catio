/* ported from ref-ui/_extract/blob6.txt — verbatim per plan T1-T7; E3 adds edit→preview→apply + pagination */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import { previewDml, applyEdits, queryPage, tablePreview, tableQuery, exportFile, exportXlsx, dbErrMsg, type EditRequest } from '../../services/db'
import type { ResultColumn } from '../../services/types'
import { reduceCellSelection, reduceRowSelection, isCellInRange, normalizeRange, cellsInRange, type GridSelection } from './gridSelection'
import { filterRows, filterModeNeedsValue, type FilterRule, type FilterMode } from './gridFilter'
import { buildInsertSql, buildUpdateSql } from './copySql'
import { buildMarkdownTable } from './markdownTable'
import { visibleColumnNames, allNullColumnNames, toggleColumnVisibility, showAllColumns } from './columnVisibility'
import { dialectFor } from './structureDdl'
import { supportsServerFilter } from './serverFilter'
import { clauseSuggest, applyClauseItem, type ClauseMode, type ClauseSuggest, type ClauseItem } from './clauseComplete'
import { TableImportDialog } from './TableImportDialog'

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
  /** Connection engine string → drives identifier quoting dialect for "复制为 SQL". */
  engine?: string
  /** Base SQL re-run for server-side pagination (when connId is set, legacy raw-SQL path). */
  sql?: string
  /** Default database/schema namespace to reuse when paginating an ad-hoc query. */
  defaultNamespace?: string
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

/** Render a cell value as display text. Nested documents/arrays (MongoDB
 *  sub-docs, Postgres JSON columns) are JSON-encoded instead of becoming the
 *  useless "[object Object]" that `String(obj)` yields. */
function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

/** Full-content text for the cell viewer: objects/arrays pretty-printed, JSON
 *  strings re-indented, everything else as-is. */
function prettyCell(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  }
  const s = String(v)
  const t = s.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.stringify(JSON.parse(t), null, 2) } catch { /* not JSON — show raw */ }
  }
  return s
}

/** Truncate to `n` chars, appending an ellipsis when clipped. */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 文本整体是否为一个可点击的 http(s) URL（行明细里把它渲染成链接）。 */
function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim())
}

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

export function DataGrid({ columns, rows, statusTones = {}, density = 'comfortable', writable = true, connId, table = 'orders', schema, engine, sql, defaultNamespace, livePreview, onRefresh, truncated, loadError, resultLabel, rowKeys, keyColumn }: DataGridProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState({ r: 2, c: 3 })
  // 多选状态（叠加在单选之上）：单元格矩形 anchor/focus + 行多选集合（origIdx）。
  // 纯函数 reduce* 负责把点击事件归约为新选择，组件只持有状态。
  const [gridSel, setGridSel] = useState<GridSelection>({ anchor: null, focus: null, rows: new Set() })
  const lastRowRef = useRef<number | null>(null)
  // 右键上下文菜单：屏幕坐标 + 触发处的列下标（用于批量编辑写哪一列）。null=关闭。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; col: number } | null>(null)
  // 批量编辑对话框：开关 + 输入值。
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkVal, setBulkVal] = useState('')
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
  // 表数据导入对话框开关。仅在「真实可写单表」(livePreview + writable + connId + table) 时可用。
  const [importOpen, setImportOpen] = useState(false)
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
  // 列级结构化筛选规则(8 种操作符 + AND/OR)。叠加在全局文本搜索之上,二者同时生效。
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const filterRuleSeq = useRef(0)
  // 服务端 WHERE / ORDER BY(对齐 dbx 的 whereFilterInput/orderByInput):输入框文本 +
  // 已提交生效的片段。提交后经 tableQuery 重新取数;客户端文本搜索/列筛选仍叠加在其上。
  const [whereInput, setWhereInput] = useState('')
  const [orderInput, setOrderInput] = useState('')
  const [serverWhere, setServerWhere] = useState('')
  const [serverOrder, setServerOrder] = useState('')
  // WHERE/ORDER BY 输入框的字段/关键字候选下拉:记录当前活跃输入框 + 候选(光标处 token)。
  const whereRef = useRef<HTMLInputElement>(null)
  const orderRef = useRef<HTMLInputElement>(null)
  const [clause, setClause] = useState<{ which: ClauseMode; sug: ClauseSuggest } | null>(null)
  const clauseRef = (which: ClauseMode) => (which === 'where' ? whereRef : orderRef)
  // 按当前输入框光标位置刷新候选(focus/输入/点击/方向键时调用)。
  function refreshClause(which: ClauseMode, el: HTMLInputElement | null) {
    if (!el) return
    setClause({ which, sug: clauseSuggest(el.value, el.selectionStart ?? el.value.length, colNames, which) })
  }
  // 选中候选:替换光标处 token,刷新输入框值并把光标移到插入末尾,再重算候选。
  function pickClause(item: ClauseItem) {
    if (!clause) return
    const which = clause.which
    const cur = which === 'where' ? whereInput : orderInput
    const { value, cursor } = applyClauseItem(cur, clause.sug, item)
    ;(which === 'where' ? setWhereInput : setOrderInput)(value)
    requestAnimationFrame(() => {
      const el = clauseRef(which).current
      if (el) { el.focus(); el.setSelectionRange(cursor, cursor); refreshClause(which, el) }
    })
  }
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  // 列显隐：隐藏的列名集合(仅影响网格渲染,排序/筛选/导出仍按完整列集)。
  // 与 colWidths 同理,DataGrid 带 key 重挂载即重置,满足「每表 tab 独立」。
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set())
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)
  // preview gate
  const [preview, setPreview] = useState<{ reqs: EditRequest[]; sql: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState<string | null>(null)
  const [applyErr, setApplyErr] = useState<string | null>(null)
  // Full-content viewer for a long/nested cell value (opened from the status bar).
  const [cellViewer, setCellViewer] = useState<{ label: string; text: string } | null>(null)
  // 列宽（列名→像素宽，仅会话内存）；首屏由启发式宽度填充，用户拖动后覆盖。
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  // 表头显示模式:false=英文列名(默认),true=列注释。本地状态;DataGrid 带 key={schema.table}
  // → 切表/关 tab 重新挂载即重置,满足「每个表 tab 独立、不记忆」。
  const [commentMode, setCommentMode] = useState(false)
  // 单元格复制成功后的短暂提示（约 1.5s 后清除）。
  const [copied, setCopied] = useState(false)
  // 行明细查看：当前展开行在 pageRows 中的显示下标（null=未打开）；支持当前页内上/下条切换。
  const [detailIdx, setDetailIdx] = useState<number | null>(null)
  const rowH = density === 'compact' ? 30 : 36
  const PAGE = pageSize

  // 单列的启发式初始宽度（沿用原 gridTemplate 的写死宽度）。
  function heuristicWidth(name: string): number {
    if (name === 'channel' || name === 'currency') return 92
    if (name === 'created_at' || name === 'updated_at' || name === 'customer_id') return 150
    return 160
  }

  // 列变化时补齐缺失列的初始宽度，不覆盖用户已拖动的列。
  useEffect(() => {
    setColWidths(prev => {
      let changed = false
      const next = { ...prev }
      for (const c of columns) {
        if (next[c.name] === undefined) { next[c.name] = heuristicWidth(c.name); changed = true }
      }
      return changed ? next : prev
    })
  }, [columns])

  // The pk column(s) of the result — needed to safely key UPDATEs. Empty → not editable per-row.
  const pkCols = useMemo(() => columns.filter(c => c.pk).map(c => c.name), [columns])
  // 是否存在任一非空注释 → 决定切换按钮显隐。仅表预览会填 comment,故 SQL 查询结果无此按钮。
  const hasComments = useMemo(() => columns.some(c => !!c.comment), [columns])
  // 列显隐计算:全部列名 → 可见列名(剔除 hiddenCols,且至少留一列)→ 渲染用的可见列对象。
  const colNames = useMemo(() => columns.map(c => c.name), [columns])
  const visibleNames = useMemo(() => visibleColumnNames(colNames, hiddenCols), [colNames, hiddenCols])
  const visibleColumns = useMemo(() => {
    const set = new Set(visibleNames)
    return columns.filter(c => set.has(c.name))
  }, [columns, visibleNames])
  // 表头展示文案:注释模式优先显示该列注释,无注释的列回退到英文名;否则始终英文名。
  function headLabel(col: ResultColumn): string { return commentMode && col.comment ? col.comment : col.name }
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

  // 列名 → 列下标(供结构化筛选求值)。
  const colIndexOf = useMemo(() => {
    const map = new Map(columns.map((c, i) => [c.name, i]))
    return (name: string) => (map.has(name) ? map.get(name)! : -1)
  }, [columns])

  // Client-side text filter: keep rows where ANY cell's string value contains the
  // (case-insensitive) filter text. Then apply the column-level structured rules
  // (8 operators + AND/OR) on top. Empty / closed filter + no rules → all rows.
  const filtered = useMemo(() => {
    const q = filterOpen ? filterText.trim().toLowerCase() : ''
    let out = tagged
    if (q) {
      out = out.filter(({ row }) =>
        row.some(v => v != null && String(v).toLowerCase().includes(q)),
      )
    }
    if (filterOpen && filterRules.length > 0) {
      // filterRows 作用在裸行上;用 origIdx 映射回 tagged 条目以保留稳定 key。
      const kept = new Set(filterRows(out.map(e => e.row), filterRules, colIndexOf))
      out = out.filter(e => kept.has(e.row))
    }
    return out
  }, [tagged, filterOpen, filterText, filterRules, colIndexOf])

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
  // 有完整的结构化规则(列名 + 需值则有值)时也算筛选生效。
  const hasActiveRules = useMemo(
    () => filterRules.some(r => r.columnName && (!filterModeNeedsValue(r.mode) || r.rawValue.trim().length > 0)),
    [filterRules],
  )
  const filterActive = filterOpen && (filterText.trim().length > 0 || hasActiveRules)
  const pageRows = (serverRows || filterActive) ? sorted : sorted.slice((page - 1) * PAGE, page * PAGE)
  const pages = serverRows ? page + (serverTruncated ? 1 : 0) : Math.max(1, Math.ceil(filtered.length / PAGE))
  const showTruncated = serverRows ? serverTruncated : !!truncated

  // ---- 行明细查看 ----
  // 当前展开行的数据(按 pageRows 显示下标取)与显示行号；上一条/下一条仅在当前页内移动。
  const detailEntry = detailIdx != null ? pageRows[detailIdx] : null
  const detailNumber = detailIdx != null ? (page - 1) * PAGE + detailIdx + 1 : 0
  function detailPrev() { setDetailIdx(i => (i != null && i > 0 ? i - 1 : i)) }
  function detailNext() { setDetailIdx(i => (i != null && i < pageRows.length - 1 ? i + 1 : i)) }
  // 明细弹窗打开时支持键盘：Esc 关闭、↑ 上一条、↓ 下一条。
  useEffect(() => {
    if (detailIdx == null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDetailIdx(null)
      else if (e.key === 'ArrowUp') { e.preventDefault(); setDetailIdx(i => (i != null && i > 0 ? i - 1 : i)) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setDetailIdx(i => (i != null && i < pageRows.length - 1 ? i + 1 : i)) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detailIdx, pageRows.length])

  // Fetch one server page. Prefer the dialect-correct tablePreview (schema/table)
  // when the parent opts in via `livePreview`; else fall back to the raw-SQL queryPage.
  const fetchPage = useMemo(() => {
    if (connId && livePreview) {
      // 服务端 WHERE/ORDER BY 任一非空 → 走 tableQuery 按条件+排序重新取数;否则回落
      // tablePreview(无条件全量,且覆盖 mongo/redis/es 等非 SQL 引擎)。
      const hasServerFilter = serverWhere.trim().length > 0 || serverOrder.trim().length > 0
      if (hasServerFilter) {
        return (limit: number, offset: number) =>
          tableQuery(connId, schema, table, serverWhere.trim() || undefined, serverOrder.trim() || undefined, limit, offset)
      }
      return (limit: number, offset: number) => tablePreview(connId, schema, table, limit, offset)
    }
    if (connId && sql) {
      return (limit: number, offset: number) => queryPage(connId, sql, limit, offset, defaultNamespace)
    }
    return null
  }, [connId, livePreview, sql, schema, table, defaultNamespace, serverWhere, serverOrder])

  // Apply a freshly-fetched server page. The Postgres live preview ALWAYS returns a
  // leading `__ctid` system column (for EVERY table, PK or not) — the parent strips
  // it from the displayed `columns`, so we must strip it from server-fetched rows
  // too, or the values shift one column left of their headers. Detect it from the
  // fetched columns rather than from `keyColumn` (which is only set for PK-less
  // tables); capture its values as the per-row keys for ctid-based editing.
  function applyServerPage(res: { columns?: ResultColumn[]; rows: unknown[][]; truncated?: boolean }) {
    const hasCtid = res.columns?.[0]?.name === '__ctid'
    if (hasCtid) {
      setServerRowKeys(res.rows.map(r => String(r[0])))
      setServerRows(res.rows.map(r => r.slice(1)))
    } else {
      setServerRowKeys(null)
      setServerRows(res.rows)
    }
    setServerTruncated(!!res.truncated)
  }

  async function gotoPage(next: number) {
    if (next < 1) return
    setDetailIdx(null) // 翻页关闭行明细（其上一条/下一条按当前页定义）
    if (fetchPage) {
      const res = await fetchPage(PAGE, (next - 1) * PAGE)
      applyServerPage(res)
      setPage(next)
    } else {
      setPage(Math.min(pages, Math.max(1, next)))
    }
  }

  // 提交服务端 WHERE / ORDER BY:固化当前输入框文本为生效片段,从首页(offset=0)按
  // 条件+排序重新取数。任一片段非空 → tableQuery;两者皆空 → 回落 tablePreview(全量)。
  // 直接用提交值构造取数闭包,避免 setState 后 fetchPage memo 尚未刷新导致读到旧片段。
  async function submitServerFilter() {
    if (!(connId && livePreview)) return
    setClause(null)
    const w = whereInput.trim()
    const o = orderInput.trim()
    setServerWhere(w)
    setServerOrder(o)
    setDetailIdx(null)
    setPage(1)
    const fetcher = (w || o)
      ? (limit: number, offset: number) => tableQuery(connId, schema, table, w || undefined, o || undefined, limit, offset)
      : (limit: number, offset: number) => tablePreview(connId, schema, table, limit, offset)
    const res = await fetcher(PAGE, 0)
    applyServerPage(res)
  }

  function changePageSize(v: string) {
    const n = Number(v)
    setDetailIdx(null)
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

  // --- 列显隐 -------------------------------------------------------------
  // 当前已加载行中整列为空(null/undefined)的列名,供「隐藏空列」一键操作。
  const nullColNames = useMemo(() => allNullColumnNames(colNames, baseRows), [colNames, baseRows])
  function toggleColumn(name: string) {
    setHiddenCols(prev => toggleColumnVisibility(colNames, prev, name))
  }
  // 一键隐藏全部空列:逐列切换以复用「至少留一列可见」的防御。
  function hideNullColumns() {
    setHiddenCols(prev => {
      let next = prev
      for (const name of nullColNames) {
        if (!next.has(name)) next = toggleColumnVisibility(colNames, next, name)
      }
      return next
    })
  }
  function resetColumns() { setHiddenCols(showAllColumns()) }

  // --- 列级结构化筛选规则管理 ----------------------------------------------
  function addFilterRule() {
    const id = `r${filterRuleSeq.current++}`
    setFilterRules(rs => [
      ...rs,
      { id, columnName: columns[0]?.name ?? '', mode: 'equals', rawValue: '', conjunction: 'AND' },
    ])
  }
  function updateFilterRule(id: string, patch: Partial<FilterRule>) {
    setFilterRules(rs => rs.map(r => {
      if (r.id !== id) return r
      const next = { ...r, ...patch }
      // 切到无需值的操作符(is-null/is-not-null)时清空已填的值。
      if (patch.mode && !filterModeNeedsValue(next.mode)) next.rawValue = ''
      return next
    }))
  }
  function removeFilterRule(id: string) {
    setFilterRules(rs => rs.filter(r => r.id !== id))
  }
  function clearFilterRules() { setFilterRules([]) }
  // 操作符下拉项:值 → i18n key。
  const filterModeOptions: { value: FilterMode; labelKey: string }[] = [
    { value: 'equals', labelKey: 'dbviews.filterModeEquals' },
    { value: 'not-equals', labelKey: 'dbviews.filterModeNotEquals' },
    { value: 'like', labelKey: 'dbviews.filterModeContains' },
    { value: 'not-like', labelKey: 'dbviews.filterModeNotContains' },
    { value: 'greater-than', labelKey: 'dbviews.filterModeGreaterThan' },
    { value: 'less-than', labelKey: 'dbviews.filterModeLessThan' },
    { value: 'is-null', labelKey: 'dbviews.filterModeIsNull' },
    { value: 'is-not-null', labelKey: 'dbviews.filterModeIsNotNull' },
  ]

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
    const s = cellText(v)
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

  // Build the export text (CSV / JSON / SQL) from the CURRENTLY displayed rows
  // (after filter + sort) and columns. SQL reuses the same INSERT builder as the
  // grid's "copy as SQL" path (copySql.buildInsertSql), so escaping/quoting stays
  // consistent with single-row edits (dml.rs::build_insert).
  function buildExport(format: 'csv' | 'json' | 'sql' | 'md'): { text: string; type: string } {
    const displayRows = pageRows.map(({ row }) => row)
    if (format === 'sql') {
      const colNames = columns.map(c => c.name)
      const sql = buildInsertSql(displayRows, table, colNames, dialectFor(engine), schema)
      return { text: sql, type: 'text/plain' }
    }
    if (format === 'md') {
      const md = buildMarkdownTable(columns.map(c => c.name), displayRows)
      return { text: md, type: 'text/markdown' }
    }
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
  async function exportAs(format: 'csv' | 'json' | 'sql' | 'md' | 'xlsx') {
    setExportMenuOpen(false)
    setExportErr(null)
    // XLSX 是二进制:由后端构建字节并写盘,不把字节当字符串过 IPC。
    if (format === 'xlsx') {
      if (!isTauri()) {
        setExportErr(t('dbviews.applyError', { message: 'XLSX export requires the desktop app' }))
        return
      }
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({
          defaultPath: 'export.xlsx',
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        })
        if (path) {
          const displayRows = pageRows.map(({ row }) => row)
          await exportXlsx({ columns: columns.map(c => c.name), rows: displayRows, sheetName: table, path })
        }
      } catch (e) {
        setExportErr(t('dbviews.applyError', { message: dbErrMsg(e) }))
      }
      return
    }
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
    setEditing({ r: rIdx, c: cIdx }); setEditVal(toEditorValue(kind, cellText(val))); setSel({ r: rIdx, c: cIdx })
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
  // --- 多选 + 右键菜单 + 批量编辑 -------------------------------------------
  // 行号单元格点击：用 reduceRowSelection 归约（按显示下标 ri 计算范围/集合），
  // 记录 lastRow 供 shift 范围使用。普通左键单格选择仍由各单元格的 onClick 处理。
  function onRowSelect(ri: number, e: React.MouseEvent) {
    e.stopPropagation()
    // lastRow 必须在 setGridSel 之前快照：updater 闭包是延迟执行的，若在其内部读 ref，
    // 会读到本函数末尾刚被改写的新值（=ri），导致 shift 范围塌缩成单格。
    const lastRow = lastRowRef.current
    setGridSel(prev => reduceRowSelection(prev, ri, { lastRow }, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }))
    lastRowRef.current = ri
  }
  // 单元格左键：在保留原单选（setSel by origIdx）之外，更新矩形选择（按显示下标 ri）。
  function onCellSelect(ri: number, ci: number, origIdx: number, e: React.MouseEvent) {
    setSel({ r: origIdx, c: ci })
    setGridSel(prev => reduceCellSelection(prev, ri, ci, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }))
    lastRowRef.current = ri
  }
  // 右键单元格：若该单元格不在当前选择内，则先把它选为单格，再弹菜单。
  function onCellContext(ri: number, ci: number, origIdx: number, e: React.MouseEvent) {
    e.preventDefault()
    const range = gridSel.anchor && gridSel.focus ? normalizeRange(gridSel.anchor, gridSel.focus) : null
    const inCellSel = isCellInRange(ri, ci, range)
    const inRowSel = gridSel.rows.has(ri)
    if (!inCellSel && !inRowSel) {
      setSel({ r: origIdx, c: ci })
      setGridSel({ anchor: { r: ri, c: ci }, focus: { r: ri, c: ci }, rows: new Set() })
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, col: ci })
  }
  // 单元格的「显示值」文本：有 pending edit 则取 edits，否则取原始 row 值。
  // codex P2-2：复制必须反映用户改动后的值，与网格显示一致。
  function displayCellText(origIdx: number, ci: number, raw: unknown): string {
    const col = columns[ci]
    if (!col) return cellText(raw)
    const k = cellKey(origIdx, col.name)
    return cellText(edits[k] !== undefined ? edits[k] : raw)
  }
  // 菜单「复制」：行多选 > 单元格矩形 > 单格回显，依次取值并按 TSV 拼接。
  function ctxCopy() {
    setCtxMenu(null)
    let text: string
    if (gridSel.rows.size > 0) {
      // codex P2-3：行多选场景，按选中行（显示顺序）拼接整行所有列的 TSV，
      // 而非 fallback 到与选择无关的上一次单格回显。
      const sortedRows = [...gridSel.rows].sort((a, b) => a - b)
      const lines: string[] = []
      for (const r of sortedRows) {
        const entry = pageRows[r]
        if (!entry) continue
        const parts = columns.map((_, c) => displayCellText(entry.origIdx, c, entry.row[c]))
        lines.push(parts.join('\t'))
      }
      text = lines.join('\n')
    } else if (cellsInRange(gridSel).length > 1) {
      const { r0, r1, c0, c1 } = normalizeRange(gridSel.anchor!, gridSel.focus!)
      const lines: string[] = []
      for (let r = r0; r <= r1; r++) {
        const entry = pageRows[r]
        if (!entry) continue
        const parts: string[] = []
        // 矩形按完整列下标记录,跨越的隐藏列不应混入复制内容(与网格显示一致)。
        for (let c = c0; c <= c1; c++) {
          const col = columns[c]
          if (col && hiddenCols.has(col.name)) continue
          parts.push(displayCellText(entry.origIdx, c, entry.row[c]))
        }
        lines.push(parts.join('\t'))
      }
      text = lines.join('\n')
    } else {
      text = selCell?.full ?? ''
    }
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  // 选中的行集合（按 origIdx）：行多选优先；否则取单元格矩形覆盖的各行。
  function selectedOrigIdxs(): number[] {
    const out = new Set<number>()
    if (gridSel.rows.size > 0) {
      for (const ri of gridSel.rows) { const e = pageRows[ri]; if (e) out.add(e.origIdx) }
    } else if (gridSel.anchor && gridSel.focus) {
      const { r0, r1 } = normalizeRange(gridSel.anchor, gridSel.focus)
      for (let r = r0; r <= r1; r++) { const e = pageRows[r]; if (e) out.add(e.origIdx) }
    }
    return [...out]
  }
  // 菜单「删除选中行」：把选中行（origIdx）并入 pending-delete 集合。
  function ctxDeleteRows() {
    setCtxMenu(null)
    const idxs = selectedOrigIdxs()
    if (idxs.length === 0) return
    setDeleted(d => { const next = new Set(d); for (const i of idxs) next.add(i); return next })
  }
  // 菜单「批量编辑」打开对话框。
  function ctxBulkEdit() { setCtxMenu(null); setBulkVal(''); setBulkOpen(true) }

  // 收集选中行的「显示值」矩阵(行多选 > 单元格矩形覆盖到的整行),按 columns 顺序对齐,
  // 取用户改动后的值(与网格显示一致)。供「复制为 SQL」生成 INSERT/UPDATE。
  function selectedRowValues(): unknown[][] {
    return selectedOrigIdxs().map(origIdx => {
      const entry = tagged.find(e => e.origIdx === origIdx)
      return columns.map((col, ci) => {
        if (!entry) return null
        const k = cellKey(origIdx, col.name)
        return edits[k] !== undefined ? edits[k] : entry.row[ci]
      })
    })
  }
  // 菜单「复制为 SQL INSERT / UPDATE」:把选中行渲染成 SQL 写入剪贴板。
  function ctxCopySql(kind: 'insert' | 'update') {
    setCtxMenu(null)
    const data = selectedRowValues()
    if (data.length === 0) return
    const dialect = dialectFor(engine)
    const colNames = columns.map(c => c.name)
    // PK-less 表(ctid 路径):pkCols 为空,需用 keyColumn + 逐行 activeRowKeys 作伪主键定位,
    // 否则 UPDATE 退化为无 WHERE 的全表更新。key 值与 selectedRowValues() 同序(都来自 selectedOrigIdxs)。
    const keyOverride = pkCols.length === 0 && keyColumn && activeRowKeys
      ? { column: keyColumn, values: selectedOrigIdxs().map(origIdx => activeRowKeys[origIdx]) }
      : undefined
    const text = kind === 'insert'
      ? buildInsertSql(data, table, colNames, dialect, schema)
      : buildUpdateSql(data, table, colNames, dialect, schema, pkCols, keyOverride)
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  // 当前选中单元格数（用于菜单/对话框文案 + 决定批量编辑可用性）。
  const selectedCellCount = useMemo(() => cellsInRange(gridSel).length, [gridSel])
  // 把同一个值写入选中矩形的每个单元格（仅现有行；走 edits 的变更检测，与单格编辑一致）。
  function applyBulkEdit() {
    if (!gridSel.anchor || !gridSel.focus) { setBulkOpen(false); return }
    const { r0, r1, c0, c1 } = normalizeRange(gridSel.anchor, gridSel.focus)
    setEdits(prev => {
      const next = { ...prev }
      for (let r = r0; r <= r1; r++) {
        const entry = pageRows[r]
        if (!entry || entry.origIdx < 0) continue
        for (let c = c0; c <= c1; c++) {
          const col = columns[c]
          if (!col) continue
          // 矩形跨越的隐藏列不应被批量编辑(与网格显示一致)。
          if (hiddenCols.has(col.name)) continue
          const k = cellKey(entry.origIdx, col.name)
          const orig = entry.row[c]
          if (bulkVal === String(orig ?? '')) { delete next[k] }
          else next[k] = bulkVal
        }
      }
      return next
    })
    setBulkOpen(false)
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
    if (!sortMenuOpen && !exportMenuOpen && !colMenuOpen) return
    function onDocClick(e: MouseEvent) {
      const tgt = e.target as Node
      if (sortMenuOpen && sortMenuRef.current && !sortMenuRef.current.contains(tgt)) setSortMenuOpen(false)
      if (exportMenuOpen && exportMenuRef.current && !exportMenuRef.current.contains(tgt)) setExportMenuOpen(false)
      if (colMenuOpen && colMenuRef.current && !colMenuRef.current.contains(tgt)) setColMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sortMenuOpen, exportMenuOpen, colMenuOpen])

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
  // The trailing action column now exists ONLY to host the remove-X on pending
  // new rows. Existing-row deletion moved to the toolbar (删除行), so per-row
  // trash icons are gone; the column collapses entirely when there are no new rows.
  const showActionCol = canEdit && newRows.length > 0
  // Toolbar table chip: live path uses the real schema/table (no bogus `public.`);
  // mock/demo path keeps the original `public.orders` label for pixel parity.
  const toolbarLabel = resultLabel ?? (connId ? (schema ? `${schema}.${table}` : table) : 'public.orders')
  // Row count shown in the toolbar: when a filter is active, reflect the filtered
  // count; otherwise live path reflects the loaded page rows, mock keeps rows.length.
  const rowCount = filterActive ? filtered.length : (connId ? baseRows.length : rows.length)
  // Fixed per-column widths so the row is exactly as wide as the sum of its
  // columns and the grid scrolls horizontally — no flex/1fr stretch that would
  // blow up a couple of columns to fill the viewport and hide the rest.
  const gridTemplate = '46px ' + visibleColumns.map(c => (colWidths[c.name] ?? heuristicWidth(c.name)) + 'px').join(' ') + (showActionCol ? ' 44px' : '')

  // 列宽拖动：在 document 上挂 mousemove/mouseup，避免鼠标移出表头丢事件；
  // 拖动期间根据 clientX 位移动态更新该列宽度，最小 60px。
  function startResize(e: React.MouseEvent, name: string) {
    e.stopPropagation() // 避免触发该列的排序 toggleSort
    e.preventDefault()
    const startX = e.clientX
    const startW = colWidths[name] ?? heuristicWidth(name)
    function onMove(ev: MouseEvent) {
      const w = Math.max(60, startW + (ev.clientX - startX))
      setColWidths(prev => ({ ...prev, [name]: w }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // 单元格 Ctrl+C 复制：编辑态（input 聚焦）不拦截，走浏览器默认。
  function onGridKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selCell) {
      e.preventDefault()
      navigator.clipboard?.writeText(selCell.full).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }).catch(() => {})
    }
  }

  // The currently-selected cell's value (for the status-bar preview + viewer).
  const selCell = (() => {
    const entry = sorted.find(e => e.origIdx === sel.r)
    const col = columns[sel.c]
    if (!entry || !col) return null
    const k = cellKey(sel.r, col.name)
    const raw = edits[k] !== undefined ? edits[k] : entry.row[sel.c]
    return { label: col.name, raw, full: cellText(raw) }
  })()

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
          {/* edit actions as compact icons w/ hover tooltips (新增行/删除行/撤销/保存) */}
          {canEdit && (
            <>
              <button className="icon-btn bare" title={t('dbviews.addRow')} onClick={addRow}><Icon name="plus" size={15} /></button>
              <button className="icon-btn bare" title={t('dbviews.deleteRow')} onClick={() => toggleDelete(sel.r)}><Icon name="trash-2" size={15} /></button>
              {pendingTotal > 0 && <button className="icon-btn bare" title={t('dbviews.discardChanges')} onClick={discardChanges}><Icon name="rotate-ccw" size={15} /></button>}
              {pendingTotal > 0 && <button className="icon-btn bare" title={t('dbviews.saveEdits')} onClick={openPreview} style={{ color: 'var(--accent-primary)' }}><Icon name="save" size={15} /></button>}
              <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
            </>
          )}
          {/* 列名/注释切换:仅当存在任一非空注释时出现(天然限定在表预览) */}
          {hasComments && (
            <button className="icon-btn bare" data-active={commentMode ? '1' : undefined}
              title={commentMode ? t('dbviews.showColumnNames') : t('dbviews.showComments')}
              onClick={() => setCommentMode(m => !m)}><Icon name="message-square" size={15} /></button>
          )}
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
          {/* 列显隐：眼睛图标下拉,逐列勾选 + 隐藏空列 + 显示全部列 */}
          <div ref={colMenuRef} style={{ position: 'relative' }}>
            <button className="icon-btn bare" title={t('dbviews.columnVisibility')} data-active={colMenuOpen || hiddenCols.size > 0 ? '1' : undefined}
              onClick={() => { setColMenuOpen(o => !o); setSortMenuOpen(false); setExportMenuOpen(false) }}><Icon name="eye" size={15} /></button>
            {colMenuOpen && (
              <div className="pop-in" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, minWidth: 200, maxHeight: 360, overflow: 'auto', background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-window)', padding: 4 }}>
                {columns.map(col => {
                  const isVisible = !hiddenCols.has(col.name)
                  return (
                    <button key={col.name} role="menuitemcheckbox" aria-checked={isVisible} className="row"
                      onClick={() => toggleColumn(col.name)}
                      style={{ width: '100%', justifyContent: 'flex-start', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: isVisible ? 'var(--text-secondary)' : 'var(--text-faint)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                      <Icon name={isVisible ? 'eye' : 'eye-off'} size={13} style={{ flex: 'none', color: isVisible ? 'var(--accent-primary)' : 'var(--text-faint)' }} />
                      <span className="ell">{col.name}</span>
                    </button>
                  )
                })}
                <div style={{ height: 1, background: 'var(--border-hairline)', margin: '4px 0' }} />
                <button className="row" disabled={nullColNames.length === 0}
                  onClick={() => { hideNullColumns() }}
                  style={{ width: '100%', justifyContent: 'flex-start', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: nullColNames.length === 0 ? 'var(--text-faint)' : 'var(--text-secondary)', cursor: nullColNames.length === 0 ? 'default' : 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                  <Icon name="eye-off" size={13} style={{ flex: 'none' }} />
                  {nullColNames.length === 0 ? t('dbviews.noNullColumns') : t('dbviews.hideNullColumns')}
                </button>
                {hiddenCols.size > 0 && (
                  <button className="row" onClick={() => { resetColumns(); setColMenuOpen(false) }}
                    style={{ width: '100%', justifyContent: 'flex-start', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                    <Icon name="eye" size={13} style={{ flex: 'none' }} />
                    {t('dbviews.showAllColumns')}
                  </button>
                )}
              </div>
            )}
          </div>
          <button className="icon-btn bare" title={t('dbviews.refresh')} disabled={refreshing} onClick={refresh}>
            <Icon name="refresh-cw" size={15} style={refreshing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
          </button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          {livePreview && writable && connId && table && (
            <Btn size="sm" variant="secondary" icon="upload" onClick={() => setImportOpen(true)}>{t('dbviews.import')}</Btn>
          )}
          <div ref={exportMenuRef} style={{ position: 'relative' }}>
            <Btn size="sm" variant="secondary" icon="download" iconR="chevron-down"
              onClick={() => { setExportMenuOpen(o => !o); setSortMenuOpen(false) }}>{t('dbviews.export')}</Btn>
            {exportMenuOpen && (
              <div className="pop-in" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, minWidth: 120, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-window)', padding: 4 }}>
                {([
                  { fmt: 'csv', icon: 'table-2', label: 'CSV' },
                  { fmt: 'json', icon: 'file-code', label: 'JSON' },
                  { fmt: 'sql', icon: 'database', label: 'SQL' },
                  { fmt: 'xlsx', icon: 'layout-grid', label: 'Excel' },
                  { fmt: 'md', icon: 'file-code', label: 'Markdown' },
                ] as const).map(({ fmt, icon, label }) => (
                  <button key={fmt} className="row" onClick={() => exportAs(fmt)}
                    style={{ width: '100%', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                    <Icon name={icon} size={13} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 服务端 WHERE / ORDER BY(仅真实表预览):输入 SQL 片段,提交后按条件+排序重新
          取数(大表也能筛全表,而非仅当前页)。客户端文本搜索/列筛选仍叠加在结果之上。
          非 SQL 引擎(MongoDB/Redis/Elasticsearch)隐藏此条 —— 后端 db_table_query 对它们
          返回 Unsupported,暴露输入框只会让用户提交后撞上误导性报错(codex 阻断项[P2])。 */}
      {livePreview && connId && supportsServerFilter(engine) && (
        <div className="row" style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', gap: 8 }}>
          {([
            { which: 'where' as ClauseMode, value: whereInput, set: setWhereInput, ref: whereRef, label: 'WHERE', aria: 'dbviews.whereClause' },
            { which: 'order' as ClauseMode, value: orderInput, set: setOrderInput, ref: orderRef, label: 'ORDER BY', aria: 'dbviews.orderByClause' },
          ]).map(({ which, value, set, ref, label, aria }) => (
            <div key={which} className="row gap6" style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', flex: 'none' }}>{label}</span>
              {/* relative 容器:候选下拉绝对定位在输入框下方。支持字段名拖入 + 字段/关键字候选。 */}
              <div className="col" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                <input ref={ref} value={value}
                  onChange={e => { set(e.target.value); refreshClause(which, e.currentTarget) }}
                  onFocus={e => refreshClause(which, e.currentTarget)}
                  onClick={e => refreshClause(which, e.currentTarget)}
                  onBlur={() => setTimeout(() => setClause(c => (c && c.which === which ? null : c)), 120)}
                  placeholder={label} aria-label={t(aria)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { setClause(null); submitServerFilter() }
                    else if (e.key === 'Escape') setClause(null)
                  }}
                  className="mono"
                  style={{ width: '100%', minWidth: 0, border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 8px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, outline: 'none' }} />
                {clause?.which === which && clause.sug.items.length > 0 && (
                  <div className="pop-in" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 70, minWidth: 180, maxHeight: 220, overflowY: 'auto', background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 8, boxShadow: 'var(--shadow-window)', padding: 4 }}>
                    {clause.sug.items.slice(0, 50).map(it => (
                      <button key={it.kind + ':' + it.label} type="button"
                        onMouseDown={e => { e.preventDefault(); pickClause(it) }}
                        className="row" style={{ width: '100%', gap: 8, padding: '4px 8px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 12, color: 'var(--text-primary)', borderRadius: 6 }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-soft)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
                        <Icon name={it.kind === 'column' ? 'columns' : 'command'} size={12} style={{ color: it.kind === 'column' ? 'var(--accent-primary)' : 'var(--text-faint)', flex: 'none' }} />
                        <span className="ell mono">{it.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <Btn size="sm" variant="secondary" icon="search" onClick={submitServerFilter}>{t('dbviews.applyServerFilter')}</Btn>
        </div>
      )}

      {/* client-side filter row (toggled by the funnel button): global text search
          + column-level structured rule builder (8 operators + AND/OR) stacked under it. */}
      {filterOpen && (
        <div className="col" style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', gap: 7 }}>
          <div className="row gap8">
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
              title={t('dbviews.cancel')} onClick={() => { setFilterText(''); setFilterRules([]); setFilterOpen(false) }}>
              <Icon name="x" size={14} />
            </button>
          </div>
          {/* 列级条件构建器 */}
          <div className="col" style={{ gap: 6 }}>
            {filterRules.map((rule, idx) => (
              <div key={rule.id} className="row gap6" data-filter-rule style={{ alignItems: 'center' }}>
                {/* 第一条规则不显示逻辑连接;其后显示 AND/OR 切换 */}
                {idx === 0 ? (
                  <span style={{ width: 58, fontSize: 11.5, color: 'var(--text-faint)' }}>{t('dbviews.filterColumns')}</span>
                ) : (
                  <select aria-label="conjunction" value={rule.conjunction}
                    onChange={e => updateFilterRule(rule.id, { conjunction: e.target.value as 'AND' | 'OR' })}
                    style={{ width: 58, border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 6px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, outline: 'none' }}>
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                )}
                <select aria-label="filter-column" value={rule.columnName}
                  onChange={e => updateFilterRule(rule.id, { columnName: e.target.value })}
                  style={{ flex: '0 0 130px', border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 6px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, outline: 'none' }}>
                  {columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <select aria-label="filter-mode" value={rule.mode}
                  onChange={e => updateFilterRule(rule.id, { mode: e.target.value as FilterMode })}
                  style={{ flex: '0 0 120px', border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 6px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, outline: 'none' }}>
                  {filterModeOptions.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                </select>
                {filterModeNeedsValue(rule.mode) && (
                  <input aria-label="filter-value" value={rule.rawValue}
                    onChange={e => updateFilterRule(rule.id, { rawValue: e.target.value })}
                    placeholder={t('dbviews.filterValuePlaceholder')}
                    style={{ flex: 1, minWidth: 80, border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '4px 8px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, outline: 'none' }} />
                )}
                <button className="icon-btn bare" style={{ width: 22, height: 22 }}
                  title={t('dbviews.filterRemoveRule')} onClick={() => removeFilterRule(rule.id)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <div className="row gap6">
              <button className="icon-btn bare" data-add-filter-rule onClick={addFilterRule}
                style={{ width: 'auto', padding: '3px 8px', gap: 5, fontSize: 12, color: 'var(--accent-primary)' }}>
                <Icon name="plus" size={13} /> {t('dbviews.filterAddRule')}
              </button>
              {filterRules.length > 0 && (
                <button className="icon-btn bare" onClick={clearFilterRules}
                  style={{ width: 'auto', padding: '3px 8px', gap: 5, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {t('dbviews.filterClearRules')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* grid */}
      <div className="grow mono scrollon" tabIndex={0} onKeyDown={onGridKeyDown} style={{ overflow: 'auto', fontSize: 12.5, outline: 'none' }}>
        <div style={{ minWidth: 'max-content' }}>
          {/* header */}
          <div data-grid-header style={{ display: 'grid', gridTemplateColumns: gridTemplate, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline-alt)' }}>
            <div style={{ ...thStyle, justifyContent: 'center', color: 'var(--text-faint)', position: 'sticky', left: 0, zIndex: 3, background: 'var(--surface-subtle)' }}>#</div>
            {visibleColumns.map((col) => (
              <div key={col.name} style={{ ...thStyle, position: 'relative' }} onClick={() => toggleSort(col.name)} className="gridhead">
                <Icon name={col.icon ?? colIcon(col)} size={12} style={{ color: col.pk ? 'var(--signal-amber)' : col.fk ? 'var(--signal-blue)' : 'var(--text-faint)' }} />
                <span className="ell" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}
                  title={commentMode && col.comment ? col.comment : undefined}>{headLabel(col)}</span>
                {col.pk && <span style={{ fontSize: 9, color: 'var(--signal-amber)', fontWeight: 700 }}>PK</span>}
                {sortCol === col.name && <Icon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} style={{ color: 'var(--accent-primary)', marginLeft: 'auto' }} />}
                {/* 列宽拖动手柄：列右缘，stopPropagation 避免触发排序 */}
                <span title={t('dbviews.resizeColumnHint')} onMouseDown={e => startResize(e, col.name)} onClick={e => e.stopPropagation()}
                  style={{ position: 'absolute', top: 0, right: 0, width: 5, height: '100%', cursor: 'col-resize', zIndex: 1 }} />
              </div>
            ))}
            {showActionCol && <div style={{ ...thStyle, justifyContent: 'center', borderRight: 'none' }} />}
          </div>
          {/* body */}
          {pageRows.map(({ row, origIdx }, ri) => {
            const globalIdx = (page - 1) * PAGE + ri
            const isDel = deleted.has(origIdx)
            return (
              <div key={origIdx} style={{ display: 'grid', gridTemplateColumns: gridTemplate, height: rowH, background: isDel ? 'color-mix(in srgb, var(--danger-fg) 12%, transparent)' : ri % 2 ? 'var(--surface-subtle)' : 'transparent', opacity: isDel ? 0.6 : 1, textDecoration: isDel ? 'line-through' : 'none' }}
                className="gridrow">
                <div data-row-select onClick={e => onRowSelect(ri, e)}
                  onContextMenu={e => { e.preventDefault(); if (!gridSel.rows.has(ri)) setGridSel(reduceRowSelection({ ...gridSel }, ri, { lastRow: lastRowRef.current }, {})); setCtxMenu({ x: e.clientX, y: e.clientY, col: 0 }) }}
                  style={{ ...tdStyle, justifyContent: 'center', color: 'var(--text-faint)', fontSize: 11, background: gridSel.rows.has(ri) ? 'var(--accent-soft)' : 'var(--surface-sunken)', borderRight: '1px solid var(--border-hairline)', position: 'sticky', left: 0, zIndex: 1, cursor: 'pointer' }}>
                  {globalIdx + 1}
                  {/* 悬浮行时浮出"查看明细"按钮，居中悬浮于行号上方；点击打开该行的纵向明细弹窗。
                      codex P2-1：按钮只占图标大小（22x22）并居中定位，不再 inset:0/100% 铺满整格，
                      否则悬浮态 pointer-events:auto 会拦截「点行号选行」。剩余区域仍可点行号触发多选。 */}
                  <button className="row-detail-btn" title={t('dbviews.viewRowDetail')}
                    onClick={e => { e.stopPropagation(); setDetailIdx(ri) }}
                    style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6, padding: 0, background: 'var(--surface-sunken)', cursor: 'pointer' }}>
                    <Icon name="maximize-2" size={13} style={{ color: 'var(--accent-primary)' }} />
                  </button>
                </div>
                {visibleColumns.map((col) => {
                  // ci 取「原始列下标」(进 row/selection 坐标系),不随列显隐改变,
                  // 与右键复制/批量编辑/复制为 SQL 使用的 columns 下标保持一致。
                  const ci = colIndexOf(col.name)
                  const k = cellKey(origIdx, col.name)
                  const isEdited = edits[k] !== undefined
                  const val = isEdited ? edits[k] : row[ci]
                  const isSel = sel.r === origIdx && sel.c === ci
                  // 多选高亮：单元格落在矩形内，或该行被行多选选中。
                  const inRange = isCellInRange(ri, ci, gridSel.anchor && gridSel.focus ? normalizeRange(gridSel.anchor, gridSel.focus) : null)
                  const inMultiSel = inRange || gridSel.rows.has(ri)
                  const isEditing = editing && editing.r === origIdx && editing.c === ci
                  return (
                    <div key={col.name} onClick={e => onCellSelect(ri, ci, origIdx, e)}
                      onContextMenu={e => onCellContext(ri, ci, origIdx, e)}
                      onDoubleClick={() => startEdit(origIdx, ci, origIdx, col.name, val)}
                      style={{
                        ...tdStyle,
                        cursor: canEdit ? 'cell' : 'default',
                        background: isEditing ? 'var(--surface-card)' : isEdited ? 'color-mix(in srgb, var(--signal-amber) 14%, transparent)' : isSel ? 'var(--accent-soft-alt)' : inMultiSel ? 'var(--accent-soft)' : 'transparent',
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
                          <span className="ell" style={{ color: 'var(--text-primary)' }}>{cellText(val)}</span>
                        </span>
                      ) : col.name === 'total_cents' ? (
                        <span className="ell" style={{ color: isEdited ? 'var(--signal-amber)' : 'var(--text-primary)', fontWeight: 500, marginLeft: 'auto' }}>{Number(val).toLocaleString()}</span>
                      ) : col.name === 'id' ? (
                        <span className="ell" style={{ color: 'var(--text-tertiary)' }}>{cellText(val)}</span>
                      ) : col.name === 'customer_id' ? (
                        <span className="ell" style={{ color: 'var(--signal-blue)' }}>{cellText(val)}</span>
                      ) : (
                        <span className="ell">{cellText(val)}</span>
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
                {showActionCol && <div style={{ ...tdStyle, justifyContent: 'center', borderRight: 'none', textDecoration: 'none' }} />}
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
                {visibleColumns.map((col) => {
                  const ci = colIndexOf(col.name)
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
                        <span className="ell" style={{ color: cellText(val).length ? 'var(--text-primary)' : 'var(--text-faint)' }}>{cellText(val).length ? cellText(val) : '—'}</span>
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
          <span className="row gap6" style={{ minWidth: 0, maxWidth: 520 }}>
            <span style={{ flex: 'none' }}>{t('dbviews.cell')}:</span>
            <span className="mono ell" style={{ color: 'var(--text-secondary)', minWidth: 0 }}>{selCell ? (clip(selCell.full, 120) || '—') : '—'}</span>
            {selCell && selCell.full.length > 120 && (
              <button className="icon-btn bare" title={t('dbviews.viewFull')} style={{ width: 18, height: 18, flex: 'none' }}
                onClick={() => setCellViewer({ label: selCell.label, text: prettyCell(selCell.raw) })}>
                <Icon name="external-link" size={12} />
              </button>
            )}
          </span>
          {showTruncated && <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color: 'var(--signal-amber)', fontWeight: 600 }}>{t('dbviews.truncated')}</span>}
          {applyMsg && <span style={{ color: 'var(--signal-green)' }}>{applyMsg}</span>}
          {copied && <span style={{ color: 'var(--signal-green)' }}>{t('dbviews.cellCopied')}</span>}
          {loadError && <span className="row gap6" style={{ color: 'var(--danger-fg)' }}><Icon name="alert-triangle" size={12} /> {t('dbviews.loadError', { message: loadError })}</span>}
          {exportErr && <span className="row gap6" style={{ color: 'var(--danger-fg)' }}><Icon name="alert-triangle" size={12} /> {exportErr}</span>}
        </div>
        <div className="row gap8">
          {/* 变更计数：默认只显示彩色圆点，具体数量以 hover tooltip 展示 */}
          <span className="row" style={{ gap: 6 }}>
            <span title={t('dbviews.statNew', { count: newCount })} style={{ color: 'var(--signal-green)', cursor: 'default', fontSize: 12 }}>●</span>
            <span title={t('dbviews.statEdited', { count: editedCount })} style={{ color: 'var(--signal-amber)', cursor: 'default', fontSize: 12 }}>●</span>
            <span title={t('dbviews.statDeleted', { count: deletedCount })} style={{ color: 'var(--danger-fg)', cursor: 'default', fontSize: 12 }}>●</span>
          </span>
          <div style={{ width: 1, height: 14, background: 'var(--border-hairline)' }} />
          {/* 每页行数：下拉框 */}
          <select value={String(pageSize)} onChange={e => changePageSize(e.target.value)}
            title={t('dbviews.pageSize')} aria-label={t('dbviews.pageSize')}
            style={{ height: 24, border: '1px solid var(--border-hairline)', borderRadius: 7, background: 'var(--surface-sunken)', color: 'var(--text-secondary)', fontSize: 11.5, padding: '0 4px', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' }}>
            {[50, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
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

      {/* Cell content viewer — full value of a long/nested cell (objects pretty-printed). */}
      {cellViewer && (
        <div onClick={() => setCellViewer(null)}
          style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 620, maxWidth: '90%', maxHeight: '80%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '16px 20px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.cellContent')}</span>
                <span className="mono ell" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{cellViewer.label}</span>
              </div>
              <div className="row gap8">
                <button className="icon-btn bare" title={t('dbviews.copy')} onClick={() => navigator.clipboard?.writeText(cellViewer.text).catch(() => {})}><Icon name="copy" size={15} /></button>
                <IconBtn name="x" size={16} variant="bare" onClick={() => setCellViewer(null)} />
              </div>
            </div>
            <pre className="mono" style={{ margin: 0, padding: '14px 18px', color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.6, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{cellViewer.text}</pre>
          </div>
        </div>
      )}

      {/* 行明细 — 纵向表单展示该行全部字段；URL 文本渲染为可点击链接；支持当前页内上一条/下一条切换。
          遮罩用 position:fixed 覆盖整个控制台(含上方 SQL 编辑区)，而非仅遮住 DataGrid 所在的结果区。 */}
      {detailEntry && (
        <div onClick={() => setDetailIdx(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 640, maxWidth: '92%', maxHeight: '84%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '16px 20px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.rowDetail')}[{detailNumber}]</span>
              <div className="row gap6">
                <button className="icon-btn bare" title={t('dbviews.prevRow')} disabled={detailIdx === 0} onClick={detailPrev}><Icon name="chevron-up" size={16} /></button>
                <button className="icon-btn bare" title={t('dbviews.nextRow')} disabled={detailIdx != null && detailIdx >= pageRows.length - 1} onClick={detailNext}><Icon name="chevron-down" size={16} /></button>
                <IconBtn name="x" size={16} variant="bare" onClick={() => setDetailIdx(null)} />
              </div>
            </div>
            <div className="col scrollon" style={{ overflow: 'auto', padding: '4px 0 8px' }}>
              {columns.map((col, ci) => {
                const k = cellKey(detailEntry.origIdx, col.name)
                const raw = edits[k] !== undefined ? edits[k] : detailEntry.row[ci]
                const text = cellText(raw)
                return (
                  <div key={col.name} className="row" style={{ alignItems: 'flex-start', gap: 16, padding: '9px 22px', borderBottom: '1px solid var(--border-hairline)' }}>
                    <span className="mono" style={{ flex: 'none', width: 168, textAlign: 'right', color: 'var(--text-tertiary)', fontSize: 12, paddingTop: 1, wordBreak: 'break-word' }}>{col.name}</span>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {text === ''
                        ? <span style={{ color: 'var(--text-faint)' }}>—</span>
                        : isUrl(text)
                          ? <a href={text} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)', textDecoration: 'underline', wordBreak: 'break-all' }}>{text}</a>
                          : text}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 右键上下文菜单：复制 / 删除选中行 / 批量编辑。点击空白处或选项后关闭。 */}
      {ctxMenu && (
        <div onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }}
          style={{ position: 'fixed', inset: 0, zIndex: 80 }}>
          <div role="menu" onClick={e => e.stopPropagation()} className="pop-in"
            style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, minWidth: 180, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-window)', padding: 4 }}>
            {([
              { key: 'copy', icon: 'copy', label: t('dbviews.ctxCopy'), onClick: ctxCopy, show: true, danger: false },
              { key: 'copy-insert', icon: 'file-code', label: t('dbviews.ctxCopyInsert', { count: selectedOrigIdxs().length }), onClick: () => ctxCopySql('insert'), show: !resultLabel && selectedOrigIdxs().length > 0, danger: false },
              { key: 'copy-update', icon: 'file-code', label: t('dbviews.ctxCopyUpdate', { count: selectedOrigIdxs().length }), onClick: () => ctxCopySql('update'), show: !resultLabel && selectedOrigIdxs().length > 0, danger: false },
              { key: 'delete', icon: 'trash-2', label: t('dbviews.ctxDeleteRows', { count: selectedOrigIdxs().length }), onClick: ctxDeleteRows, show: canEdit && selectedOrigIdxs().length > 0, danger: true },
              { key: 'bulk', icon: 'pencil', label: t('dbviews.ctxBulkEdit', { count: selectedCellCount }), onClick: ctxBulkEdit, show: canEdit && selectedCellCount > 0, danger: false },
            ] as const).filter(it => it.show).map(it => (
              <button key={it.key} role="menuitem" className="row" onClick={it.onClick}
                style={{ width: '100%', gap: 8, padding: '6px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: it.danger ? 'var(--danger-fg)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
                <Icon name={it.icon} size={13} />
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 批量编辑对话框：把同一个值写入选中的所有单元格（作为 pending edits）。 */}
      {bulkOpen && (
        <div onClick={() => setBulkOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 460, maxWidth: '90%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.bulkEditTitle')}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('dbviews.bulkEditDesc', { count: selectedCellCount })}</span>
              </div>
              <IconBtn name="x" size={16} variant="bare" onClick={() => setBulkOpen(false)} />
            </div>
            <div className="col" style={{ gap: 12, padding: '16px 20px 20px' }}>
              <input autoFocus value={bulkVal} onChange={e => setBulkVal(e.target.value)}
                placeholder={t('dbviews.bulkEditPlaceholder')}
                onKeyDown={e => { if (e.key === 'Enter') applyBulkEdit(); if (e.key === 'Escape') setBulkOpen(false) }}
                style={{ border: '1px solid var(--border-hairline)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface-sunken)', color: 'var(--text-primary)', font: 'inherit', fontSize: 13, outline: 'none' }} />
              <div className="row gap8" style={{ justifyContent: 'flex-end' }}>
                <Btn variant="ghost" onClick={() => setBulkOpen(false)}>{t('dbviews.cancel')}</Btn>
                <Btn variant="primary" icon="check" onClick={applyBulkEdit}>{t('dbviews.bulkEditApply')}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {importOpen && connId && table && (
        <TableImportDialog
          connId={connId}
          schema={schema}
          table={table}
          engine={engine}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); refresh() }}
        />
      )}
    </div>
  )
}
