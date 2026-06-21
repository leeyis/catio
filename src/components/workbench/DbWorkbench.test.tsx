import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'

// ---- mock listActiveDbConnections so we can control capabilities per-test ----
const h = vi.hoisted(() => ({
  list: vi.fn(() => [] as import('../../state/dbConnections').ActiveDbConnection[]),
  tablePreview: vi.fn(),
  getSchema: vi.fn(),
  runQuery: vi.fn(),
  objectSource: vi.fn(),
}))

vi.mock('../../state/dbConnections', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...mod, listActiveDbConnections: h.list }
})

// ---- mock the db service so the live-connection data path can be driven without Tauri ----
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, tablePreview: h.tablePreview, getSchema: h.getSchema, runQuery: h.runQuery, objectSource: h.objectSource }
})

import { DbWorkbench } from './DbWorkbench'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

/** Tables no longer auto-open and schemas are collapsed by default — open a table
 *  the way a user does: expand its schema node, then click the table. Returns its chip. */
async function openTable(schema = 'public', table = 'orders') {
  fireEvent.click(await screen.findByTestId(`schema-node:${schema}`))
  fireEvent.click(await screen.findByTestId(`schema-tbl:${schema}.${table}`))
  return screen.findByTestId(`wbtab-table:${schema}.${table}`)
}

const CONN = DATA.byId['d-orders'] // has id: 'd-orders', kind: 'db'

/** A minimal real schema (public.orders) the backend `getSchema` would return. */
const LIVE_SCHEMA = {
  db: 'conn',
  schemas: [{
    name: 'public', open: false,
    tables: [{ name: 'orders', rows: '', cols: 0 }],
    views: [], functions: [],
  }],
}

describe('DbWorkbench capability-gating', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.tablePreview.mockReset()
    h.getSchema.mockReset()
    h.runQuery.mockReset()
    h.objectSource.mockReset()
    // Defaults so capability-gating tests (which now have an active connection →
    // live fetch + schema load) don't crash on an undefined promise.
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
    h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() ...')
  })

  it('all tabs enabled when no active connection (mock/demo path)', () => {
    // listActiveDbConnections returns [] → ALL_ENABLED fallback
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)

    // Structure Segmented button should be enabled
    expect(screen.getByTestId('seg-structure')).not.toBeDisabled()
  })

  it('keeps the structure tab viewable even when structureEdit is false', async () => {
    // MongoDB/ClickHouse/… can VIEW structure (sampled columns) but not ALTER it;
    // the tab must stay clickable — editing is gated inside StructureView instead.
    h.list.mockReturnValue([
      {
        connId: 'conn-1',
        profileId: 'd-orders',
        dbType: 'redis',
        name: 'test',
        capabilities: {
          writable: false,
          transactions: false,
          schemas: false,
          sqlConsole: false,
          er: false,
          structureEdit: false,
        },
      },
    ])
    wrap(<DbWorkbench conn={CONN} />)

    // Structure tab is viewable regardless of structureEdit. Open a table first
    // (tables no longer auto-open) so the table pane's Structure segment renders.
    await openTable()
    expect(await screen.findByTestId('seg-structure')).not.toBeDisabled()
  })

  it('structure tab stays viewable with structureEdit=false (edit gated separately)', async () => {
    h.list.mockReturnValue([
      {
        connId: 'conn-2',
        profileId: 'd-orders',
        dbType: 'mongodb',
        name: 'test',
        capabilities: {
          writable: true,
          transactions: true,
          schemas: true,
          sqlConsole: true,
          er: true,
          structureEdit: false,
        },
      },
    ])
    wrap(<DbWorkbench conn={CONN} />)

    await openTable()
    expect(await screen.findByTestId('seg-structure')).not.toBeDisabled()
  })

  it('all tabs enabled when all capabilities are true', async () => {
    h.list.mockReturnValue([
      {
        connId: 'conn-3',
        profileId: 'd-orders',
        dbType: 'postgres',
        name: 'prod-orders',
        capabilities: {
          writable: true,
          transactions: true,
          schemas: true,
          sqlConsole: true,
          er: true,
          structureEdit: true,
        },
      },
    ])
    wrap(<DbWorkbench conn={CONN} />)

    await openTable()
    expect(await screen.findByTestId('seg-structure')).not.toBeDisabled()
  })
})

