/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBtn } from '../atoms'
import type { Connection, Gpu, Monitor } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { monitorStart, monitorStop, listen } from '../../services/ssh'

// Mirror the Tauri guard used in SftpPanel / TerminalPane.
// Live monitor engages in the desktop app AND the browser deploy (server mode), where the
// monitor:// stream rides the WebSocket.
function isServerEnv(): boolean {
  return typeof window !== 'undefined' && '__CATIO_SERVER__' in window &&
    (window as unknown as Record<string, unknown>).__CATIO_SERVER__ === true
}
function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export interface MonitorPanelProps {
  onClose: () => void
  conn?: Connection // reserved for future use
  sessionId?: string
}

interface SparkProps {
  data: number[]
  color: string
}

function Spark({ data, color }: SparkProps) {
  // Guard: need ≥1 point; with a single point treat it as a flat line at x=0..w.
  const safeData = data.length > 0 ? data : [0]
  const max = Math.max(...safeData, 100)
  const w = 100, h = 32
  const denom = safeData.length > 1 ? safeData.length - 1 : 1
  const pts = safeData.map((v, i) => `${(i / denom) * w},${h - (v / max) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 36 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.10" stroke="none" />
    </svg>
  )
}

interface StatProps {
  label: string
  val: number
  unit: string
  data: number[]
  color: string
  /** Optional caption, e.g. "9.6 GB / 16 GB" for memory used/total. */
  sub?: string
}

function Stat({ label, val, unit, data, color, sub }: StatProps) {
  return (
    <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>{label}</span>
        <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{val}<span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{unit}</span></span>
      </div>
      {sub && <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-faint)', marginTop: -2 }}>{sub}</span>}
      <Spark data={data} color={color} />
    </div>
  )
}

interface MiniProps {
  label: string
  value: string
  tone?: string
}

function Mini({ label, value, tone }: MiniProps) {
  return (
    <div className="col" style={{ gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: 9.5, color: 'var(--text-faint)', letterSpacing: '0.2px' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: tone || 'var(--text-secondary)' }}>{value}</span>
    </div>
  )
}

interface GpuCardProps {
  g: Gpu
}

function GpuCard({ g }: GpuCardProps) {
  const { t } = useTranslation()
  const memPct = Math.round((g.memUsed / g.memTotal) * 100)
  const tempTone = g.temp >= 80 ? 'var(--danger-fg)' : g.temp >= 65 ? 'var(--signal-amber)' : 'var(--signal-green)'
  const utilTone = g.utilNow >= 80 ? 'var(--signal-amber)' : 'var(--signal-green)'
  return (
    <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10, gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div className="row gap7" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 22, height: 22, borderRadius: 6, background: 'color-mix(in srgb, var(--signal-green) 14%, transparent)', color: 'var(--signal-green)', flex: 'none' }}>
            <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>{g.idx}</span>
          </div>
          <div className="col" style={{ lineHeight: 1.2, minWidth: 0 }}>
            <span className="ell" style={{ fontSize: 12, fontWeight: 600 }}>{g.name}</span>
            <span className="ell mono" style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>{g.procs}</span>
          </div>
        </div>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: utilTone, flex: 'none' }}>{g.utilNow}<span style={{ fontSize: 9, color: 'var(--text-faint)' }}>%</span></span>
      </div>
      <Spark data={g.util} color={utilTone} />
      {/* VRAM bar */}
      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>{t('panels.gpuVram')}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{g.memUsed} / {g.memTotal} GB</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-inset)', overflow: 'hidden' }}>
          <div style={{ width: memPct + '%', height: '100%', background: memPct > 85 ? 'var(--danger-fg)' : 'var(--signal-green)' }} />
        </div>
      </div>
      {/* telemetry row */}
      <div className="row" style={{ justifyContent: 'space-between', paddingTop: 2, borderTop: '1px solid var(--border-hairline)' }}>
        <Mini label={t('panels.gpuTemp')} value={g.temp + '°C'} tone={tempTone} />
        <Mini label={t('panels.gpuPower')} value={g.power + 'W'} />
        <Mini label={t('panels.gpuPowerCap')} value={g.powerCap + 'W'} />
        <Mini label={t('panels.gpuFan')} value={g.fan + '%'} />
      </div>
    </div>
  )
}

// ---- loading skeleton (shimmer placeholder shown until first sample arrives) ----
function Sk({ w, h = 12, r = 6 }: { w: number | string; h?: number; r?: number }) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r, flex: 'none' }} />
}
function SkCard({ children }: { children: React.ReactNode }) {
  return <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10, gap: 10 }}>{children}</div>
}
function MonitorSkeleton() {
  const statCard = (
    <SkCard>
      <div className="row" style={{ justifyContent: 'space-between' }}><Sk w={48} /><Sk w={32} /></div>
      <Sk w="100%" h={36} r={8} />
    </SkCard>
  )
  return (
    <div className="grow" style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{statCard}{statCard}</div>
      <SkCard>
        <div className="row" style={{ justifyContent: 'space-between' }}><Sk w={64} /><Sk w={40} /></div>
        <Sk w="100%" h={48} r={8} />
      </SkCard>
      <div className="row" style={{ justifyContent: 'space-between', padding: '4px 2px 0' }}><Sk w={72} h={11} /><Sk w={66} h={19} r={9} /></div>
      <SkCard>
        <div className="row" style={{ justifyContent: 'space-between' }}><Sk w={48} /><Sk w={28} /></div>
        <Sk w="100%" h={7} r={999} />
      </SkCard>
      <div className="col" style={{ gap: 6 }}>
        <Sk w={72} h={11} />
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="row" style={{ gap: 8, padding: '4px 8px', alignItems: 'center' }}>
            <Sk w={34} h={10} /><Sk w="50%" h={10} /><div className="grow" /><Sk w={26} h={10} /><Sk w={26} h={10} />
          </div>
        ))}
      </div>
    </div>
  )
}

const EMPTY_MONITOR: Monitor = {
  host: '',
  cpu: [],
  mem: [],
  net: [],
  disk: 0,
  diskTotal: '',
  diskUsed: '',
  cores: 0,
  memTotal: '',
  memUsed: '',
  gpus: [],
  procs: [],
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

    monitorStart(sessionId, 2000).catch(() => { /* ignore if already running */ })
    listen<Monitor>('monitor://' + sessionId, (payload) => {
      if (active) setMon(payload)
    }).then(fn => {
      if (!active) { fn(); return }
      unlisten = fn
    }).catch(() => { /* no-op outside Tauri */ })

    return () => {
      active = false
      if (unlisten) unlisten()
      monitorStop(sessionId).catch(() => { /* best-effort */ })
    }
    // Re-run when sessionId changes (new connection)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Refresh button: in live mode restart the polling interval; in demo mode no-op.
  function handleRefresh() {
    if (sessionId && (isTauriEnv() || isServerEnv())) {
      monitorStart(sessionId, 2000).catch(() => {})
    }
  }

  return (
    <PanelShell icon="gauge" title={t('panels.monitorTitle')} sub={sessionId ? (mon.host + ' · ' + t('panels.monitorRealtime')) : undefined} onClose={onClose} actions={<IconBtn name="refresh-cw" size={15} variant="bare" onClick={handleRefresh} />}>
      {!sessionId ? (
        <PanelEmpty icon="gauge" text={t('panels.noSessionHint')} />
      ) : mon.cpu.length === 0 ? (
        <MonitorSkeleton />
      ) : (
        <div className="grow" style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Stat label={t('panels.cpu')} val={mon.cpu[mon.cpu.length - 1]} unit="%" data={mon.cpu} color="var(--signal-blue)" />
            <Stat label={t('panels.mem')} val={mon.mem[mon.mem.length - 1]} unit="%" data={mon.mem} color="var(--signal-violet)"
              sub={mon.memUsed && mon.memTotal ? `${mon.memUsed} / ${mon.memTotal}` : undefined} />
          </div>
          <Stat label={t('panels.netIO')} val={mon.net[mon.net.length - 1]} unit=" MB/s" data={mon.net} color="var(--signal-green)" />

          {/* GPU — multi-GPU telemetry */}
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '4px 2px 0' }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('panels.gpuSection', { count: mon.gpus.length })}</span>
            <span className="chip mono" style={{ height: 19, fontSize: 9.5 }}>nvidia-smi</span>
          </div>
          {mon.gpus.map(g => <GpuCard key={g.idx} g={g} />)}

          <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10, gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('panels.disk')}</span><span className="mono" style={{ fontSize: 12 }}>{mon.diskUsed && mon.diskTotal ? <span style={{ color: 'var(--text-faint)' }}>{mon.diskUsed} / {mon.diskTotal} · </span> : null}{mon.disk}%</span></div>
            <div style={{ height: 7, borderRadius: 999, background: 'var(--surface-inset)', overflow: 'hidden' }}><div style={{ width: mon.disk + '%', height: '100%', background: mon.disk > 80 ? 'var(--danger-fg)' : 'var(--signal-amber)' }} /></div>
          </div>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '4px 2px' }}>{t('panels.topProcs')}</span>
            <div className="row mono" style={{ fontSize: 10, color: 'var(--text-faint)', padding: '0 8px 4px', gap: 10 }}><span style={{ width: 56, flexShrink: 0 }}>{t('panels.procPid')}</span><span className="grow">{t('panels.procCmd')}</span><span style={{ width: 38, textAlign: 'right' }}>{t('panels.procCpu')}</span><span style={{ width: 38, textAlign: 'right' }}>{t('panels.procMem')}</span></div>
            {mon.procs.map(p => (
              <div key={p.pid} className="row mono" style={{ fontSize: 11, padding: '5px 8px', borderRadius: 7, color: 'var(--text-secondary)', gap: 10 }}>
                <span style={{ width: 56, flexShrink: 0, color: 'var(--text-faint)' }}>{p.pid}</span>
                <span className="grow ell">{p.cmd}</span>
                <span style={{ width: 38, textAlign: 'right', color: p.cpu > 10 ? 'var(--signal-amber)' : 'var(--text-secondary)' }}>{p.cpu}</span>
                <span style={{ width: 38, textAlign: 'right' }}>{p.mem}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </PanelShell>
  )
}
