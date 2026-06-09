/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; E6 wires the live query path */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { runQuery, getSchema, schemaColumns, dbErrMsg } from '../../services/db'
import type { ResultColumn, Schema } from '../../services/types'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
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
  /**
   * True when this console is the currently-shown query tab. Consoles stay
   * MOUNTED while hidden, so only the active one may consume the global
   * `catio-insert` / `catio-run` (sql) window events — otherwise every open
   * query tab would insert the same text.
   */
  active?: boolean
}

export function SqlConsole({ density, fresh, writable = true, connId, initialCode, active }: SqlConsoleProps) {
  const { t } = useTranslation()
  const D = useData()
  const [code, setCode] = useState(
    // A fresh query starts with its optional seed template (or EMPTY when none).
    // The editor shows its own placeholder hint when empty.
    fresh ? (initialCode ?? '') : D.sampleSQL
  )
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>(fresh ? 'idle' : 'done')
  // Live result of the last successful run (only used when connId is set).
  const [result, setResult] = useState<{ columns: ResultColumn[]; rows: unknown[][]; sql: string } | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  // Live schema (table names) fetched from the backend when connected.
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  // Live columns per schema namespace: { [schemaName]: { [table]: columns } }.
  const [liveColumns, setLiveColumns] = useState<Record<string, Record<string, string[]>>>({})
  // Imperative handle to the CodeMirror editor for cursor-aware insertion.
  const editorRef = useRef<SqlEditorHandle>(null)

  useEffect(() => {
    if (!connId) { setLiveSchema(null); return }
    let alive = true
    getSchema(connId).then(s => { if (alive) setLiveSchema(s) }).catch(() => {})
    return () => { alive = false }
  }, [connId])

  // Stable identity of the schema namespaces (names only) so the column fetch
  // re-runs when connId or the schema list changes, but NOT on every keystroke.
  const namespaceNames = useMemo(
    () => (liveSchema ? liveSchema.schemas.map(ns => ns.name) : []),
    [liveSchema],
  )
  const namespaceKey = namespaceNames.join(',')

  // Fetch REAL column names for each schema namespace from the live backend.
  // Best-effort: on rejection we leave that namespace out (editor falls back to
  // table-names-only). Re-runs only when connId or the namespace list changes.
  useEffect(() => {
    if (!connId || namespaceNames.length === 0) { setLiveColumns({}); return }
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
  }, [connId, namespaceKey])

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
    if (connId) {
      // Live path: execute the typed SQL against the backend.
      setPhase('running')
      runQuery(connId, sql)
        .then(res => { setResult({ columns: res.columns, rows: res.rows, sql }); setPhase('done') })
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
      if (editorRef.current) {
        // Insert on a NEW LINE at the caret, then run the resulting full doc.
        const next = editorRef.current.insertAtCursor(ce.detail.text, true)
        runRef.current(next)
      } else {
        // Editor not ready: append, then run the combined text.
        setCode(prev => {
          const next = (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text
          runRef.current(next)
          return next
        })
      }
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
      <div className="row" style={{ justifyContent: 'flex-end', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
        <div className="row gap6">
          <button className="icon-btn bare" title={t('dbviews.format')}><Icon name="wrench" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.clear')} onClick={() => setCode('')}><Icon name="eraser" size={15} /></button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <Btn size="sm" variant="primary" icon={phase === 'running' ? 'loader' : 'play'} onClick={() => run()}>
            {phase === 'running' ? t('dbviews.running') : t('dbviews.run')} <span style={{ opacity: .6, fontSize: 10, marginLeft: 2 }}>⌘↵</span>
          </Btn>
        </div>
      </div>
      {/* editor — always grows to fill the available area (full width + height).
          When there are no results yet it fills the whole console; once a run
          starts it shares the space with the results region below (a split). */}
      <div style={{ flex: 1, minHeight: 140, width: '100%', borderBottom: phase === 'idle' ? 'none' : '1px solid var(--border-hairline)' }}>
        <SqlEditor ref={editorRef} code={code} onChange={setCode} schema={editorSchema} onRun={run} onRunSelection={connId ? (sql => run(sql)) : undefined} />
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
                    writable={writable} connId={connId} sql={result?.sql}
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
