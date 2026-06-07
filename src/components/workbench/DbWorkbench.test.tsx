import { render, screen } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'

// ---- mock listActiveDbConnections so we can control capabilities per-test ----
const h = vi.hoisted(() => ({
  list: vi.fn(() => [] as import('../../state/dbConnections').ActiveDbConnection[]),
}))

vi.mock('../../state/dbConnections', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state/dbConnections')>()
  return { ...mod, listActiveDbConnections: h.list }
})

import { DbWorkbench } from './DbWorkbench'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

const CONN = DATA.byId['d-orders'] // has id: 'd-orders', kind: 'db'

describe('DbWorkbench capability-gating', () => {
  beforeEach(() => h.list.mockReset())

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
