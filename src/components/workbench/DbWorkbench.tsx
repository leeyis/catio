/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; E6 wires the live-connection data path */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView, SqlConsole, ERDiagram } from '../dbviews'
import { SqlEditor } from '../dbviews/SqlEditor'
import { CreateObjectModal } from '../dbviews/CreateObjectModal'
import { SchemaBrowser } from './SchemaBrowser'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections } from '../../state/dbConnections'
import { getSchema, tablePreview, tableStructure, objectSource, runQuery, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, ResultColumn, Schema, SchemaNamespace } from '../../services/types'

/** Initial page size for the live table preview (matches DataGrid's default). */
const PREVIEW_PAGE = 100

export interface DbWorkbenchProps {
  conn: Connection
  density?: 'comfortable' | 'compact'
  /**
   * True when this workbench is the currently-shown App tab. Workbenches stay
   * mounted while hidden, so this gates which query console may consume the
   * global `catio-insert` / `catio-run` (sql) events (only the shown tab's
   * active query console responds).
   */
  active?: boolean
}

/** All-enabled capabilities — used when no active backend connection is found (mock/demo). */
const ALL_ENABLED: DbCapabilities = {
  writable: true,
  transactions: true,
  schemas: true,
  sqlConsole: true,
  er: true,
  structureEdit: true,
}