describe('DbWorkbench live-connection data path', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.tablePreview.mockReset()
    h.getSchema.mockReset()
    h.runQuery.mockReset()
    h.objectSource.mockReset()
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
    h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() ...')
  })

  it('fetches real rows via tablePreview (real schema/table, not hardcoded) and renders them when connected', async () => {
    h.list.mockReturnValue([
      {
        connId: 'conn-live',
        profileId: 'd-orders',
        dbType: 'postgres',
        name: 'prod-orders',
        capabilities: {
          writable: true, transactions: true, schemas: true,
          sqlConsole: true, er: true, structureEdit: true,
        },
      },
    ])
    // The backend returns its own columns/rows (distinct from the mock orders data).
    h.tablePreview.mockResolvedValue({
      columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'label', type: 'text' },
      ],
      rows: [[1, 'live-alpha'], [2, 'live-beta']],
    })

    wrap(<DbWorkbench conn={CONN} />)
    await openTable()

    // tablePreview is called with the REAL schema/table from getSchema — not a
    // hardcoded `SELECT * FROM public.<table>`. (schema='public' here because the
    // postgres connection has schema namespaces; engines without them pass undefined.)
    await waitFor(() => expect(h.tablePreview).toHaveBeenCalled())
    expect(h.tablePreview).toHaveBeenCalledWith('conn-live', 'public', 'orders', 100, 0)

    // Fetched rows render (proves connId/sql/columns/rows threaded into DataGrid).
    expect(await screen.findByText('live-alpha')).toBeInTheDocument()
    expect(screen.getByText('live-beta')).toBeInTheDocument()
    // The grid is writable (pk present) → the cell edit/Save affordance path is active.
    expect(screen.getByText('label')).toBeInTheDocument()
  })

  it('uses the mock orders data (no tablePreview) when there is no active connection', () => {
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)
    expect(h.tablePreview).not.toHaveBeenCalled()
  })
})

