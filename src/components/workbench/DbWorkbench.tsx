/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; E6 wires the live-connection data path */
import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView, SqlConsole, ERDiagram } from '../dbviews'
import { SchemaBrowser } from './SchemaBrowser'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections } from '../../state/dbConnections'
import { runQuery, type DbCapabilities } from '../../services/db'
import type { Connection, ResultColumn } from '../../services/types'

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
  const tbl = D.schema.schemas[0].tables.find(t => t.name === (obj.type === 'table' ? obj.table : ''))

  // ---- Live table-data fetch (only when there is an active backend connection) ----
  // `live` holds the real QueryResult for the selected table; null means "use the mock path".
  const selectedTable = obj.type === 'table' ? obj.table : null
  // SQL re-run by the grid for pagination/refresh. Schema-qualified to match the browser.
  const liveSql = selectedTable ? `SELECT * FROM public.${selectedTable}` : null
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][] } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)

  useEffect(() => {
    // Only fetch when connected to a real backend AND viewing a table.
    if (!connId || !selectedTable || !liveSql) { setLive(null); setLiveErr(null); return }
    let cancelled = false
    setLiveErr(null)
    runQuery(connId, liveSql)
      .then(res => { if (!cancelled) setLive({ columns: res.columns, rows: res.rows }) })
      .catch(e => { if (!cancelled) setLiveErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [connId, selectedTable, liveSql])

  function pickTable(name: string) { setObj({ type: 'table', table: name }) }
  function newQuery() {
    if (!caps.sqlConsole) return
    setQueryN(n => n + 1); setObj({ type: 'sql', qid: queryN + 1 })
  }
  function openER() {
    if (!caps.er) return
    setObj({ type: 'er' })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <SchemaBrowser onPick={pickTable} active={obj.type === 'table' ? obj.table : null}
        onNewQuery={newQuery} onOpenER={openER} erActive={obj.type === 'er'} sqlActive={obj.type === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er} />
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {obj.type === 'table' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
              <div className="row gap7" style={{ minWidth: 0 }}>
                <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="table-2" size={15} /></div>
                <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
                  <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>public.{obj.table}</span>
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
                    writable={caps.writable} connId={connId} table={obj.table} schema="public"
                    sql={liveSql ?? undefined} loadError={liveErr ?? undefined} />
                : <DataGrid
                    columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                    rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                    statusTones={D.statusTones} density={density} key={obj.table} />)}
              {effectiveTableTab === 'structure' && <StructureView table={obj.table} key={obj.table} />}
            </div>
          </>
        )}
        {obj.type === 'sql' && <SqlConsole density={density} fresh queryN={obj.qid} key={'q' + obj.qid}
          writable={caps.writable} connId={connId ?? undefined} />}
        {obj.type === 'er' && <ERDiagram onOpenTable={(tblName) => setObj({ type: 'table', table: tblName })} />}
      </div>
    </div>
  )
}