export function DbWorkbench({ conn, density, active: shown = true }: DbWorkbenchProps) {
  const { t } = useTranslation()
  const D = useData()

  // Resolve the active live connection (if any): the first one whose profileId matches conn.id.
  // When present (Tauri + connected) we drive the grid from the backend; otherwise we keep the
  // mock/demo path pixel-identical. caps falls back to ALL_ENABLED when not connected.
  const active = useMemo(
    () => listActiveDbConnections().find(a => a.profileId === conn.id),
    [conn.id],
  )
  const caps: DbCapabilities = active ? active.capabilities : ALL_ENABLED
  const connId = active?.connId ?? null

  // active object: a table (with data/structure sub-tab), the schema ER diagram, or a query console.
  // A table carries BOTH its schema namespace and name (names are ambiguous across schemas).
  const [obj, setObj] = useState<
    | { type: 'table'; schema: string; table: string }
    | { type: 'object'; schema: string; name: string; kind: 'view' | 'function' | 'procedure' }
    | { type: 'sql'; qid: number }
    | { type: 'er' }
  >({ type: 'table', schema: 'public', table: 'orders' })
  // If structure tab is disabled and currently active, fall back to data
  const [tableTab, setTableTab] = useState('data') // data | structure
  const effectiveTableTab = (!caps.structureEdit && tableTab === 'structure') ? 'data' : tableTab
  const [queryN, setQueryN] = useState(1)
  // Open SQL query tabs (ids). Each click of 新建查询 appends one; consoles stay
  // mounted so each tab's editor + results persist across switches.
  const [openQueries, setOpenQueries] = useState<number[]>([])
  // Optional seed SQL per query tab (qid → template), used to pre-fill a fresh
  // console opened via 新建表 / 新建视图. Tabs without an entry start empty.
  const [queryInitialCode, setQueryInitialCode] = useState<Record<number, string>>({})
  // Schema whose ER diagram is being viewed (null → falls back to current namespace).
  const [erSchema, setErSchema] = useState<string | null>(null)
  // Open CREATE TABLE/VIEW form modal (null → closed). Carries the target schema + kind.
  const [createObj, setCreateObj] = useState<{ schema: string; kind: 'table' | 'view' } | null>(null)
  // Error surfaced when a CREATE statement fails to run.
  const [createErr, setCreateErr] = useState<string | null>(null)
  // Horizontally-scrollable query tab strip — chevrons scroll it when tabs overflow.
  const tabStripRef = useRef<HTMLDivElement>(null)
  const scrollTabs = (dx: number) => tabStripRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  // ---- Real schema tree (only when connected) ----
  // `liveSchema` holds the backend-introspected schema; null means "use the mock schema".
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  useEffect(() => {
    if (!connId) { setLiveSchema(null); return }
    let cancelled = false
    getSchema(connId)
      .then(sc => { if (!cancelled) setLiveSchema(sc) })
      .catch(() => { if (!cancelled) setLiveSchema(null) })
    return () => { cancelled = true }
  }, [connId])

  // Re-introspect the live schema on demand (schema "刷新" action). No-op on the mock path.
  function refreshSchema() {
    if (!connId) return
    getSchema(connId)
      .then(sc => setLiveSchema(sc))
      .catch(() => {})
  }

  const selectedTable = obj.type === 'table' ? obj.table : null

  // All schema namespaces to render. Live: the backend's full list (ads/dwd/dws/…);
  // Mock: the seeded single namespace (pixel-identical demo).
  const namespaces: SchemaNamespace[] = useMemo(() => {
    const ns = liveSchema?.schemas
    return (ns && ns.length) ? ns : D.schema.schemas
  }, [liveSchema, D.schema])

  // Auto-select a REAL table once the live schema loads: if the current table is not
  // present in any live namespace, jump to the first table of the first schema. This
  // prevents the mock default ('public.orders') from triggering "加载数据失败" on a real DB.
  useEffect(() => {
    if (!connId || !liveSchema || !liveSchema.schemas.length) return
    if (obj.type !== 'table') return
    const exists = liveSchema.schemas.some(
      n => n.name === obj.schema && (n.tables.some(t => t.name === obj.table) || n.views.some(v => v.name === obj.table)),
    )
    if (exists) return
    const first = liveSchema.schemas.find(n => n.tables.length) ?? liveSchema.schemas[0]
    const firstTable = first.tables[0]
    if (firstTable) setObj({ type: 'table', schema: first.name, table: firstTable.name })
    // obj.schema/obj.table read inside; intentionally re-run only when schema/conn change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, liveSchema])

  // The namespace currently being viewed (drives the table-meta lookup).
  const namespace: SchemaNamespace = useMemo(() => {
    return namespaces.find(n => n.name === (obj.type === 'table' ? obj.schema : ''))
      ?? namespaces[0]
  }, [namespaces, obj])

  // The schema qualifier passed to the dialect-correct preview + structure fetch.
  // Comes from the selected object's schema. Only meaningful when the engine has
  // schema namespaces; the backend drops it otherwise.
  const selectedSchema = caps.schemas ? (obj.type === 'table' ? obj.schema : undefined) : undefined

  const tbl = namespace.tables.find(t => t.name === (obj.type === 'table' ? obj.table : ''))

  // ---- Live table-data fetch (only when there is an active backend connection) ----
  // `live` holds the real QueryResult for the selected table; null means "use the mock path".
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][] } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)
  // For PK-less Postgres tables: the per-row `ctid` value (aligned to `live.rows`),
  // used as a stable row key for in-grid UPDATE/DELETE. Null when the table has a
  // PK or the engine doesn't expose `__ctid`.
  const [rowKeys, setRowKeys] = useState<string[] | null>(null)

  useEffect(() => {
    // Only fetch when connected to a real backend AND viewing a table.
    if (!connId || !selectedTable) { setLive(null); setLiveErr(null); setRowKeys(null); return }
    let cancelled = false
    setLiveErr(null)
    // Dialect-correct, identifier-quoted, paginated preview (works for all engines,
    // not just Postgres). Schema qualification lives in the backend command.
    // In parallel, fetch the table structure to learn which columns are primary
    // keys — `db_table_preview` doesn't mark PKs, but in-grid editing needs them
    // (DataGrid's `canEdit` is gated on `pkCols.length > 0`). We mark `pk: true`
    // on any preview column whose name is a PK in the structure. A failed
    // structure fetch is non-fatal: we just leave pk flags off (editing stays
    // disabled) rather than crashing or losing the data.
    Promise.all([
      tablePreview(connId, selectedSchema, selectedTable, PREVIEW_PAGE, 0),
      tableStructure(connId, selectedSchema ?? '', selectedTable).catch(() => null),
    ])
      .then(([res, struct]) => {
        if (cancelled) return
        const pkNames = new Set((struct?.columns ?? []).filter(c => c.key === 'PK').map(c => c.name))
        // The Postgres preview prepends a leading `__ctid` system column. Always
        // strip it from the displayed columns/rows so it's never shown or exported.
        // When the table has NO primary key, keep its per-row values as `rowKeys`
        // so the grid can still key UPDATE/DELETE on `ctid`.
        const ctidIdx = res.columns.findIndex(c => c.name === '__ctid')
        let cols = res.columns
        let rws = res.rows
        let keys: string[] | null = null
        if (ctidIdx >= 0) {
          if (pkNames.size === 0) keys = res.rows.map(r => String(r[ctidIdx]))
          cols = res.columns.filter((_, i) => i !== ctidIdx)
          rws = res.rows.map(r => r.filter((_, i) => i !== ctidIdx))
        }
        const columns: ResultColumn[] = pkNames.size
          ? cols.map(c => (pkNames.has(c.name) ? { ...c, pk: true } : c))
          : cols
        setLive({ columns, rows: rws })
        setRowKeys(keys)
      })
      .catch(e => { if (!cancelled) { setLiveErr(dbErrMsg(e)); setRowKeys(null) } })
    return () => { cancelled = true }
  }, [connId, selectedTable, selectedSchema])

  // ---- Object definition (view / function / procedure source) ----
  // Fetched only when an object is selected AND there is a live backend connection.
  const [objSource, setObjSource] = useState<string>('')
  const [objLoading, setObjLoading] = useState(false)
  const [objErr, setObjErr] = useState<string | null>(null)
  const objSig = obj.type === 'object' ? `${obj.kind}:${obj.schema}.${obj.name}` : null

  useEffect(() => {
    if (!connId || obj.type !== 'object') { setObjSource(''); setObjErr(null); setObjLoading(false); return }
    let cancelled = false
    setObjLoading(true)
    setObjErr(null)
    setObjSource('')
    objectSource(connId, obj.schema, obj.name, obj.kind)
      .then(src => { if (!cancelled) setObjSource(src) })
      .catch(e => { if (!cancelled) setObjErr(dbErrMsg(e)) })
      .finally(() => { if (!cancelled) setObjLoading(false) })
    return () => { cancelled = true }
    // obj.kind/schema/name captured via objSig; re-run only when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, objSig])

  function pickTable(schema: string, name: string) { setObj({ type: 'table', schema, table: name }) }
  function pickObject(schema: string, name: string, kind: 'view' | 'function' | 'procedure') {
    setObj({ type: 'object', schema, name, kind })
  }
  function newQuery(seed?: string) {
    if (!caps.sqlConsole) return
    const id = queryN + 1
    setQueryN(id)
    setOpenQueries(q => [...q, id])
    if (seed != null) setQueryInitialCode(m => ({ ...m, [id]: seed }))
    setObj({ type: 'sql', qid: id })
  }
  /** Open the CREATE TABLE/VIEW form modal for `schema`. No-op without a live connection. */
  function onNewObjectTemplate(schema: string, kind: 'table' | 'view') {
    if (!connId) return
    setCreateErr(null)
    setCreateObj({ schema, kind })
  }
  function closeQuery(id: number) {
    const next = openQueries.filter(x => x !== id)
    setOpenQueries(next)
    if (obj.type === 'sql' && obj.qid === id) {
      setObj(next.length
        ? { type: 'sql', qid: next[next.length - 1] }
        : { type: 'table', schema: selectedSchema ?? namespace.name, table: selectedTable ?? namespace.tables[0]?.name ?? 'orders' })
    }
  }
  function openER(schema?: string) {
    if (!caps.er) return
    setErSchema(schema ?? null)
    setObj({ type: 'er' })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', width: '100%', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SchemaBrowser onPick={pickTable} onPickObject={pickObject} active={obj.type === 'table' ? { schema: obj.schema, table: obj.table } : null}
        onNewQuery={() => newQuery()} onOpenER={openER} onNewObjectTemplate={onNewObjectTemplate} onRefresh={refreshSchema}
        erActive={obj.type === 'er'} sqlActive={obj.type === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er}
        schemas={connId ? namespaces : undefined} conn={connId ? conn : undefined} live={!!connId} />
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {obj.type === 'table' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
              <div className="row gap7" style={{ minWidth: 0 }}>
                <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="table-2" size={15} /></div>
                <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
                  <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{connId ? (selectedSchema ? `${selectedSchema}.${obj.table}` : obj.table) : `public.${obj.table}`}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{tbl ? `${tbl.rows} ${t('workbench.rowsLabel')} · ${tbl.cols} ${t('workbench.colsLabel')}` : ''}</span>
                </div>
              </div>
              <Segmented value={effectiveTableTab} onChange={setTableTab} options={[
                { value: 'data', label: t('workbench.tabData'), icon: 'table-2' },
                { value: 'structure', label: t('workbench.tabStructure'), icon: 'columns', disabled: !caps.structureEdit, testId: 'seg-structure' },
              ]} />
            </div>
            <div className="grow" style={{ minHeight: 0 }}>
              {effectiveTableTab === 'data' && (connId
                ? <DataGrid
                    columns={(live?.columns ?? [])}
                    rows={(live?.rows ?? [])}
                    statusTones={D.statusTones} density={density} key={`${selectedSchema ?? ''}.${obj.table}`}
                    writable={caps.writable} connId={connId} table={obj.table} schema={selectedSchema}
                    rowKeys={rowKeys ?? undefined} keyColumn={rowKeys ? 'ctid' : undefined}
                    livePreview loadError={liveErr ?? undefined} />
                : <DataGrid
                    columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                    rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                    statusTones={D.statusTones} density={density} key={obj.table} />)}
              {effectiveTableTab === 'structure' && <StructureView table={obj.table} schema={selectedSchema} connId={connId ?? undefined} engine={conn.engine} key={`${selectedSchema ?? ''}.${obj.table}`} />}
            </div>
          </>
        )}
        {obj.type === 'object' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
              <div className="row gap7" style={{ minWidth: 0 }}>
                <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
                  <Icon name={obj.kind === 'view' ? 'eye' : 'function-square'} size={15} />
                </div>
                <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
                  <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{`${obj.schema}.${obj.name}`}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('dbviews.objectDefinition')}</span>
                </div>
              </div>
              <span className="mono" style={{ flex: 'none', alignSelf: 'center', height: 22, lineHeight: '22px', padding: '0 9px', borderRadius: 7, fontSize: 11, fontWeight: 600,
                color: 'var(--accent-primary)', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)' }}>
                {obj.kind === 'view' ? t('dbviews.objViewKind') : obj.kind === 'function' ? t('dbviews.objFunctionKind') : t('dbviews.objProcedureKind')}
              </span>
            </div>
            <div className="grow" style={{ minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
              {objLoading
                ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.objLoading')}</div>
                : objErr
                  ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--signal-red)', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('dbviews.loadError', { message: objErr })}</div>
                  : objSource
                    ? <SqlEditor code={objSource} onChange={() => {}} />
                    : <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.noDefinition')}</div>}
            </div>
          </>
        )}
        {obj.type === 'er' && (() => {
          const erName = erSchema ?? namespace.name
          return <ERDiagram connId={connId ?? undefined} schema={erName} onOpenTable={(tblName) => setObj({ type: 'table', schema: erName, table: tblName })} />
        })()}
        {/* SQL query tabs — every open query stays mounted (display-toggled) so its
            editor + results persist across tab/table switches. */}
        {openQueries.length > 0 && (
          <div className="col" style={{ height: '100%', width: '100%', minHeight: 0, minWidth: 0, display: obj.type === 'sql' ? 'flex' : 'none' }}>
            <div className="row" style={{ gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', width: '100%', minWidth: 0, alignItems: 'center' }}>
              <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollLeft')} onClick={() => scrollTabs(-160)}><Icon name="chevron-left" size={14} /></button>
              <div ref={tabStripRef} className="row" style={{ gap: 6, flex: 1, minWidth: 0, overflowX: 'auto' }}>
                {openQueries.map(id => {
                  const isActive = obj.type === 'sql' && obj.qid === id
                  return (
                    <div key={id} onClick={() => setObj({ type: 'sql', qid: id })} className="row gap6"
                      style={{ flex: 'none', alignItems: 'center', height: 26, padding: '0 6px 0 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                        background: isActive ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                      <Icon name="file-code" size={12} /> query-{id}.sql
                      <button className="icon-btn bare" style={{ width: 18, height: 18 }} title={t('shell.close')} onClick={e => { e.stopPropagation(); closeQuery(id) }}><Icon name="x" size={11} /></button>
                    </div>
                  )
                })}
              </div>
              <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollRight')} onClick={() => scrollTabs(160)}><Icon name="chevron-right" size={14} /></button>
              <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.newQuery')} onClick={() => newQuery()}><Icon name="plus" size={14} /></button>
            </div>
            <div className="grow" style={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
              {openQueries.map(id => (
                <div key={id} style={{ flex: 1, minHeight: 0, width: '100%', display: obj.type === 'sql' && obj.qid === id ? 'flex' : 'none', flexDirection: 'column' }}>
                  <SqlConsole density={density} fresh queryN={id} writable={caps.writable} connId={connId ?? undefined} initialCode={queryInitialCode[id]} active={shown && obj.type === 'sql' && obj.qid === id} />
                </div>
              ))}
            </div>
          </div>
        )}
        {/* CREATE TABLE / VIEW form modal — only with a live connection. */}
        {createObj && connId && (
          <CreateObjectModal
            kind={createObj.kind}
            schema={createObj.schema}
            engine={conn.engine}
            onClose={() => { setCreateObj(null); setCreateErr(null) }}
            onCreate={async sql => {
              try {
                await runQuery(connId, sql)
                setCreateObj(null)
                setCreateErr(null)
                refreshSchema()
              } catch (e) {
                setCreateErr(dbErrMsg(e))
              }
            }}
          />
        )}
        {createErr && (
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 80, maxWidth: 420, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
            <span>{t('dbviews.applyError', { message: createErr })}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => setCreateErr(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
