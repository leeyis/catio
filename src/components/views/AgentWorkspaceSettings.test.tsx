import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { setAgentWorkspaceScope, prepareAgentWorkspace } from '../../state/agentWorkspace'
import { AgentWorkspaceSettings } from './AgentWorkspaceSettings'

const mocks = vi.hoisted(() => ({ configure: vi.fn(), choose: vi.fn() }))
vi.mock('../../services/localFiles', () => ({ configureLocalWorkspace: mocks.configure, chooseLocalWorkspace: mocks.choose }))

beforeEach(async () => {
  localStorage.clear()
  mocks.configure.mockReset().mockImplementation(async p => p)
  mocks.choose.mockReset()
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  setAgentWorkspaceScope(null)
  setAgentWorkspaceScope('__open')
  await prepareAgentWorkspace()
  mocks.configure.mockClear()
})
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })
function mount() { return render(<LanguageProvider><AgentWorkspaceSettings /></LanguageProvider>) }

describe('Agent workspace settings', () => {
  it('validates and persists a manually entered directory, then restores it on remount', async () => {
    mocks.configure.mockResolvedValue('/Users/test/报告')
    const view = mount()
    fireEvent.change(screen.getByLabelText('本机工作目录'), { target: { value: '/Users/test/报告/.' } })
    expect(mocks.configure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('保存目录'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(localStorage.getItem('catio-agent-workspace:__open')).toBe('/Users/test/报告')
    view.unmount(); mount()
    expect((screen.getByLabelText('本机工作目录') as HTMLInputElement).value).toBe('/Users/test/报告')
  })
  it('chooses a folder but does not grant access until Save; cancellation keeps the draft', async () => {
    mount()
    mocks.choose.mockResolvedValueOnce('/tmp/reports').mockResolvedValueOnce(null)
    fireEvent.click(screen.getByText('选择文件夹'))
    await waitFor(() => expect((screen.getByLabelText('本机工作目录') as HTMLInputElement).value).toBe('/tmp/reports'))
    expect(mocks.configure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('选择文件夹'))
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('本机工作目录') as HTMLInputElement).value).toBe('/tmp/reports')
    fireEvent.click(screen.getByText('保存目录'))
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith('/tmp/reports'))
  })
  it('keeps the previous saved directory on validation failure and clears without deleting files', async () => {
    mount()
    fireEvent.change(screen.getByLabelText('本机工作目录'), { target: { value: '/valid' } })
    fireEvent.click(screen.getByText('保存目录'))
    await screen.findByRole('status')
    mocks.configure.mockRejectedValueOnce('workspaceUnavailable')
    fireEvent.change(screen.getByLabelText('本机工作目录'), { target: { value: '/missing' } })
    fireEvent.click(screen.getByText('保存目录'))
    expect((await screen.findByRole('alert')).textContent).toContain('目录不存在')
    expect(localStorage.getItem('catio-agent-workspace:__open')).toBe('/valid')
    fireEvent.click(screen.getByText('清除目录'))
    await waitFor(() => expect(localStorage.getItem('catio-agent-workspace:__open')).toBeNull())
    expect(mocks.configure).toHaveBeenLastCalledWith(null)
  })
  it('isolates local accounts and revokes access on lock', async () => {
    localStorage.setItem('catio-agent-workspace:alice', '/alice')
    localStorage.setItem('catio-agent-workspace:bob', '/bob')
    setAgentWorkspaceScope('alice')
    mount()
    expect((screen.getByLabelText('本机工作目录') as HTMLInputElement).value).toBe('/alice')
    await act(async () => { await prepareAgentWorkspace(); setAgentWorkspaceScope('bob'); await prepareAgentWorkspace() })
    expect((screen.getByLabelText('本机工作目录') as HTMLInputElement).value).toBe('/bob')
    act(() => setAgentWorkspaceScope(null))
    await expect(prepareAgentWorkspace()).rejects.toThrow('workspaceLocked')
    expect(mocks.configure).toHaveBeenLastCalledWith(null)
  })
  it('disables local directory actions outside desktop', () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    mount()
    expect((screen.getByText('选择文件夹') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('保存目录') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/指定本机目录读写需要使用桌面版/)).toBeTruthy()
  })
})
