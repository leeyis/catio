/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; E6 wires the live-connection data path
   Task 9: 统一 tab 系统 — 表/对象/查询/ER 平级共存,身份复用互不覆盖 */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { SqlConsole, ERDiagram } from '../dbviews'
import { CreateObjectModal } from '../dbviews/CreateObjectModal'
import { SchemaBrowser } from './SchemaBrowser'
import { TablePane } from './TablePane'
import { ObjectPane } from './ObjectPane'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections } from '../../state/dbConnections'
import { getSchema, runQuery, dbErrMsg, type DbCapabilities } from '../../services/db'
import type { Connection, Schema, SchemaNamespace } from '../../services/types'

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

/** 统一 tab:表预览 / 对象源码 / SQL 查询 / ER 图(照 dbx 的 QueryTab.mode 思路)。
 *  id 即身份键 → 单击侧边栏时同身份 tab 直接激活复用(findTabByIdentity)。 */
export type WorkbenchTab =
  | { id: string; kind: 'table'; schema: string; table: string }
  | { id: string; kind: 'object'; schema: string; name: string; objKind: 'view' | 'function' | 'procedure' }
  | { id: string; kind: 'sql'; qid: number; defaultSchema?: string }
  | { id: string; kind: 'er'; schema: string }

const tabIdOf = {
  table: (schema: string, table: string) => `table:${schema}.${table}`,
  object: (kind: string, schema: string, name: string) => `object:${kind}:${schema}.${name}`,
  sql: (qid: number) => `sql:${qid}`,
  er: (schema: string) => `er:${schema}`,
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

  // ---- Unified tab state ----
  // No live connection → seed the pixel-identical mock demo tab (public.orders).
  // A LIVE connection starts with NO table tab: the real first table is opened once
  // introspection returns (reconciliation effect below). Seeding the mock tab for a
  // real connection would auto-run `SELECT * FROM "public"."orders"` against a DB
  // that lacks it (达梦 reports 无效的模式名[public]).
  const [tabs, setTabs] = useState<WorkbenchTab[]>(
    connId ? [] : [{ id: tabIdOf.table('public', 'orders'), kind: 'table', schema: 'public', table: 'orders' }],
  )
  const [activeId, setActiveId] = useState<string | null>(connId ? null : tabIdOf.table('public', 'orders'))
  const [queryN, setQueryN] = useState(0)
  const [queryInitialCode, setQueryInitialCode] = useState<Record<number, string>>({})
  // 功能#3:每个 SQL tab 的一次性"seed + 自动执行"信号(历史「执行」兜底)。
  // seq 单调递增,SqlConsole 据此去重,避免重渲染重复执行。
  const [autoRunByTab, setAutoRunByTab] = useState<Record<string, { text: string; seq: number }>>({})
  const autoRunSeq = useRef(0)
  const activeTab = tabs.find(tb => tb.id === activeId) ?? null

  // ---- 侧栏整栏收起 (功能#2) — 仅本次会话内存 ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 每个 SQL 控制台上报的"是否最大化"(功能#6 父侧联动);活动 tab 最大化时联动收起侧栏。
  const [fsByTab, setFsByTab] = useState<Record<string, boolean>>({})
  // 有效收起 = 手动收起 || 当前活动 SQL 控制台处于最大化(activeId 可能为 null,安全取值)。
  const effectiveCollapsed = sidebarCollapsed || (activeId != null && !!fsByTab[activeId])

  // Open CREATE TABLE/VIEW form modal (null → closed). Carries the target schema + kind.
  const [createObj, setCreateObj] = useState<{ schema: string; kind: 'table' | 'view' } | null>(null)
  // Error surfaced when a CREATE statement fails to run.
  const [createErr, setCreateErr] = useState<string | null>(null)
  // 标签右键菜单(需求1):{tabId,x,y} 定位;全局 click / Escape 关闭。
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // Horizontally-scrollable tab strip — chevrons scroll it when tabs overflow.
  const tabStripRef = useRef<HTMLDivElement>(null)
  const scrollTabs = (dx: number) => tabStripRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  // ---- Real schema tree (only when connected) ----
  // `liveSchema` holds the backend-introspected schema; null means "use the mock schema".
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  // Surface introspection failures instead of swallowing them — a swallowed error
  // used to fall back to the mock demo tree, which then let the user query tables
  // the real database doesn't have.
  const [schemaErr, setSchemaErr] = useState<string | null>(null)
  // True while the backend is introspecting — drives the tree's skeleton placeholder
  // so a freshly-connected DB shows a loading state, not a blank/empty tree.
  const [schemaLoading, setSchemaLoading] = useState(false)
  useEffect(() => {
    if (!connId) { setLiveSchema(null); setSchemaErr(null); setSchemaLoading(false); return }
    let cancelled = false
    setSchemaErr(null)
    setLiveSchema(null)
    setSchemaLoading(true)
    getSchema(connId)
      .then(sc => { if (!cancelled) { setLiveSchema(sc); setSchemaErr(null) } })
      .catch(e => { if (!cancelled) { setLiveSchema(null); setSchemaErr(dbErrMsg(e)) } })
      .finally(() => { if (!cancelled) setSchemaLoading(false) })
    return () => { cancelled = true }
  }, [connId])

  // Re-introspect the live schema on demand (schema "刷新" action). No-op on the mock path.
  // refreshing 驱动刷新按钮转圈;失败不再吞错,refreshErr 以 toast 显示。
  const [refreshing, setRefreshing] = useState(false)
  const [refreshErr, setRefreshErr] = useState<string | null>(null)
  function refreshSchema() {
    if (!connId || refreshing) return
    setRefreshing(true)
    setRefreshErr(null)
    getSchema(connId)
      .then(sc => setLiveSchema(sc))
      .catch(e => setRefreshErr(dbErrMsg(e)))
      .finally(() => setRefreshing(false))
  }

  // All schema namespaces to render. A real connection renders the backend's
  // schema ONLY — never the mock/demo tree (showing fake tables a user could click
  // and then query against a real DB that lacks them is actively misleading). The
  // seeded demo tree is used only when there is no live connection.
  const namespaces: SchemaNamespace[] = useMemo(() => {
    if (connId) return liveSchema?.schemas ?? []
    return D.schema.schemas
  }, [connId, liveSchema, D.schema])

  // ---- tab 操作 ----

  /** 同身份 tab 已开 → 激活复用;否则追加并激活。 */
  function openTab(tab: WorkbenchTab) {
    setTabs(prev => (prev.some(x => x.id === tab.id) ? prev : [...prev, tab]))
    setActiveId(tab.id)
  }
  function pickTable(schema: string, name: string) {
    openTab({ id: tabIdOf.table(schema, name), kind: 'table', schema, table: name })
  }
  function pickObject(schema: string, name: string, kind: 'view' | 'function' | 'procedure') {
    openTab({ id: tabIdOf.object(kind, schema, name), kind: 'object', schema, name, objKind: kind })
  }
  /** autoRun=true → 新控制台在挂载后自动插入并执行该 SQL 一次(历史「执行」无窗口兜底,功能#3)。 */
  function newQuery(seed?: string, defaultSchema?: string, autoRun = false) {
    if (!caps.sqlConsole) return
    const id = queryN + 1
    setQueryN(id)
    // autoRun 由 autoRun 信号统一负责"插入+执行";若同时 seed initialCode 会让 SQL 重复一遍。
    if (autoRun && seed != null) {
      setAutoRunByTab(m => ({ ...m, [tabIdOf.sql(id)]: { text: seed, seq: ++autoRunSeq.current } }))
    } else if (seed != null) {
      setQueryInitialCode(m => ({ ...m, [id]: seed }))
    }
    openTab({ id: tabIdOf.sql(id), kind: 'sql', qid: id, defaultSchema })
  }
  /** Open the CREATE TABLE/VIEW form modal for `schema`. No-op without a live connection. */
  function onNewObjectTemplate(schema: string, kind: 'table' | 'view') {
    if (!connId) return
    setCreateErr(null)
    setCreateObj({ schema, kind })
  }
  function openER(schema?: string) {
    if (!caps.er) return
    const s = schema ?? namespace.name
    openTab({ id: tabIdOf.er(s), kind: 'er', schema: s })
  }
  /** 关闭 tab;若关的是当前 tab,激活右侧相邻(无则左侧),全关后为空状态。
   *  全函数式更新:批量/程序化连续关闭也不会用陈旧 tabs 覆盖。 */
  function closeTab(id: string) {
    setTabs(prev => {
      const idx = prev.findIndex(x => x.id === id)
      if (idx < 0) return prev
      const next = prev.filter(x => x.id !== id)
      setActiveId(cur => (cur === id ? (next.length ? next[Math.min(idx, next.length - 1)].id : null) : cur))
      return next
    })
  }
  /** 关闭除 id 外的其余 tab,并激活该 id。 */
  function closeOthers(id: string) {
    setTabs(prev => prev.filter(x => x.id === id))
    setActiveId(id)
  }
  /** 关闭全部 tab,进入空状态。 */
  function closeAll() {
    setTabs([])
    setActiveId(null)
  }

  // Live schema 加载后:仅剔除已不存在的表 tab(reconcile);不再自动打开第一张表
  // ——按用户要求把"看哪张表"的选择权交还给用户(连接后停在空状态,树也默认折叠)。
  useEffect(() => {
    if (!connId || !liveSchema || !liveSchema.schemas.length) return
    const exists = (s: string, tname: string) => liveSchema.schemas.some(
      n => n.name === s && (n.tables.some(x => x.name === tname) || n.views.some(v => v.name === tname)),
    )
    setTabs(prev => {
      const kept = prev.filter(tb => tb.kind !== 'table' || exists(tb.schema, tb.table))
      return kept.length === prev.length ? prev : kept
    })
  }, [connId, liveSchema])

  // Real connection whose introspection FAILED or returned no schemas: drop the
  // seeded demo table/object/ER tabs so we never auto-query a mock table the real
  // database doesn't have (the source of the misleading "无效的模式名[public]"). SQL
  // tabs are kept — the user can still run queries. (Success/non-empty is handled
  // by the reconciliation effect above.)
  useEffect(() => {
    if (!connId) return
    const settledEmpty = schemaErr != null || (liveSchema != null && liveSchema.schemas.length === 0)
    if (!settledEmpty) return
    setTabs(prev => (prev.some(tb => tb.kind !== 'sql') ? prev.filter(tb => tb.kind === 'sql') : prev))
  }, [connId, schemaErr, liveSchema])

  // activeId 失效(指向已被剔除的 tab)时回落到最后一个 tab。
  useEffect(() => {
    if (activeId && tabs.some(tb => tb.id === activeId)) return
    setActiveId(tabs.length ? tabs[tabs.length - 1].id : null)
  }, [tabs, activeId])

  // The namespace currently being viewed (drives namespace-level operations like ER/new-object).
  const namespace: SchemaNamespace = useMemo(() => {
    return namespaces.find(n => n.name === (activeTab?.kind === 'table' ? activeTab.schema : ''))
      ?? namespaces[0]
  }, [namespaces, activeTab])

  // ---- 功能#3:历史「执行」无窗口兜底 ----
  // catio-run 全局派发。激活 tab 为 SQL 控制台时由 SqlConsole 自行处理(行为不变);
  // 当激活 tab 不是 SQL 控制台时,DbWorkbench 介入:有已开 SQL tab → 切到最近的那个并执行,
  // 否则新建一个并 seed + 自动执行。仅可见 workbench(shown)响应。
  // 处理逻辑放进每渲染更新的 ref,监听只按 [shown] 订阅一次,避免每次状态变化重订阅。
  const runFallbackRef = useRef<(text: string) => void>(() => {})
  runFallbackRef.current = (text: string) => {
    if (!caps.sqlConsole) return
    // 激活 tab 即 SQL 控制台 → 不介入(SqlConsole 现有逻辑会处理)。
    if (activeTab?.kind === 'sql') return
    // 有已开 SQL tab(非激活)→ 切到最近打开的那个,再 seed + 执行。
    const lastSql = [...tabs].reverse().find(tb => tb.kind === 'sql')
    if (lastSql) {
      setActiveId(lastSql.id)
      setAutoRunByTab(m => ({ ...m, [lastSql.id]: { text, seq: ++autoRunSeq.current } }))
      return
    }
    // 完全没有 SQL tab → 新建并 seed + 自动执行。
    newQuery(text, namespace?.name, true)
  }
  useEffect(() => {
    if (!shown) return
    const onRun = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; text?: string }>
      if (!ce.detail || ce.detail.kind !== 'sql' || typeof ce.detail.text !== 'string') return
      runFallbackRef.current(ce.detail.text)
    }
    window.addEventListener('catio-run', onRun)
    return () => window.removeEventListener('catio-run', onRun)
  }, [shown])

  // 标签右键菜单:全局 click / Escape 关闭(参照 WorkbenchTabs)。
  useEffect(() => {
    if (!tabMenu) return
    const onClickOutside = () => setTabMenu(null)
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setTabMenu(null) }
    window.addEventListener('click', onClickOutside)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onClickOutside)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [tabMenu])

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', width: '100%', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SchemaBrowser onPick={pickTable} onPickObject={pickObject}
        active={activeTab?.kind === 'table' ? { schema: activeTab.schema, table: activeTab.table } : null}
        onNewQuery={(schema) => newQuery(undefined, schema ?? namespace.name)} onOpenER={openER} onNewObjectTemplate={onNewObjectTemplate} onRefresh={refreshSchema}
        refreshing={refreshing}
        erActive={activeTab?.kind === 'er'} sqlActive={activeTab?.kind === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er}
        canSqlConsole={caps.sqlConsole} canEr={caps.er} canStructureEdit={caps.structureEdit}
        collapsed={effectiveCollapsed} onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        schemas={connId ? namespaces : undefined} conn={connId ? conn : undefined} live={!!connId} loading={schemaLoading} />
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {/* 统一 tab strip:表 / 对象 / 查询 / ER 平级,身份复用,全部保持 mounted。 */}
        {tabs.length > 0 && (
          <div className="row" style={{ gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', width: '100%', minWidth: 0, alignItems: 'center' }}>
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollLeft')} onClick={() => scrollTabs(-160)}><Icon name="chevron-left" size={14} /></button>
            <div ref={tabStripRef} className="row" style={{ gap: 6, flex: 1, minWidth: 0, overflowX: 'auto' }}>
              {tabs.map(tb => {
                const isActive = tb.id === activeId
                const icon = tb.kind === 'table' ? 'table-2'
                  : tb.kind === 'sql' ? 'file-code'
                  : tb.kind === 'er' ? 'network'
                  : tb.objKind === 'view' ? 'eye' : 'function-square'
                const label = tb.kind === 'table' ? tb.table
                  : tb.kind === 'sql' ? `query-${tb.qid}.sql`
                  : tb.kind === 'er' ? `ER · ${tb.schema}`
                  : tb.name
                return (
                  <div key={tb.id} data-testid={`wbtab-${tb.id}`} onClick={() => setActiveId(tb.id)}
                    onContextMenu={e => { e.preventDefault(); setTabMenu({ tabId: tb.id, x: e.clientX, y: e.clientY }) }}
                    className="row gap6" title={label}
                    style={{ flex: 'none', alignItems: 'center', height: 26, padding: '0 6px 0 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                      background: isActive ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                    <Icon name={icon} size={12} /> <span className="ell mono" style={{ maxWidth: 140 }}>{label}</span>
                    <button className="icon-btn bare" data-testid={`wbtab-close-${tb.id}`} style={{ width: 18, height: 18 }} title={t('shell.close')} onClick={e => { e.stopPropagation(); closeTab(tb.id) }}><Icon name="x" size={11} /></button>
                  </div>
                )
              })}
            </div>
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollRight')} onClick={() => scrollTabs(160)}><Icon name="chevron-right" size={14} /></button>
          </div>
        )}
        {/* 标签右键菜单(需求1):关闭当前 / 关闭其他 / 关闭所有。 */}
        {tabMenu && (
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', left: tabMenu.x, top: tabMenu.y, zIndex: 200,
              background: 'var(--surface-card)', border: '1px solid var(--border-hairline)',
              borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', padding: '4px 0', minWidth: 160,
            }}>
            {[
              { label: t('workbench.closeCurrent'), action: () => { closeTab(tabMenu.tabId); setTabMenu(null) } },
              { label: t('workbench.closeOthers'), action: () => { closeOthers(tabMenu.tabId); setTabMenu(null) } },
              { label: t('workbench.closeAll'), action: () => { closeAll(); setTabMenu(null) } },
            ].map(item => (
              <button
                key={item.label}
                onClick={item.action}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '7px 14px',
                  border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-soft)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {/* panes — 全部 mounted,display 切换,切回状态原样(与原 SQL console 同款机制)。 */}
        <div className="grow" style={{ minHeight: 0, minWidth: 0, position: 'relative' }}>
          {tabs.map(tb => (
            <div key={tb.id} className="col" style={{ height: '100%', width: '100%', minHeight: 0, minWidth: 0, display: tb.id === activeId ? 'flex' : 'none' }}>
              {tb.kind === 'table' && (
                <TablePane conn={conn} connId={connId} caps={caps} schema={tb.schema} table={tb.table} density={density} />
              )}
              {tb.kind === 'object' && (
                <ObjectPane connId={connId} schema={tb.schema} name={tb.name} objKind={tb.objKind} />
              )}
              {tb.kind === 'sql' && (
                <SqlConsole density={density} fresh queryN={tb.qid} writable={caps.writable} connId={connId ?? undefined}
                  initialCode={queryInitialCode[tb.qid]} initialDefaultSchema={tb.defaultSchema} autoRun={autoRunByTab[tb.id]}
                  onFullscreenChange={(fs) => setFsByTab(m => (m[tb.id] === fs ? m : { ...m, [tb.id]: fs }))}
                  active={shown && tb.id === activeId} engine={conn.engine} connName={conn.name} profileId={conn.id} />
              )}
              {tb.kind === 'er' && (
                <ERDiagram connId={connId ?? undefined} schema={tb.schema} onOpenTable={tname => pickTable(tb.schema, tname)} />
              )}
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-faint)' }}>
              <Icon name="table-2" size={28} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('workbench.noTabs')}</span>
              <span style={{ fontSize: 11.5 }}>{t('workbench.noTabsHint')}</span>
            </div>
          )}
        </div>
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
        {refreshErr && (
          /* createErr toast 占同一角落时上移错开,避免互相遮挡。 */
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: createErr ? 58 : 12, zIndex: 80, maxWidth: 420, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
            <span>{t('workbench.refreshFailed', { message: refreshErr })}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => setRefreshErr(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
        {schemaErr && (
          /* 库结构加载失败:不再静默回落到 mock 演示树,而是明确报错。 */
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: 12 + (createErr ? 46 : 0) + (refreshErr ? 46 : 0), zIndex: 80, maxWidth: 460, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
            <span>{t('workbench.schemaLoadFailed', { message: schemaErr })}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => setSchemaErr(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
