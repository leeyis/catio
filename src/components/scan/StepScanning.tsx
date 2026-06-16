import { useTranslation } from 'react-i18next'
import { Btn, StatusDot } from '../atoms'
import type { StatusKind } from '../atoms'
import { Icon } from '../Icon'
import { findEngine } from '../../services/dbEngines'
import type { StepScanningProps } from './types'
import type { ScanRow } from './types'

// elapsedMs -> mm:ss
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// 扫描状态 -> StatusDot 语义色：authed=绿、unauthed=琥珀、open=灰
function statusKind(status: ScanRow['status']): StatusKind {
  if (status === 'authed') return 'up'
  if (status === 'unauthed') return 'idle'
  return 'down'
}

// 行右侧的副标题：db 显示引擎名，host 显示 OS
function rowMeta(row: ScanRow): string | undefined {
  if (row.kind === 'db') {
    const eng = row.engineId ? findEngine(row.engineId) : undefined
    return eng?.label ?? row.dbType ?? row.engineId
  }
  return row.os
}

/** 步骤③ 扫描中：实时进度条 + 边扫边出的精简结果流。 */
export function StepScanning({ progress, rows, scanning, done, onCancel, onBack, onNext, elapsedMs }: StepScanningProps) {
  const { t } = useTranslation()

  const scanned = progress?.scanned ?? 0
  const total = progress?.total ?? 0
  const found = progress?.found ?? rows.length
  const failed = progress?.failed ?? 0
  const pct = total > 0 ? Math.min(100, (scanned / total) * 100) : 0
  // done 或已扫出结果时允许查看结果
  const canViewResults = done || rows.length > 0

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* 顶部：返回 + 标题 */}
      <div className="row gap10" style={{ justifyContent: 'space-between' }}>
        <Btn variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>{t('scan.back')}</Btn>
        <div className="row gap10" style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
          <Icon name="clock" size={14} />
          <span className="mono">{t('scan.scanning.elapsed')} {fmtElapsed(elapsedMs)}</span>
        </div>
      </div>

      {/* 进度条 + 统计 */}
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('scan.scanning.progress', { scanned, total })}
          </span>
          <div className="row gap10" style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--signal-green)' }}>{t('scan.scanning.found', { found })}</span>
            {failed > 0 && (
              <span style={{ color: 'var(--text-faint)' }}>{t('scan.scanning.failed', { failed })}</span>
            )}
          </div>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: 999,
            background: 'var(--accent-primary)',
            transition: 'width .3s ease',
          }} />
        </div>
      </div>

      {/* 结果流：边扫边出 */}
      <div className="col" style={{
        gap: 4,
        maxHeight: 280,
        overflowY: 'auto',
        border: '1px solid var(--border-hairline)',
        borderRadius: 10,
        background: 'var(--surface-subtle)',
        padding: 6,
      }}>
        {rows.length === 0 ? (
          <div className="row gap10" style={{ justifyContent: 'center', padding: '32px 0', color: 'var(--text-faint)', fontSize: 13 }}>
            {scanning && <Icon name="loader" size={16} style={{ animation: 'spin 1s linear infinite' }} />}
            <span>{t('scan.scanning.waiting')}</span>
          </div>
        ) : (
          rows.map(row => {
            const meta = rowMeta(row)
            return (
              <div key={row.rowId} className="row gap10" style={{
                justifyContent: 'space-between',
                padding: '7px 10px',
                borderRadius: 8,
                background: 'var(--surface-card)',
                animation: 'slideInRight .2s ease',
              }}>
                <div className="row gap10" style={{ minWidth: 0 }}>
                  <StatusDot status={statusKind(row.status)} />
                  <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.address}
                  </span>
                </div>
                {meta && (
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{meta}</span>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 底部操作：扫描中→取消；可看结果→查看结果 */}
      <div className="row gap10" style={{ justifyContent: 'flex-end' }}>
        {scanning && (
          <Btn variant="danger" size="md" icon="x" onClick={onCancel}>{t('scan.cancel')}</Btn>
        )}
        {canViewResults && (
          <Btn variant="primary" size="md" iconR="chevron-right" onClick={onNext}>
            {t('scan.scanning.viewResults')}
          </Btn>
        )}
      </div>
    </div>
  )
}

export default StepScanning
