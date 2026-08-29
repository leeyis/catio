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
  netRx: [7, 8, 9.25],
  netTx: [3, 4, 4.75],
  disk: 77,
  diskTotal: '1 TB',
  diskUsed: '770 GB',
  cores: 8,
  memTotal: '32 GB',
  memUsed: '14 GB',
  system: { os: 'Ubuntu 24.04 LTS', kernel: '6.8.0-test', uptimeSeconds: 90061, processCount: 248 },
  cpuInfo: {
    model: 'AMD EPYC 7543P', sockets: 2, physicalCores: 32, threads: 64,
    frequencyMhz: 2800, l3Cache: '256 MiB', temperatureC: 53,
    load1: 1.2, load5: 0.8, load15: 0.4, userPct: 48.2, systemPct: 12.1, iowaitPct: 4.7,
  },
  memoryInfo: {
    total: '32 GB', used: '14 GB', available: '18 GB', cache: '6 GB',
    swapTotal: '8 GB', swapUsed: '1 GB', active: '11 GB', inactive: '5 GB',
    slab: '768 MB', dirty: '24 MB', writeback: '3 MB',
    pressureSomePct: 0.12, pressureFullPct: 0.01,
  },
  networkInfo: {
    interface: 'eth0', interfaceCount: 2, rxMbps: 9.25, txMbps: 4.75,
    linkSpeedMbps: 1000, duplex: 'full', ipv4: '10.0.0.8/24', packetsPerSecond: 2048,
    tcpConnections: 38, drops: 0, errors: 0,
  },
  disks: [
    { device: '/dev/sda1', fsType: 'ext4', mount: '/', total: '1 TB', used: '770 GB', available: '230 GB', usedPct: 77, inodePct: 18 },
    { device: '/dev/sdb1', fsType: 'xfs', mount: '/data', total: '2 TB', used: '1 TB', available: '1 TB', usedPct: 50, inodePct: 7 },
  ],
  diskIo: { readMbps: 24.5, writeMbps: 8.25 },
  gpus: [{
    idx: 0, name: 'NVIDIA RTX 3090', util: [20, 30, 40], utilNow: 40,
    memUsed: 21, memTotal: 24, temp: 46, power: 28, powerCap: 350, fan: 0,
    procs: 'python worker.py', driver: '550.54.15',
  }],
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

  it('shows a loading skeleton until the first sample arrives, then real data', async () => {
    const { container } = wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    // before any payload: skeleton placeholders are present
    await waitFor(() => expect(container.querySelectorAll('.skel').length).toBeGreaterThan(0))
    await waitFor(() => expect(h.listenCb).not.toBeNull())
    await act(async () => { h.listenCb!(CUSTOM_MONITOR) })
    // after data: skeleton gone, real values shown
    await waitFor(() => expect(screen.getByText(/77%/)).toBeTruthy())
    expect(screen.getByText('AMD EPYC 7543P')).toBeTruthy()
    expect(screen.getByText('9.25 MB/s')).toBeTruthy()
    expect(screen.getByText('4.75 MB/s')).toBeTruthy()
    expect(screen.getByText('11 GB')).toBeTruthy()
    expect(screen.getByText(/some 0\.12% \/ full 0\.01%/)).toBeTruthy()
    expect(screen.getByText('/data')).toBeTruthy()
    expect(screen.getByText('NVIDIA RTX 3090')).toBeTruthy()
    expect(screen.getByText('21 / 24 GB')).toBeTruthy()
    expect(container.querySelectorAll('.skel').length).toBe(0)
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

  it('keeps rendering legacy monitor payloads while the server is being upgraded', async () => {
    const { container } = wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(h.listenCb).not.toBeNull())
    const legacy = {
      host: 'legacy-server', cpu: [35], mem: [45], net: [14], disk: 61,
      diskTotal: '500 GB', diskUsed: '305 GB', cores: 8,
      memTotal: '16 GB', memUsed: '7.2 GB', gpus: [], procs: [],
    } as unknown as Monitor

    await act(async () => { h.listenCb!(legacy) })

    await waitFor(() => expect(screen.getByText('14.0 MB/s')).toBeTruthy())
    expect(screen.getByText('0.00 MB/s')).toBeTruthy()
    expect(screen.getByText('305 GB / 500 GB')).toBeTruthy()
    expect(screen.getByText('后端未返回挂载点')).toBeTruthy()
    expect(container.querySelector('.monitor-disk-path strong')?.textContent).toBe('磁盘汇总')
    expect(screen.queryByTitle('/')).toBeNull()
  })

  it('calls monitorStop on unmount', async () => {
    const { unmount } = wrap(<MonitorPanel onClose={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(h.monitorStart).toHaveBeenCalled())
    unmount()
    await waitFor(() => expect(h.monitorStop).toHaveBeenCalledWith('sess-1'))
  })

  it('does NOT call monitorStart when no sessionId (empty state)', async () => {
    wrap(<MonitorPanel onClose={() => {}} />)
    // Give effects a tick.
    await new Promise(r => setTimeout(r, 50))
    expect(h.monitorStart).not.toHaveBeenCalled()
    expect(h.listen).not.toHaveBeenCalled()
  })

  it('renders empty state when no sessionId provided', async () => {
    wrap(<MonitorPanel onClose={() => {}} />)
    // Panel renders PanelEmpty with the no-session hint (zh locale in tests)
    await waitFor(() => {
      expect(screen.getByText(/无活动会话/)).toBeTruthy()
    })
  })
})
