/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; E6 wires the live query path */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { runQuery, getSchema, schemaColumns, dbErrMsg } from '../../services/db'
import type { ResultColumn, Schema } from '../../services/types'
import { SqlEditor } from './SqlEditor'
import { DataGrid } from './DataGrid'

export interface SqlConsoleProps {
  density?: 'comfortable' | 'compact'
  fresh?: boolean
  queryN?: number
  /** Capabilities of the active connection (writable gates the result grid's editing). */
  writable?: boolean
  /** When set, Run executes the typed SQL against the live backend instead of mock. */
  connId?: string
}

export function SqlConsole({ density, fresh, queryN, writable = true, connId }: SqlConsoleProps) {
  const { t } = useTranslation()
  const D = useData()
  const [code, setCode] = useState(
    // A fresh query starts EMPTY (no hardcoded sample SQL). The editor shows its
    // own placeholder hint instead.
    fresh ? '' : D.sampleSQL
  )
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>(fresh ? 'idle' : 'done')
  // Live result of the last successful run (only used when connId is set).
  const [result, setResult] = useState<{ columns: ResultColumn[]; rows: unknown[][]; sql: string } | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  // Live schema (table names) fetched from the backend when connected.
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  // Live columns per schema namespace: { [schemaName]: { [table]: columns } }.
  const [liveColumns, setLiveColumns] = useState<Record<string, Record<string, string[]>>>({})

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
   * Completion schema map for the SQL editor: `table → [columns]`, with both a
   * bare and `schema.table`-qualified key so lang-sql matches either form.
   *
   * Connected (live) path: columns come from the REAL backend via
   * `schemaColumns` (stored in `liveColumns`), merged across namespaces. A table
   * still in flight (columns not yet fetched, or the fetch failed) falls back to
   * an empty list — table-name completion still works.
   *
   * Mock path: columns come from `tableStructures` when known (best-effort).
   */
  const editorSchema = useMemo<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {}
    const mockColsFor = (table: string): string[] =>
      D.tableStructures[table]?.columns.map(c => c.name) ?? []
    const namespaces = (liveSchema ?? D.schema).schemas
    for (const ns of namespaces) {
      const realCols = connId ? liveColumns[ns.name] : undefined
      for (const tbl of [...ns.tables, ...ns.views]) {
        const cols = connId ? (realCols?.[tbl.name] ?? []) : mockColsFor(tbl.name)
        map[tbl.name] = cols
        map[`${ns.name}.${tbl.name}`] = cols
      }
    }
    return map
  }, [connId, liveSchema, liveColumns, D.schema, D.tableStructures])

  function run() {
    setRunErr(null)
    if (connId) {
      // Live path: execute the typed SQL against the backend.
      setPhase('running')
      const sql = code
      runQuery(connId, sql)
        .then(res => { setResult({ columns: res.columns, rows: res.rows, sql }); setPhase('done') })
        .catch(e => { setRunErr(dbErrMsg(e)); setPhase('done') })
      return
    }
    // Mock path: unchanged demo timing.
    setPhase('running')
    setTimeout(() => setPhase('done'), 450)
  }

  useEffect(() => {
    const h = (e: Event) => {
      const ce = e as CustomEvent
      if (!ce.detail || ce.detail.kind !== 'sql') return
      setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text)
    }
    window.addEventListener('catio-insert', h)
    return () => window.removeEventListener('catio-insert', h)
  }, [])

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      {/* console toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
        <div className="row gap8">
          <span className="chip" style={{ background: 'var(--surface-sunken)' }}><Icon name="file-code" size={12} /> query-{queryN || 1}.sql</span>
        </div>
        <div className="row gap6">
          <button className="icon-btn bare" title={t('dbviews.format')}><Icon name="wrench" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.clear')} onClick={() => setCode('')}><Icon name="eraser" size={15} /></button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <Btn size="sm" variant="primary" icon={phase === 'running' ? 'loader' : 'play'} onClick={run}>
            {phase === 'running' ? t('dbviews.running') : t('dbviews.run')} <span style={{ opacity: .6, fontSize: 10, marginLeft: 2 }}>⌘↵</span>
          </Btn>
        </div>
      </div>
      {/* editor */}
      <div style={{ flex: 'none', height: 188, borderBottom: '1px solid var(--border-hairline)' }}>
        <SqlEditor code={code} onChange={setCode} schema={editorSchema} onRun={run} />
      </div>
      {/* results */}
      <div className="grow" style={{ minHeight: 0 }}>
        {phase === 'running'
          ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-tertiary)' }}>
              <Icon name="loader" size={26} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>{t('dbviews.executingOn')}</span>
            </div>
          : phase === 'idle'
          ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-faint)' }}>
              <Icon name="play-circle" size={28} />
              <span style={{ fontSize: 13 }}>{t('dbviews.runToSeeResults')}</span>
              <span style={{ fontSize: 11.5 }}>{t('dbviews.runHint')}</span>
            </div>
          : (connId
              ? <DataGrid
                  columns={result?.columns ?? []}
                  rows={result?.rows ?? []}
                  statusTones={D.statusTones} density={density}
                  writable={writable} connId={connId} sql={result?.sql}
                  loadError={runErr ?? undefined} />
              : <DataGrid
                  columns={D.ordersColumns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                  rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                  statusTones={D.statusTones} density={density} />)}
      </div>
    </div>
  )
}