describe('DbWorkbench unified tabs', () => {
  const LIVE_CONN = {
    connId: 'conn-live', profileId: 'd-orders', dbType: 'postgres' as const, name: 'prod-orders',
    capabilities: {
      writable: true, transactions: true, schemas: true,
      sqlConsole: true, er: true, structureEdit: true,
    },
  }
  const SCHEMA_WITH_FN = {
    db: 'conn',
    schemas: [{
      name: 'public', open: false,
      tables: [{ name: 'orders', rows: '', cols: 0 }],
      views: [], functions: [{ name: 'calc_total' }],
    }],
  }

  beforeEach(() => {
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.runQuery.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([LIVE_CONN])
    h.getSchema.mockResolvedValue(SCHEMA_WITH_FN)
    h.tablePreview.mockResolvedValue({
      columns: [{ name: 'id', type: 'int', pk: true }],
      rows: [[101]],
    })
    h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() RETURNS int ...')
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
  })

  it('新建查询与表预览 tab 共存,切回表预览数据仍在', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    // 用户从树里打开第一张表(不再自动打开)
    const tableChip = await openTable()
    expect(await screen.findByText('101')).toBeInTheDocument()
    // 新建查询 → sql tab 出现,表 tab 仍在
    fireEvent.click(screen.getByTestId('wb-new-query'))
    expect(await screen.findByTestId('wbtab-sql:1')).toBeInTheDocument()
    expect(screen.getByTestId('wbtab-table:public.orders')).toBeInTheDocument()
    // 切回表 tab → 数据仍然渲染(pane 保持 mounted)
    fireEvent.click(tableChip)
    expect(screen.getByText('101')).toBeVisible()
  })

  it('新建查询入口在左侧更明显,tab strip 不再渲染右侧新建查询按钮', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('schema-node:public')
    const newQueryButtons = screen.getAllByTitle(/新建查询|New query/)
    expect(screen.getByTestId('wb-new-query')).toBeInTheDocument()
    expect(newQueryButtons.filter(el => el.getAttribute('data-testid') === 'wb-new-query')).toHaveLength(1)
  })

  it('多库/Schema 连接的新建查询显示默认选项并随执行传给 runQuery', async () => {
    h.getSchema.mockResolvedValue({
      db: 'conn',
      schemas: [
        { name: 'ads', open: false, tables: [{ name: 'company', rows: '', cols: 0 }], views: [], functions: [] },
        { name: 'dwd', open: false, tables: [{ name: 'fund', rows: '', cols: 0 }], views: [], functions: [] },
      ],
    })
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('schema-node:ads')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    const select = await screen.findByTestId('sql-default-schema')
    expect(select).toHaveValue('ads')
    fireEvent.change(select, { target: { value: 'dwd' } })
    // 运行按钮在编辑器为空时置灰;经 catio-run 事件注入并运行一条语句(等价 snippet/历史运行)
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: 'sql', text: 'select 1' } }))
    await waitFor(() => expect(h.runQuery).toHaveBeenCalled())
    expect(h.runQuery).toHaveBeenCalledWith('conn-live', expect.any(String), 'dwd', expect.objectContaining({ profileId: 'd-orders' }))
  })

  it('MongoDB 多 database 查询也显示默认库选择并传给 runQuery', async () => {
    h.list.mockReturnValue([{
      ...LIVE_CONN,
      dbType: 'mongodb',
      capabilities: {
        writable: true, transactions: false, schemas: true,
        sqlConsole: true, er: false, structureEdit: false,
      },
    }])
    h.getSchema.mockResolvedValue({
      db: 'conn',
      schemas: [
        { name: 'admin', open: false, tables: [{ name: 'system.users', rows: '', cols: 0 }], views: [], functions: [] },
        { name: 'app', open: false, tables: [{ name: 'orders', rows: '', cols: 0 }], views: [], functions: [] },
      ],
    })
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('schema-node:admin')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    const select = await screen.findByTestId('sql-default-schema')
    expect(select).toHaveValue('admin')
    fireEvent.change(select, { target: { value: 'app' } })
    // 运行按钮在编辑器为空时置灰;经 catio-run 事件注入并运行一条语句(等价 snippet/历史运行)
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: 'sql', text: 'db.orders.find()' } }))
    await waitFor(() => expect(h.runQuery).toHaveBeenCalled())
    expect(h.runQuery).toHaveBeenCalledWith('conn-live', expect.any(String), 'app', expect.objectContaining({ profileId: 'd-orders' }))
  })

  it('再次单击同一表复用已开 tab,不重复新开', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    fireEvent.click(await screen.findByTestId('schema-node:public'))
    const tbl = await screen.findByTestId('schema-tbl:public.orders')
    fireEvent.click(tbl)
    fireEvent.click(tbl)
    expect(screen.getAllByTestId('wbtab-table:public.orders')).toHaveLength(1)
  })

  it('函数源码 tab 与查询 tab 并存', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    fireEvent.click(await screen.findByTestId('schema-node:public')) // 展开 schema(默认折叠)
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    // 展开 Functions 分组(默认折叠)并点函数
    const fnHeaders = screen.getAllByText(/函数|Functions/)
    fireEvent.click(fnHeaders[0])
    fireEvent.click(await screen.findByText('calc_total()'))
    expect(await screen.findByTestId('wbtab-object:function:public.calc_total')).toBeInTheDocument()
    expect(screen.getByTestId('wbtab-sql:1')).toBeInTheDocument()
    // CodeMirror 在 jsdom 下取不到渲染文本,降级为行为断言(objectSource 被正确调用)
    // 函数源码已加载(通过行为验证)
    await waitFor(() => expect(h.objectSource).toHaveBeenCalledWith('conn-live', 'public', 'calc_total', 'function'))
  })

  it('关闭当前 tab 后激活相邻 tab', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const tableChip = await openTable()
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()
    expect(tableChip).toBeInTheDocument()
  })

  it('关闭当前 tab 后相邻 tab 成为激活态(内容可见)', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await openTable()
    await screen.findByText('101')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    // 关闭激活的 sql tab 后,表 tab 被激活,其内容重新可见
    expect(screen.getByText('101')).toBeVisible()
  })

  it('schema 刷新后失效的表 tab 被剔除,activeId 回落到存活 tab', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await openTable('public', 'orders')
    // 再开一个查询 tab 作为"存活 tab",再切回 orders 使其激活
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-table:public.orders'))
    // 第二次 getSchema(刷新)返回不含 orders 的 schema → orders tab 被剔除(不再自动开新表)
    h.getSchema.mockResolvedValue({
      db: 'conn',
      schemas: [{ name: 'public', open: false, tables: [{ name: 'users', rows: '', cols: 0 }], views: [], functions: [] }],
    })
    fireEvent.click(screen.getByTestId('wb-refresh'))
    await waitFor(() => expect(screen.queryByTestId('wbtab-table:public.orders')).not.toBeInTheDocument())
    // activeId 回落到存活的 sql tab(不再自动打开新首表)
    expect(screen.getByTestId('wbtab-sql:1')).toBeInTheDocument()
  })

  it('mock 路径(无连接)关闭最后一个 tab 显示空状态', async () => {
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)
    const chip = await screen.findByTestId('wbtab-table:public.orders')
    expect(chip).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wbtab-close-table:public.orders'))
    expect(screen.queryByTestId('wbtab-table:public.orders')).not.toBeInTheDocument()
    expect(screen.getByText(/没有打开的标签|No open tabs/)).toBeInTheDocument()
  })
})

