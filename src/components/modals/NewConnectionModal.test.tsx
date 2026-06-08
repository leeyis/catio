import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { ConnectionProfile } from '../../state/connections'

// Mock the persistence layer so we can assert on saveProfile calls.
const h = vi.hoisted(() => ({ saveProfile: vi.fn() }))
vi.mock('../../state/connections', () => ({ saveProfile: h.saveProfile }))

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

describe('NewConnectionModal — edit mode', () => {
  beforeEach(() => h.saveProfile.mockClear())

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
