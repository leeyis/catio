import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { setOpticalToken } from '../../state/optical'
const mocks = vi.hoisted(() => ({ read: vi.fn(), cancel: vi.fn() }))
vi.mock('../../services/optical', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/optical')>(), opticalRead: mocks.read, opticalCancel: mocks.cancel,
}))
import { OpticalTransferModal } from './OpticalTransferModal'
const item = { name: 'test.bin', path: '/test.bin', type: 'file' as const, size: 3, modified: 0, permissions: '-rw-r--r--', owner: '', group: '' }
function open() { const close = vi.fn(); return { close, ...render(<LanguageProvider><OpticalTransferModal item={item} sessionId="session" onClose={close} /></LanguageProvider>) } }
function frameMessage(frame: HTMLIFrameElement, data: object) { act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { channel: 'catio-cimbar', ...data } })) }) }
describe('optical playback lifecycle', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); setOpticalToken('grant'); mocks.cancel.mockResolvedValue(undefined) })
  afterEach(() => { act(() => setOpticalToken(null)) })
  it('requires explicit start, transfers bytes only to its sandbox, and cancels on close', async () => {
    mocks.read.mockResolvedValue({ name: 'test.bin', data: 'AAH/' })
    const view = open(); expect(mocks.read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('开始播放'))
    const frame = screen.getByTitle('动态码播放区域') as HTMLIFrameElement
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    const send = vi.spyOn(frame.contentWindow!, 'postMessage')
    // Another window cannot trigger the file handoff.
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: window, data: { channel: 'catio-cimbar', type: 'ready' } })) })
    await act(async () => {}); expect(send).not.toHaveBeenCalled()
    frameMessage(frame, { type: 'ready' })
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    const msg = send.mock.calls[0][0]
    expect([...new Uint8Array(msg.buffer)]).toEqual([0, 1, 255])
    frameMessage(frame, { type: 'loaded', requestId: msg.requestId })
    fireEvent.click(screen.getByText('暂停'))
    expect(send.mock.calls[send.mock.calls.length - 1]?.[0].type).toBe('pause')
    frameMessage(frame, { type: 'paused', requestId: msg.requestId })
    expect(screen.getByText('继续')).toBeInTheDocument()
    view.unmount(); expect(mocks.cancel).toHaveBeenCalledWith('grant', msg.requestId)
  })
  it('ignores late file responses after unmount and stops when authorization is removed', async () => {
    let resolve!: (file: { name: string; data: string }) => void
    mocks.read.mockImplementation(() => new Promise(r => { resolve = r }))
    const view = open(); fireEvent.click(screen.getByText('开始播放'))
    const frame = screen.getByTitle('动态码播放区域') as HTMLIFrameElement
    const send = vi.spyOn(frame.contentWindow!, 'postMessage')
    frameMessage(frame, { type: 'ready' })
    act(() => setOpticalToken(null)); expect(view.close).toHaveBeenCalled()
    expect(screen.queryByTitle('动态码播放区域')).toBeNull()
    await act(async () => { resolve({ name: 'test.bin', data: 'AAH/' }) })
    expect(send).not.toHaveBeenCalled(); expect(mocks.cancel).toHaveBeenCalled()
  })
  it('tears down the encoder and cancels reading on encoder failure', async () => {
    mocks.read.mockImplementation(() => new Promise(() => {}))
    open(); fireEvent.click(screen.getByText('开始播放'))
    const frame = screen.getByTitle('动态码播放区域') as HTMLIFrameElement
    frameMessage(frame, { type: 'error' })
    expect(screen.getByRole('alert')).toHaveTextContent('WebGL')
    expect(screen.queryByTitle('动态码播放区域')).toBeNull()
    expect(mocks.cancel).toHaveBeenCalled()
  })
})
