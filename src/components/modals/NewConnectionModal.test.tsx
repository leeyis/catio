import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'

// ---- mock the db service so the test-connection path is driven without Tauri ----
const h = vi.hoisted(() => ({
  testConnection: vi.fn(),
  dbConnect: vi.fn(),
}))
vi.mock('../../services/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../services/db')>()
  return { ...mod, testConnection: h.testConnection, dbConnect: h.dbConnect }
})

import { NewConnectionModal } from './NewConnectionModal'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

describe('NewConnectionModal', () => {
  beforeEach(() => {
    h.testConnection.mockReset()
    h.dbConnect.mockReset()
  })

  it('defaults to the DB kind and does not prefill mock values', () => {
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    // The DB engine picker (PostgreSQL) is shown → DB kind is active.
    expect(screen.getByText('PostgreSQL')).toBeTruthy()
    // No leftover mock prefill from the reference design.
    expect(container.textContent ?? '').not.toContain('prod-orders')
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    expect(inputs.some(i => i.value === 'prod-orders')).toBe(false)
    expect(inputs.some(i => i.value === '10.0.4.2')).toBe(false)
    expect(inputs.some(i => i.value === 'app_ro')).toBe(false)
  })

  it('opens on the host tab when initialKind="host"', () => {
    wrap(<NewConnectionModal onClose={() => {}} initialKind="host" />)
    // Host kind shows the protocol segmented control (SSH) instead of the DB engine picker.
    expect(screen.getByText('SSH')).toBeTruthy()
    expect(screen.queryByText('PostgreSQL')).toBeNull()
  })

  it('port field rejects non-digit input', () => {
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const port = inputs.find(i => i.value === '5432')!
    expect(port).toBeTruthy()
    fireEvent.change(port, { target: { value: '12ab34' } })
    expect(port.value).toBe('1234')
  })

  it('invokes testConnection and shows the real version + latency on success', async () => {
    h.testConnection.mockResolvedValue({ version: 'PostgreSQL 16.2 on x86_64', latencyMs: 7 })
    const { container } = wrap(<NewConnectionModal onClose={() => {}} />)
    // Fill required-ish fields.
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    const host = inputs.find(i => i.getAttribute('placeholder') === '127.0.0.1')!
    fireEvent.change(host, { target: { value: '127.0.0.1' } })
    // Click 测试连接 (test connection)
    fireEvent.click(screen.getByText('测试连接'))
    expect(h.testConnection).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByText(/PostgreSQL 16.2/)).toBeTruthy()
      expect(screen.getByText(/7ms/)).toBeTruthy()
    })
  })

  it('shows the failure label when testConnection rejects', async () => {
    h.testConnection.mockRejectedValue(new Error('connection refused'))
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('测试连接'))
    await waitFor(() => {
      expect(screen.getByText('测试失败')).toBeTruthy()
      expect(screen.getByText('connection refused')).toBeTruthy()
    })
  })
})
