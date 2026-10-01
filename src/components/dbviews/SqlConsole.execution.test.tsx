import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'
import type { DataGridProps } from './DataGrid'

const api = vi.hoisted(() => ({ runQuery: vi.fn(), splitQuery: vi.fn(), cancelQuery: vi.fn(), grid: null as DataGridProps | null }))
vi.mock('../../services/db', async original => ({
  ...await original<typeof import('../../services/db')>(),
  runQuery: api.runQuery, splitQuery: api.splitQuery, cancelQuery: api.cancelQuery,
  getSchema: vi.fn().mockResolvedValue({ db: 'c1', schemas: [] }),
  schemaColumns: vi.fn().mockResolvedValue([]), erRelations: vi.fn().mockResolvedValue([]),
}))
vi.mock('./SqlEditor', () => ({ SqlEditor: () => <div /> }))
vi.mock('./DataGrid', () => ({ DataGrid: (props: DataGridProps) => {
  api.grid = props
  return <div data-testid="result-grid">{props.loadError && <span role="alert">{props.loadError}</span>}</div>
} }))
const wrap = (engine = 'postgres', sql = 'SELECT 1') => render(
  <LanguageProvider><DataProvider><SqlConsole fresh connId="c1" engine={engine} initialCode={sql} /></DataProvider></LanguageProvider>,
)
beforeAll(async () => { await i18n.changeLanguage('en') })
beforeEach(() => { api.runQuery.mockReset(); api.splitQuery.mockReset().mockImplementation((_id: string, sql: string) => Promise.resolve([sql])); api.cancelQuery.mockReset(); api.grid = null })

describe('SQL execution truthfulness', () => {
  it('waits for the backend terminal result after requesting cancellation', async () => {
    let reject!: (e: Error) => void
    api.runQuery.mockReturnValue(new Promise((_, no) => { reject = no }))
    api.cancelQuery.mockResolvedValue(undefined)
    wrap()
    fireEvent.click(screen.getByTestId('sql-run'))
    await waitFor(() => expect(api.runQuery).toHaveBeenCalledTimes(1))
    const execution = api.runQuery.mock.calls[0][5] as { executionId: string }
    expect(execution.executionId).toMatch(/^[\w-]+$/)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(api.cancelQuery).toHaveBeenCalledWith('c1', execution.executionId))
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
    expect(screen.queryByTestId('result-grid')).not.toBeInTheDocument()
    await act(async () => { reject(new Error('query cancelled')) })
    expect(screen.getByRole('alert')).toHaveTextContent('query cancelled')
    expect(screen.getByTestId('sql-run')).toBeEnabled()
  })

  it('does not claim an unsupported cancellation stopped the server query', async () => {
    let resolve!: (value: unknown) => void
    api.runQuery.mockReturnValue(new Promise(ok => { resolve = ok }))
    api.cancelQuery.mockRejectedValue(new Error('native cancellation not supported; still executing'))
    wrap('jdbc')
    fireEvent.click(screen.getByTestId('sql-run'))
    await waitFor(() => expect(api.runQuery).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('still executing')
    expect(screen.queryByTestId('sql-run')).not.toBeInTheDocument()
    await act(async () => { resolve({ columns: [{ name: 'n', type: 'int' }], rows: [[1]] }) })
    expect(screen.getByTestId('sql-run')).toBeEnabled()
  })

  it('shows affected rows and never gives a mutation to the paging/refresh replay path', async () => {
    api.runQuery.mockResolvedValue({ columns: [], rows: [], rowsAffected: 2, truncated: false })
    wrap('postgres', 'UPDATE items SET active=true')
    fireEvent.click(screen.getByTestId('sql-run'))
    await screen.findByTestId('result-grid')
    expect(screen.getByRole('status')).toHaveTextContent('2')
    expect(api.grid?.sql).toBeUndefined()
    expect(api.grid?.writable).toBe(false)
  })

  it('runs multiple statements once, exposes each result, and stops before later writes after an error', async () => {
    api.splitQuery.mockResolvedValue(['SELECT 1', 'bad statement', 'DELETE FROM items'])
    api.runQuery.mockResolvedValueOnce({ columns: [{ name: 'n', type: 'int' }], rows: [[1]] })
      .mockRejectedValueOnce(new Error('syntax error'))
    wrap('postgres', 'SELECT 1; bad statement; DELETE FROM items')
    fireEvent.click(screen.getByTestId('sql-run'))
    await screen.findByText('syntax error')
    expect(api.runQuery).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(screen.getByRole('tab', { name: 'Statement 1' }))
    expect(api.grid?.rows).toEqual([[1]])
    expect(api.grid?.loadError).toBeUndefined()
  })

  it('preserves the result cap indicator and engine for a read result', async () => {
    api.runQuery.mockResolvedValue({ columns: [{ name: 'n', type: 'int' }], rows: [[1]], truncated: true })
    wrap()
    fireEvent.click(screen.getByTestId('sql-run'))
    await screen.findByTestId('result-grid')
    expect(api.grid?.truncated).toBe(true)
    expect(api.grid?.engine).toBe('postgres')
  })
})
