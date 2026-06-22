import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'
import { SchemaBrowser } from './SchemaBrowser'
import type { SchemaNamespace } from '../../services/types'

const NS: SchemaNamespace[] = [
  { name: 'eastmoney', open: false, tables: [{ name: 'orders', rows: '', cols: 0 }], views: [], functions: [] },
  { name: 'esales', open: false, tables: [{ name: 'leads', rows: '', cols: 0 }], views: [], functions: [] },
]
const NS_FULL: SchemaNamespace[] = [
  { name: 'eastmoney', open: false, tables: [{ name: 'orders', rows: '', cols: 0 }], views: [{ name: 'v_daily' }], functions: [{ name: 'fn_total' }] },
]
const CONN = DATA.byId['d-orders'] // stable id 'd-orders' → used as the filter persistence key

const noop = () => {}
const renderBrowser = () => render(
  <LanguageProvider><DataProvider>
    <SchemaBrowser onPick={noop} active={null} onNewQuery={noop} onOpenER={noop}
      erActive={false} sqlActive={false} schemas={NS} conn={CONN} live />
  </DataProvider></LanguageProvider>,
)

describe('SchemaBrowser', () => {
  beforeEach(() => localStorage.clear())

  it('renders schema nodes COLLAPSED by default — no tables until the user expands', () => {
    renderBrowser()
    expect(screen.getByTestId('schema-node:eastmoney')).toBeInTheDocument()
    expect(screen.queryByTestId('schema-tbl:eastmoney.orders')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('schema-node:eastmoney'))
    expect(screen.getByTestId('schema-tbl:eastmoney.orders')).toBeInTheDocument()
  })

  it('default shows ALL schemas', () => {
    renderBrowser()
    expect(screen.getByTestId('schema-node:eastmoney')).toBeInTheDocument()
    expect(screen.getByTestId('schema-node:esales')).toBeInTheDocument()
  })

  it('filter hides a schema from the tree and persists the choice per connection', () => {
    renderBrowser()
    fireEvent.click(screen.getByTestId('schema-filter-btn'))
    fireEvent.click(screen.getByTestId('schema-filter-item:esales')) // uncheck esales
    expect(screen.queryByTestId('schema-node:esales')).not.toBeInTheDocument()
    expect(screen.getByTestId('schema-node:eastmoney')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('catio-hidden-schemas')!)).toEqual({ 'd-orders': ['esales'] })
  })

  it('restores hidden schemas from storage on mount', () => {
    localStorage.setItem('catio-hidden-schemas', JSON.stringify({ 'd-orders': ['esales'] }))
    renderBrowser()
    expect(screen.queryByTestId('schema-node:esales')).not.toBeInTheDocument()
    expect(screen.getByTestId('schema-node:eastmoney')).toBeInTheDocument()
  })

  it('"select all" restores every schema', () => {
    localStorage.setItem('catio-hidden-schemas', JSON.stringify({ 'd-orders': ['esales'] }))
    renderBrowser()
    fireEvent.click(screen.getByTestId('schema-filter-btn'))
    fireEvent.click(screen.getByText('全选'))
    expect(screen.getByTestId('schema-node:esales')).toBeInTheDocument()
  })

  it('hides ER/new-table/new-view menu items when the engine lacks those capabilities', () => {
    render(
      <LanguageProvider><DataProvider>
        <SchemaBrowser onPick={noop} active={null} onNewQuery={noop} onOpenER={noop}
          onNewObjectTemplate={noop} onRefresh={noop}
          erActive={false} sqlActive={false} schemas={NS} conn={CONN} live
          canSqlConsole canEr={false} canStructureEdit={false} />
      </DataProvider></LanguageProvider>,
    )
    // Open the "..." menu for the first schema node.
    fireEvent.click(screen.getAllByTitle('Schema 操作')[0])
    expect(screen.queryByText('ER 图')).not.toBeInTheDocument()
    expect(screen.queryByText('新建表')).not.toBeInTheDocument()
    expect(screen.queryByText('新建视图')).not.toBeInTheDocument()
    expect(screen.getByText('新建查询')).toBeInTheDocument()
    expect(screen.getByText('刷新')).toBeInTheDocument()
  })

  it('shows every menu item when all engine capabilities are present', () => {
    render(
      <LanguageProvider><DataProvider>
        <SchemaBrowser onPick={noop} active={null} onNewQuery={noop} onOpenER={noop}
          onNewObjectTemplate={noop} onRefresh={noop}
          erActive={false} sqlActive={false} schemas={NS} conn={CONN} live
          canSqlConsole canEr canStructureEdit />
      </DataProvider></LanguageProvider>,
    )
    fireEvent.click(screen.getAllByTitle('Schema 操作')[0])
    expect(screen.getByText('新建查询')).toBeInTheDocument()
    expect(screen.getByText('ER 图')).toBeInTheDocument()
    expect(screen.getByText('新建表')).toBeInTheDocument()
    expect(screen.getByText('新建视图')).toBeInTheDocument()
    expect(screen.getByText('刷新')).toBeInTheDocument()
  })

  it('hides Views/Functions tree nodes when the engine lacks those concepts (e.g. Redis)', () => {
    render(
      <LanguageProvider><DataProvider>
        <SchemaBrowser onPick={noop} onPickObject={noop} active={null} onNewQuery={noop} onOpenER={noop}
          erActive={false} sqlActive={false} schemas={NS_FULL} conn={CONN} live
          canViews={false} canFunctions={false} />
      </DataProvider></LanguageProvider>,
    )
    fireEvent.click(screen.getByTestId('schema-node:eastmoney'))
    expect(screen.queryByText('Views')).not.toBeInTheDocument()
    expect(screen.queryByText('Functions')).not.toBeInTheDocument()
    // Tables stay visible regardless.
    expect(screen.getByTestId('schema-tbl:eastmoney.orders')).toBeInTheDocument()
  })

  it('shows Views but hides Functions when the engine has views only (e.g. SQLite)', () => {
    render(
      <LanguageProvider><DataProvider>
        <SchemaBrowser onPick={noop} onPickObject={noop} active={null} onNewQuery={noop} onOpenER={noop}
          erActive={false} sqlActive={false} schemas={NS_FULL} conn={CONN} live
          canViews canFunctions={false} />
      </DataProvider></LanguageProvider>,
    )
    fireEvent.click(screen.getByTestId('schema-node:eastmoney'))
    expect(screen.getByText('Views')).toBeInTheDocument()
    expect(screen.queryByText('Functions')).not.toBeInTheDocument()
  })

  // ---- 需求4: 树叶子节点 hover 复制/插入图标 ----
  const renderFull = (sqlActive: boolean) => render(
    <LanguageProvider><DataProvider>
      <SchemaBrowser onPick={noop} onPickObject={noop} active={null} onNewQuery={noop} onOpenER={noop}
        erActive={false} sqlActive={sqlActive} schemas={NS_FULL} conn={CONN} live />
    </DataProvider></LanguageProvider>,
  )
  // Expand the schema, then Views / Functions groups, so all leaf nodes are visible.
  const expandAll = () => {
    fireEvent.click(screen.getByTestId('schema-node:eastmoney'))
    fireEvent.click(screen.getByText('Views'))
    fireEvent.click(screen.getByText('Functions'))
  }

  it('sqlActive=true: every leaf node has BOTH a copy and an insert button', () => {
    renderFull(true)
    expandAll()
    // 1 table + 1 view + 1 function = 3 of each.
    expect(screen.getAllByTitle('复制名称')).toHaveLength(3)
    expect(screen.getAllByTitle('插入到查询')).toHaveLength(3)
  })

  it('sqlActive=false: leaf nodes have a copy button but NO insert button', () => {
    renderFull(false)
    expandAll()
    expect(screen.getAllByTitle('复制名称')).toHaveLength(3)
    expect(screen.queryByTitle('插入到查询')).not.toBeInTheDocument()
  })

  it('clicking the insert button dispatches catio-insert with the node name', () => {
    renderFull(true)
    expandAll()
    const spy = vi.fn()
    window.addEventListener('catio-insert', spy)
    fireEvent.click(screen.getAllByTitle('插入到查询')[0]) // first = table 'orders'
    window.removeEventListener('catio-insert', spy)
    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0][0] as CustomEvent
    expect(ev.detail).toEqual({ kind: 'sql', text: 'orders' })
  })

  it('clicking the copy button writes the node name to the clipboard', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderFull(false)
    expandAll()
    fireEvent.click(screen.getAllByTitle('复制名称')[0]) // first = table 'orders'
    expect(writeText).toHaveBeenCalledWith('orders')
  })

  it('clicking copy shows a brief 已复制 feedback on that node', () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true })
    renderFull(false)
    expandAll()
    fireEvent.click(screen.getAllByTitle('复制名称')[0]) // first = table 'orders'
    // 复制后被点的那个节点反馈为「已复制」,其余仍是「复制名称」。
    expect(screen.getByTitle('已复制')).toBeInTheDocument()
    expect(screen.getAllByTitle('复制名称')).toHaveLength(2)
  })
})
