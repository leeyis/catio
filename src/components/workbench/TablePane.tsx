/* 表预览 pane:统一 tab 系统中的 kind:'table' 内容。自管数据 fetch +
   data/structure 子切换,保持 mounted 时切回状态原样(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import type { StructureSection } from '../dbviews/StructureView'
import { DataGrid, StructureView, RedisKeyspaceView } from '../dbviews'
import { useData } from '../../state/DataContext'
import { tablePreview, tableStructure, dbErrMsg, type DbCapabilities } from '../../services/db'
import { removeBinaryColumn } from '../dbviews/binaryValue'
import type { Connection, ResultColumn, BinaryCell } from '../../services/types'

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

export function TablePane(props: TablePaneProps) {
  return <TableContent key={JSON.stringify([props.connId, props.schema, props.table, props.conn.engine])} {...props} />
}
function TableContent({ conn, connId, caps, schema, table, density }: TablePaneProps) {
  const { t } = useTranslation()
  const D = useData()
  const viewId = useId()
  const [tableTab, setTableTab] = useState<'data' | 'keyspace' | StructureSection>('data')
  const [structureVisited, setStructureVisited] = useState(false)
  const [structureSection, setStructureSection] = useState<StructureSection>('columns')

  // ---- Live table-data fetch(平移自 DbWorkbench,语义不变)----
  const [live, setLive] = useState<{ columns: ResultColumn[]; rows: unknown[][]; binaryCells?: BinaryCell[]; truncated?: boolean } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)
  const [rowKeys, setRowKeys] = useState<string[] | null>(null)
  // True while (re)fetching a table's preview — drives the result-area loading
  // overlay so fast table switches show a transition instead of stale rows.
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!connId) { setLive(null); setLiveErr(null); setRowKeys(null); setLoading(false); return }
    let cancelled = false
    setLive(null); setRowKeys(null)
    setLiveErr(null)
    setLoading(true)
    Promise.all([
      tablePreview(connId, schema, table, PREVIEW_PAGE, 0),
      tableStructure(connId, schema ?? '', table).catch(() => null),
    ])
      .then(([res, struct]) => {
        if (cancelled) return
        const pkNames = new Set((struct?.columns ?? []).filter(c => c.key === 'PK' && conn.engine !== 'clickhouse').map(c => c.name))
        // 列名→注释映射（零额外请求,来自并行加载的 structure）。仅表预览使用;
        // 空注释不入表,避免给所有列硬塞空串而误触发结果区的注释切换按钮。
        const commentByName = new Map<string, string>()
        for (const c of struct?.columns ?? []) if (c.comment) commentByName.set(c.name, c.comment)
        const ctidIdx = conn.engine === 'postgres' && struct && !struct.columns.some(c => c.name === '__ctid')
          ? res.columns.findIndex(c => c.name === '__ctid') : -1
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
        setLive({ columns, rows: rws, binaryCells: removeBinaryColumn(res.binaryCells, ctidIdx), truncated: res.truncated })
        setRowKeys(keys)
      })
      .catch(e => { if (!cancelled) { setLiveErr(dbErrMsg(e)); setRowKeys(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema, table])

  // mongo/es 的数据网格编辑会生成 SQL DML(db_apply_edits),对这两类引擎必败 → 预览只读。
  const sqlDml = !['mongodb', 'elasticsearch', 'redis'].includes(conn.engine ?? '')
  // Redis 无表结构:第二个 segment 改为展示 key 元信息(keyspace 概览)而非列/DDL。
  const isRedis = (conn.engine ?? '').toLowerCase() === 'redis'

  const views: { value: typeof tableTab; label: string; icon: string }[] = [
    { value: 'data', label: t('workbench.tabData'), icon: 'table-2' },
    ...(isRedis ? [{ value: 'keyspace' as const, label: t('workbench.tabKeyspace'), icon: 'database' }] : [
      { value: 'columns' as const, label: t('dbviews.tabColumns'), icon: 'columns' },
      { value: 'indexes' as const, label: t('dbviews.tabIndexes'), icon: 'gauge' },
      ...(sqlDml ? [
        { value: 'fks' as const, label: t('dbviews.tabFks'), icon: 'link' },
        { value: 'triggers' as const, label: t('dbviews.tabTriggers'), icon: 'zap' },
        { value: 'ddl' as const, label: 'DDL', icon: 'code' },
      ] : []),
    ]),
  ]
  function choose(value: typeof tableTab) {
    setTableTab(value)
    if (value !== 'data') setStructureVisited(true)
    if (value !== 'data' && value !== 'keyspace') setStructureSection(value)
  }

  return (
    <div className="col db-object-workspace" style={{ height: '100%', minHeight: 0 }}>
      <div className="db-object-identity">
        <Icon name="table-2" size={14} />
        <strong className="mono ell" title={schema ? `${schema}.${table}` : table}>{schema ? `${schema}.${table}` : table}</strong>
        <span className="db-object-caption">{conn.engineId ?? conn.engine}</span>
        <div className="grow" />
        {!caps.structureEdit && tableTab !== 'data' && <span className="db-object-caption">{t('dbviews.structureWorkspace.readOnly')}</span>}
      </div>
      <div className="db-object-tabs" role="tablist" aria-label={t('dbviews.structureWorkspace.navigation')}>
        {views.map((view, index) => <button key={view.value} id={`${viewId}-${view.value}`} role="tab" aria-controls={`${viewId}-${view.value === 'data' ? 'data-panel' : 'metadata-panel'}`} aria-selected={tableTab === view.value} tabIndex={tableTab === view.value ? 0 : -1}
          data-testid={view.value === 'columns' || view.value === 'keyspace' ? 'seg-structure' : `object-view-${view.value}`}
          onClick={() => choose(view.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length
            choose(views[next].value)
            ;(event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus()
          }}><Icon name={view.icon} size={13} />{view.label}</button>)}
      </div>
      <div className="grow" style={{ minHeight: 0, position: 'relative' }}>
        {/* result-area loading overlay — shown while a table's data is (re)fetching */}
        {connId && loading && tableTab === 'data' && (
          <div className="col" style={{ position: 'absolute', inset: 0, zIndex: 5, alignItems: 'center', justifyContent: 'center', gap: 10, background: 'color-mix(in srgb, var(--surface-base) 62%, transparent)', backdropFilter: 'blur(1px)', color: 'var(--text-tertiary)' }}>
            <Icon name="loader" size={24} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )}
        <div id={`${viewId}-data-panel`} role="tabpanel" aria-labelledby={`${viewId}-data`} style={{height:'100%',display:tableTab==='data'?'block':'none'}}>
        {(connId
          ? <DataGrid
              columns={(live?.columns ?? [])}
              rows={(live?.rows ?? [])}
              binaryCells={live?.binaryCells}
              statusTones={D.statusTones} density={density} key={`${connId}.${schema ?? ''}.${table}`}
              writable={caps.writable && sqlDml} transactions={caps.transactions} connId={connId} table={table} schema={schema} engine={conn.engine}
              rowKeys={rowKeys ?? undefined} keyColumn={rowKeys ? 'ctid' : undefined}
              loadColumnMetadata={sqlDml ? async () => (await tableStructure(connId, schema ?? '', table)).columns.map(c => ({
                name: c.name, type: c.type, pk: c.key === 'PK' && conn.engine !== 'clickhouse', fk: c.key === 'FK', comment: c.comment || undefined,
              })) : undefined}
              livePreview truncated={live?.truncated} loadError={liveErr ?? undefined} />
          : <DataGrid
              columns={D.ordersColumns.map((c): ResultColumn => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
              rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
              statusTones={D.statusTones} density={density} key={table} />)}
        </div>
        <div id={`${viewId}-metadata-panel`} role="tabpanel" aria-labelledby={`${viewId}-${isRedis ? 'keyspace' : structureSection}`} style={{height:'100%',display:tableTab!=='data'?'block':'none'}}>
        {structureVisited && (isRedis
          ? <RedisKeyspaceView connId={connId ?? undefined} schema={schema} key={`ks.${schema ?? ''}`} />
          : <StructureView section={structureSection} table={table} schema={schema} connId={connId ?? undefined} engine={conn.engine} canEdit={caps.writable && caps.structureEdit} />)}
        </div>
      </div>
    </div>
  )
}
