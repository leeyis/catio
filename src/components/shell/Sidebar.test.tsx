import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { ConnRow, Sidebar } from './Sidebar'
import type { Connection } from '../../services/types'

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

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('Sidebar ConnRow', () => {
  it('clicking the card body calls onOpen (details path)', () => {
    const onOpen = vi.fn()
    wrap(<ConnRow conn={CONN} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('my-server'))
    expect(onOpen).toHaveBeenCalledWith(CONN)
  })

  it('no longer renders the per-card detail icon button', () => {
    const onOpen = vi.fn()
    const { container } = wrap(<ConnRow conn={CONN} onOpen={onOpen} />)
    // The old detail affordance was an icon-btn with title 详情.
    expect(screen.queryByTitle('详情')).toBeNull()
    // Hovering should not surface any inner button (the row is the only clickable).
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('Sidebar footer auth state', () => {
  it('auth disabled: shows authDisabled text, no mock user, enable button calls onEnableAuth', () => {
    const onOpen = vi.fn()
    const onEnableAuth = vi.fn()
    wrap(
      <Sidebar
        onOpen={onOpen}
        authEnabled={false}
        currentUser="skyler"
        onEnableAuth={onEnableAuth}
      />
    )
    // Shows the auth-disabled label (zh locale default)
    expect(screen.getByText('未设登录密码')).toBeTruthy()
    // Enable affordance is present
    const enableBtn = screen.getByText('立即设置')
    expect(enableBtn).toBeTruthy()
    // Clicking enable calls onEnableAuth
    fireEvent.click(enableBtn)
    expect(onEnableAuth).toHaveBeenCalledTimes(1)
  })

  it('auth disabled: does NOT show the lock button', () => {
    const onOpen = vi.fn()
    wrap(
      <Sidebar
        onOpen={onOpen}
        authEnabled={false}
        currentUser="skyler"
      />
    )
    expect(screen.queryByTitle('锁定工作区')).toBeNull()
  })

  it('auth enabled: shows currentUser + lock button, no authDisabled text', () => {
    const onOpen = vi.fn()
    const onLock = vi.fn()
    wrap(
      <Sidebar
        onOpen={onOpen}
        authEnabled={true}
        currentUser="alice"
        onLock={onLock}
      />
    )
    // User name shown
    expect(screen.getByText('alice')).toBeTruthy()
    // Lock button present (zh locale title)
    const lockBtn = screen.getByTitle('锁定工作区')
    expect(lockBtn).toBeTruthy()
    fireEvent.click(lockBtn)
    expect(onLock).toHaveBeenCalledTimes(1)
    // Auth-disabled text must not appear
    expect(screen.queryByText('未设登录密码')).toBeNull()
  })
})
