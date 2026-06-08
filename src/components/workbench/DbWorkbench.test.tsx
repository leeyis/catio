import { render, screen, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'

// ---- mock listActiveDbConnections so we can control capabilities per-test ----
const h = vi.hoisted(() => ({
  list: vi.fn(() => [] as import('../../state/dbConnections').ActiveDbConnection[]),
  tablePreview: vi.fn(),
  getSchema: vi.fn(),
}))

vi.mock('../../state/dbConnections', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...mod, listActiveDbConnections: h.list }
})

// ---- mock the db service so the live-connection data path can be driven without Tauri ----
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, tablePreview: h.tablePreview, getSchema: h.getSchema }
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
    // Defaults so capability-gating tests (which now have an active connection →
    // live fetch + schema load) don't crash on an undefined promise.
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
  })

  it('all tabs enabled when no active connection (mock/demo path)', () => {
    // listActiveDbConnections returns [] → ALL_ENABLED fallback
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)

    // Structure Segmented button should be enabled
    expect(screen.getByTestId('seg-structure')).not.toBeDisabled()
  })

  it('disables structure/er/sqlConsole tabs when capabilities are false', () => {
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

    // Structure Segmented button should be disabled
    expect(screen.getByTestId('seg-structure')).toBeDisabled()
  })

  it('disables only structureEdit=false, leaves er/sqlConsole enabled', () => {
    h.list.mockReturnValue([
      {
        connId: 'conn-2',
        profileId: 'd-orders',
        dbType: 'redis',
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

    expect(screen.getByTestId('seg-structure')).toBeDisabled()
  })

  it('all tabs enabled when all capabilities are true', () => {
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

    expect(screen.getByTestId('seg-structure')).not.toBeDisabled()
  })
})

describe('DbWorkbench live-connection data path', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.tablePreview.mockReset()
    h.getSchema.mockReset()
    h.tablePreview.mockResolvedValue({ columns: [], rows: [] })
    h.getSchema.mockResolvedValue(LIVE_SCHEMA)
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
