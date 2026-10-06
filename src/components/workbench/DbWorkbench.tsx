/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7; E6 wires the live-connection data path
   Task 9: 统一 tab 系统 — 表/对象/查询/ER 平级共存,身份复用互不覆盖 */
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConfirmModal } from '../modals/ConfirmModal'
import { useQuerySessionWork } from '../../state/querySessionWork'
import { DatabaseWorkProvider,useDatabaseDraftWork,hasPendingDatabaseWork,hasBusyDatabaseDraftWork } from '../../state/databaseDraftWork'
import { SqlConsole, ERDiagram } from '../dbviews'
import { CreateObjectModal } from '../dbviews/CreateObjectModal'
import { ObjectAdminModal } from '../dbviews/ObjectAdminModal'
import { DatabaseExportDialog, type DatabaseExportRequest } from '../dbviews/DatabaseExportDialog'
import { DataTransferDialog, type TransferConnectionOption } from '../dbviews/DataTransferDialog'
import { buildCreateTableDDL, dialectFor, qualifiedTable, supportsDdlExport } from '../dbviews/structureDdl'
import { SchemaBrowser } from './SchemaBrowser'
import { useMetadataTree } from './useMetadataTree'
import { ComparePane } from './ComparePane'
import { TablePane } from './TablePane'
import { ObjectPane } from './ObjectPane'
import './databaseWorkspace.css'
import { DatabaseCommandPalette,type DatabaseCommand } from './DatabaseCommandPalette'
import { useData } from '../../state/DataContext'
import { listActiveDbConnections, useActiveDbConnections } from '../../state/dbConnections'
import { runQuery, dropObject, renameObject, truncateTable, duplicateTableStructure, tableStructure, exportDatabaseSql, exportFile, dbErrMsg, preferredNamespace, type DbCapabilities } from '../../services/db'
import type { Connection, SchemaNamespace } from '../../services/types'

export interface DbWorkbenchProps {
  conn: Connection
  workspaceTabId?: string
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
  views: true,
  functions: true,
}

/** 统一 tab:表预览 / 对象源码 / SQL 查询 / ER 图(照 dbx 的 QueryTab.mode 思路)。
 *  id 即身份键 → 单击侧边栏时同身份 tab 直接激活复用(findTabByIdentity)。 */
export type WorkbenchTab = (
  | { id: string; kind: 'table'; schema: string; table: string }
  | { id: string; kind: 'object'; schema: string; name: string; objKind: 'view' | 'function' | 'procedure' }
  | { id: string; kind: 'sql'; qid: number; defaultSchema?: string }
  | { id: string; kind: 'er'; schema: string }
  | { id: string; kind: 'compare' }) & { preview?:boolean }

const identityPart=(name:string)=>encodeURIComponent(name).replace(/\./g, '%2E')
export const tabIdOf = {
  table: (schema: string, table: string) => `table:${identityPart(schema)}.${identityPart(table)}`,
  object: (kind: string, schema: string, name: string) => `object:${kind}:${identityPart(schema)}.${identityPart(name)}`,
  sql: (qid: number) => `sql:${qid}`,
  er: (schema: string) => `er:${identityPart(schema)}`,
  compare: () => 'compare',
}

