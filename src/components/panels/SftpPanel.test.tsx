import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { Connection, SftpItem } from '../../services/types'

// ---- ssh service mock ----
const h = vi.hoisted(() => ({
  sftpList: vi.fn(),
  sftpRealpath: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpTouch: vi.fn(),
  sftpRename: vi.fn(),
  sftpDelete: vi.fn(),
  sftpDownloadUrl: vi.fn((sessionId: string, path: string) => `/api/sftp/download?sessionId=${sessionId}&path=${path}`),
  sftpTransferCancel: vi.fn(),
  isSshSessionLostError: vi.fn((e: unknown) => {
    const kind = e && typeof e === 'object' && 'kind' in e ? String((e as { kind?: unknown }).kind) : ''
    const msg = e instanceof Error ? e.message : String(e && typeof e === 'object' && 'message' in e ? (e as { message?: unknown }).message : e)
    return kind === 'NotFound' || kind === 'ChannelClosed' || msg.toLowerCase().includes('session not found') || msg.toLowerCase().includes('channel closed')
  }),
  sshErrorMessage: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e && typeof e === 'object' && 'message' in e ? (e as { message?: unknown }).message : e)),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('../../services/ssh', () => ({
  sftpList: h.sftpList,
  sftpRealpath: h.sftpRealpath,
  sftpUpload: h.sftpUpload,
  sftpDownload: h.sftpDownload,
  sftpMkdir: h.sftpMkdir,
  sftpTouch: h.sftpTouch,
  sftpRename: h.sftpRename,
  sftpDelete: h.sftpDelete,
  sftpDownloadUrl: h.sftpDownloadUrl,
  sftpTransferCancel: h.sftpTransferCancel,
  isSshSessionLostError: h.isSshSessionLostError,
  sshErrorMessage: h.sshErrorMessage,
  listen: h.listen,
}))

// ---- dialog + webview plugin mocks (avoid dynamic import failures in jsdom) ----
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }),
}))

import { SftpPanel } from './SftpPanel'
import { clearSftpNav } from '../../state/sftpNav'

const mk = (o: Partial<SftpItem> & { name: string; path: string; type: SftpItem['type'] }): SftpItem => ({
  size: 0, modified: 1717801234, permissions: '-rw-r--r--', owner: 'root', group: 'root', ...o,
})

