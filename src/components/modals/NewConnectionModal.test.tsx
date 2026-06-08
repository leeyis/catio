import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { ConnectionProfile } from '../../state/connections'

// Mock the persistence layer so we can assert on saveProfile calls.
const h = vi.hoisted(() => ({ saveProfile: vi.fn(), sshTest: vi.fn() }))
vi.mock('../../state/connections', () => ({ saveProfile: h.saveProfile }))
vi.mock('../../services/ssh', async (orig) => {
  const actual = await orig<typeof import('../../services/ssh')>()
  return { ...actual, sshTest: h.sshTest }
})

import { NewConnectionModal } from './NewConnectionModal'

const PROFILE: ConnectionProfile = {
  id: 'live-1.2.3.4:22-deploy',
  name: 'my-server',
  host: '1.2.3.4',
  port: 2222,
  user: 'deploy',
  auth: { method: 'password' },
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('NewConnectionModal — create mode', () => {
  beforeEach(() => { h.saveProfile.mockClear(); h.sshTest.mockReset() })

  it('starts with EMPTY defaults (no prototype sample values)', () => {
    wrap(<NewConnectionModal onClose={() => {}} onConnect={() => {}} />)
    // host/SSH tab so the host fields are visible
    fireEvent.click(screen.getByText('主机 / 终端'))
    const name = screen.getByText('名称').parentElement!.querySelector('input') as HTMLInputElement
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    expect(name.value).toBe('')
    expect(host.value).toBe('')
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    expect(user.value).toBe('')
    // No prototype sample values anywhere.
    expect(screen.queryByDisplayValue('prod-web-01')).toBeNull()
    expect(screen.queryByDisplayValue('10.0.1.21')).toBeNull()
    expect(screen.queryByDisplayValue('deploy')).toBeNull()
    expect(screen.queryByDisplayValue('catio')).toBeNull()
    // Port resets to the sensible SSH default on the host tab.
    const port = screen.getByText('端口').parentElement!.querySelector('input') as HTMLInputElement
    expect(port.value).toBe('22')
  })

  it('Test button calls sshTest and renders the real result', async () => {
    h.sshTest.mockResolvedValue({ ok: true, latencyMs: 17 })
    wrap(<NewConnectionModal onClose={() => {}} onConnect={() => {}} />)
    fireEvent.click(screen.getByText('主机 / 终端'))
    const host = screen.getByText('主机').parentElement!.querySelector('input') as HTMLInputElement
    const user = screen.getByText('用户名').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.input(host, { target: { value: '1.2.3.4' } })
    fireEvent.input(user, { target: { value: 'root' } })
    fireEvent.click(screen.getByText('测试连接'))
    expect(h.sshTest).toHaveBeenCalledTimes(1)
    expect(h.sshTest.mock.calls[0][0]).toMatchObject({ host: '1.2.3.4', user: 'root' })
    await waitFor(() => expect(screen.getByText(/测试通过 · 17ms/)).toBeTruthy())
  })
})

describe('NewConnectionModal — edit mode', () => {
  beforeEach(() => { h.saveProfile.mockClear(); h.sshTest.mockReset() })

  it('leaves the password field empty in edit mode (secrets never stored)', () => {
    wrap(<NewConnectionModal editProfile={PROFILE} onClose={() => {}} />)
    const pw = screen.getByPlaceholderText('密码') as HTMLInputElement
    expect(pw.value).toBe('')
  })

  it('renders the edit title and prefills fields from the profile', () => {
    wrap(<NewConnectionModal editProfile={PROFILE} onClose={() => {}} />)
    expect(screen.getByText('编辑连接')).toBeTruthy()
    expect((screen.getByDisplayValue('my-server') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('1.2.3.4') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('2222') as HTMLInputElement)).toBeTruthy()
    expect((screen.getByDisplayValue('deploy') as HTMLInputElement)).toBeTruthy()
  })

  it('Save updates the SAME id, calls onSaved, and does NOT call onConnect', () => {
    const onSaved = vi.fn()
    const onConnect = vi.fn()
    const onClose = vi.fn()
    wrap(<NewConnectionModal editProfile={PROFILE} onSaved={onSaved} onConnect={onConnect} onClose={onClose} />)
    fireEvent.click(screen.getByText('保存'))
    expect(h.saveProfile).toHaveBeenCalledTimes(1)
    expect(h.saveProfile.mock.calls[0][0]).toMatchObject({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 2222, user: 'deploy' })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onConnect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
