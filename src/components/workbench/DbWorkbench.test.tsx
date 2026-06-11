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
  objectSource: vi.fn(),
}))

vi.mock('../../state/dbConnections', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...mod, listActiveDbConnections: h.list }
})

// ---- mock the db service so the live-connection data path can be driven without Tauri ----
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, tablePreview: h.tablePreview, getSchema: h.getSchema, objectSource: h.objectSource }
})

import { DbWorkbench } from './DbWorkbench'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

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
    h.objectSource.mockReset()
    // Defaults so capability-gating tests (which now have an active connection →
    // live fetch + schema load) don't crash on an undefined promise.
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
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

    // Structure tab is viewable regardless of structureEdit. (A live connection
    // opens its first table after introspection resolves → findByTestId awaits it.)
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

    expect(await screen.findByTestId('seg-structure')).not.toBeDisabled()
  })
})

describe('DbWorkbench live-connection data path', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.tablePreview.mockReset()
    h.getSchema.mockReset()
    h.objectSource.mockReset()
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
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
    h.list.mockReset(); h.tablePreview.mockReset(); h.getSchema.mockReset(); h.objectSource.mockReset()
    h.list.mockReturnValue([LIVE_CONN])
    h.getSchema.mockResolvedValue(SCHEMA_WITH_FN)
    h.tablePreview.mockResolvedValue({
      columns: [{ name: 'id', type: 'int', pk: true }],
      rows: [[101]],
    })
    h.objectSource.mockResolvedValue('CREATE FUNCTION calc_total() RETURNS int ...')
  })

  it('新建查询与表预览 tab 共存,切回表预览数据仍在', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    // live schema 加载后自动打开第一张表的 tab
    const tableChip = await screen.findByTestId('wbtab-table:public.orders')
    expect(await screen.findByText('101')).toBeInTheDocument()
    // 新建查询 → sql tab 出现,表 tab 仍在
    fireEvent.click(screen.getByTestId('wb-new-query'))
    expect(await screen.findByTestId('wbtab-sql:1')).toBeInTheDocument()
    expect(screen.getByTestId('wbtab-table:public.orders')).toBeInTheDocument()
    // 切回表 tab → 数据仍然渲染(pane 保持 mounted)
    fireEvent.click(tableChip)
    expect(screen.getByText('101')).toBeVisible()
  })

  it('再次单击同一表复用已开 tab,不重复新开', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
    const treeItems = await screen.findAllByText('orders')
    fireEvent.click(treeItems[treeItems.length - 1])
    fireEvent.click(treeItems[treeItems.length - 1])
    expect(screen.getAllByTestId('wbtab-table:public.orders')).toHaveLength(1)
  })

  it('函数源码 tab 与查询 tab 并存', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
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
    const tableChip = await screen.findByTestId('wbtab-table:public.orders')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()
    expect(tableChip).toBeInTheDocument()
  })

  it('关闭当前 tab 后相邻 tab 成为激活态(内容可见)', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
    await screen.findByText('101')
    fireEvent.click(screen.getByTestId('wb-new-query'))
    await screen.findByTestId('wbtab-sql:1')
    fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    // 关闭激活的 sql tab 后,表 tab 被激活,其内容重新可见
    expect(screen.getByText('101')).toBeVisible()
  })

  it('schema 刷新后失效的表 tab 被剔除,activeId 回落到存活 tab', async () => {
    wrap(<DbWorkbench conn={CONN} />)
    await screen.findByTestId('wbtab-table:public.orders')
    // 第二次 getSchema(刷新)返回不含 orders 的 schema → orders tab 应被剔除,自动打开新首表
    h.getSchema.mockResolvedValue({
      db: 'conn',
      schemas: [{ name: 'public', open: false, tables: [{ name: 'users', rows: '', cols: 0 }], views: [], functions: [] }],
    })
    fireEvent.click(screen.getByTestId('wb-refresh'))
    await waitFor(() => expect(screen.queryByTestId('wbtab-table:public.orders')).not.toBeInTheDocument())
    // 新首表 tab 打开且为激活态(其 testid 存在)
    expect(await screen.findByTestId('wbtab-table:public.users')).toBeInTheDocument()
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