const ROOT_ITEMS: SftpItem[] = [
  mk({ name: 'logs', path: '/srv/logs', type: 'dir', permissions: 'drwxr-xr-x' }),
  mk({ name: 'a.txt', path: '/srv/a.txt', type: 'file', size: 1024 }),
]
const LOGS_ITEMS: SftpItem[] = [
  mk({ name: 'app.log', path: '/srv/logs/app.log', type: 'file', size: 4300 }),
]
const CONN_A: Connection = {
  id: 'host-a',
  group: 'g',
  kind: 'host',
  name: 'Host A',
  sub: 'user@host-a:22',
  icon: 'server',
  status: 'up',
  proto: 'ssh',
}
const CONN_B: Connection = {
  ...CONN_A,
  id: 'host-b',
  name: 'Host B',
  sub: 'user@host-b:22',
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('SftpPanel (SFTP wiring)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.sftpRealpath.mockResolvedValue('/srv')
    h.sftpList.mockImplementation((_sid: string, p: string) => Promise.resolve(p === '/srv/logs' ? LOGS_ITEMS : ROOT_ITEMS))
    h.sftpUpload.mockResolvedValue('xfer-1')
    h.sftpDownload.mockResolvedValue('xfer-1')
    h.sftpMkdir.mockResolvedValue(undefined)
    h.sftpTouch.mockResolvedValue(undefined)
    h.sftpRename.mockResolvedValue(undefined)
    h.sftpDelete.mockResolvedValue(undefined)
    h.sftpTransferCancel.mockResolvedValue(undefined)
    h.sftpDownloadUrl.mockClear()
    h.isSshSessionLostError.mockClear()
    h.sshErrorMessage.mockClear()
    h.listen.mockResolvedValue(() => {})
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    localStorage.clear()
    clearSftpNav()
    vi.clearAllMocks()
  })

  it('resolves home then lists the resolved absolute path', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => {
      expect(screen.getByText('a.txt')).toBeTruthy()
      expect(screen.getByText('logs')).toBeTruthy()
    })
    expect(h.sftpRealpath).toHaveBeenCalledWith('sess-1', '.')
    expect(h.sftpList).toHaveBeenCalledWith('sess-1', '/srv')
  })

  it('shows empty state when no sessionId provided', async () => {
    wrap(<SftpPanel onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText(/无活动会话/)).toBeTruthy()
    })
    expect(h.sftpList).not.toHaveBeenCalled()
  })

  it('navigates into a directory on double-click', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy())

    fireEvent.doubleClick(screen.getByText('logs'))
    await waitFor(() => expect(h.sftpList).toHaveBeenCalledWith('sess-1', '/srv/logs'))
    await waitFor(() => expect(screen.getByText('app.log')).toBeTruthy())
  })

  it('notifies the owner when listing fails because the SSH session is gone', async () => {
    const onSessionClosed = vi.fn()
    h.sftpList.mockRejectedValueOnce({ kind: 'NotFound', message: 'session not found: sess-1' })

    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" onSessionClosed={onSessionClosed} />)

    await waitFor(() => expect(onSessionClosed).toHaveBeenCalledWith('sess-1'))
    expect(screen.getByText('session not found: sess-1')).toBeTruthy()
  })

  it('does not close the session for ordinary SFTP operation errors', async () => {
    const onSessionClosed = vi.fn()
    h.sftpList.mockRejectedValueOnce(new Error('sftp error: Permission denied'))

    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" onSessionClosed={onSessionClosed} />)

    await waitFor(() => expect(screen.getByText('sftp error: Permission denied')).toBeTruthy())
    expect(onSessionClosed).not.toHaveBeenCalled()
  })

  it('restores the last browsed directory after the panel is reopened', async () => {
    const { unmount } = wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('logs'))
    await waitFor(() => expect(screen.getByText('app.log')).toBeTruthy())

    // simulate switching to another panel/page and back
    unmount()
    h.sftpRealpath.mockClear()
    h.sftpList.mockClear()
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)

    // restored to /srv/logs from the cache — no home re-resolution, no reload
    await waitFor(() => expect(screen.getByText('app.log')).toBeTruthy())
    expect(h.sftpRealpath).not.toHaveBeenCalled()
    expect(h.sftpList).not.toHaveBeenCalled()
  })

  it('renders an editable address bar with the current path', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    const input = screen.getByDisplayValue('/srv') as HTMLInputElement
    expect(input).toBeTruthy()
  })

  it('jumps to a typed path on Enter', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    const input = screen.getByDisplayValue('/srv') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/srv/logs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(h.sftpList).toHaveBeenCalledWith('sess-1', '/srv/logs'))
  })

  it('scopes SFTP favorites by connection', async () => {
    localStorage.setItem('catio-sftp-favorites-v2', JSON.stringify({
      [CONN_A.id]: ['/srv/only-a'],
      [CONN_B.id]: ['/srv/only-b'],
    }))

    wrap(<SftpPanel onClose={() => {}} conn={CONN_A} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getByTitle('收藏夹 / 快速跳转'))

    expect(screen.getByText('/srv/only-a')).toBeTruthy()
    expect(screen.queryByText('/srv/only-b')).toBeNull()
  })

  it('writes new favorites into the current connection scope only', async () => {
    wrap(<SftpPanel onClose={() => {}} conn={CONN_A} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    fireEvent.click(screen.getByTitle('收藏夹 / 快速跳转'))
    fireEvent.click(screen.getByText('收藏当前目录'))

    const scoped = JSON.parse(localStorage.getItem('catio-sftp-favorites-v2') ?? '{}') as Record<string, string[]>
    expect(scoped[CONN_A.id]).toEqual(['/srv'])
    expect(scoped[CONN_B.id]).toBeUndefined()
    expect(localStorage.getItem('catio-sftp-favorites')).toBeNull()
  })

  it('creates a new folder via the header button + inline input', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getByTitle('新建文件夹'))
    const input = screen.getByPlaceholderText('文件夹名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'newdir' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(h.sftpMkdir).toHaveBeenCalledWith('sess-1', '/srv/newdir'))
  })

  it('renames an entry via the right-click context menu', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.contextMenu(screen.getByText('a.txt'))
    fireEvent.click(screen.getByText('重命名'))
    const input = screen.getByDisplayValue('a.txt') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(h.sftpRename).toHaveBeenCalledWith('sess-1', '/srv/a.txt', '/srv/b.txt'))
  })

  it('can cancel an in-flight upload', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    ;(open as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['/local/big.bin'])
    h.sftpUpload.mockResolvedValueOnce('xfer-9')

    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    fireEvent.click(screen.getByTitle('上传'))
    // the active transfer row (and its cancel button) appears
    await waitFor(() => expect(screen.getByTitle('取消传输')).toBeTruthy())

    fireEvent.click(screen.getByTitle('取消传输'))
    await waitFor(() => expect(h.sftpTransferCancel).toHaveBeenCalledWith('xfer-9'))
  })

  it('deletes an entry via context menu + confirm', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy())
    fireEvent.contextMenu(screen.getByText('logs'))
    fireEvent.click(screen.getByText('删除'))
    // confirm bar shows a Delete button
    const delButtons = screen.getAllByText('删除')
    fireEvent.click(delButtons[delButtons.length - 1])
    await waitFor(() => expect(h.sftpDelete).toHaveBeenCalledWith('sess-1', '/srv/logs', true))
  })
})
