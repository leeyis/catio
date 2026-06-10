/* 表预览 pane:统一 tab 系统中的 kind:'table' 内容。自管数据 fetch +
   data/structure 子切换,保持 mounted 时切回状态原样(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView } from '../dbviews'
import { useData } from '../../state/DataContext'
import { tablePreview, tableStructure, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, ResultColumn } from '../../services/types'

/** Initial page size for the live table preview (matches DataGrid's default). */
const PREVIEW_PAGE = 100

export interface TablePaneProps {
  conn: Connection
  connId: string | null
  caps: DbCapabilities
  schema?: string
  table: string
  density?: 'comfortable' | 'compact'
}

export function TablePane({ conn, connId, caps, schema, table, density }: TablePaneProps) {
  const { t } = useTranslation()
  const D = useData()
  // data | structure. Structure is VIEWABLE for every engine; editing gated by caps.structureEdit inside StructureView.
  const [tableTab, setTableTab] = useState('data')

  // mock 路径的行/列标签(live 路径用真实 fetch 计数)
  const mockTbl = useMemo(
    () => D.schema.schemas.find(n => n.name === schema)?.tables.find(x => x.name === table),
    [D.schema, schema, table],
  )

  // ---- Live table-data fetch(平移自 DbWorkbench,语义不变)----
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][] } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)
  const [rowKeys, setRowKeys] = useState<string[] | null>(null)

  useEffect(() => {
    if (!connId) { setLive(null); setLiveErr(null); setRowKeys(null); return }
    let cancelled = false
    setLiveErr(null)
    Promise.all([
      tablePreview(connId, schema, table, PREVIEW_PAGE, 0),
      tableStructure(connId, schema ?? '', table).catch(() => null),
    ])
      .then(([res, struct]) => {
        if (cancelled) return
        const pkNames = new Set((struct?.columns ?? []).filter(c => c.key === 'PK').map(c => c.name))
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
  }, [connId, schema, table])

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
        <div className="row gap7" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="table-2" size={15} /></div>
          <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
            <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{connId ? (schema ? `${schema}.${table}` : table) : `public.${table}`}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{connId
              ? `${live?.rows?.length ?? 0} ${t('workbench.rowsLabel')} · ${live?.columns?.length ?? 0} ${t('workbench.colsLabel')}`
              : mockTbl ? `${mockTbl.rows} ${t('workbench.rowsLabel')} · ${mockTbl.cols} ${t('workbench.colsLabel')}` : ''}</span>
          </div>
        </div>
        <Segmented value={tableTab} onChange={setTableTab} options={[
          { value: 'data', label: t('workbench.tabData'), icon: 'table-2' },
          { value: 'structure', label: t('workbench.tabStructure'), icon: 'columns', testId: 'seg-structure' },
        ]} />
      </div>
      <div className="grow" style={{ minHeight: 0 }}>
        {tableTab === 'data' && (connId
          ? <DataGrid
              columns={(live?.columns ?? [])}
              rows={(live?.rows ?? [])}
              statusTones={D.statusTones} density={density} key={`${schema ?? ''}.${table}`}
              writable={caps.writable} connId={connId} table={table} schema={schema}
              rowKeys={rowKeys ?? undefined} keyColumn={rowKeys ? 'ctid' : undefined}
              livePreview loadError={liveErr ?? undefined} />
          : <DataGrid
              columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
              rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
              statusTones={D.statusTones} density={density} key={table} />)}
        {tableTab === 'structure' && <StructureView table={table} schema={schema} connId={connId ?? undefined} engine={conn.engine} canEdit={caps.structureEdit} key={`${schema ?? ''}.${table}`} />}
      </div>
    </>
  )
}
