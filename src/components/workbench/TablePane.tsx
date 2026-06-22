/* 表预览 pane:统一 tab 系统中的 kind:'table' 内容。自管数据 fetch +
   data/structure 子切换,保持 mounted 时切回状态原样(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView, RedisKeyspaceView } from '../dbviews'
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
  // True while (re)fetching a table's preview — drives the result-area loading
  // overlay so fast table switches show a transition instead of stale rows.
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!connId) { setLive(null); setLiveErr(null); setRowKeys(null); setLoading(false); return }
    let cancelled = false
    setLiveErr(null)
    setLoading(true)
    Promise.all([
      tablePreview(connId, schema, table, PREVIEW_PAGE, 0),
      tableStructure(connId, schema ?? '', table).catch(() => null),
    ])
      .then(([res, struct]) => {
        if (cancelled) return
        const pkNames = new Set((struct?.columns ?? []).filter(c => c.key === 'PK').map(c => c.name))
        // 列名→注释映射（零额外请求,来自并行加载的 structure）。仅表预览使用;
        // 空注释不入表,避免给所有列硬塞空串而误触发结果区的注释切换按钮。
        const commentByName = new Map<string, string>()
        for (const c of struct?.columns ?? []) if (c.comment) commentByName.set(c.name, c.comment)
        const ctidIdx = res.columns.findIndex(c => c.name === '__ctid')
        let cols = res.columns
        let rws = res.rows
        let keys: string[] | null = null
        if (ctidIdx >= 0) {
          if (pkNames.size === 0) keys = res.rows.map(r => String(r[ctidIdx]))
          cols = res.columns.filter((_, i) => i !== ctidIdx)
          rws = res.rows.map(r => r.filter((_, i) => i !== ctidIdx))
        }
        const columns: ResultColumn[] = cols.map(c => {
          const comment = commentByName.get(c.name)
          const pk = pkNames.has(c.name) || undefined
          return (comment !== undefined || pk) ? { ...c, ...(pk ? { pk: true } : {}), ...(comment !== undefined ? { comment } : {}) } : c
        })
        setLive({ columns, rows: rws })
        setRowKeys(keys)
      })
      .catch(e => { if (!cancelled) { setLiveErr(dbErrMsg(e)); setRowKeys(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema, table])

  // mongo/es 的数据网格编辑会生成 SQL DML(db_apply_edits),对这两类引擎必败 → 预览只读。
  const sqlDml = conn.engine !== 'mongodb' && conn.engine !== 'elasticsearch'
  // Redis 无表结构:第二个 segment 改为展示 key 元信息(keyspace 概览)而非列/DDL。
  const isRedis = (conn.engine ?? '').toLowerCase() === 'redis'

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
          { value: 'structure', label: isRedis ? t('workbench.tabKeyspace') : t('workbench.tabStructure'), icon: isRedis ? 'database' : 'columns', testId: 'seg-structure' },
        ]} />
      </div>
      <div className="grow" style={{ minHeight: 0, position: 'relative' }}>
        {/* result-area loading overlay — shown while a table's data is (re)fetching */}
        {connId && loading && tableTab === 'data' && (
          <div className="col" style={{ position: 'absolute', inset: 0, zIndex: 5, alignItems: 'center', justifyContent: 'center', gap: 10, background: 'color-mix(in srgb, var(--surface-base) 62%, transparent)', backdropFilter: 'blur(1px)', color: 'var(--text-tertiary)' }}>
            <Icon name="loader" size={24} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )}
        {tableTab === 'data' && (connId
          ? <DataGrid
              columns={(live?.columns ?? [])}
              rows={(live?.rows ?? [])}
              statusTones={D.statusTones} density={density} key={`${schema ?? ''}.${table}`}
              writable={caps.writable && sqlDml} connId={connId} table={table} schema={schema} engine={conn.engine}
              rowKeys={rowKeys ?? undefined} keyColumn={rowKeys ? 'ctid' : undefined}
              livePreview loadError={liveErr ?? undefined} />
          : <DataGrid
              columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
              rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
              statusTones={D.statusTones} density={density} key={table} />)}
        {tableTab === 'structure' && (isRedis
          ? <RedisKeyspaceView connId={connId ?? undefined} schema={schema} key={`ks.${schema ?? ''}`} />
          : <StructureView table={table} schema={schema} connId={connId ?? undefined} engine={conn.engine} canEdit={caps.structureEdit} key={`${schema ?? ''}.${table}`} />)}
      </div>
    </>
  )
}
