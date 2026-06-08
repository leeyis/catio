import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DetailsPanel } from './DetailsPanel'
import { saveDbConnection, dbProfileToConnection, type DbProfile } from '../../state/dbConnections'
import type { Connection } from '../../services/types'

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

const CONN: Connection = {
  id: 'live-1.2.3.4:22-deploy',
  group: '',
  kind: 'host',
  name: 'my-server',
  sub: 'deploy@1.2.3.4:22',
  icon: 'server',
  status: 'idle',
  proto: 'ssh',
}

const profile: DbProfile = {
  id: 'db-test-1', name: 'orders-pg', dbType: 'postgres',
  host: '127.0.0.1', port: 55432, user: 'postgres', database: 'orders',
}

describe('DetailsPanel (host)', () => {
  it('renders the passed connection name and sub', () => {
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} />)
    expect(screen.getAllByText('my-server').length).toBeGreaterThan(0)
    expect(screen.getByText('deploy@1.2.3.4:22')).toBeTruthy()
  })

  it('Connect button calls onConnect with the conn', () => {
    const onConnect = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('连接'))
    expect(onConnect).toHaveBeenCalledWith(CONN)
  })

  it('pencil (edit) calls onEdit with the conn', () => {
    const onEdit = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onEdit={onEdit} />)
    fireEvent.click(screen.getByTitle('编辑'))
    expect(onEdit).toHaveBeenCalledWith(CONN)
  })

  it('Copy button calls onCopy with the conn', () => {
    const onCopy = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onCopy={onCopy} />)
    fireEvent.click(screen.getByText('复制'))
    expect(onCopy).toHaveBeenCalledWith(CONN)
  })

  it('trash (delete) calls onDelete with the conn', () => {
    const onDelete = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onDelete={onDelete} />)
    fireEvent.click(screen.getByTitle('删除'))
    expect(onDelete).toHaveBeenCalledWith(CONN)
  })

  it('shows Close-session (not Connect) when connected, calling onCloseSession', () => {
    const onCloseSession = vi.fn()
    wrap(<DetailsPanel conn={CONN} connected onClose={() => {}} onCloseSession={onCloseSession} />)
    expect(screen.queryByText('连接')).toBeNull()
    fireEvent.click(screen.getByText('关闭会话'))
    expect(onCloseSession).toHaveBeenCalledWith(CONN)
  })

  it('hides the last-used row when lastUsed is undefined', () => {
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} />)
    expect(screen.queryByText('最近使用')).toBeNull()
  })
})

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
    wrap(<DetailsPanel conn={conn} onClose={() => {}} onDeleteDb={onDelete} />)
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
    const { container } = wrap(<DetailsPanel conn={conn} onClose={() => {}} onConnectDb={onConnect} />)
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
