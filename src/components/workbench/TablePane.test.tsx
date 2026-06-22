import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { TablePane } from './TablePane'
import type { Connection, ResultColumn } from '../../services/types'
import type { DbCapabilities } from '../../services/db'

// Capture the columns TablePane hands to DataGrid so we can assert the
// name→comment mapping built from the parallel structure fetch.
let lastGridColumns: ResultColumn[] | null = null
vi.mock('../dbviews', () => ({
  DataGrid: (props: { columns: ResultColumn[] }) => {
    lastGridColumns = props.columns
    return <div data-testid="datagrid-stub" />
  },
  StructureView: () => <div data-testid="structure-stub" />,
}))

const tablePreview = vi.fn()
const tableStructure = vi.fn()
vi.mock('../../services/db', () => ({
  tablePreview: (...a: unknown[]) => tablePreview(...a),
  tableStructure: (...a: unknown[]) => tableStructure(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const caps: DbCapabilities = {
  writable: true, transactions: true, schemas: true, sqlConsole: true, er: true, structureEdit: true,
  views: true, functions: true,
}
const conn = { id: 'p1', engine: 'postgres', name: 'pg' } as unknown as Connection

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

describe('TablePane comment mapping', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { lastGridColumns = null; tablePreview.mockReset(); tableStructure.mockReset() })

  it('attaches structure comments to the DataGrid columns by column name', async () => {
    tablePreview.mockResolvedValue({
      columns: [
        { name: 'id', type: 'bigint' },
        { name: 'status', type: 'text' },
      ] as ResultColumn[],
      rows: [[1, 'open']],
    })
    tableStructure.mockResolvedValue({
      comment: '',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: '', comment: '主键' },
        { name: 'status', type: 'text', nullable: false, default: null, key: '', extra: '', comment: '订单状态' },
      ],
      indexes: [],
      fks: [],
    })

    wrap(<TablePane conn={conn} connId="c1" caps={caps} schema="public" table="orders" />)

    await waitFor(() => expect(lastGridColumns).not.toBeNull())
    await waitFor(() => {
      const byName = Object.fromEntries((lastGridColumns ?? []).map(c => [c.name, c.comment]))
      expect(byName.id).toBe('主键')
      expect(byName.status).toBe('订单状态')
    })
  })

  it('leaves comment undefined for columns absent from the structure', async () => {
    tablePreview.mockResolvedValue({
      columns: [{ name: 'computed', type: 'int' }] as ResultColumn[],
      rows: [[42]],
    })
    tableStructure.mockResolvedValue({
      comment: '', columns: [], indexes: [], fks: [],
    })

    wrap(<TablePane conn={conn} connId="c1" caps={caps} schema="public" table="orders" />)

    await waitFor(() => expect(lastGridColumns).not.toBeNull())
    await waitFor(() => {
      const col = (lastGridColumns ?? []).find(c => c.name === 'computed')
      expect(col?.comment).toBeUndefined()
    })
  })
})
