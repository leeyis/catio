/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useTranslation } from 'react-i18next'
import { IconBtn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection, Gpu } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface MonitorPanelProps {
  onClose: () => void
  conn?: Connection // reserved for future use; monitor data comes from useData()
}

interface SparkProps {
  data: number[]
  color: string
}

function Spark({ data, color }: SparkProps) {
  const max = Math.max(...data, 100)
  const w = 100, h = 32
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(' ')
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
}

function Stat({ label, val, unit, data, color }: StatProps) {
  return (
    <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>{label}</span>
        <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{val}<span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{unit}</span></span>
      </div>
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

export function MonitorPanel({ onClose, conn: _conn }: MonitorPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const mon = D.monitor
  return (
    <PanelShell icon="gauge" title={t('panels.monitorTitle')} sub={mon.host + ' · ' + t('panels.monitorRealtime')} onClose={onClose} actions={<IconBtn name="refresh-cw" size={15} variant="bare" />}>
      <div className="grow" style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Stat label={t('panels.cpu')} val={mon.cpu[mon.cpu.length - 1]} unit="%" data={mon.cpu} color="var(--signal-blue)" />
          <Stat label={t('panels.mem')} val={mon.mem[mon.mem.length - 1]} unit="%" data={mon.mem} color="var(--signal-violet)" />
        </div>
        <Stat label={t('panels.netIO')} val={mon.net[mon.net.length - 1]} unit=" MB/s" data={mon.net} color="var(--signal-green)" />

        {/* GPU — multi-GPU telemetry */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '4px 2px 0' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('panels.gpuSection', { count: mon.gpus.length })}</span>
          <span className="chip mono" style={{ height: 19, fontSize: 9.5 }}>nvidia-smi</span>
        </div>
        {mon.gpus.map(g => <GpuCard key={g.idx} g={g} />)}

        <div className="col" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 10, gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('panels.disk')}</span><span className="mono" style={{ fontSize: 12 }}>{mon.disk}%</span></div>
          <div style={{ height: 7, borderRadius: 999, background: 'var(--surface-inset)', overflow: 'hidden' }}><div style={{ width: mon.disk + '%', height: '100%', background: mon.disk > 80 ? 'var(--danger-fg)' : 'var(--signal-amber)' }} /></div>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '4px 2px' }}>{t('panels.topProcs')}</span>
          <div className="row mono" style={{ fontSize: 10, color: 'var(--text-faint)', padding: '0 8px 4px' }}><span style={{ width: 42 }}>{t('panels.procPid')}</span><span className="grow">{t('panels.procCmd')}</span><span style={{ width: 38, textAlign: 'right' }}>{t('panels.procCpu')}</span><span style={{ width: 38, textAlign: 'right' }}>{t('panels.procMem')}</span></div>
          {mon.procs.map(p => (
            <div key={p.pid} className="row mono" style={{ fontSize: 11, padding: '5px 8px', borderRadius: 7, color: 'var(--text-secondary)' }}>
              <span style={{ width: 42, color: 'var(--text-faint)' }}>{p.pid}</span>
              <span className="grow ell">{p.cmd}</span>
              <span style={{ width: 38, textAlign: 'right', color: p.cpu > 10 ? 'var(--signal-amber)' : 'var(--text-secondary)' }}>{p.cpu}</span>
              <span style={{ width: 38, textAlign: 'right' }}>{p.mem}</span>
            </div>
          ))}
        </div>
      </div>
    </PanelShell>
  )
}
