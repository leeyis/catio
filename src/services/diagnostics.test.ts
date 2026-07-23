import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import { diagnosticLogDir, writeDiagnosticLog } from './diagnostics'

beforeEach(() => {
  invokeMock.mockReset()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('diagnostic logging', () => {
  it('persists only the structured diagnostic event in Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    invokeMock.mockResolvedValue(undefined)
    const event = {
      level: 'debug' as const,
      area: 'terminal' as const,
      event: 'busy-detected',
      channelId: 'term-7',
      source: 'busy-check' as const,
      active: true,
      capture: false,
      busy: true,
    }

    await writeDiagnosticLog(event)

    expect(invokeMock).toHaveBeenCalledWith('diagnostics_log', { event })
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('command')
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('host')
  })

  it('does not call a desktop command in browser mode', async () => {
    await writeDiagnosticLog({
      level: 'info',
      area: 'agent',
      event: 'split-requested',
      source: 'split-request',
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('resolves the platform log directory through the backend', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    invokeMock.mockResolvedValue('C:\\logs\\catio')

    await expect(diagnosticLogDir()).resolves.toBe('C:\\logs\\catio')
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_log_dir')
  })
})
