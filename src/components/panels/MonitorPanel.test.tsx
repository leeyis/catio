import { render, screen, waitFor, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import type { Monitor } from '../../services/types'

// ---- ssh service mock ----
// We need to capture the listen callback so we can push synthetic monitor events.
const h = vi.hoisted(() => ({
  monitorStart: vi.fn().mockResolvedValue(undefined),
  monitorStop: vi.fn().mockResolvedValue(undefined),
  // listen captures callback so tests can invoke it.
  listenCb: null as ((payload: Monitor) => void) | null,
  listen: vi.fn().mockImplementation((_event: string, cb: (payload: Monitor) => void) => {
    h.listenCb = cb
    return Promise.resolve(() => { h.listenCb = null })
  }),
}))

vi.mock('../../services/ssh', () => ({
  monitorStart: h.monitorStart,
  monitorStop: h.monitorStop,
  listen: h.listen,
}))

import { MonitorPanel } from './MonitorPanel'

const CUSTOM_MONITOR: Monitor = {
  host: 'test-server',
  cpu: [55, 60, 65],
  mem: [40, 42, 44],
  net: [10, 12, 14],
  disk: 77,
  cores: 8,
  memTotal: '32 GB',
  memUsed: '14 GB',
  gpus: [],
  procs: [
    { pid: 999, cmd: 'my-custom-proc', cpu: 12.5, mem: 5.1 },
  ],
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('MonitorPanel (monitor wiring)', () => {
  beforeEach(() => {
    h.monitorStart.mockClear()
    h.monitorStop.mockClear()
    h.listen.mockClear()
    h.listenCb = null
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('calls monitorStart and listen when given a sessionId in Tauri env', async () => {
    wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(h.monitorStart).toHaveBeenCalled())
    expect(h.monitorStart).toHaveBeenCalledWith('sess-1', 2000)
    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    expect(h.listen.mock.calls[0][0]).toBe('monitor://sess-1')
  })

  it('reflects live monitor data pushed via listen callback', async () => {
    wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(h.listenCb).not.toBeNull())

    // Push a custom monitor payload through the captured callback.
    // Wrap in act() since this directly triggers a React state update.
    await act(async () => {
      h.listenCb!(CUSTOM_MONITOR)
    })

    await waitFor(() => {
      // Disk 77 should appear.
      expect(screen.getByText(/77%/)).toBeTruthy()
    })

    await waitFor(() => {
      // Custom proc should appear.
      expect(screen.getByText('my-custom-proc')).toBeTruthy()
    })
  })

  it('calls monitorStop on unmount', async () => {
    const { unmount } = wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(h.monitorStart).toHaveBeenCalled())
    unmount()
    await waitFor(() => expect(h.monitorStop).toHaveBeenCalledWith('sess-1'))
  })

  it('does NOT call monitorStart in demo mode (no sessionId)', async () => {
    wrap(<MonitorPanel onClose={() => {}} />)
    // Give effects a tick.
    await new Promise(r => setTimeout(r, 50))
    expect(h.monitorStart).not.toHaveBeenCalled()
    expect(h.listen).not.toHaveBeenCalled()
  })

  it('renders demo data without crashing when no sessionId provided', () => {
    const { container } = wrap(<MonitorPanel onClose={() => {}} />)
    // Panel should render (host name present in the subtitle area).
    expect(container.querySelector('.panel-shell, [data-panel]') || container.firstChild).toBeTruthy()
  })
})
