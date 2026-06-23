/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; E6 wires the live query path */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { runQuery, runExplain, getSchema, schemaColumns, tablePreview, dbErrMsg } from '../../services/db'
import type { ResultColumn, Schema } from '../../services/types'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { mongoCompletion } from './mongoCompletion'
import { redisCompletion } from './redisCompletion'
import { redisLinter } from './redisDiagnostics'
import { sqlLinter, linterTableNames } from './sqlDiagnostics'
import { formatSql } from './sqlFormatter'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { DataGrid } from './DataGrid'
import { ExplainPlanViewer } from './ExplainPlanViewer'
import { SqlFileDialog } from './SqlFileDialog'
import { parseExplainResult, supportsExplainPlan, type ParsedExplainPlan } from './explainPlan'
import { readHiddenSchemas, HIDDEN_SCHEMAS_EVENT } from '../../state/schemaFilter'
import type { DbType } from '../../services/db'

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
  /** Namespace selected when this query tab is opened from a scoped action. */
  initialDefaultSchema?: string
  /**
   * One-shot "seed-and-run" signal from the parent (history "执行" with no active
   * SQL console, 功能#3). When `seq` changes (per dispatch) AND this console is the
   * active one, the text is inserted and run once. Identity-stable seqs are not
   * re-run, so a re-render won't trigger a duplicate execution.
   */
  autoRun?: { text: string; seq: number }
  /**
   * True when this console is the currently-shown query tab. Consoles stay
   * MOUNTED while hidden, so only the active one may consume the global
   * `catio-insert` / `catio-run` (sql) window events — otherwise every open
   * query tab would insert the same text.
   */
  active?: boolean
  /** 连接引擎(conn.engine = dbType)。mongodb/elasticsearch → plain 模式(Task 10 实装)。 */
  engine?: string
  /** 连接名,用于"正在 X 上执行…"提示。缺省回落到当前默认命名空间。 */
  connName?: string
  /** 保存档 profile id — 随历史记录持久化,使历史可按连接删除/友好显示。 */
  profileId?: string
  /**
   * 上报"是否处于最大化"(paneMode !== 'split')给父级 DbWorkbench,
   * 用于最大化时联动收起左侧侧栏(功能#6)。仅当前活动 tab 的态影响侧栏。
   */
  onFullscreenChange?: (fullscreen: boolean) => void
}

