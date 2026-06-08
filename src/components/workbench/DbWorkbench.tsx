/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; E6 wires the live-connection data path */
import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView, SqlConsole, ERDiagram } from '../dbviews'
import { SchemaBrowser } from './SchemaBrowser'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections } from '../../state/dbConnections'
import { getSchema, tablePreview, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, ResultColumn, Schema, SchemaNamespace } from '../../services/types'

/** Initial page size for the live table preview (matches DataGrid's default). */
const PREVIEW_PAGE = 100

export interface DbWorkbenchProps {
  conn: Connection
  density?: 'comfortable' | 'compact'
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

export function DbWorkbench({ conn, density }: DbWorkbenchProps) {
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

  // active object: a table (with data/structure sub-tab), the schema ER diagram, or a query console
  const [obj, setObj] = useState<
    | { type: 'table'; table: string }
    | { type: 'sql'; qid: number }
    | { type: 'er' }
  >({ type: 'table', table: 'orders' })
  // If structure tab is disabled and currently active, fall back to data
  const [tableTab, setTableTab] = useState('data') // data | structure
  const effectiveTableTab = (!caps.structureEdit && tableTab === 'structure') ? 'data' : tableTab
  const [queryN, setQueryN] = useState(1)
  // Open SQL query tabs (ids). Each click of 新建查询 appends one; consoles stay
  // mounted so each tab's editor + results persist across switches.
  const [openQueries, setOpenQueries] = useState<number[]>([])

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

  const selectedTable = obj.type === 'table' ? obj.table : null

  // Which schema namespace are we browsing? Live: the namespace that contains the
  // selected table, else the first namespace. Mock: the seeded public namespace.
  const namespace: SchemaNamespace = useMemo(() => {
    const ns = liveSchema?.schemas
    if (ns && ns.length) {
      return ns.find(n => n.tables.some(tb => tb.name === selectedTable))
        ?? ns.find(n => n.views.some(v => v.name === selectedTable))
        ?? ns[0]
    }
    return D.schema.schemas[0]
  }, [liveSchema, selectedTable, D.schema])

  // The schema qualifier passed to the dialect-correct preview. Only meaningful when
  // the engine has schema namespaces; the backend drops it otherwise.
  const selectedSchema = caps.schemas ? namespace.name : undefined

  const tbl = namespace.tables.find(t => t.name === (obj.type === 'table' ? obj.table : ''))

  // ---- Live table-data fetch (only when there is an active backend connection) ----
  // `live` holds the real QueryResult for the selected table; null means "use the mock path".
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][] } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)

  useEffect(() => {
    // Only fetch when connected to a real backend AND viewing a table.
    if (!connId || !selectedTable) { setLive(null); setLiveErr(null); return }
    let cancelled = false
    setLiveErr(null)
    // Dialect-correct, identifier-quoted, paginated preview (works for all engines,
    // not just Postgres). Schema qualification lives in the backend command.
    tablePreview(connId, selectedSchema, selectedTable, PREVIEW_PAGE, 0)
      .then(res => { if (!cancelled) setLive({ columns: res.columns, rows: res.rows }) })
      .catch(e => { if (!cancelled) setLiveErr(dbErrMsg(e)) })
    return () => { cancelled = true }
  }, [connId, selectedTable, selectedSchema])

  function pickTable(name: string) { setObj({ type: 'table', table: name }) }
  function newQuery() {
    if (!caps.sqlConsole) return
    const id = queryN + 1
    setQueryN(id)
    setOpenQueries(q => [...q, id])
    setObj({ type: 'sql', qid: id })
  }
  function closeQuery(id: number) {
    const next = openQueries.filter(x => x !== id)
    setOpenQueries(next)
    if (obj.type === 'sql' && obj.qid === id) {
      setObj(next.length
        ? { type: 'sql', qid: next[next.length - 1] }
        : { type: 'table', table: selectedTable ?? 'orders' })
    }
  }
  function openER() {
    if (!caps.er) return
    setObj({ type: 'er' })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <SchemaBrowser onPick={pickTable} active={obj.type === 'table' ? obj.table : null}
        onNewQuery={newQuery} onOpenER={openER} erActive={obj.type === 'er'} sqlActive={obj.type === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er}
        namespace={connId ? namespace : undefined} />
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
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
                    statusTones={D.statusTones} density={density} key={obj.table}
                    writable={caps.writable} connId={connId} table={obj.table} schema={selectedSchema}
                    livePreview loadError={liveErr ?? undefined} />
                : <DataGrid
                    columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                    rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                    statusTones={D.statusTones} density={density} key={obj.table} />)}
              {effectiveTableTab === 'structure' && <StructureView table={obj.table} key={obj.table} />}
            </div>
          </>
        )}
        {obj.type === 'er' && <ERDiagram onOpenTable={(tblName) => setObj({ type: 'table', table: tblName })} />}
        {/* SQL query tabs — every open query stays mounted (display-toggled) so its
            editor + results persist across tab/table switches. */}
        {openQueries.length > 0 && (
          <div className="col" style={{ height: '100%', minHeight: 0, display: obj.type === 'sql' ? 'flex' : 'none' }}>
            <div className="row" style={{ gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', overflowX: 'auto' }}>
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
              <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.newQuery')} onClick={newQuery}><Icon name="plus" size={14} /></button>
            </div>
            <div className="grow" style={{ minHeight: 0, position: 'relative' }}>
              {openQueries.map(id => (
                <div key={id} style={{ position: 'absolute', inset: 0, display: obj.type === 'sql' && obj.qid === id ? 'block' : 'none' }}>
                  <SqlConsole density={density} fresh queryN={id} writable={caps.writable} connId={connId ?? undefined} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
