import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataTransferDialog } from './DataTransferDialog'

// Mock the db service so the dialog runs without the Tauri runtime.
const transferTable = vi.fn()
const tableStructure = vi.fn()
vi.mock('../../services/db', () => ({
  transferTable: (...a: unknown[]) => transferTable(...a),
  tableStructure: (...a: unknown[]) => tableStructure(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

const connections = [
  { id: 'src', name: 'prod-pg', engine: 'postgres' },
  { id: 'dst', name: 'analytics-ch', engine: 'clickhouse' },
]

describe('DataTransferDialog', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => {
    transferTable.mockReset(); tableStructure.mockReset()
    // Source table columns (user_id, display_name); target table same names.
    tableStructure.mockResolvedValue({
      comment: '', indexes: [], fks: [],
      columns: [
        { name: 'user_id', type: 'int', nullable: false, default: null, key: 'PK', extra: '', comment: '' },
        { name: 'display_name', type: 'text', nullable: true, default: null, key: '', extra: '', comment: '' },
      ],
    })
  })

  it('auto-maps matching columns and migrates with append by default', async () => {
    transferTable.mockResolvedValue({ rowsTransferred: 42 })

    wrap(
      <DataTransferDialog
        connections={connections}
        initialSourceConnId="src"
        initialSourceSchema="public"
        initialSourceTable="users"
        onClose={() => {}}
      />,
    )

    // Pick a target connection + table.
    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
    fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users_copy' } })

    // Target columns load → auto-map matches both → migrate enabled (2 columns).
    const apply = await screen.findByRole('button', { name: /Migrate 2 column/i })
    expect(apply).not.toBeDisabled()

    fireEvent.click(apply)

    await waitFor(() => expect(transferTable).toHaveBeenCalledTimes(1))
    expect(transferTable).toHaveBeenCalledWith({
      sourceConnId: 'src', sourceSchema: 'public', sourceTable: 'users',
      targetConnId: 'dst', targetSchema: undefined, targetTable: 'users_copy',
      mode: 'append',
      mappings: [
        { sourceColumn: 'user_id', targetColumn: 'user_id' },
        { sourceColumn: 'display_name', targetColumn: 'display_name' },
      ],
      upsertKeys: undefined,
    })
    await waitFor(() => expect(screen.getByText(/Migrated 42 row/i)).toBeInTheDocument())
  })

  it('requires typing the target table name to confirm a destructive overwrite, and sends allowDestructive', async () => {
    transferTable.mockResolvedValue({ rowsTransferred: 7 })

    wrap(
      <DataTransferDialog
        connections={connections}
        initialSourceConnId="src"
        initialSourceSchema="public"
        initialSourceTable="users"
        onClose={() => {}}
      />,
    )

    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
    fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users_copy' } })

    // Switch to the destructive overwrite mode (label = "Truncate first").
    fireEvent.click(await screen.findByRole('button', { name: 'Truncate first' }))

    // Migrate stays disabled until the user retypes the exact target table name.
    const apply = await screen.findByRole('button', { name: /Migrate \d+ column/i })
    expect(apply).toBeDisabled()

    // Wrong confirmation text keeps it disabled.
    const confirmInput = screen.getByLabelText('transfer-destructive-confirm')
    fireEvent.change(confirmInput, { target: { value: 'users_cop' } })
    expect(screen.getByRole('button', { name: /Migrate \d+ column/i })).toBeDisabled()

    // Exact match enables it.
    fireEvent.change(confirmInput, { target: { value: 'users_copy' } })
    const enabled = screen.getByRole('button', { name: /Migrate \d+ column/i })
    expect(enabled).not.toBeDisabled()

    fireEvent.click(enabled)
    await waitFor(() => expect(transferTable).toHaveBeenCalledTimes(1))
    const arg = transferTable.mock.calls[0][0]
    expect(arg.mode).toBe('overwrite')
    expect(arg.allowDestructive).toBe(true)
  })

  it('does not send allowDestructive for non-destructive append', async () => {
    transferTable.mockResolvedValue({ rowsTransferred: 1 })
    wrap(
      <DataTransferDialog
        connections={connections}
        initialSourceConnId="src"
        initialSourceSchema="public"
        initialSourceTable="users"
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
    fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users_copy' } })
    fireEvent.click(await screen.findByRole('button', { name: /Migrate 2 column/i }))
    await waitFor(() => expect(transferTable).toHaveBeenCalledTimes(1))
    expect(transferTable.mock.calls[0][0].allowDestructive).toBeUndefined()
  })

  it('hides the upsert mode when the target engine has no native upsert', async () => {
    wrap(
      <DataTransferDialog
        connections={connections}
        initialSourceConnId="src"
        initialSourceSchema="public"
        initialSourceTable="users"
        onClose={() => {}}
      />,
    )
    // Target = clickhouse (no native upsert) → only append + overwrite buttons.
    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Append' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Upsert' })).not.toBeInTheDocument()
  })

  it('requires an upsert key and passes it when target supports upsert', async () => {
    transferTable.mockResolvedValue({ rowsTransferred: 3 })
    // Make BOTH connections postgres so the target supports native upsert.
    const pgConns = [
      { id: 'src', name: 'prod-pg', engine: 'postgres' },
      { id: 'dst', name: 'staging-pg', engine: 'postgres' },
    ]
    wrap(
      <DataTransferDialog
        connections={pgConns}
        initialSourceConnId="src"
        initialSourceSchema="public"
        initialSourceTable="users"
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
    fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users' } })

    // Switch to upsert mode.
    fireEvent.click(await screen.findByRole('button', { name: 'Upsert' }))

    // Without a key chosen, migrate stays disabled.
    const apply = screen.getByRole('button', { name: /Migrate \d+ column/i })
    expect(apply).toBeDisabled()

    // Choose user_id as the upsert key.
    fireEvent.click(await screen.findByLabelText('upsert-key-user_id'))
    expect(screen.getByRole('button', { name: /Migrate \d+ column/i })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Migrate \d+ column/i }))
    await waitFor(() => expect(transferTable).toHaveBeenCalledTimes(1))
    const arg = transferTable.mock.calls[0][0]
    expect(arg.mode).toBe('upsert')
    expect(arg.upsertKeys).toEqual(['user_id'])
  })
})
