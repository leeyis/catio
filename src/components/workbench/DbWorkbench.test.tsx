import { render, screen, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'

// ---- mock listActiveDbConnections so we can control capabilities per-test ----
const h = vi.hoisted(() => ({
  list: vi.fn(() => [] as import('../../state/dbConnections').ActiveDbConnection[]),
  runQuery: vi.fn(),
}))

vi.mock('../../state/dbConnections', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...mod, listActiveDbConnections: h.list }
})

// ---- mock the db service so the live-connection data path can be driven without Tauri ----
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, runQuery: h.runQuery }
})

import { DbWorkbench } from './DbWorkbench'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

const CONN = DATA.byId['d-orders'] // has id: 'd-orders', kind: 'db'

describe('DbWorkbench capability-gating', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.runQuery.mockReset()
    // Default: resolve to an empty result so capability-gating tests (which now have an
    // active connection → live fetch) don't crash on an undefined promise.
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
  })

  it('all tabs enabled when no active connection (mock/demo path)', () => {
    // listActiveDbConnections returns [] → ALL_ENABLED fallback
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)

    // Structure Segmented button should be enabled
    expect(screen.getByTestId('seg-structure')).not.toBeDisabled()

    // SQL console button should be enabled
    expect(screen.getByTestId('btn-sql-console')).not.toBeDisabled()

    // ER button should be enabled
    expect(screen.getByTestId('btn-er-diagram')).not.toBeDisabled()
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

    // SQL console button should be disabled
    expect(screen.getByTestId('btn-sql-console')).toBeDisabled()

    // ER button should be disabled
    expect(screen.getByTestId('btn-er-diagram')).toBeDisabled()
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
    expect(screen.getByTestId('btn-sql-console')).not.toBeDisabled()
    expect(screen.getByTestId('btn-er-diagram')).not.toBeDisabled()
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
    expect(screen.getByTestId('btn-sql-console')).not.toBeDisabled()
    expect(screen.getByTestId('btn-er-diagram')).not.toBeDisabled()
  })
})

describe('DbWorkbench live-connection data path', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.runQuery.mockReset()
    // Default: resolve to an empty result so capability-gating tests (which now have an
    // active connection → live fetch) don't crash on an undefined promise.
    h.runQuery.mockResolvedValue({ columns: [], rows: [] })
  })

  it('fetches real rows via runQuery and renders them in the DataGrid when connected', async () => {
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
    h.runQuery.mockResolvedValue({
      columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'label', type: 'text' },
      ],
      rows: [[1, 'live-alpha'], [2, 'live-beta']],
    })

    wrap(<DbWorkbench conn={CONN} />)

    // runQuery is called for the selected table with a schema-qualified SELECT.
    await waitFor(() => expect(h.runQuery).toHaveBeenCalled())
    expect(h.runQuery).toHaveBeenCalledWith('conn-live', 'SELECT * FROM public.orders')

    // Fetched rows render (proves connId/sql/columns/rows threaded into DataGrid).
    expect(await screen.findByText('live-alpha')).toBeInTheDocument()
    expect(screen.getByText('live-beta')).toBeInTheDocument()
    // The grid is writable (pk present) → the cell edit/Save affordance path is active.
    expect(screen.getByText('label')).toBeInTheDocument()
  })

  it('uses the mock orders data (no runQuery) when there is no active connection', () => {
    h.list.mockReturnValue([])
    wrap(<DbWorkbench conn={CONN} />)
    expect(h.runQuery).not.toHaveBeenCalled()
  })
})