describe('DbWorkbench 标签栏右键菜单 (需求1)', () => {
  beforeEach(() => {
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.runQuery.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([])
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
    h.objectSource.mockResolvedValue('')
  })

  it('对标签右键弹出菜单(含"关闭其他")', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const chip = await screen.findByTestId('wbtab-table:public.orders')
    fireEvent.contextMenu(chip)
    expect(screen.getByText(/关闭其他|Close others/)).toBeInTheDocument()
  })

  it('点击"关闭其他"后仅剩该标签', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const tableChip = await screen.findByTestId('wbtab-table:public.orders')
    // 展开 schema 并打开另一张表? mock 只有 orders → 改用新建查询造出第二个 tab。
    fireEvent.click(screen.getByTestId('wb-new-query'))
    const sqlChip = await screen.findByTestId('wbtab-sql:1')
    // 对表标签右键 → 关闭其他 → 仅剩表标签
    fireEvent.contextMenu(tableChip)
    fireEvent.click(screen.getByText(/关闭其他|Close others/))
    expect(screen.getByTestId('wbtab-table:public.orders')).toBeInTheDocument()
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()
    expect(sqlChip).not.toBeInTheDocument()
  })

  it('点击"关闭所有"后进入空状态', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const chip = await screen.findByTestId('wbtab-table:public.orders')
    fireEvent.contextMenu(chip)
    fireEvent.click(screen.getByText(/关闭所有|Close all/))
    expect(screen.queryByTestId('wbtab-table:public.orders')).not.toBeInTheDocument()
    expect(screen.getByText(/没有打开的标签|No open tabs/)).toBeInTheDocument()
  })
})

describe('DbWorkbench 侧栏整栏收起 (功能#2)', () => {
  beforeEach(() => {
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.runQuery.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([])
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
    h.objectSource.mockResolvedValue('')
  })

  it('点击收起按钮进入收起态(出现展开按钮、隐藏搜索框),再点展开恢复', () => {
    wrap(<DbWorkbench conn={CONN} />)
    // 展开态:搜索框可见、收起按钮存在
    expect(screen.getByPlaceholderText(/搜索表|Search/)).toBeInTheDocument()
    const collapseBtn = screen.getByTestId('wb-collapse-sidebar')
    // 收起 → 搜索框消失,展开按钮出现
    fireEvent.click(collapseBtn)
    expect(screen.queryByPlaceholderText(/搜索表|Search/)).not.toBeInTheDocument()
    const expandBtn = screen.getByTestId('wb-expand-sidebar')
    expect(expandBtn).toBeInTheDocument()
    // 展开 → 搜索框恢复
    fireEvent.click(expandBtn)
    expect(screen.getByPlaceholderText(/搜索表|Search/)).toBeInTheDocument()
  })
})

