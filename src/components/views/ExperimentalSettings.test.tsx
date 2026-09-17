import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { lockOptical, setOpticalToken } from '../../state/optical'
const mocks = vi.hoisted(() => ({ status: vi.fn(), unlock: vi.fn(), lock: vi.fn() }))
vi.mock('../../services/optical', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/optical')>(),
  opticalAvailable: () => true, opticalStatus: mocks.status, opticalUnlock: mocks.unlock, opticalLock: mocks.lock,
}))
import { ExperimentalSettings } from './ExperimentalSettings'
function renderSettings() { return render(<LanguageProvider><ExperimentalSettings /></LanguageProvider>) }
describe('experimental feature gate', () => {
  beforeEach(() => {
    localStorage.clear(); setOpticalToken(null); vi.clearAllMocks()
    mocks.status.mockResolvedValue({ visible: true, configured: true, canConfigure: true }); mocks.lock.mockResolvedValue(undefined)
  })
  afterEach(() => { act(() => setOpticalToken(null)) })
  it('hides the panel when the installation switch is off', async () => {
    mocks.status.mockResolvedValue({ visible: false, configured: false, canConfigure: false })
    renderSettings(); await act(async () => {})
    expect(screen.queryByRole('switch')).toBeNull()
    expect(mocks.unlock).not.toHaveBeenCalled()
  })
  it('requires reading and accepting the disclaimer for each unlock', async () => {
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'test-passphrase' } })
    expect(screen.getByRole('button', { name: '验证并开启' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('dialog'))
    expect(mocks.unlock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: '验证并开启' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
  it('stays off after a wrong passphrase and never persists the secret', async () => {
    mocks.unlock.mockRejectedValue('optical.wrongPassphrase')
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'wrong-passphrase' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('口令不正确')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('口令')).toHaveValue('')
    expect(JSON.stringify(localStorage)).not.toContain('wrong-passphrase')
  })
  it('unlocks only after success and revokes on disable', async () => {
    mocks.unlock.mockResolvedValue('grant')
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'test-passphrase' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    expect(mocks.unlock).toHaveBeenCalledWith('test-passphrase', false)
    fireEvent.click(screen.getByRole('switch'))
    expect(mocks.lock).toHaveBeenCalledWith('grant')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
  it('revokes a late successful unlock after the dialog is cancelled', async () => {
    let resolve!: (value: string) => void
    mocks.unlock.mockImplementation(() => new Promise<string>(r => { resolve = r }))
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'test-passphrase' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => { resolve('late-grant') })
    expect(mocks.lock).toHaveBeenCalledWith('late-grant')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
  it('requires matching initial passphrases and prevents non-admin setup', async () => {
    mocks.status.mockResolvedValue({ visible: true, configured: false, canConfigure: true })
    const view = renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'test-passphrase' } })
    fireEvent.change(screen.getByLabelText('确认口令'), { target: { value: 'different' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }))
    expect(screen.getByRole('alert')).toHaveTextContent('不一致'); expect(mocks.unlock).not.toHaveBeenCalled()
    view.unmount(); mocks.status.mockResolvedValue({ visible: true, configured: false, canConfigure: false })
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('alert')).toHaveTextContent('管理员')
    expect(screen.queryByLabelText('口令')).not.toBeInTheDocument()
  })
  it('does not re-enable after the workspace locks during an unlock request', async () => {
    let resolve!: (value: string) => void
    mocks.unlock.mockImplementation(() => new Promise<string>(r => { resolve = r }))
    renderSettings(); await act(async () => {})
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 'test-passphrase' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '验证并开启' }))
    await act(async () => { await lockOptical(); resolve('late-grant') })
    expect(mocks.lock).toHaveBeenCalledWith('late-grant')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
})
