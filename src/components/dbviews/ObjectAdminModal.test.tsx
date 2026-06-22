import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { ObjectAdminModal } from './ObjectAdminModal'

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('ObjectAdminModal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drop: confirm stays disabled until the exact object name is typed', () => {
    const onConfirm = vi.fn()
    wrap(<ObjectAdminModal op="drop" objectType="TABLE" schema="public" name="orders" onConfirm={onConfirm} onCancel={() => {}} />)
    const btn = screen.getByTestId('obj-admin-confirm') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onConfirm).not.toHaveBeenCalled()
    // Wrong text keeps it disabled.
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'order' } })
    expect((screen.getByTestId('obj-admin-confirm') as HTMLButtonElement).disabled).toBe(true)
    // Exact name enables it; confirm fires with no payload (drop needs none).
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'orders' } })
    expect((screen.getByTestId('obj-admin-confirm') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('obj-admin-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it('truncate: requires typing the table name to confirm', () => {
    const onConfirm = vi.fn()
    wrap(<ObjectAdminModal op="truncate" objectType="TABLE" schema={undefined} name="events" onConfirm={onConfirm} onCancel={() => {}} />)
    expect((screen.getByTestId('obj-admin-confirm') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'events' } })
    fireEvent.click(screen.getByTestId('obj-admin-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it('rename: confirm passes the new name and is disabled when empty/unchanged', () => {
    const onConfirm = vi.fn()
    wrap(<ObjectAdminModal op="rename" objectType="TABLE" schema="public" name="orders" onConfirm={onConfirm} onCancel={() => {}} />)
    const btn = () => screen.getByTestId('obj-admin-confirm') as HTMLButtonElement
    // Empty new name → disabled.
    expect(btn().disabled).toBe(true)
    // Same as old name → still disabled (no-op rename).
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'orders' } })
    expect(btn().disabled).toBe(true)
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'orders_2024' } })
    expect(btn().disabled).toBe(false)
    fireEvent.click(btn())
    expect(onConfirm).toHaveBeenCalledWith('orders_2024')
  })

  it('duplicate: confirm passes the target table name', () => {
    const onConfirm = vi.fn()
    wrap(<ObjectAdminModal op="duplicate" objectType="TABLE" schema="public" name="users" onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.change(screen.getByTestId('obj-admin-input'), { target: { value: 'users_copy' } })
    fireEvent.click(screen.getByTestId('obj-admin-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('users_copy')
  })

  it('cancel fires onCancel', () => {
    const onCancel = vi.fn()
    wrap(<ObjectAdminModal op="drop" objectType="TABLE" schema="public" name="orders" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('obj-admin-cancel'))
    expect(onCancel).toHaveBeenCalled()
  })
})
