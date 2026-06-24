import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'

const h = vi.hoisted(() => ({ saveDbConnection: vi.fn() }))
vi.mock('../../state/dbConnections', async (orig) => {
  const actual = await orig<typeof import('../../state/dbConnections')>()
  return { ...actual, saveDbConnection: h.saveDbConnection }
})

import { ImportConnectionsModal } from './ImportConnectionsModal'

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>,
  )
}

/** Drive a File through the hidden <input type=file> + FileReader path. */
function uploadFile(name: string, content: string) {
  const input = screen.getByTestId('import-file-input') as HTMLInputElement
  const file = new File([content], name, { type: 'text/plain' })
  // jsdom's FileReader.readAsText reads File contents fine.
  fireEvent.change(input, { target: { files: [file] } })
}

const DBEAVER_JSON = JSON.stringify({
  connections: {
    c1: {
      provider: 'mysql',
      name: 'prod-mysql',
      configuration: { host: 'db.example.com', port: '3306', user: 'appuser', 'database-name': 'orders' },
    },
  },
})

describe('ImportConnectionsModal', () => {
  beforeEach(() => h.saveDbConnection.mockReset())

  it('parses a DBeaver file and previews the connection', async () => {
    wrap(<ImportConnectionsModal onClose={() => {}} />)
    uploadFile('data-sources.json', DBEAVER_JSON)
    expect(await screen.findByText('prod-mysql')).toBeTruthy()
    // Draft has no password → "需要认证" badge shows.
    expect(screen.getAllByText('需要认证').length).toBeGreaterThan(0)
  })

  it('imports the selected drafts via saveDbConnection and closes', async () => {
    const onClose = vi.fn()
    const onImported = vi.fn()
    wrap(<ImportConnectionsModal onClose={onClose} onImported={onImported} />)
    uploadFile('data-sources.json', DBEAVER_JSON)
    await screen.findByText('prod-mysql')
    fireEvent.click(screen.getByText('导入 1 条'))
    await waitFor(() => expect(h.saveDbConnection).toHaveBeenCalledTimes(1))
    const saved = h.saveDbConnection.mock.calls[0][0]
    expect(saved.name).toBe('prod-mysql')
    expect(saved.dbType).toBe('mysql')
    expect(saved.host).toBe('db.example.com')
    expect(saved.needsAuth).toBe(true)
    expect(saved.id).toBeTruthy()
    expect(onImported).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows an error when the file has no importable connections', async () => {
    wrap(<ImportConnectionsModal onClose={() => {}} />)
    uploadFile('data-sources.json', '{"foo":1}')
    expect(await screen.findByText(/未发现可导入的连接/)).toBeTruthy()
  })

  it('shows a parse error on malformed content', async () => {
    wrap(<ImportConnectionsModal onClose={() => {}} />)
    uploadFile('data-sources.json', 'not json at all')
    expect(await screen.findByText(/无法解析该文件/)).toBeTruthy()
  })
})
