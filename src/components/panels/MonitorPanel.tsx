import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBtn } from '../atoms'
import type { Connection, Gpu, Monitor, MonitorDiskUsage } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { listen, monitorStart, monitorStop } from '../../services/ssh'
import './MonitorPanel.css'

function isServerEnv(): boolean {
  return typeof window !== 'undefined' && '__CATIO_SERVER__' in window &&
    (window as unknown as Record<string, unknown>).__CATIO_SERVER__ === true
}

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export interface MonitorPanelProps {
  onClose: () => void
  conn?: Connection
  sessionId?: string
}

const EMPTY_MONITOR: Monitor = {
  host: '',
  cpu: [],
  mem: [],
  net: [],
  netRx: [],
  netTx: [],
  disk: 0,
  diskTotal: '',
  diskUsed: '',
  cores: 0,
  memTotal: '',
  memUsed: '',
  gpus: [],
  procs: [],
  system: { os: '', kernel: '', uptimeSeconds: 0, processCount: 0 },
  cpuInfo: {
    model: '', sockets: 0, physicalCores: 0, threads: 0, frequencyMhz: null,
    l3Cache: '', temperatureC: null, load1: 0, load5: 0, load15: 0,
    userPct: 0, systemPct: 0, iowaitPct: 0,
  },
  memoryInfo: { total: '', used: '', available: '', cache: '', swapTotal: '', swapUsed: '' },
  networkInfo: {
    interface: '', interfaceCount: 0, rxMbps: 0, txMbps: 0, linkSpeedMbps: null,
    duplex: '', ipv4: '', packetsPerSecond: 0, tcpConnections: 0, drops: 0, errors: 0,
  },
  disks: [],
  diskIo: { readMbps: 0, writeMbps: 0 },
}

function normalizeMonitor(payload: Monitor): Monitor {
  const legacyNet = payload.net ?? []
  const netRx = payload.netRx ?? legacyNet
  const netTx = payload.netTx ?? legacyNet.map(() => 0)
  return {
    ...EMPTY_MONITOR,
    ...payload,
    cpu: payload.cpu ?? [],
    mem: payload.mem ?? [],
    net: legacyNet,
    netRx,
    netTx,
    gpus: (payload.gpus ?? []).map(gpu => ({ ...gpu, driver: gpu.driver ?? '' })),
    procs: payload.procs ?? [],
    disks: payload.disks ?? [],
    system: { ...EMPTY_MONITOR.system, ...payload.system },
    cpuInfo: { ...EMPTY_MONITOR.cpuInfo, ...payload.cpuInfo },
    memoryInfo: { ...EMPTY_MONITOR.memoryInfo, ...payload.memoryInfo },
    networkInfo: {
      ...EMPTY_MONITOR.networkInfo,
      ...payload.networkInfo,
      rxMbps: payload.networkInfo?.rxMbps ?? netRx[netRx.length - 1] ?? 0,
      txMbps: payload.networkInfo?.txMbps ?? netTx[netTx.length - 1] ?? 0,
    },
    diskIo: { ...EMPTY_MONITOR.diskIo, ...payload.diskIo },
  }
}

function latest(values: number[]): number {
  return values[values.length - 1] ?? 0
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

function formatDecimal(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.0'
}

function formatRate(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} MB/s`
  if (value >= 10) return `${value.toFixed(1)} MB/s`
  return `${value.toFixed(2)} MB/s`
}

function formatFrequency(mhz: number | null): string {
  if (!mhz || mhz <= 0) return '—'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`
}

