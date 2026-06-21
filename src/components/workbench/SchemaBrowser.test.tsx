import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'
import { SchemaBrowser } from './SchemaBrowser'
import type { SchemaNamespace } from '../../services/types'

const NS: SchemaNamespace[] = [
  { name: 'eastmoney', open: false, tables: [{ name: 'orders', rows: '', cols: 0 }], views: [], functions: [] },
  { name: 'esales', open: false, tables: [{ name: 'leads', rows: '', cols: 0 }], views: [], functions: [] },
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
})