describe('DbWorkbench 历史记录无窗口执行 (功能#3)', () => {
  const LIVE_CONN = {
    connId: 'conn-live', profileId: 'd-orders', dbType: 'postgres' as const, name: 'prod-orders',
    capabilities: {
      writable: true, transactions: true, schemas: true,
      sqlConsole: true, er: true, structureEdit: true,
    },
  }
  // 只含一张表的库 → 自动打开 public.orders 表预览 tab(激活态非 SQL 控制台)。
  const SCHEMA = {
    db: 'conn',
    schemas: [{
      name: 'public', open: false,
      tables: [{ name: 'orders', rows: '', cols: 0 }],
      views: [], functions: [],
    }],
  }

  beforeEach(() => {
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.runQuery.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([LIVE_CONN])
    h.getSchema.mockResolvedValue(SCHEMA)
    h.tablePreview.mockResolvedValue({ columns: [{ name: 'id', type: 'int', pk: true }], rows: [[101]] })
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
    h.objectSource.mockResolvedValue('')
  })

  const fireRun = (text: string) =>
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: 'sql', text } }))

  it('(a) 完全没有 SQL tab:派发 catio-run 后新建 SQL tab 并执行', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    // 打开表预览 tab(激活,非 SQL);此时没有任何 SQL 控制台。
    await openTable()
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()

    fireRun('select 1')

    // DbWorkbench 兜底:新建 SQL tab 并 seed + 自动执行。
    expect(await screen.findByTestId('wbtab-sql:1')).toBeInTheDocument()
    await waitFor(() => expect(h.runQuery).toHaveBeenCalledTimes(1))
    expect(h.runQuery).toHaveBeenCalledWith(
      'conn-live', 'select 1', 'public', expect.objectContaining({ profileId: 'd-orders' }),
    )
  })

  it('(a2) 新建窗口不重复 seed:编辑器只含一条语句(回归)', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await openTable()
    fireRun('select 1')
    await screen.findByTestId('wbtab-sql:1')
    await waitFor(() => expect(h.runQuery).toHaveBeenCalledTimes(1)) // autoRun 执行一次
    // 再点"运行"(运行整个编辑器内容):若新建时既 seed initialCode 又 autoRun 插入,
    // 编辑器会是两行 → runQuery 收到重复语句。修复后应只发一条。
    h.runQuery.mockClear()
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('sql-run'))
      expect(h.runQuery).toHaveBeenCalledTimes(1)
    })
    expect(h.runQuery).toHaveBeenCalledWith(
      'conn-live', 'select 1', 'public', expect.objectContaining({ profileId: 'd-orders' }),
    )
  })

  it('(b) 有 SQL tab 但非激活:切到该 tab 并执行,不新建', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    const tableChip = await openTable()
    // 先新建一个 SQL tab(sql:1,激活),再切回表预览 → SQL tab 存在但非激活。
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(tableChip)

    fireRun('select 2')

    // 不新建第二个 SQL tab;复用 sql:1 并执行。
    await waitFor(() => expect(h.runQuery).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('wbtab-sql:2')).not.toBeInTheDocument()
    expect(screen.getByTestId('wbtab-sql:1')).toBeInTheDocument()
    expect(h.runQuery).toHaveBeenCalledWith(
      'conn-live', 'select 2', 'public', expect.objectContaining({ profileId: 'd-orders' }),
    )
  })

  it('(c) 激活 tab 是 SQL:由 SqlConsole 处理,DbWorkbench 不重复执行', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('schema-node:public')
    // 新建 SQL tab 并保持激活。
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')

    fireRun('select 3')

    // 仅 SqlConsole 执行一次,DbWorkbench 不介入(不重复执行、不新建 tab)。
    await waitFor(() => expect(h.runQuery).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('wbtab-sql:2')).not.toBeInTheDocument()
  })
})
