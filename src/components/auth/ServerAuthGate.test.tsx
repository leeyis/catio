import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import i18n from '../../i18n'

const h = vi.hoisted(() => ({
  isServer: vi.fn(),
  authMe: vi.fn(),
  authLogin: vi.fn(),
  authBootstrap: vi.fn(),
  authLogout: vi.fn(),
}))
vi.mock('../../services/transport', () => ({ isServer: h.isServer, isTauri: () => false, rpc: vi.fn() }))
vi.mock('../../services/auth', () => ({
  authMe: h.authMe, authLogin: h.authLogin, authBootstrap: h.authBootstrap, authLogout: h.authLogout,
}))

import { ServerAuthGate } from './ServerAuthGate'

const ADMIN = { id: 1, username: 'admin', isAdmin: true, createdAt: 0 }

describe('ServerAuthGate', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { vi.clearAllMocks() })

  it('passes children straight through outside server mode (desktop/dev)', () => {
    h.isServer.mockReturnValue(false)
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    expect(screen.getByText('APP')).toBeTruthy()
    expect(h.authMe).not.toHaveBeenCalled()
  })

  it('shows the login form when server mode + logged out', async () => {
    h.isServer.mockReturnValue(true)
    h.authMe.mockResolvedValue({ user: null, needsBootstrap: false })
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    await waitFor(() => expect(screen.getByText('Sign in to Catio')).toBeTruthy())
    expect(screen.queryByText('APP')).toBeNull()
  })

  it('shows the first-run bootstrap form when no users exist', async () => {
    h.isServer.mockReturnValue(true)
    h.authMe.mockResolvedValue({ user: null, needsBootstrap: true })
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    // The confirm-password field is unique to the bootstrap form (login has no confirm).
    await waitFor(() => expect(screen.getByPlaceholderText('Re-enter your password')).toBeTruthy())
  })

  it('renders children when already authenticated', async () => {
    h.isServer.mockReturnValue(true)
    h.authMe.mockResolvedValue({ user: ADMIN, needsBootstrap: false })
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    await waitFor(() => expect(screen.getByText('APP')).toBeTruthy())
  })

  it('logs in, then reveals the app', async () => {
    h.isServer.mockReturnValue(true)
    h.authMe.mockResolvedValueOnce({ user: null, needsBootstrap: false }) // initial
    h.authLogin.mockResolvedValue(ADMIN)
    h.authMe.mockResolvedValueOnce({ user: ADMIN, needsBootstrap: false }) // after login
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    await waitFor(() => expect(screen.getByText('Sign in to Catio')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Enter a username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByText('Sign in'))
    await waitFor(() => expect(screen.getByText('APP')).toBeTruthy())
    expect(h.authLogin).toHaveBeenCalledWith('admin', 'secret123')
  })

  it('surfaces the server error message on a failed login', async () => {
    h.isServer.mockReturnValue(true)
    h.authMe.mockResolvedValue({ user: null, needsBootstrap: false })
    h.authLogin.mockRejectedValue(new Error('用户名或口令错误'))
    render(<ServerAuthGate><div>APP</div></ServerAuthGate>)
    await waitFor(() => expect(screen.getByText('Sign in to Catio')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Enter a username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByText('Sign in'))
    await waitFor(() => expect(screen.getByText('用户名或口令错误')).toBeTruthy())
    expect(screen.queryByText('APP')).toBeNull()
  })
})
