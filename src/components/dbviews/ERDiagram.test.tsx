import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ERDiagram } from './ERDiagram'
import { invalidateSchemaCache } from '../../services/dbMetadata'
const api = vi.hoisted(() => ({ schemaColumnCatalog: vi.fn(), schemaColumns: vi.fn(), erRelations: vi.fn() }))
vi.mock('../../services/db', async original => ({ ...await original<typeof import('../../services/db')>(), ...api }))
vi.mock('../../state/DataContext', () => ({ useData: () => ({ erModel: { tables: [{ name: 'DEMO_ONLY', x: 0, y: 0 }], relations: [] }, tableStructures: {} }) }))
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name}/> }))
const catalog = (name = 'accounts') => ({ tables: [[name, ['id']]], errors: [], truncated: false })
beforeEach(async () => {
  vi.resetAllMocks(); invalidateSchemaCache(undefined, { announce: false })
  api.schemaColumnCatalog.mockResolvedValue(catalog())
  api.schemaColumns.mockResolvedValue([])
  api.erRelations.mockResolvedValue([])
  await i18n.changeLanguage('en')
})
it('uses the lightweight catalog rather than the legacy column endpoint', async () => {
  render(<ERDiagram connId="c" schema="main"/>)
  expect(await screen.findByText('accounts')).toBeInTheDocument()
  expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c', 'main')
  expect(api.schemaColumns).not.toHaveBeenCalled()
})
it('does not disguise a column failure as an empty database and supports retry', async () => {
  api.schemaColumnCatalog.mockRejectedValueOnce(new Error('permission denied'))
  render(<ERDiagram connId="c" schema="main"/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
  expect(screen.queryByText('No tables to display in this schema')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('accounts')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('keeps available tables when relations fail', async () => {
  api.erRelations.mockRejectedValue(new Error('relations denied'))
  render(<ERDiagram connId="c" schema="main"/>)
  expect(await screen.findByText('accounts')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('relations denied')
})
it('shows partial catalog errors and truncation without claiming an empty schema', async () => {
  api.schemaColumnCatalog.mockResolvedValue({ tables: [], errors: [{ schema: 'main.private', message: 'denied' }], truncated: true })
  render(<ERDiagram connId="c" schema="main"/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('main.private: denied')
  expect(screen.getByRole('alert')).toHaveTextContent('truncated')
  expect(screen.queryByText('No tables to display in this schema')).not.toBeInTheDocument()
})
it('never shows demo tables for a live connection awaiting its namespace', () => {
  render(<ERDiagram connId="c"/>)
  expect(screen.queryByText('DEMO_ONLY')).not.toBeInTheDocument()
  expect(api.schemaColumnCatalog).not.toHaveBeenCalled()
  expect(screen.getByText('Select a schema to load the diagram')).toBeInTheDocument()
})
it('discards a late catalog after switching namespaces', async () => {
  let finish!: (value: ReturnType<typeof catalog>) => void
  api.schemaColumnCatalog.mockImplementation((_id, schema) => schema === 'old' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(catalog('current_table')))
  const view = render(<ERDiagram connId="c" schema="old"/>)
  view.rerender(<ERDiagram connId="c" schema="new"/>)
  expect(await screen.findByText('current_table')).toBeInTheDocument()
  await act(async () => finish(catalog('stale_table')))
  expect(screen.queryByText('stale_table')).not.toBeInTheDocument()
})
it('reloads only for matching metadata invalidation', async () => {
  render(<ERDiagram connId="c" schema="main"/>)
  await screen.findByText('accounts')
  act(() => invalidateSchemaCache('other'))
  act(() => invalidateSchemaCache('c', { schema: 'other' }))
  expect(api.schemaColumnCatalog).toHaveBeenCalledTimes(1)
  api.schemaColumnCatalog.mockResolvedValue(catalog('new_table'))
  act(() => invalidateSchemaCache('c', { schema: 'main' }))
  await waitFor(() => expect(screen.getByText('new_table')).toBeInTheDocument())
})
it('shows a genuinely empty schema only after successful complete reads', async () => {
  api.schemaColumnCatalog.mockResolvedValue({ tables: [], errors: [], truncated: false })
  render(<ERDiagram connId="c" schema="main"/>)
  expect(await screen.findByText('No tables to display in this schema')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('does not draw a missing-column relation onto the first available column', async () => {
  api.schemaColumnCatalog.mockResolvedValue({ tables: [['child', ['actual']], ['parent', ['id']]], errors: [], truncated: false })
  api.erRelations.mockResolvedValue([{ from: 'child', fromCol: 'missing', to: 'parent', toCol: 'id' }])
  const view = render(<ERDiagram connId="c" schema="main"/>)
  await screen.findByText('parent')
  expect(view.container.querySelector('path')?.getAttribute('d')).toBe('')
})
it('does not infer a primary key merely from the target of a foreign key', async () => {
  const tables: [string, string[]][] = [['child', ['parent_code']], ['parent', ['code']]]
  api.schemaColumnCatalog.mockResolvedValue({ tables, errors: [], truncated: false })
  api.schemaColumns.mockResolvedValue(tables)
  api.erRelations.mockResolvedValue([{ from: 'child', fromCol: 'parent_code', to: 'parent', toCol: 'code' }])
  const view = render(<ERDiagram connId="c" schema="main"/>)
  await screen.findByText('parent')
  expect(view.container.querySelector('[data-icon="key"]')).toBeNull()
  expect(view.container.querySelector('[data-icon="link"]')).not.toBeNull()
})