function formatUptime(seconds: number, language: string): string {
  if (!seconds) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (language.startsWith('zh')) {
    if (days > 0) return `${days}天 ${hours}小时`
    if (hours > 0) return `${hours}小时 ${minutes}分`
    return `${minutes}分钟`
  }
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

interface SparkProps {
  data: number[]
  color: string
  ceiling?: number
  height?: number
}

function Spark({ data, color, ceiling, height = 34 }: SparkProps) {
  const safeData = data.length > 0 ? data : [0]
  const max = ceiling ?? Math.max(...safeData, 1)
  const width = 100
  const chartHeight = 30
  const denominator = safeData.length > 1 ? safeData.length - 1 : 1
  const points = safeData
    .map((value, index) => {
      const bounded = Math.max(0, Math.min(max, value))
      return `${(index / denominator) * width},${chartHeight - (bounded / max) * chartHeight}`
    })
    .join(' ')
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${chartHeight}`} preserveAspectRatio="none" className="monitor-spark" style={{ height }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,${chartHeight} ${points} ${width},${chartHeight}`} fill={color} opacity="0.09" stroke="none" />
    </svg>
  )
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="monitor-metric" title={title}>
      <span className="monitor-metric-label">{label}</span>
      <span className="monitor-metric-value mono" style={tone ? { color: tone } : undefined}>{value || '—'}</span>
    </div>
  )
}

function Progress({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="monitor-progress" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clampPct(value))}>
      <div className="monitor-progress-fill" style={{ width: `${clampPct(value)}%`, background: tone }} />
    </div>
  )
}

function SectionTitle({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="monitor-section-title">
      <span>{title}</span>
      {aside}
    </div>
  )
}

function HostStrip({ mon }: { mon: Monitor }) {
  const { t, i18n } = useTranslation()
  return (
    <div className="monitor-host-strip">
      <Metric label={t('panels.monitorOs')} value={mon.system.os} title={mon.system.os} />
      <Metric label={t('panels.monitorKernel')} value={mon.system.kernel} title={mon.system.kernel} />
      <Metric label={t('panels.monitorUptime')} value={formatUptime(mon.system.uptimeSeconds, i18n.language)} />
      <Metric label={t('panels.monitorProcesses')} value={mon.system.processCount ? String(mon.system.processCount) : '—'} />
    </div>
  )
}

