/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; E6 wires the live query path */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { runQuery, getSchema, schemaColumns, dbErrMsg } from '../../services/db'
import type { ResultColumn, Schema } from '../../services/types'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { mongoCompletion } from './mongoCompletion'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { DataGrid } from './DataGrid'

export interface SqlConsoleProps {
  density?: 'comfortable' | 'compact'
  fresh?: boolean
  queryN?: number
  /** Capabilities of the active connection (writable gates the result grid's editing). */
  writable?: boolean
  /** When set, Run executes the typed SQL against the live backend instead of mock. */
  connId?: string
  /** Seed text for a fresh console (e.g. a CREATE TABLE/VIEW template). Falls back to empty. */
  initialCode?: string
  /** Namespace selected when this query tab is opened from a scoped action. */
  initialDefaultSchema?: string
  /**
   * True when this console is the currently-shown query tab. Consoles stay
   * MOUNTED while hidden, so only the active one may consume the global
   * `catio-insert` / `catio-run` (sql) window events — otherwise every open
   * query tab would insert the same text.
   */
  active?: boolean
  /** 连接引擎(conn.engine = dbType)。mongodb/elasticsearch → plain 模式(Task 10 实装)。 */
  engine?: string
}

export function SqlConsole({ density, fresh, writable = true, connId, initialCode, initialDefaultSchema, active, engine }: SqlConsoleProps) {
  const { t } = useTranslation()
  // mongodb/elasticsearch 用各自语法(mongo shell / REST+SQL),编辑器走 plain 模式:
  // 不挂 SQL 补全、显示语法占位提示、结果网格只读(mongo 的 _id 带 pk 标记,
  // 会让 DataGrid 误开 SQL DML 编辑——对 mongo 必然失败)。
  const plain = engine === 'mongodb' || engine === 'elasticsearch'
  const supportsDefaultNamespace = engine !== 'elasticsearch'
  const editorPlaceholder = engine === 'mongodb' ? t('dbviews.mongoPlaceholder')
    : engine === 'elasticsearch' ? t('dbviews.esPlaceholder')
    : undefined
  const D = useData()
  const [code, setCode] = useState(
    // A fresh query starts with its optional seed template (or EMPTY when none).
    // The editor shows its own placeholder hint when empty.
    fresh ? (initialCode ?? '') : D.sampleSQL
  )
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>(fresh ? 'idle' : 'done')
  // Live result of the last successful run (only used when connId is set).
  const [result, setResult] = useState<{
    columns: ResultColumn[]
    rows: unknown[][]
    sql: string
    defaultNamespace?: string
  } | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  // Live schema/database namespaces (table names) fetched from the backend when connected.
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  const [defaultNamespace, setDefaultNamespace] = useState(initialDefaultSchema ?? '')
  // Live columns per schema namespace: { [schemaName]: { [table]: columns } }.
  const [liveColumns, setLiveColumns] = useState<Record<string, Record<string, string[]>>>({})
  // Imperative handle to the CodeMirror editor for cursor-aware insertion.
  const editorRef = useRef<SqlEditorHandle>(null)
  // Live collection names for the plain-mode mongo completion source. Held in a
  // ref so the (stable-identity) completion source reads the latest list without
  // rebuilding the editor extension on every schema change.
  const collectionsRef = useRef<string[]>([])

  useEffect(() => {
    if (!connId || !supportsDefaultNamespace) { setLiveSchema(null); return }
    let alive = true
    getSchema(connId).then(s => { if (alive) setLiveSchema(s) }).catch(() => {})
    return () => { alive = false }
  }, [connId, supportsDefaultNamespace])

  // Plain-mode (mongo) collection names for autocompletion — union of every
  // database's collections/views. Best-effort: a failed fetch leaves the list
  // empty (completion degrades to methods/chains only).
  useEffect(() => {
    if (!connId || engine !== 'mongodb') { collectionsRef.current = []; return }
    let alive = true
    getSchema(connId)
      .then(s => {
        if (!alive) return
        const names = new Set<string>()
        for (const ns of s.schemas) {
          for (const tbl of ns.tables) names.add(tbl.name)
          for (const v of ns.views) names.add(v.name)
        }
        collectionsRef.current = [...names]
      })
      .catch(() => { if (alive) collectionsRef.current = [] })
    return () => { alive = false }
  }, [connId, engine])

  // Stable completion source for the editor (mongo only for now). Identity is
  // keyed on engine so the editor extension isn't rebuilt as collections load.
  const completion = useMemo(
    () => (engine === 'mongodb' ? mongoCompletion(() => collectionsRef.current) : undefined),
    [engine],
  )

  // Stable identity of the schema namespaces (names only) so the column fetch
  // re-runs when connId or the schema list changes, but NOT on every keystroke.
  const namespaceNames = useMemo(
    () => (liveSchema ? liveSchema.schemas.map(ns => ns.name) : []),
    [liveSchema],
  )
  const namespaceKey = namespaceNames.join(',')
  const schemaOptions = useMemo(
    () => (liveSchema ?? D.schema).schemas.map(ns => ns.name).filter(Boolean),
    [liveSchema, D.schema],
  )
  const schemaOptionsKey = schemaOptions.join('\u0000')

  useEffect(() => {
    if (!supportsDefaultNamespace || schemaOptions.length === 0) { setDefaultNamespace(''); return }
    setDefaultNamespace(cur => {
      if (cur && schemaOptions.includes(cur)) return cur
      if (initialDefaultSchema && schemaOptions.includes(initialDefaultSchema)) return initialDefaultSchema
      return schemaOptions[0] ?? ''
    })
    // schemaOptionsKey captures option identity; avoid re-running just because
    // the memoized array identity changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsDefaultNamespace, schemaOptionsKey, initialDefaultSchema])

  // Fetch REAL column names for each schema namespace from the live backend.
  // Best-effort: on rejection we leave that namespace out (editor falls back to
  // table-names-only). Re-runs only when connId or the namespace list changes.
  useEffect(() => {
    if (!connId || plain || namespaceNames.length === 0) { setLiveColumns({}); return }
    let alive = true
    Promise.all(
      namespaceNames.map(name =>
        schemaColumns(connId, name)
          .then(pairs => [name, Object.fromEntries(pairs)] as const)
          .catch(() => [name, {} as Record<string, string[]>] as const),
      ),
    )
      .then(entries => { if (alive) setLiveColumns(Object.fromEntries(entries)) })
      .catch(() => { if (alive) setLiveColumns({}) })
    return () => { alive = false }
    // namespaceKey captures the namespace-name identity; intentionally not on liveSchema object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, plain, namespaceKey])

  /**
   * Nested completion schema for the SQL editor, in @codemirror/lang-sql's
   * `SQLNamespace` shape so schemas, tables, and columns render with DISTINCT
   * autocomplete icons:
   *   - schema  → `{ self: { type: 'class' }, children: { …tables } }`
   *   - table   → `{ self: { type: 'type' }, children: [ …columns ] }`
   *   - column  → string entries, which lang-sql completes with type `'property'`
   *
   * Without explicit `self` completions lang-sql gives every nested key the same
   * `'type'` icon (schemas and tables become indistinguishable); the `self` tag
   * overrides that per level so the icons differ.
   *
   * Tables are exposed both schema-qualified (under their schema's `children`, so
   * `ads.orders` → its columns) and bare at the top level (so `orders` completes
   * unqualified). Schema names stay top-level keys, now with the `class` icon.
   *
   * Connected (live) path: columns come from the REAL backend via
   * `schemaColumns` (stored in `liveColumns`), merged across namespaces. A table
   * still in flight (columns not yet fetched, or the fetch failed) falls back to
   * an empty list — table-name completion still works.
   *
   * Mock path: columns come from `tableStructures` when known (best-effort).
   */
  const editorSchema = useMemo<SQLNamespace>(() => {
    const top: Record<string, SQLNamespace> = {}
    const mockColsFor = (table: string): string[] =>
      D.tableStructures[table]?.columns.map(c => c.name) ?? []
    const tableNode = (label: string, cols: readonly string[]): SQLNamespace => ({
      self: { label, type: 'type' },
      children: cols,
    })
    const namespaces = (liveSchema ?? D.schema).schemas
    for (const ns of namespaces) {
      const realCols = connId ? liveColumns[ns.name] : undefined
      const tables: Record<string, SQLNamespace> = {}
      for (const tbl of [...ns.tables, ...ns.views]) {
        const cols = connId ? (realCols?.[tbl.name] ?? []) : mockColsFor(tbl.name)
        const node = tableNode(tbl.name, cols)
        // Schema-qualified (ads.orders → columns) and bare (orders → columns).
        tables[tbl.name] = node
        if (!(tbl.name in top)) top[tbl.name] = node
      }
      // Schema name itself: a `class`-typed completion whose children are tables.
      top[ns.name] = { self: { label: ns.name, type: 'class' }, children: tables }
    }
    return top
  }, [connId, liveSchema, liveColumns, D.schema, D.tableStructures])

  function run(sqlOverride?: string) {
    setRunErr(null)
    // A selection-run passes just the highlighted SQL; otherwise run the whole editor.
    const sql = sqlOverride && sqlOverride.trim() ? sqlOverride : code
    // 空 / 纯空白 SQL 不执行：拦在所有入口（按钮 / Alt+Enter / 片段运行）之前，
    // 避免把空语句发给后端报错，或 mock 路径空转出现"执行中"。
    if (!sql.trim()) return
    const runDefaultNamespace = supportsDefaultNamespace && defaultNamespace && schemaOptions.includes(defaultNamespace)
      ? defaultNamespace
      : undefined
    if (connId) {
      // Live path: execute the typed SQL against the backend.
      setPhase('running')
      runQuery(connId, sql, runDefaultNamespace)
        .then(res => {
          setResult({ columns: res.columns, rows: res.rows, sql, defaultNamespace: runDefaultNamespace })
          setPhase('done')
        })
        .catch(e => { setRunErr(dbErrMsg(e)); setPhase('done') })
      return
    }
    // Mock path: unchanged demo timing.
    setPhase('running')
    setTimeout(() => setPhase('done'), 450)
  }

  // Keep the latest run() in a ref so the (active-gated) event listener always
  // calls the current closure without re-subscribing on every keystroke.
  const runRef = useRef(run)
  runRef.current = run

  // Snippet / history / AI "insert" + "run" into the SQL editor.
  // GATING: only the ACTIVE query console consumes these global events, so N
  // mounted (hidden) tabs don't all insert the same text. When active is
  // undefined (e.g. a standalone console with no tab strip) we still respond so
  // existing single-console usages keep working.
  useEffect(() => {
    if (active === false) return
    const onInsert = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; text?: string }>
      if (!ce.detail || ce.detail.kind !== 'sql' || typeof ce.detail.text !== 'string') return
      // Insert at the caret / replace the selection via the CodeMirror view.
      // Fall back to the previous append behavior if the editor isn't mounted yet.
      if (editorRef.current) editorRef.current.insertAtCursor(ce.detail.text)
      else setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text)
    }
    const onRun = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; text?: string }>
      if (!ce.detail || ce.detail.kind !== 'sql' || typeof ce.detail.text !== 'string') return
      // Insert on a NEW LINE at the caret (so the statement is visible in the
      // editor), then run ONLY that statement — NOT the whole document. Running
      // the full buffer would concatenate it with any existing query and throw a
      // syntax error (`…WHERE…select * …`). Run the snippet text in isolation.
      if (editorRef.current) editorRef.current.insertAtCursor(ce.detail.text, true)
      else setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text)
      runRef.current(ce.detail.text)
    }
    window.addEventListener('catio-insert', onInsert)
    window.addEventListener('catio-run', onRun)
    return () => {
      window.removeEventListener('catio-insert', onInsert)
      window.removeEventListener('catio-run', onRun)
    }
  }, [active])

  return (
    <div className="col" style={{ height: '100%', width: '100%', minHeight: 0, minWidth: 0 }}>
      {/* console toolbar — the query name lives in the tab strip above, so it's not
          repeated here; just the editor actions, right-aligned. */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
        <div className="row gap6">
          <Btn size="sm" variant="primary" disabled={phase === 'running' || !code.trim()} icon={phase === 'running' ? 'loader' : 'play'} onClick={() => run()}>
            {phase === 'running' ? t('dbviews.running') : t('dbviews.run')} <span style={{ opacity: .6, fontSize: 10, marginLeft: 2 }}>Alt↵</span>
          </Btn>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <button className="icon-btn bare" title={t('dbviews.format')}><Icon name="wrench" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.clear')} onClick={() => setCode('')}><Icon name="eraser" size={15} /></button>
        </div>
        <div className="row gap6" style={{ minWidth: 0 }}>
          {supportsDefaultNamespace && schemaOptions.length > 1 && (
            <label className="row gap6" title={t('workbench.defaultSchema')}
              style={{ height: 30, minWidth: 0, maxWidth: 260, padding: '0 8px', border: '1px solid var(--border-hairline)', borderRadius: 9, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)', fontSize: 11.5 }}>
              <Icon name="database" size={13} style={{ flex: 'none', color: 'var(--text-faint)' }} />
              <span style={{ flex: 'none' }}>{t('workbench.defaultSchema')}</span>
              <select
                data-testid="sql-default-schema"
                aria-label={t('workbench.defaultSchema')}
                value={defaultNamespace}
                onChange={e => setDefaultNamespace(e.target.value)}
                style={{ minWidth: 82, maxWidth: 130, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'Geist Mono', monospace" }}>
                {schemaOptions.map(schema => <option key={schema} value={schema}>{schema}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      {/* editor — always grows to fill the available area (full width + height).
          When there are no results yet it fills the whole console; once a run
          starts it shares the space with the results region below (a split). */}
      <div style={{ flex: 1, minHeight: 140, width: '100%', borderBottom: phase === 'idle' ? 'none' : '1px solid var(--border-hairline)' }}>
        <SqlEditor ref={editorRef} code={code} onChange={setCode} schema={editorSchema} onRun={run} onRunSelection={connId ? (sql => run(sql)) : undefined} placeholder={editorPlaceholder} plain={plain} completion={completion} />
      </div>
      {/* results — only rendered once a run has started (running/done). While
          idle (fresh query) the editor above fills everything. */}
      {phase !== 'idle' && (
        <div style={{ flex: 1, minHeight: 0, width: '100%' }}>
          {phase === 'running'
            ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-tertiary)' }}>
                <Icon name="loader" size={26} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: 13 }}>{t('dbviews.executingOn')}</span>
              </div>
            : (connId
                ? <DataGrid
                    columns={result?.columns ?? []}
                    rows={result?.rows ?? []}
                    statusTones={D.statusTones} density={density}
                    writable={writable && !plain} connId={connId}
                    // plain 引擎(mongo/es)不传 sql:服务端分页会拼 SQL LIMIT/OFFSET 必败,回落客户端分页。
                    sql={plain ? undefined : result?.sql}
                    defaultNamespace={result?.defaultNamespace}
                    resultLabel={t('dbviews.queryResult')}
                    loadError={runErr ?? undefined} />
                : <DataGrid
                    columns={D.ordersColumns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                    rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                    statusTones={D.statusTones} density={density} />)}
        </div>
      )}
    </div>
  )
}
