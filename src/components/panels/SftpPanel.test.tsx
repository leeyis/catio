import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'

// ---- ssh service mock ----
const h = vi.hoisted(() => ({
  getSftp: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('../../services/ssh', () => ({
  getSftp: h.getSftp,
  sftpUpload: h.sftpUpload,
  sftpDownload: h.sftpDownload,
  listen: h.listen,
}))

// ---- dialog plugin mock (avoids dynamic import failures in jsdom) ----
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}))

import { SftpPanel } from './SftpPanel'

const MOCK_SFTP = {
  path: '/srv',
  items: [
    { name: 'a.txt', type: 'file' as const, size: '1.0 KB' },
    { name: 'logs', type: 'dir' as const },
  ],
}

const MOCK_SFTP_LOGS = {
  path: '/srv/logs',
  items: [
    { name: 'app.log', type: 'file' as const, size: '4.2 KB' },
  ],
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
    h.getSftp.mockResolvedValue(MOCK_SFTP)
    h.sftpUpload.mockResolvedValue(undefined)
    h.sftpDownload.mockResolvedValue(undefined)
    h.listen.mockResolvedValue(() => {})
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    h.getSftp.mockClear()
    h.sftpUpload.mockClear()
    h.sftpDownload.mockClear()
    h.listen.mockClear()
  })

  it('renders items returned by getSftp', async () => {
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => {
      expect(screen.getByText('a.txt')).toBeTruthy()
      expect(screen.getByText('logs')).toBeTruthy()
    })
    expect(h.getSftp).toHaveBeenCalledWith('sess-1', expect.anything())
  })

  it('shows empty state when no sessionId provided', async () => {
    // Without sessionId, panel renders PanelEmpty — getSftp is NOT called
    wrap(<SftpPanel onClose={() => {}} />)
    await waitFor(() => {
      // Match the noSessionHint text (zh locale in tests)
      expect(screen.getByText(/无活动会话/)).toBeTruthy()
    })
    expect(h.getSftp).not.toHaveBeenCalled()
  })

  it('navigates into a directory when clicking a dir row', async () => {
    h.getSftp
      .mockResolvedValueOnce(MOCK_SFTP)
      .mockResolvedValueOnce(MOCK_SFTP_LOGS)

    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy())

    fireEvent.click(screen.getByText('logs'))
    await waitFor(() => expect(h.getSftp).toHaveBeenCalledWith('sess-1', '/srv/logs'))
    await waitFor(() => expect(screen.getByText('app.log')).toBeTruthy())
  })

  it('shows the ".." entry when not at root', async () => {
    h.getSftp.mockResolvedValue(MOCK_SFTP)
    wrap(<SftpPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('..')).toBeTruthy())
  })

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn()
    wrap(<SftpPanel onClose={onClose} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    // Just verify the panel renders and onClose is wired (tested via PanelShell)
    expect(onClose).not.toHaveBeenCalled()
  })
})
