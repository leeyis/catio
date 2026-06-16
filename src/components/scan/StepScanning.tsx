import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn } from '../atoms'
import { Icon } from '../Icon'
import type { ScanLogLevel } from '../../services/scan'
import type { StepScanningProps } from './types'

// elapsedMs -> mm:ss
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// 日志级别 → 终端配色（深色终端面板上的可读色）。
const LOG_COLOR: Record<ScanLogLevel, string> = {
  hit: 'var(--signal-green)',
  warn: 'var(--signal-amber)',
  attempt: 'var(--term-fg)',
  info: 'var(--term-dim)',
  miss: 'var(--text-faint)',
}

// 顶部统计小卡。
function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="col" style={{
      flex: 1, minWidth: 0, gap: 2, padding: '10px 14px',
      borderRadius: 12, border: '1px solid var(--border-hairline)', background: 'var(--surface-card)',
    }}>
      <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: accent ?? 'var(--text-primary)', lineHeight: 1.1 }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
    </div>
  )
}

/** 步骤③ 扫描中：进度 + 统计 + 控制台式实时日志（当前 IP / 用户名 / 密码试登录实时输出）。 */
export function StepScanning({ progress, rows, logs, scanning, done, onCancel, onBack, onNext, elapsedMs }: StepScanningProps) {
  const { t } = useTranslation()

  const scanned = progress?.scanned ?? 0
  const total = progress?.total ?? 0
  const found = progress?.found ?? rows.length
  const failed = progress?.failed ?? 0
  const pct = total > 0 ? Math.min(100, (scanned / total) * 100) : 0
  const canViewResults = done || rows.length > 0

  // 控制台自动滚动到底部（有新日志时）。
  const consoleRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* 顶部：返回 + 用时 */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Btn variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>{t('scan.back')}</Btn>
        <div className="row gap8" style={{ color: 'var(--text-tertiary)', fontSize: 12, alignItems: 'center' }}>
          <Icon name="clock" size={14} />
          <span className="mono">{t('scan.scanning.elapsed')} {fmtElapsed(elapsedMs)}</span>
        </div>
      </div>

      {/* 统计小卡 */}
      <div className="row gap10">
        <StatTile label={t('scan.scanning.scanned')} value={`${scanned} / ${total}`} />
        <StatTile label={t('scan.scanning.foundLabel')} value={String(found)} accent="var(--signal-green)" />
        <StatTile label={t('scan.scanning.failedLabel')} value={String(failed)} accent={failed > 0 ? 'var(--signal-amber)' : undefined} />
      </div>

      {/* 进度条 */}
      <div className="col" style={{ gap: 6 }}>
        <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${pct}%`, borderRadius: 999,
            background: 'var(--accent-primary)', transition: 'width .3s ease',
          }} />
        </div>
      </div>

      {/* 控制台式实时日志 */}
      <div className="col" style={{
        borderRadius: 14, overflow: 'hidden',
        border: '1px solid var(--border-hairline)', background: 'var(--term-bg)',
        boxShadow: 'var(--shadow-card)',
      }}>
        {/* 终端标题栏 */}
        <div className="row" style={{
          justifyContent: 'space-between', alignItems: 'center',
          padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div className="row gap8" style={{ alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: '#ff5f56', display: 'inline-block' }} />
              <span style={{ width: 9, height: 9, borderRadius: 999, background: '#ffbd2e', display: 'inline-block' }} />
              <span style={{ width: 9, height: 9, borderRadius: 999, background: '#27c93f', display: 'inline-block' }} />
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--term-dim)', marginLeft: 4 }}>{t('scan.scanning.console')}</span>
          </div>
          {scanning && (
            <span className="row gap6" style={{ alignItems: 'center', fontSize: 11, color: 'var(--term-dim)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--signal-green)', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
              {t('scan.scanning.live')}
            </span>
          )}
        </div>
        {/* 日志行 */}
        <div ref={consoleRef} className="mono" style={{
          height: 320, overflowY: 'auto', padding: '10px 14px',
          fontSize: 12, lineHeight: 1.7, color: 'var(--term-fg)',
        }}>
          {logs.length === 0 ? (
            <div className="row gap8" style={{ justifyContent: 'center', padding: '120px 0', color: 'var(--term-dim)', fontSize: 12.5 }}>
              {scanning && <Icon name="loader" size={15} style={{ animation: 'spin 1s linear infinite' }} />}
              <span>{t('scan.scanning.waiting')}</span>
            </div>
          ) : (
            logs.map((l, i) => (
              <div key={i} style={{ color: LOG_COLOR[l.level], whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {l.message}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 底部操作 */}
      <div className="row gap10" style={{ justifyContent: 'flex-end' }}>
        {scanning && (
          <Btn variant="danger" size="md" icon="x" onClick={onCancel}>{t('scan.cancel')}</Btn>
        )}
        {canViewResults && (
          <Btn variant="primary" size="md" iconR="chevron-right" onClick={onNext}>
            {t('scan.scanning.viewResults')} ({found})
          </Btn>
        )}
      </div>
    </div>
  )
}

export default StepScanning