export function DbWorkbench({ conn, density, active: shown = true, workspaceTabId }: DbWorkbenchProps) {
  const { t } = useTranslation()
  const D = useData()
  const workbenchId=workspaceTabId??conn.id
  const sessionWork=useQuerySessionWork()
  const drafts=useDatabaseDraftWork()
  const [queryCloseAction,setQueryCloseAction]=useState<(()=>void)|null>(null)
  const pendingQueryTab=(id:string)=>hasPendingDatabaseWork({ownerId:workbenchId+':'+id})

  // Resolve the active live connection (if any): the first one whose profileId matches conn.id.
  // When present (Tauri + connected) we drive the grid from the backend; otherwise we keep the
  // mock/demo path pixel-identical. caps falls back to ALL_ENABLED when not connected.
  const active = useMemo(
    () => listActiveDbConnections().find(a => a.profileId === conn.id),
    [conn.id],
  )
  const caps: DbCapabilities = active ? active.capabilities : ALL_ENABLED
  const connId = active?.connId ?? null

  // 跨库迁移的连接候选(源+目标都从这里选):全部当前活动连接,以 connId 为标识。
  // engine=dbType 用于判定目标是否支持原生 upsert(DataTransferDialog 内部用)。
  // 用响应式 useActiveDbConnections 订阅活动连接store:用户在本 workbench 挂载之后
  // 才连上目标库时,候选列表会随之刷新(否则目标会从迁移对话框的连接选择器里消失,
  // 让跨库迁移这个核心场景静默失效)。
  const activeConns = useActiveDbConnections()
  const transferConnections: TransferConnectionOption[] = useMemo(
    () => activeConns.map(c => ({ id: c.connId, name: c.name, engine: c.dbType })),
    [activeConns],
  )

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
  const [sidebarWidth,setSidebarWidth]=useState(216)
  const sidebarDrag=useRef<{x:number;width:number}|null>(null)
  // 每个 SQL 控制台上报的"是否最大化"(功能#6 父侧联动);活动 tab 最大化时联动收起侧栏。
  const [fsByTab, setFsByTab] = useState<Record<string, boolean>>({})
  // 有效收起 = 手动收起 || 当前活动 SQL 控制台处于最大化(activeId 可能为 null,安全取值)。
  const effectiveCollapsed = sidebarCollapsed || (activeId != null && !!fsByTab[activeId])

  // Open CREATE TABLE/VIEW form modal (null → closed). Carries the target schema + kind.
  const [createObj, setCreateObj] = useState<{ schema: string; kind: 'table' | 'view' } | null>(null)
  // 对象管理(删除/重命名/清空表/复制表结构)的目标 + 操作,驱动 ObjectAdminModal。
  const [adminObj, setAdminObj] = useState<{ op: 'drop' | 'rename' | 'truncate' | 'duplicate'; objectType: 'TABLE' | 'VIEW'; schema: string; name: string } | null>(null)
  // 对象管理操作的结果提示(成功 toast / 失败错误)。
  const [adminMsg, setAdminMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 整库导出对话框的目标 schema(null → 关闭)。
  const [exportSchema, setExportSchema] = useState<string | null>(null)
  // D3 跨库迁移对话框的迁移源(schema.table;null → 关闭)。源连接固定为当前 live connId。
  const [transferSource, setTransferSource] = useState<{ schema: string; table: string } | null>(null)
  // Error surfaced when a CREATE statement fails to run.
  const [createErr, setCreateErr] = useState<string | null>(null)
  // 标签右键菜单(需求1):{tabId,x,y} 定位;全局 click / Escape 关闭。
  const [commandsOpen,setCommandsOpen]=useState(false)
  useEffect(()=>{if(!shown)setCommandsOpen(false)},[shown,connId])
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // Horizontally-scrollable tab strip — chevrons scroll it when tabs overflow.
  const tabStripRef = useRef<HTMLDivElement>(null)
  const scrollTabs = (dx: number) => tabStripRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  const metadata=useMetadataTree(connId??undefined)
  const liveSchema=metadata.schema, schemaErr=metadata.error, schemaLoading=metadata.loading
  const refreshing=metadata.refreshing, refreshErr=metadata.refreshError
  const refreshSchema=metadata.refresh

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
    setTabs(prev => {
      const existing=prev.find(x=>x.id===tab.id)
      if(existing)return tab.preview===false&&existing.preview?prev.map(x=>x.id===tab.id?{...x,preview:false}:x):prev
      return [...prev.filter(x=>!tab.preview||!x.preview||pendingQueryTab(x.id)),tab]
    })
    setActiveId(tab.id)
  }
  function pickTable(schema: string, name: string, pinned=false) {
    openTab({ id: tabIdOf.table(schema, name), kind: 'table', schema, table: name,preview:!pinned })
  }
  function pickObject(schema: string, name: string, kind: 'view' | 'function' | 'procedure',pinned=false) {
    openTab({ id: tabIdOf.object(kind, schema, name), kind: 'object', schema, name, objKind: kind,preview:!pinned })
  }
  function pinTab(id:string){setTabs(prev=>prev.map(tab=>tab.id===id&&tab.preview?{...tab,preview:false}:tab))}
  useEffect(()=>{setTabs(prev=>{let changed=false;const next=prev.map(tab=>{if(tab.preview&&drafts.some(item=>item.ownerId===workbenchId+':'+tab.id&&(item.dirty||item.busy))){changed=true;return {...tab,preview:false}}return tab});return changed?next:prev})},[drafts,workbenchId])

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
  /** Open the Data Compare tab (source/target tables picked inside the pane). */
  function openCompare() {
    openTab({ id: tabIdOf.compare(), kind: 'compare' })
  }
  /** Open the CREATE TABLE/VIEW form modal for `schema`. No-op without a live connection. */
  function onNewObjectTemplate(schema: string, kind: 'table' | 'view') {
    if (!connId) return
    setCreateErr(null)
    setCreateObj({ schema, kind })
  }
  /**
   * 执行整库导出:对选中表逐表取结构 → 用 structureDdl 拼 CREATE TABLE(approximation,
   * 与结构面板 DDL 同源)→ 调 T13 service exportDatabaseSql 让后端分页取数 + 组装脚本 →
   * 通过 save 对话框选目标 .sql,后端 exportFile 落盘。落盘真机验证见 notes。
   */
  async function runDatabaseExport(schema: string, req: DatabaseExportRequest) {
    if (!connId) return
    const dialect = dialectFor(conn.engine)
    // 要导出的表名:undefined 表示「全部」→ 取该 schema 当前树里的全部表名。
    const ns = namespaces.find(n => n.name === schema)
    const tableNames = req.selectedTables ?? (ns?.tables.map(t => t.name) ?? [])
    // 逐表取结构 → 拼 DDL(仅在需要结构时)。某表取结构失败必须中止整次导出并上报:
    // 静默跳过会让该表 DDL 悄悄从输出消失,后端仍写文件并弹成功 toast(误导)。抛出由
    // dialog 的 catch 捕获,展示到内联错误区,且不会走到后续落盘。
    const tableDdls: Record<string, string> = {}
    if (req.includeStructure) {
      for (const name of tableNames) {
        try {
          const st = await tableStructure(connId, schema, name)
          tableDdls[name] = buildCreateTableDDL(dialect, qualifiedTable(dialect, schema, name), st)
        } catch (e) {
          throw new Error(t('dbexport.ddlFailed', { table: name, message: dbErrMsg(e) }))
        }
      }
    }
    const script = await exportDatabaseSql({
      connId, database: schema, schema,
      selectedTables: req.selectedTables ?? [],
      tableDdls,
      includeStructure: req.includeStructure,
      includeData: req.includeData,
      batchSize: req.batchSize,
      rowLimit: req.rowLimit,
    })
    // 选目标文件并落盘(webview <a download> 在 Tauri 内为 no-op,走后端 exportFile)。
    const { save } = await import('@tauri-apps/plugin-dialog')
    const safeName = (schema || 'database').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'database'
    const path = await save({ defaultPath: `${safeName}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
    if (!path) return // 用户取消保存
    await exportFile(path, script)
    setExportSchema(null)
    setAdminMsg({ kind: 'ok', text: t('dbexport.exported', { path }) })
  }
  function openER(schema?: string) {
    if (!caps.er) return
    const s = schema ?? namespace.name
    openTab({ id: tabIdOf.er(s), kind: 'er', schema: s })
  }
  /** 关闭 tab;若关的是当前 tab,激活右侧相邻(无则左侧),全关后为空状态。
   *  全函数式更新:批量/程序化连续关闭也不会用陈旧 tabs 覆盖。 */
  function closeTab(id: string, confirmed = false) {
    if(hasBusyDatabaseDraftWork({ownerId:workbenchId+':'+id})){setQueryCloseAction(()=>()=>closeTab(id));return}
    if(confirmed!==true&&pendingQueryTab(id)){setQueryCloseAction(()=>()=>closeTab(id,true));return}
    setTabs(prev => {
      const idx = prev.findIndex(x => x.id === id)
      if (idx < 0) return prev
      const next = prev.filter(x => x.id !== id)
      setActiveId(cur => (cur === id ? (next.length ? next[Math.min(idx, next.length - 1)].id : null) : cur))
      return next
    })
  }
  /** 关闭除 id 外的其余 tab,并激活该 id。 */
  function closeOthers(id: string, confirmed = false) {
    if(confirmed!==true&&tabs.some(tab=>tab.id!==id&&pendingQueryTab(tab.id))){setQueryCloseAction(()=>()=>closeOthers(id,true));return}
    if(tabs.some(tab=>tab.id!==id&&hasBusyDatabaseDraftWork({ownerId:workbenchId+':'+tab.id}))){setQueryCloseAction(()=>()=>closeOthers(id));return}
    setTabs(prev => prev.filter(x => x.id === id))
    setActiveId(id)
  }
  /** 关闭全部 tab,进入空状态。 */
  function closeAll(confirmed = false) {
    if(confirmed!==true&&tabs.some(tab=>pendingQueryTab(tab.id))){setQueryCloseAction(()=>()=>closeAll(true));return}
    if(hasBusyDatabaseDraftWork({workbenchId})){setQueryCloseAction(()=>()=>closeAll());return}
    setTabs([])
    setActiveId(null)
  }

  // Live schema 加载后:仅剔除已不存在的表 tab(reconcile);不再自动打开第一张表
  // ——按用户要求把"看哪张表"的选择权交还给用户(连接后停在空状态,树也默认折叠)。
  useEffect(() => {
    if (!connId || !liveSchema || !liveSchema.schemas.length) return
    const exists = (s: string, tname: string) => liveSchema.schemas.some(
      n => n.name === s && ((n.status && n.status!=='loaded') || n.tables.some(x => x.name === tname) || n.views.some(v => v.name === tname)),
    )
    setTabs(prev => {
      const kept = prev.filter(tb => tb.kind !== 'table' || exists(tb.schema, tb.table) || pendingQueryTab(tb.id))
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
    setTabs(prev => (prev.some(tb => tb.kind !== 'sql') ? prev.filter(tb => tb.kind === 'sql' || pendingQueryTab(tb.id)) : prev))
  }, [connId, schemaErr, liveSchema])

  // activeId 失效(指向已被剔除的 tab)时回落到最后一个 tab。
  useEffect(() => {
    if (activeId && tabs.some(tb => tb.id === activeId)) return
    setActiveId(tabs.length ? tabs[tabs.length - 1].id : null)
  }, [tabs, activeId])

  // The namespace currently being viewed (drives namespace-level operations like ER/new-object).
  const namespace: SchemaNamespace = useMemo(() => {
    const explicit = activeTab?.kind === 'sql' ? activeTab.defaultSchema
      : activeTab && 'schema' in activeTab ? activeTab.schema : undefined
    const name = preferredNamespace(namespaces.map(ns => ns.name), explicit, liveSchema?.defaultNamespace)
    return namespaces.find(ns => ns.name === name) ?? namespaces[0]
  }, [namespaces, activeTab, liveSchema?.defaultNamespace])

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

  const commands:DatabaseCommand[]=[
    ...(caps.sqlConsole?[{id:'query',label:t('workbench.newQuery'),icon:'file-code',run:()=>newQuery(undefined,namespace?.name)}]:[]),
    ...(caps.er?[{id:'er',label:t('workbench.erDiagram'),icon:'network',run:()=>openER()}]:[]),
    ...(connId?[{id:'compare',label:t('compare.title'),icon:'git-compare',run:openCompare}]:[]),
    {id:'refresh',label:t('workbench.refresh'),icon:'refresh-cw',run:refreshSchema},
    ...namespaces.flatMap(ns=>[
      ...ns.tables.map(table=>({id:tabIdOf.table(ns.name,table.name),label:table.name,detail:ns.name,icon:'table-2',run:()=>pickTable(ns.name,table.name,true)})),
      ...(caps.views?ns.views.map(view=>({id:tabIdOf.object('view',ns.name,view.name),label:view.name,detail:ns.name,icon:'eye',run:()=>pickObject(ns.name,view.name,'view',true)})):[]),
      ...(caps.functions?ns.functions.map(fn=>({id:tabIdOf.object('function',ns.name,fn.name),label:fn.name,detail:ns.name,icon:'function-square',run:()=>pickObject(ns.name,fn.name,'function',true)})):[]),
    ]),
  ]
  return (
    <DatabaseWorkProvider owner={{ownerId:workbenchId+':tasks',workbenchId,profileId:conn.id}}><div className="db-workbench" onKeyDown={event=>{if(shown&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229&&(event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'){event.preventDefault();event.stopPropagation();setCommandsOpen(true)}}} style={{ display: 'flex', alignItems: 'stretch', height: '100%', width: '100%', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SchemaBrowser width={sidebarWidth} visible={shown} onPick={pickTable} onPickObject={pickObject} onPin={(schema,name)=>pickTable(schema,name,true)} onPinObject={(schema,name,kind)=>pickObject(schema,name,kind,true)}
        active={activeTab?.kind === 'table' ? { schema: activeTab.schema, table: activeTab.table } : null}
        onNewQuery={(schema) => newQuery(undefined, schema ?? namespace?.name)} onOpenER={openER} onOpenCompare={connId ? openCompare : undefined} onOpenCommands={()=>setCommandsOpen(true)} onNewObjectTemplate={onNewObjectTemplate} onRefresh={refreshSchema}
        onObjectAdmin={connId ? (op, objectType, schema, name) => setAdminObj({ op, objectType, schema, name }) : undefined}
        onTransferData={connId ? (schema, table) => setTransferSource({ schema, table }) : undefined}
        onExportDatabase={connId && supportsDdlExport(conn.engine) ? (schema) => setExportSchema(schema) : undefined}
        refreshing={refreshing}
        erActive={activeTab?.kind === 'er'} sqlActive={activeTab?.kind === 'sql'}
        disabledSql={!caps.sqlConsole} disabledEr={!caps.er}
        canSqlConsole={caps.sqlConsole} canEr={caps.er} canStructureEdit={caps.structureEdit}
        canViews={caps.views} canFunctions={caps.functions}
        collapsed={effectiveCollapsed} onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        schemas={connId ? namespaces : undefined} connId={connId??undefined} onLoadNamespace={metadata.loadNamespace} conn={connId ? conn : undefined} live={!!connId} loading={schemaLoading} />
      {!effectiveCollapsed&&<div role="separator" aria-orientation="vertical" aria-label={t('dbviews.resizeColumnHint')} tabIndex={0} onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setSidebarWidth(width=>Math.max(176,Math.min(360,width+(event.key==='ArrowLeft'?-12:12))))}}} onPointerDown={event=>{event.preventDefault();sidebarDrag.current={x:event.clientX,width:sidebarWidth};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{const drag=sidebarDrag.current;if(drag)setSidebarWidth(Math.max(176,Math.min(360,drag.width+event.clientX-drag.x)))}} onPointerUp={event=>{sidebarDrag.current=null;event.currentTarget.releasePointerCapture(event.pointerId)}} onLostPointerCapture={()=>{sidebarDrag.current=null}} style={{width:5,flex:'none',cursor:'col-resize',background:'var(--surface-subtle)'}}/>}
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {commandsOpen&&shown&&<DatabaseCommandPalette commands={commands} onClose={()=>setCommandsOpen(false)}/>}
        {/* 统一 tab strip:表 / 对象 / 查询 / ER 平级,身份复用,全部保持 mounted。 */}
        {tabs.length > 0 && (
          <div className="db-document-tabs">
            <button className="icon-btn bare" style={{ width: 24, height: 24, flex: 'none' }} title={t('workbench.scrollLeft')} onClick={() => scrollTabs(-160)}><Icon name="chevron-left" size={14} /></button>
            <div ref={tabStripRef} role="tablist" aria-label={t('dbviews.workspace.title')} className="row" style={{ gap: 0, flex: 1, minWidth: 0, overflowX: 'auto' }}>
              {tabs.map(tb => {
                const isActive = tb.id === activeId
                const sessionState=sessionWork.find(item=>item.ownerId===workbenchId+':'+tb.id)?.info.transactionState
                const icon = tb.kind === 'table' ? 'table-2'
                  : tb.kind === 'sql' ? 'file-code'
                  : tb.kind === 'er' ? 'network'
                  : tb.kind === 'compare' ? 'git-compare'
                  : tb.objKind === 'view' ? 'eye' : 'function-square'
                const label = tb.kind === 'table' ? tb.table
                  : tb.kind === 'sql' ? `query-${tb.qid}.sql`
                  : tb.kind === 'er' ? `ER · ${tb.schema}`
                  : tb.kind === 'compare' ? t('compare.title')
                  : tb.name
                return (
                  <div key={tb.id} role="tab" aria-selected={isActive} tabIndex={isActive?0:-1} data-active={isActive} data-testid={`wbtab-${tb.id}`} onClick={() => setActiveId(tb.id)}
                    onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(['Enter',' '].includes(event.key)){event.preventDefault();setActiveId(tb.id)}else if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const index=tabs.findIndex(t=>t.id===tb.id);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;setActiveId(tabs[next].id);tabStripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()}}}
                    onDoubleClick={()=>pinTab(tb.id)} onContextMenu={e => { e.preventDefault(); setTabMenu({ tabId: tb.id, x: e.clientX, y: e.clientY }) }}
                    className="db-document-tab" title={label}>
                    <Icon name={icon} size={12} /> {sessionState && sessionState!=='idle' && <span className="dot" title={t(`dbviews.txState.${sessionState}`)} style={{background:sessionState==='failed'?'var(--danger-fg)':'var(--signal-amber)'}}/>} <span className="ell mono" style={{ maxWidth: 140,fontStyle:tb.preview?'italic':undefined }}>{label}</span>
                    {tb.preview&&<button className="icon-btn bare" data-testid={'wbtab-pin-'+tb.id} title={t('dbviews.pinTab')} onClick={event=>{event.stopPropagation();pinTab(tb.id)}}><Icon name="pin" size={12}/></button>}
                    {drafts.some(item=>item.ownerId===workbenchId+':'+tb.id&&item.dirty)&&<span className="dot" title={t('dbviews.unsavedEdits')} style={{background:'var(--signal-amber)'}}/>}
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
              ...(tabs.find(tab=>tab.id===tabMenu.tabId)?.preview?[{label:t('dbviews.pinTab'),action:()=>{pinTab(tabMenu.tabId);setTabMenu(null)}}]:[]),
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
              <DatabaseWorkProvider owner={{ownerId:workbenchId+':'+tb.id,workbenchId,profileId:conn.id}}>
              {tb.kind === 'table' && (
                <TablePane conn={conn} connId={connId} caps={caps} schema={tb.schema} table={tb.table} density={density} />
              )}
              {tb.kind === 'object' && (
                <ObjectPane canEdit={caps.writable&&caps.structureEdit} connId={connId} connName={conn.name} schema={tb.schema} name={tb.name} objKind={tb.objKind} engine={conn.engineId ?? conn.engine} />
              )}
              {tb.kind === 'sql' && (
                <SqlConsole density={density} fresh queryN={tb.qid} writable={caps.writable} connId={connId ?? undefined}
                  querySessions={!!caps.querySessions} workbenchId={workbenchId} sessionOwnerId={workbenchId+':'+tb.id}
                  initialCode={queryInitialCode[tb.qid]} initialDefaultSchema={tb.defaultSchema} autoRun={autoRunByTab[tb.id]}
                  onFullscreenChange={(fs) => setFsByTab(m => (m[tb.id] === fs ? m : { ...m, [tb.id]: fs }))}
                  active={shown && tb.id === activeId} engine={conn.engine} engineId={conn.engineId} connName={conn.name} profileId={conn.id} />
              )}
              {tb.kind === 'er' && (
                <ERDiagram connId={connId ?? undefined} schema={tb.schema} onOpenTable={tname => pickTable(tb.schema, tname,true)} />
              )}
              {tb.kind === 'compare' && (
                <ComparePane connId={connId ?? ''} engine={conn.engine} schemas={namespaces} />
              )}
              </DatabaseWorkProvider>
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="db-welcome">
              <div className="db-welcome-mark"><Icon name="database" size={26}/></div>
              <span className="mono" style={{fontSize:11}}>{conn.name} · {conn.engineId??conn.engine}</span>
              <h2>{t('dbviews.workspace.welcome')}</h2>
              <p>{t(['mongodb','redis','elasticsearch'].includes(conn.engine??'')?'workbench.noTabsHint':'dbviews.workspace.welcomeHint')}</p>
              <span className="db-welcome-shortcut"><kbd>Ctrl / ⌘ Shift P</kbd>{t('dbviews.commands')}</span>
            </div>
          )}
        </div>
        {queryCloseAction && <ConfirmModal title={t('dbviews.draftCloseTitle')} message={<>{t('dbviews.databaseCloseWarning')}{hasBusyDatabaseDraftWork({workbenchId})&&<div role="status">{t('dbviews.pendingWorkHint')}</div>}</>}
          confirmLabel={t('dbviews.discardAndClose')} cancelLabel={t('dbviews.keepWork')} confirmDisabled={hasBusyDatabaseDraftWork({workbenchId})} danger confirmIcon="x"
          onCancel={()=>setQueryCloseAction(null)} onConfirm={()=>{const action=queryCloseAction;setQueryCloseAction(null);action()}}/>}
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
        {/* 对象管理(删除/重命名/清空表/复制表结构)确认弹窗 — 仅 live 连接。 */}
        {adminObj && connId && (
          <ObjectAdminModal
            op={adminObj.op}
            objectType={adminObj.objectType}
            schema={adminObj.schema}
            name={adminObj.name}
            onCancel={() => setAdminObj(null)}
            onConfirm={async payload => {
              const { op, objectType, schema, name } = adminObj
              try {
                if (op === 'drop') await dropObject(connId, objectType, schema, name)
                else if (op === 'truncate') await truncateTable(connId, schema, name)
                else if (op === 'rename') await renameObject(connId, objectType, schema, name, payload ?? '')
                else await duplicateTableStructure(connId, schema, name, payload ?? '')
                setAdminObj(null)
                const okKey = op === 'drop' ? 'okDrop' : op === 'truncate' ? 'okTruncate' : op === 'rename' ? 'okRename' : 'okDuplicate'
                setAdminMsg({ kind: 'ok', text: t('workbench.objAdmin.' + okKey) })
                refreshSchema()
              } catch (e) {
                setAdminObj(null)
                setAdminMsg({ kind: 'err', text: t('workbench.objAdmin.failed', { msg: dbErrMsg(e) }) })
              }
            }}
          />
        )}
        {/* 整库导出对话框 — 仅 live + 支持 SQL(DDL/INSERT)的连接。 */}
        {exportSchema != null && connId && (
          <DatabaseExportDialog
            schema={exportSchema}
            allTables={(namespaces.find(n => n.name === exportSchema)?.tables ?? []).map(t => t.name)}
            onClose={() => setExportSchema(null)}
            onExport={req => runDatabaseExport(exportSchema, req)}
          />
        )}
        {/* D3 跨库/跨表数据迁移对话框 — 仅 live 连接;源固定为当前连接的被选表。 */}
        {transferSource && connId && (
          <DataTransferDialog
            connections={transferConnections}
            initialSourceConnId={connId}
            initialSourceSchema={transferSource.schema || undefined}
            initialSourceTable={transferSource.table}
            onClose={() => setTransferSource(null)}
            onTransferred={count => setAdminMsg({ kind: 'ok', text: t('dbviews.transferDone', { count }) })}
          />
        )}
        {adminMsg && (
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 80, maxWidth: 420, padding: '9px 12px', borderRadius: 10,
            border: `1px solid ${adminMsg.kind === 'ok' ? 'var(--border-hairline)' : 'var(--danger-border)'}`,
            background: adminMsg.kind === 'ok' ? 'var(--surface-card)' : 'var(--danger-soft)',
            color: adminMsg.kind === 'ok' ? 'var(--text-primary)' : 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name={adminMsg.kind === 'ok' ? 'check' : 'alert-triangle'} size={14} style={{ flex: 'none' }} />
            <span>{adminMsg.text}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => setAdminMsg(null)}><Icon name="x" size={12} /></button>
          </div>
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
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => metadata.clearRefreshError()}><Icon name="x" size={12} /></button>
          </div>
        )}
        {schemaErr && (
          /* 库结构加载失败:不再静默回落到 mock 演示树,而是明确报错。 */
          <div className="row gap6" style={{ position: 'absolute', left: 12, bottom: 12 + (createErr ? 46 : 0) + (refreshErr ? 46 : 0), zIndex: 80, maxWidth: 460, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12, boxShadow: 'var(--shadow-window)' }}>
            <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
            <span>{t('workbench.schemaLoadFailed', { message: schemaErr })}</span>
            <button className="icon-btn bare" style={{ width: 20, height: 20, marginLeft: 'auto' }} onClick={() => metadata.clearError()}><Icon name="x" size={12} /></button>
          </div>
        )}
      </div>
    </div></DatabaseWorkProvider>
  )
}
