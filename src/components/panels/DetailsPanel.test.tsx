import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DetailsPanel } from './DetailsPanel'
import { saveDbConnection, dbProfileToConnection, type DbProfile } from '../../state/dbConnections'

function wrap(ui: React.ReactNode) {
  return render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
}

const profile: DbProfile = {
  id: 'db-test-1', name: 'orders-pg', dbType: 'postgres',
  host: '127.0.0.1', port: 55432, user: 'postgres', database: 'orders',
}

describe('DetailsPanel (db)', () => {
  beforeEach(() => {
    localStorage.clear()
    saveDbConnection(profile)
  })

  it('shows the real saved profile metadata (not the mock CPU/uptime rows)', () => {
    const conn = dbProfileToConnection(profile)
    const { container } = wrap(<DetailsPanel conn={conn} onClose={() => {}} />)
    expect(screen.getAllByText('orders-pg').length).toBeGreaterThan(0)
    expect(screen.getByText('127.0.0.1')).toBeTruthy()
    expect(screen.getByText('55432')).toBeTruthy()
    expect(screen.getByText('postgres')).toBeTruthy()
    // Real status, no mock CPU/内存 or uptime rows.
    expect(screen.getByText('未连接')).toBeTruthy()
    expect(container.textContent ?? '').not.toContain('CPU / 内存')
  })

  it('delete shows a confirm dialog and only deletes on confirm', () => {
    const onDelete = vi.fn()
    const conn = dbProfileToConnection(profile)
    wrap(<DetailsPanel conn={conn} onClose={() => {}} onDelete={onDelete} />)
    // Click the 删除 action button (one in the panel; the dialog adds another after).
    fireEvent.click(screen.getByText('删除'))
    // Second-confirm dialog appears with the connection name.
    expect(screen.getByText(/确定删除连接 orders-pg/)).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
    // Confirm in the dialog.
    const confirmButtons = screen.getAllByText('删除')
    fireEvent.click(confirmButtons[confirmButtons.length - 1])
    expect(onDelete).toHaveBeenCalledWith(profile)
  })

  it('copy writes a password-free descriptor to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const conn = dbProfileToConnection(profile)
    wrap(<DetailsPanel conn={conn} onClose={() => {}} />)
    fireEvent.click(screen.getByText('复制'))
    expect(writeText).toHaveBeenCalledWith('postgres://postgres@127.0.0.1:55432/orders')
  })

  it('connect prompts for a secret when no active connection exists', () => {
    const onConnect = vi.fn().mockResolvedValue(undefined)
    const conn = dbProfileToConnection(profile)
    const { container } = wrap(<DetailsPanel conn={conn} onClose={() => {}} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('连接'))
    // Password prompt appears (type=password input).
    expect(container.querySelector('input[type="password"]')).toBeTruthy()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('renders an empty state when no matching saved profile exists', () => {
    const conn = dbProfileToConnection({ ...profile, id: 'db-missing' })
    wrap(<DetailsPanel conn={conn} onClose={() => {}} />)
    expect(screen.queryByText('orders-pg')).toBeNull()
  })
})