function CpuCard({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  const cpu = mon.cpuInfo
  const cpuNow = latest(mon.cpu)
  const temperatureTone = (cpu.temperatureC ?? 0) >= 80
    ? 'var(--danger-fg)'
    : (cpu.temperatureC ?? 0) >= 65 ? 'var(--signal-amber)' : 'var(--signal-green)'
  return (
    <section className="monitor-card">
      <div className="monitor-card-heading">
        <div className="monitor-card-heading-main">
          <span className="monitor-card-kicker">{t('panels.cpu')}</span>
          <span className="monitor-card-model" title={cpu.model}>{cpu.model || t('panels.monitorUnavailable')}</span>
        </div>
        <span className="monitor-primary-value mono">{formatDecimal(cpuNow)}<small>%</small></span>
      </div>
      <Spark data={mon.cpu} color="var(--signal-blue)" ceiling={100} height={42} />
      <div className="monitor-detail-grid monitor-detail-grid-cpu">
        <Metric label={t('panels.cpuPhysicalCores')} value={cpu.physicalCores ? String(cpu.physicalCores) : '—'} />
        <Metric label={t('panels.cpuThreads')} value={cpu.threads ? String(cpu.threads) : String(mon.cores || '—')} />
        <Metric label={t('panels.cpuSockets')} value={cpu.sockets ? String(cpu.sockets) : '—'} />
        <Metric label={t('panels.cpuFrequency')} value={formatFrequency(cpu.frequencyMhz)} />
        <Metric label={t('panels.cpuL3Cache')} value={cpu.l3Cache || '—'} title={cpu.l3Cache} />
        <Metric label={t('panels.cpuTemperature')} value={cpu.temperatureC == null ? '—' : `${formatDecimal(cpu.temperatureC)}°C`} tone={temperatureTone} />
      </div>
      <div className="monitor-inline-stats mono">
        <span>{t('panels.cpuUser')} <b>{formatDecimal(cpu.userPct)}%</b></span>
        <span>{t('panels.cpuSystem')} <b>{formatDecimal(cpu.systemPct)}%</b></span>
        <span>{t('panels.cpuIowait')} <b>{formatDecimal(cpu.iowaitPct)}%</b></span>
        <span>{t('panels.cpuLoad')} <b>{formatDecimal(cpu.load1, 2)} / {formatDecimal(cpu.load5, 2)} / {formatDecimal(cpu.load15, 2)}</b></span>
      </div>
    </section>
  )
}

function MemoryCard({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  const memoryNow = latest(mon.mem)
  const info = mon.memoryInfo
  const used = info.used || mon.memUsed
  const total = info.total || mon.memTotal
  return (
    <section className="monitor-card">
      <div className="monitor-card-heading">
        <div className="monitor-card-heading-main">
          <span className="monitor-card-kicker">{t('panels.mem')}</span>
          <span className="monitor-card-model mono">{used && total ? `${used} / ${total}` : t('panels.monitorUnavailable')}</span>
        </div>
        <span className="monitor-primary-value mono">{formatDecimal(memoryNow)}<small>%</small></span>
      </div>
      <Spark data={mon.mem} color="var(--signal-violet)" ceiling={100} height={36} />
      <Progress value={memoryNow} tone={memoryNow > 85 ? 'var(--danger-fg)' : 'var(--signal-violet)'} />
      <div className="monitor-detail-grid">
        <Metric label={t('panels.memAvailable')} value={info.available} />
        <Metric label={t('panels.memCache')} value={info.cache} />
        <Metric label={t('panels.memSwap')} value={info.swapUsed && info.swapTotal ? `${info.swapUsed} / ${info.swapTotal}` : '—'} />
      </div>
    </section>
  )
}

function NetworkCard({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  const network = mon.networkInfo
  const rx = latest(mon.netRx)
  const tx = latest(mon.netTx)
  const duplex = network.duplex === 'full'
    ? t('panels.netFullDuplex')
    : network.duplex === 'half' ? t('panels.netHalfDuplex') : '—'
  const interfaceLabel = network.interface
    ? `${network.interface}${network.interfaceCount > 1 ? ` +${network.interfaceCount - 1}` : ''}`
    : '—'
  return (
    <section className="monitor-card">
      <div className="monitor-card-heading">
        <div className="monitor-card-heading-main">
          <span className="monitor-card-kicker">{t('panels.netIO')}</span>
          <span className="monitor-card-model mono">{interfaceLabel}</span>
        </div>
        <span className="monitor-chip mono">{network.ipv4 || t('panels.monitorUnavailable')}</span>
      </div>
      <div className="monitor-throughput-grid">
        <div className="monitor-throughput">
          <div className="monitor-throughput-heading">
            <span className="monitor-direction monitor-direction-down">↓</span>
            <span>{t('panels.netDownload')}</span>
            <b className="mono">{formatRate(rx)}</b>
          </div>
          <Spark data={mon.netRx} color="var(--signal-green)" height={34} />
        </div>
        <div className="monitor-throughput">
          <div className="monitor-throughput-heading">
            <span className="monitor-direction monitor-direction-up">↑</span>
            <span>{t('panels.netUpload')}</span>
            <b className="mono">{formatRate(tx)}</b>
          </div>
          <Spark data={mon.netTx} color="var(--signal-blue)" height={34} />
        </div>
      </div>
      <div className="monitor-detail-grid">
        <Metric label={t('panels.netLink')} value={network.linkSpeedMbps ? `${network.linkSpeedMbps} Mbps` : '—'} />
        <Metric label={t('panels.netDuplex')} value={duplex} />
        <Metric label={t('panels.netPackets')} value={`${formatDecimal(network.packetsPerSecond, 0)} pps`} />
        <Metric label={t('panels.netTcp')} value={String(network.tcpConnections)} />
        <Metric label={t('panels.netDrops')} value={String(network.drops)} tone={network.drops ? 'var(--signal-amber)' : undefined} />
        <Metric label={t('panels.netErrors')} value={String(network.errors)} tone={network.errors ? 'var(--danger-fg)' : undefined} />
      </div>
    </section>
  )
}

function diskTone(percentage: number): string {
  if (percentage >= 90) return 'var(--danger-fg)'
  if (percentage >= 75) return 'var(--signal-amber)'
  return 'var(--signal-blue)'
}

function DiskRow({ disk }: { disk: MonitorDiskUsage }) {
  const { t } = useTranslation()
  const tone = diskTone(disk.usedPct)
  return (
    <div className="monitor-disk-row">
      <div className="monitor-disk-main">
        <div className="monitor-disk-path">
          <strong className="mono" title={disk.mount}>{disk.mount}</strong>
          <span className="mono" title={`${disk.device} ${disk.fsType}`}>{disk.device}{disk.fsType ? ` · ${disk.fsType}` : ''}</span>
        </div>
        <div className="monitor-disk-usage mono">
          <strong style={{ color: tone }}>{disk.usedPct}%</strong>
          <span>{disk.used} / {disk.total}</span>
        </div>
      </div>
      <Progress value={disk.usedPct} tone={tone} />
      <div className="monitor-disk-meta mono">
        <span>{t('panels.diskAvailable')} {disk.available || '—'}</span>
        <span>{t('panels.diskInode')} {disk.inodePct == null ? '—' : `${disk.inodePct}%`}</span>
      </div>
    </div>
  )
}

function DiskSection({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  const legacyDisk: MonitorDiskUsage = {
    device: '', fsType: '', mount: '/', total: mon.diskTotal, used: mon.diskUsed,
    available: '', usedPct: mon.disk, inodePct: null,
  }
  const disks = mon.disks.length > 0 ? mon.disks : [legacyDisk]
  return (
    <section>
      <SectionTitle
        title={t('panels.diskSection', { count: disks.length })}
        aside={(
          <div className="monitor-io-summary mono">
            <span>R {formatRate(mon.diskIo.readMbps)}</span>
            <span>W {formatRate(mon.diskIo.writeMbps)}</span>
          </div>
        )}
      />
      <div className="monitor-disk-list">{disks.map(disk => <DiskRow key={`${disk.device}:${disk.mount}`} disk={disk} />)}</div>
    </section>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <Metric label={label} value={value} tone={tone} />
}

function GpuCard({ gpu }: { gpu: Gpu }) {
  const { t } = useTranslation()
  const memoryPercentage = gpu.memTotal > 0 ? Math.round((gpu.memUsed / gpu.memTotal) * 100) : 0
  const temperatureTone = gpu.temp >= 80
    ? 'var(--danger-fg)'
    : gpu.temp >= 65 ? 'var(--signal-amber)' : 'var(--signal-green)'
  const utilisationTone = gpu.utilNow >= 80 ? 'var(--signal-amber)' : 'var(--signal-green)'
  return (
    <div className="monitor-card monitor-gpu-card">
      <div className="monitor-gpu-heading">
        <div className="monitor-gpu-identity">
          <span className="monitor-gpu-index mono">{gpu.idx}</span>
          <div>
            <strong title={gpu.name}>{gpu.name}</strong>
            <span className="mono" title={gpu.procs}>{gpu.procs || t('panels.gpuNoProcess')}</span>
          </div>
        </div>
        <span className="monitor-primary-value mono" style={{ color: utilisationTone }}>{gpu.utilNow}<small>%</small></span>
      </div>
      <Spark data={gpu.util} color={utilisationTone} ceiling={100} height={36} />
      <div className="monitor-gpu-memory">
        <div><span>{t('panels.gpuVram')}</span><b className="mono">{gpu.memUsed} / {gpu.memTotal} GB</b></div>
        <Progress value={memoryPercentage} tone={memoryPercentage > 85 ? 'var(--danger-fg)' : 'var(--signal-green)'} />
      </div>
      <div className="monitor-detail-grid monitor-gpu-details">
        <Mini label={t('panels.gpuTemp')} value={`${gpu.temp}°C`} tone={temperatureTone} />
        <Mini label={t('panels.gpuPower')} value={`${gpu.power}W`} />
        <Mini label={t('panels.gpuPowerCap')} value={`${gpu.powerCap}W`} />
        <Mini label={t('panels.gpuFan')} value={`${gpu.fan}%`} />
      </div>
    </div>
  )
}

function GpuSection({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  const driver = mon.gpus.find(gpu => gpu.driver)?.driver
  return (
    <section>
      <SectionTitle
        title={t('panels.gpuSection', { count: mon.gpus.length })}
        aside={<span className="monitor-chip mono">{driver ? `${t('panels.gpuDriver')} ${driver}` : 'nvidia-smi'}</span>}
      />
      {mon.gpus.length > 0
        ? <div className="monitor-gpu-grid">{mon.gpus.map(gpu => <GpuCard key={gpu.idx} gpu={gpu} />)}</div>
        : <div className="monitor-empty-inline">{t('panels.gpuUnavailable')}</div>}
    </section>
  )
}

function ProcessSection({ mon }: { mon: Monitor }) {
  const { t } = useTranslation()
  return (
    <section>
      <SectionTitle title={t('panels.topProcs')} />
      <div className="monitor-process-table">
        <div className="monitor-process-row monitor-process-head mono">
          <span>{t('panels.procPid')}</span><span>{t('panels.procCmd')}</span><span>{t('panels.procCpu')}</span><span>{t('panels.procMem')}</span>
        </div>
        {mon.procs.map(process => (
          <div key={process.pid} className="monitor-process-row mono">
            <span>{process.pid}</span>
            <span title={process.cmd}>{process.cmd}</span>
            <span style={{ color: process.cpu > 10 ? 'var(--signal-amber)' : undefined }}>{process.cpu}</span>
            <span>{process.mem}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SkeletonBlock({ width, height = 11 }: { width: number | string; height?: number }) {
  return <div className="skel" style={{ width, height, borderRadius: 6 }} />
}

function MonitorSkeleton() {
  return (
    <div className="monitor-scroll">
      <div className="monitor-host-strip">{[0, 1, 2, 3].map(index => <SkeletonBlock key={index} width="70%" height={28} />)}</div>
      {[0, 1, 2].map(index => (
        <div className="monitor-card monitor-skeleton-card" key={index}>
          <div><SkeletonBlock width={58} /><SkeletonBlock width={index === 0 ? '78%' : '46%'} /></div>
          <SkeletonBlock width="100%" height={42} />
          <div className="monitor-detail-grid"><SkeletonBlock width="70%" /><SkeletonBlock width="70%" /><SkeletonBlock width="70%" /></div>
        </div>
      ))}
      <div className="monitor-card"><SkeletonBlock width="100%" height={54} /></div>
    </div>
  )
}

export function MonitorPanel({ onClose, conn: _conn, sessionId }: MonitorPanelProps) {
  const { t } = useTranslation()
  const [mon, setMon] = useState<Monitor>(EMPTY_MONITOR)

  useEffect(() => {
    if (!sessionId || (!isTauriEnv() && !isServerEnv())) {
      setMon(EMPTY_MONITOR)
      return
    }

    let unlisten: (() => void) | null = null
    let active = true

    monitorStart(sessionId, 2000).catch(() => { /* already running or disconnected */ })
    listen<Monitor>(`monitor://${sessionId}`, payload => {
      if (active) setMon(normalizeMonitor(payload))
    }).then(fn => {
      if (!active) {
        fn()
        return
      }
      unlisten = fn
    }).catch(() => { /* no-op outside a live transport */ })

    return () => {
      active = false
      unlisten?.()
      monitorStop(sessionId).catch(() => { /* best effort */ })
    }
  }, [sessionId])

  function handleRefresh() {
    if (sessionId && (isTauriEnv() || isServerEnv())) {
      monitorStart(sessionId, 2000).catch(() => {})
    }
  }

  return (
    <PanelShell
      icon="gauge"
      title={t('panels.monitorTitle')}
      sub={sessionId ? `${mon.host} · ${t('panels.monitorRealtime')}` : undefined}
      onClose={onClose}
      actions={<IconBtn name="refresh-cw" size={15} variant="bare" onClick={handleRefresh} />}
    >
      {!sessionId ? (
        <PanelEmpty icon="gauge" text={t('panels.noSessionHint')} />
      ) : mon.cpu.length === 0 ? (
        <MonitorSkeleton />
      ) : (
        <div className="monitor-scroll">
          <HostStrip mon={mon} />
          <CpuCard mon={mon} />
          <MemoryCard mon={mon} />
          <NetworkCard mon={mon} />
          <DiskSection mon={mon} />
          <GpuSection mon={mon} />
          <ProcessSection mon={mon} />
        </div>
      )}
    </PanelShell>
  )
}