export function SqlConsole({ density, fresh, writable = true, connId, initialCode, initialDefaultSchema, autoRun, active, engine, connName, profileId, onFullscreenChange }: SqlConsoleProps) {
  const { t } = useTranslation()
  // mongodb/elasticsearch/redis 用各自语法(mongo shell / REST+SQL / Redis 命令),
  // 编辑器走 plain 模式:不挂 SQL 补全、显示语法占位提示、结果网格只读(mongo 的 _id
  // 带 pk 标记会让 DataGrid 误开 SQL DML 编辑——对这些引擎必然失败)。
  // Redis 把输入当真实 Redis 命令执行(GET/HGETALL/SCAN…,见 redis driver 的 query())。
  const plain = engine === 'mongodb' || engine === 'elasticsearch' || engine === 'redis'
  // Redis 命令在连接时选定的 default_db 上执行(查询页不传库),故不显示库选择器,
  // 避免"选了 db 却不生效"的误导(ES 本就无多库概念)。
  const supportsDefaultNamespace = engine !== 'elasticsearch' && engine !== 'redis'
  const editorPlaceholder = engine === 'mongodb' ? t('dbviews.mongoPlaceholder')
    : engine === 'elasticsearch' ? t('dbviews.esPlaceholder')
    : engine === 'redis' ? t('dbviews.redisPlaceholder')
    : undefined
  const D = useData()
  const [code, setCode] = useState(
    // A fresh query starts with its optional seed template (or EMPTY when none).
    // The editor shows its own placeholder hint when empty.
    fresh ? (initialCode ?? '') : D.sampleSQL
  )
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>(fresh ? 'idle' : 'done')
  // Live result of the last successful run (only used when connId is set).
  const [result, setResult] = useState<{
    columns: ResultColumn[]
    rows: unknown[][]
    sql: string
    defaultNamespace?: string
  } | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  // T12 执行计划(EXPLAIN):非空时结果区显示 ExplainPlanViewer(树/表/JSON),关闭后回到普通结果。
  // 仅 PG/MySQL 且已连接(connId)支持(supportsExplainPlan + connId 门控)。
  const [explain, setExplain] = useState<{ plan?: ParsedExplainPlan; loading: boolean; error?: string } | null>(null)
  const canExplain = !!connId && supportsExplainPlan(engine as DbType | undefined)
  // 编辑区是否需要让出空间给下方结果区:普通运行(phase!=='idle')或正在/已展示执行计划。
  const hasResults = phase !== 'idle' || !!explain
  // 每次出结果(成功或失败)自增,用作 DataGrid 的 key:换 key → 重新挂载 →
  // 清掉上一次查询残留的分页(serverRows)/编辑/排序状态。
  const [runSeq, setRunSeq] = useState(0)
  // Live schema/database namespaces (table names) fetched from the backend when connected.
  const [liveSchema, setLiveSchema] = useState<Schema | null>(null)
  const [defaultNamespace, setDefaultNamespace] = useState(initialDefaultSchema ?? '')
  // Live columns per schema namespace: { [schemaName]: { [table]: columns } }.
  const [liveColumns, setLiveColumns] = useState<Record<string, Record<string, string[]>>>({})
  // Imperative handle to the CodeMirror editor for cursor-aware insertion.
  const editorRef = useRef<SqlEditorHandle>(null)
  // 编辑区/结果区上下分隔(功能#5):编辑区占比,仅会话内存。
  const [splitRatio, setSplitRatio] = useState(0.5)
  // 一键最大化(功能#6):'split' 上下分屏 / 'maxEditor' 编辑区占满 / 'maxResults' 结果区占满。
  const [paneMode, setPaneMode] = useState<'split' | 'maxEditor' | 'maxResults'>('split')
  // 外层容器引用 — 拖动分隔条时按容器高度把位移换算成比例增量。
  const splitContainerRef = useRef<HTMLDivElement>(null)
  // 分隔条 hover/拖动高亮(不依赖外部 CSS 文件,内联实现,保证主题切换正常)。
  const [splitHot, setSplitHot] = useState(false)
  // T16 SQL 文件批量执行对话框开关。仅已连接(connId)时可用。
  const [sqlFileOpen, setSqlFileOpen] = useState(false)

  // 上报最大化态给父级(功能#6 父子契约):非 split 即视为占满,父级据此联动收起侧栏。
  useEffect(() => { onFullscreenChange?.(paneMode !== 'split') }, [paneMode, onFullscreenChange])

  // 分隔条拖动:在 document 上挂 mousemove/mouseup,按容器高度换算比例,clamp 到 [0.15,0.85]。
  function onSplitDragStart(e: React.MouseEvent) {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return
    const total = container.getBoundingClientRect().height
    if (total <= 0) return
    const startY = e.clientY
    const startRatio = splitRatio
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientY - startY) / total
      const next = Math.min(0.85, Math.max(0.15, startRatio + delta))
      setSplitRatio(next)
    }
    const onUp = () => {
      setSplitHot(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    setSplitHot(true)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  // Live collection names for the plain-mode mongo completion source. Held in a
  // ref so the (stable-identity) completion source reads the latest list without
  // rebuilding the editor extension on every schema change.
  const collectionsRef = useRef<string[]>([])
  // Sampled Redis key names for the plain-mode redis completion source (key args).
  const redisKeysRef = useRef<string[]>([])

  useEffect(() => {
    if (!connId || !supportsDefaultNamespace) { setLiveSchema(null); return }
    let alive = true
    getSchema(connId).then(s => { if (alive) setLiveSchema(s) }).catch(() => {})
    return () => { alive = false }
  }, [connId, supportsDefaultNamespace])

  // Plain-mode (mongo) collection names for autocompletion — union of every
  // database's collections/views. Best-effort: a failed fetch leaves the list
  // empty (completion degrades to methods/chains only).
  useEffect(() => {
    if (!connId || engine !== 'mongodb') { collectionsRef.current = []; return }
    let alive = true
    getSchema(connId)
      .then(s => {
        if (!alive) return
        const names = new Set<string>()
        for (const ns of s.schemas) {
          for (const tbl of ns.tables) names.add(tbl.name)
          for (const v of ns.views) names.add(v.name)
        }
        collectionsRef.current = [...names]
      })
      .catch(() => { if (alive) collectionsRef.current = [] })
    return () => { alive = false }
  }, [connId, engine])

  // Plain-mode (redis) key-name sample for argument completion. SCAN-based
  // preview of the connected default DB (the pseudo-table "keys"); best-effort.
  useEffect(() => {
    if (!connId || engine !== 'redis') { redisKeysRef.current = []; return }
    let alive = true
    tablePreview(connId, undefined, 'keys', 300, 0)
      .then(res => {
        if (!alive) return
        const ki = res.columns.findIndex(c => c.name === 'key')
        redisKeysRef.current = ki >= 0 ? res.rows.map(r => String(r[ki])).filter(Boolean) : []
      })
      .catch(() => { if (alive) redisKeysRef.current = [] })
    return () => { alive = false }
  }, [connId, engine])

  // Stable completion source for the editor (mongo + redis). Identity is keyed on
  // engine so the editor extension isn't rebuilt as the live name lists load.
  const completion = useMemo(
    () => (engine === 'mongodb' ? mongoCompletion(() => collectionsRef.current)
      : engine === 'redis' ? redisCompletion(() => redisKeysRef.current)
      : undefined),
    [engine],
  )
  // Known table/view names for the SQL linter's "unknown table" check. Held in a
  // ref so the (stable-identity) linter reads the latest list without rebuilding
  // the editor extension as the schema/columns load.
  const sqlTablesRef = useRef<string[]>([])
  // Syntax diagnostics source:
  //  - redis → command arity / unknown / blocked / quotes
  //  - SQL (non-plain) → unbalanced parens / unclosed strings / unknown tables
  const lintSource = useMemo(
    () => (engine === 'redis' ? redisLinter : plain ? undefined : sqlLinter(() => sqlTablesRef.current)),
    [engine, plain],
  )

  // Stable identity of the schema namespaces (names only) so the column fetch
  // re-runs when connId or the schema list changes, but NOT on every keystroke.
  const namespaceNames = useMemo(
    () => (liveSchema ? liveSchema.schemas.map(ns => ns.name) : []),
    [liveSchema],
  )
  const namespaceKey = namespaceNames.join(',')

  // 结构面板漏斗筛掉的库/Schema,这里也只保留筛选后的(联动)。key 与 SchemaBrowser 一致
  // (conn.id 即此处的 profileId);监听变更事件,做到切换漏斗时库下拉实时刷新。
  const [hiddenSchemas, setHiddenSchemas] = useState<Set<string>>(
    () => new Set(profileId ? readHiddenSchemas(profileId) : []),
  )
  useEffect(() => {
    const refresh = () => setHiddenSchemas(new Set(profileId ? readHiddenSchemas(profileId) : []))
    refresh()
    if (typeof window === 'undefined') return
    window.addEventListener(HIDDEN_SCHEMAS_EVENT, refresh)
    return () => window.removeEventListener(HIDDEN_SCHEMAS_EVENT, refresh)
  }, [profileId])

  const schemaOptions = useMemo(
    () => (liveSchema ?? D.schema).schemas.map(ns => ns.name).filter(Boolean).filter(name => !hiddenSchemas.has(name)),
    [liveSchema, D.schema, hiddenSchemas],
  )
  const schemaOptionsKey = schemaOptions.join('\u0000')

  useEffect(() => {
    if (!supportsDefaultNamespace || schemaOptions.length === 0) { setDefaultNamespace(''); return }
    setDefaultNamespace(cur => {
      if (cur && schemaOptions.includes(cur)) return cur
      if (initialDefaultSchema && schemaOptions.includes(initialDefaultSchema)) return initialDefaultSchema
      return schemaOptions[0] ?? ''
    })
    // schemaOptionsKey captures option identity; avoid re-running just because
    // the memoized array identity changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsDefaultNamespace, schemaOptionsKey, initialDefaultSchema])

  // Fetch REAL column names for each schema namespace from the live backend.
  // Best-effort: on rejection we leave that namespace out (editor falls back to
  // table-names-only). Re-runs only when connId or the namespace list changes.
  useEffect(() => {
    if (!connId || plain || namespaceNames.length === 0) { setLiveColumns({}); return }
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
  }, [connId, plain, namespaceKey])

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
    // Feed the SQL linter's "unknown table" check (read lazily via sqlTablesRef).
    // 已连接但 liveSchema 未加载完成时,linterTableNames 会返回 []，避免拿 demo 表名
    // 对真实库里的表误报"未知的表"。autocomplete 的 editorSchema 仍可用 demo 表名兜底。
    sqlTablesRef.current = linterTableNames(connId, liveSchema, D.schema)
    return top
  }, [connId, liveSchema, liveColumns, D.schema, D.tableStructures])

  // 自增运行令牌：每次运行/停止都 +1，在途的 then/catch 只有令牌仍匹配时才落地。
  // 这样"停止"或被新一次运行取代时，旧结果会被丢弃,UI 立即交还控制权。
  const runToken = useRef(0)

  function run(sqlOverride?: string) {
    // 运行中不重复触发（避免 Alt↵ 在执行中再起一次）。
    if (phase === 'running') return
    setRunErr(null)
    // 普通运行接管结果区:清掉可能正在展示的执行计划,回到数据网格。
    setExplain(null)
    // A selection-run passes just the highlighted SQL; otherwise run the whole editor.
    const sql = sqlOverride && sqlOverride.trim() ? sqlOverride : code
    // 空 / 纯空白 SQL 不执行：拦在所有入口（按钮 / Alt+Enter / 片段运行）之前，
    // 避免把空语句发给后端报错，或 mock 路径空转出现"执行中"。
    if (!sql.trim()) return
    const runDefaultNamespace = supportsDefaultNamespace && defaultNamespace && schemaOptions.includes(defaultNamespace)
      ? defaultNamespace
      : undefined
    const myToken = ++runToken.current
    if (connId) {
      // Live path: execute the typed SQL against the backend.
      setPhase('running')
      runQuery(connId, sql, runDefaultNamespace, { name: connName, engine, profileId })
        .then(res => {
          if (myToken !== runToken.current) return // 已被停止/被新运行取代
          setResult({ columns: res.columns, rows: res.rows, sql, defaultNamespace: runDefaultNamespace })
          setRunSeq(s => s + 1)
          setPhase('done')
        })
        .catch(e => {
          if (myToken !== runToken.current) return
          // 失败时清空上一次的结果,避免旧数据与错误信息并存(误导)。
          setResult(null)
          setRunErr(dbErrMsg(e))
          setRunSeq(s => s + 1)
          setPhase('done')
        })
      return
    }
    // Mock path: unchanged demo timing.
    setPhase('running')
    setTimeout(() => { if (myToken === runToken.current) setPhase('done') }, 450)
  }

  // 停止：作废在途结果并把 UI 交还到就绪态。注意——这是前端层面的"停止等待"，
  // 后端/JDBC sidecar 当前不支持中断已发出的语句，服务端查询可能仍会跑完。
  function stop() {
    runToken.current++
    setPhase('idle')
    setRunErr(null)
  }

  // T12「解释」:对当前(或选中)SQL 取执行计划。复用 runToken 令牌,使其与
  // 普通运行/停止互斥(在途的 explain 被新运行/停止取代时丢弃),并切到 split 态
  // 让结果区可见。失败时把后端报错原样展示在查看器里(不污染普通结果)。
  function runExplainPlan() {
    if (!canExplain) return
    // 选中优先:与普通 run() 一致 —— 编辑区选中片段时只对选中文本取计划,
    // 避免在多语句编辑区里对整段 code 运行 EXPLAIN(多语句会拼出非法 EXPLAIN)。
    const selected = editorRef.current?.getSelectedText()
    const sql = selected && selected.trim() ? selected : code
    if (!sql.trim()) return
    const myToken = ++runToken.current
    setPaneMode('split')
    setExplain({ loading: true })
    // 与普通 run() 一致:把选中的默认库/Schema 传给 EXPLAIN,否则后端落连接默认库报表不存在。
    const explainNamespace = supportsDefaultNamespace && defaultNamespace && schemaOptions.includes(defaultNamespace)
      ? defaultNamespace
      : undefined
    runExplain(connId!, sql, explainNamespace)
      .then(res => {
        if (myToken !== runToken.current) return
        // engine 已被 canExplain 收窄为 PG/MySQL 之一。
        const plan = parseExplainResult(engine as 'postgres' | 'mysql', res)
        setExplain({ loading: false, plan })
      })
      .catch(e => {
        if (myToken !== runToken.current) return
        setExplain({ loading: false, error: dbErrMsg(e) })
      })
  }

  // Keep the latest run() in a ref so the (active-gated) event listener always
  // calls the current closure without re-subscribing on every keystroke.
  const runRef = useRef(run)
  runRef.current = run

  // 功能#3:父级派发的一次性"seed + run"(历史「执行」无激活 SQL 控制台时,
  // 由 DbWorkbench 新建/切换到本控制台并下发)。仅当本控制台为激活态、且 seq 未消费过
  // 才执行一次:插入文本到编辑器(jsdom 下编辑器未挂载则降级 setCode),再运行该语句。
  // 初值 -1(无效 seq):autoRun 仅在父级有意下发时才传入,故首个非空 autoRun 必然触发
  // (新建控制台挂载即带 autoRun 的分支也需要在挂载后运行)。
  const autoRunSeqRef = useRef(-1)
  useEffect(() => {
    if (active === false) return
    if (!autoRun || autoRun.seq === autoRunSeqRef.current) return
    autoRunSeqRef.current = autoRun.seq
    if (editorRef.current) editorRef.current.insertAtCursor(autoRun.text, true)
    else setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + autoRun.text)
    runRef.current(autoRun.text)
  }, [autoRun, active])

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
      // Insert on a NEW LINE at the caret (so the statement is visible in the
      // editor), then run ONLY that statement — NOT the whole document. Running
      // the full buffer would concatenate it with any existing query and throw a
      // syntax error (`…WHERE…select * …`). Run the snippet text in isolation.
      if (editorRef.current) editorRef.current.insertAtCursor(ce.detail.text, true)
      else setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text)
      runRef.current(ce.detail.text)
    }
    window.addEventListener('catio-insert', onInsert)
    window.addEventListener('catio-run', onRun)
    return () => {
      window.removeEventListener('catio-insert', onInsert)
      window.removeEventListener('catio-run', onRun)
    }
  }, [active])

  return (
    <div ref={splitContainerRef} className="col" style={{ height: '100%', width: '100%', minHeight: 0, minWidth: 0 }}>
      {/* console toolbar — the query name lives in the tab strip above, so it's not
          repeated here; just the editor actions, right-aligned. */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
        <div className="row gap6">
          {phase === 'running' ? (
            <Btn size="sm" variant="danger" style={{ height: 26, padding: '0 10px', fontSize: 11.5 }} icon="square" onClick={stop}>
              {t('dbviews.stop')}
            </Btn>
          ) : (
            <Btn size="sm" variant="primary" testId="sql-run" disabled={!code.trim()} style={{ height: 26, padding: '0 10px', fontSize: 11.5 }} icon="play" onClick={() => run()}>
              {t('dbviews.run')} <span style={{ opacity: .6, fontSize: 10, marginLeft: 2 }}>Alt↵</span>
            </Btn>
          )}
          {/* T12 执行计划入口:仅 PG/MySQL 且已连接时出现,空 SQL 时禁用。 */}
          {canExplain && (
            <Btn size="sm" variant="secondary" testId="sql-explain" disabled={!code.trim()}
              style={{ height: 26, padding: '0 10px', fontSize: 11.5 }} icon="git-branch"
              title={t('dbviews.explainTitle')} onClick={runExplainPlan}>
              {t('dbviews.explain')}
            </Btn>
          )}
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <button className="icon-btn bare" title={t('dbviews.format')} disabled={plain || !code.trim()}
            onClick={() => setCode(prev => formatSql(prev, engine))}><Icon name="wrench" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.clear')} onClick={() => setCode('')}><Icon name="eraser" size={15} /></button>
          {/* T16 SQL 文件批量执行:选 .sql 文件 → 按方言切分 → 逐句执行 + 进度/错误恢复。仅已连接可用。 */}
          {connId && (
            <button className="icon-btn bare" title={t('dbviews.sqlFileRunFile')} data-testid="sql-run-file" onClick={() => setSqlFileOpen(true)}><Icon name="file-code" size={15} /></button>
          )}
        </div>
        <div className="row gap6" style={{ minWidth: 0 }}>
          {supportsDefaultNamespace && schemaOptions.length > 1 && (
            <label className="row gap6" title={t('workbench.defaultSchema')}
              style={{ height: 30, minWidth: 0, maxWidth: 260, padding: '0 8px', border: '1px solid var(--border-hairline)', borderRadius: 9, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)', fontSize: 11.5 }}>
              <Icon name="database" size={13} style={{ flex: 'none', color: 'var(--text-faint)' }} />
              <span style={{ flex: 'none' }}>{t('workbench.defaultSchema')}</span>
              <select
                data-testid="sql-default-schema"
                aria-label={t('workbench.defaultSchema')}
                value={defaultNamespace}
                onChange={e => setDefaultNamespace(e.target.value)}
                style={{ minWidth: 82, maxWidth: 130, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 12, fontFamily: "'Geist Mono', monospace" }}>
                {schemaOptions.map(schema => <option key={schema} value={schema}>{schema}</option>)}
              </select>
            </label>
          )}
          {/* 功能#6:编辑区最大化/恢复。仅在有结果区时显示——idle 时编辑区本就占满。 */}
          {hasResults && (
            paneMode === 'maxEditor'
              ? <button className="icon-btn bare" title={t('dbviews.restorePane')} onClick={() => setPaneMode('split')}><Icon name="minimize-2" size={15} /></button>
              : <button className="icon-btn bare" title={t('dbviews.maximizeEditor')} onClick={() => setPaneMode('maxEditor')}><Icon name="maximize-2" size={15} /></button>
          )}
        </div>
      </div>
      {/* editor — always grows to fill the available area (full width + height).
          When there are no results yet it fills the whole console; once a run
          starts it shares the space with the results region below (a split).
          功能#5/#6:split 态按 splitRatio 分配高度;maxEditor 占满;maxResults 时隐藏。 */}
      {paneMode !== 'maxResults' && (
        <div style={{
          flexGrow: !hasResults || paneMode === 'maxEditor' ? 1 : splitRatio,
          flexBasis: 0,
          minHeight: 140,
          width: '100%',
          borderBottom: !hasResults ? 'none' : '1px solid var(--border-hairline)',
        }}>
          <SqlEditor ref={editorRef} code={code} onChange={setCode} schema={editorSchema} onRun={run} onRunSelection={connId ? (sql => run(sql)) : undefined} placeholder={editorPlaceholder} plain={plain} completion={completion} lintSource={lintSource} />
        </div>
      )}
      {/* 功能#5:编辑区与结果区之间的水平拖动分隔条。仅在 split 态且有结果区时显示。 */}
      {hasResults && paneMode === 'split' && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('dbviews.resizeColumnHint')}
          onMouseDown={onSplitDragStart}
          onMouseEnter={() => setSplitHot(true)}
          onMouseLeave={() => setSplitHot(false)}
          style={{ flex: 'none', height: 6, width: '100%', cursor: 'row-resize', background: splitHot ? 'var(--accent-primary)' : 'var(--border-hairline)', transition: 'background .12s' }}
        />
      )}
      {/* results — only rendered once a run has started (running/done). While
          idle (fresh query) the editor above fills everything.
          功能#6:maxEditor 时隐藏;maxResults 占满;split 按 1-ratio 分配。 */}
      {hasResults && paneMode !== 'maxEditor' && (
        <div className="col" style={{ flexGrow: paneMode === 'maxResults' ? 1 : 1 - splitRatio, flexBasis: 0, minHeight: 0, width: '100%' }}>
          {/* 功能#6:结果区极简工具条,仅放最大化/恢复入口(控制 maxResults<->split)。视觉克制,右对齐。 */}
          <div className="row" style={{ justifyContent: 'flex-end', flex: 'none', padding: '3px 8px', borderBottom: '1px solid var(--border-hairline)' }}>
            {paneMode === 'maxResults'
              ? <button className="icon-btn bare" title={t('dbviews.restorePane')} onClick={() => setPaneMode('split')}><Icon name="minimize-2" size={15} /></button>
              : <button className="icon-btn bare" title={t('dbviews.maximizeResults')} onClick={() => setPaneMode('maxResults')}><Icon name="maximize-2" size={15} /></button>}
          </div>
          <div style={{ flex: 1, minHeight: 0, width: '100%' }}>
          {explain
            ? <ExplainPlanViewer plan={explain.plan} loading={explain.loading} error={explain.error} onClose={() => setExplain(null)} />
            : phase === 'running'
            ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-tertiary)' }}>
                <Icon name="loader" size={26} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: 13 }}>{t('dbviews.executingOn', { target: connName || defaultNamespace || '—' })}</span>
              </div>
            : (connId
                ? <DataGrid
                    key={runSeq}
                    columns={result?.columns ?? []}
                    rows={result?.rows ?? []}
                    statusTones={D.statusTones} density={density}
                    writable={writable && !plain} connId={connId}
                    // plain 引擎(mongo/es)不传 sql:服务端分页会拼 SQL LIMIT/OFFSET 必败,回落客户端分页。
                    sql={plain ? undefined : result?.sql}
                    defaultNamespace={result?.defaultNamespace}
                    resultLabel={t('dbviews.queryResult')}
                    loadError={runErr ?? undefined} />
                : <DataGrid
                    columns={D.ordersColumns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon }))}
                    rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
                    statusTones={D.statusTones} density={density} />)}
          </div>
        </div>
      )}
      {/* T16 SQL 文件批量执行对话框。 */}
      {sqlFileOpen && connId && (
        <SqlFileDialog connId={connId} connName={connName} onClose={() => setSqlFileOpen(false)} />
      )}
    </div>
  )
}
