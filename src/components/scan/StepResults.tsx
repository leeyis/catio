// 步骤④：结果确认。
// 职责边界：去重(existing)与默认勾选(selected)由父容器(ScanWizard)在收到结果时
// 计算并写入 ScanRow；本组件只负责展示 / 过滤 / 勾选 / 触发导入 / 触发导出。
// 分组归属由 ScanWizard 持有（groupId / onGroupChange props），导入时写入 profile.group。

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useGroups } from '../../state/groups'
import { findEngine } from '../../services/dbEngines'
import type { ScanRow, StepResultsProps } from './types'

type StatusFilter = 'all' | 'authed' | 'unauthed' | 'existing'

// 状态标签 → token 配色映射。
const STATUS_TONE: Record<string, { fg: string; bg: string }> = {
  authed: { fg: 'var(--signal-green)', bg: 'color-mix(in srgb, var(--signal-green) 14%, transparent)' },
  unauthed: { fg: 'var(--signal-amber)', bg: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)' },
  existing: { fg: 'var(--text-faint)', bg: 'var(--surface-sunken)' },
  open: { fg: 'var(--text-tertiary)', bg: 'var(--surface-sunken)' },
}

// 单元格通用样式。
const TD: React.CSSProperties = {
  padding: '9px 12px',
  fontSize: 12.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-hairline)',
  verticalAlign: 'middle',
}
const TH: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'left',
  color: 'var(--text-tertiary)',
  textTransform: 'none',
  borderBottom: '1px solid var(--border-hairline-alt)',
  whiteSpace: 'nowrap',
}
const SELECT_STYLE: React.CSSProperties = {
  height: 30,
  padding: '0 28px 0 10px',
  borderRadius: 8,
  border: '1px solid var(--border-hairline-alt)',
  background: 'var(--surface-sunken)',
  fontSize: 12.5,
  color: 'var(--text-primary)',
  outline: 'none',
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
}

/** 一行命中状态归一化：existing 优先，其次依据扫描状态。 */
function rowTag(r: ScanRow): 'authed' | 'unauthed' | 'existing' | 'open' {
  if (r.existing) return 'existing'
  if (r.status === 'authed') return 'authed'
  if (r.status === 'unauthed') return 'unauthed'
  return 'open'
}

export default function StepResults({
  rows, mode, groupId, onGroupChange, onToggleRow, onToggleAll, onImport, onExport, onBack,
}: StepResultsProps) {
  const { t } = useTranslation()
  const groups = useGroups()

  // 过滤状态。
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [engineFilter, setEngineFilter] = useState<string>('all')
  // 导出菜单开合。
  const [exportOpen, setExportOpen] = useState(false)

  // ---- 汇总统计（基于全量 rows，不受过滤影响）----
  const stats = useMemo(() => {
    let authed = 0, unauthed = 0, existing = 0
    for (const r of rows) {
      const tag = rowTag(r)
      if (tag === 'existing') existing++
      else if (tag === 'authed') authed++
      else if (tag === 'unauthed') unauthed++
    }
    return { total: rows.length, authed, unauthed, existing }
  }, [rows])

  // ---- db 模式：引擎过滤选项（带计数）----
  const engineOptions = useMemo(() => {
    if (mode !== 'db') return []
    const counts = new Map<string, number>()
    for (const r of rows) {
      const id = r.engineId
      if (!id) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return Array.from(counts.entries()).map(([id, n]) => ({
      id,
      label: findEngine(id)?.label ?? id,
      n,
    }))
  }, [rows, mode])

  // ---- 应用过滤 ----
  const visibleRows = useMemo(() => {
    return rows.filter(r => {
      if (statusFilter !== 'all' && rowTag(r) !== statusFilter) return false
      if (mode === 'db' && engineFilter !== 'all' && r.engineId !== engineFilter) return false
      return true
    })
  }, [rows, statusFilter, engineFilter, mode])

  const visibleRowIds = useMemo(() => visibleRows.map(r => r.rowId), [visibleRows])

  // 全选 checkbox 态：仅在“可勾选”（非 existing）的可见行上判定。
  const selectableVisible = useMemo(() => visibleRows.filter(r => !r.existing), [visibleRows])
  const allChecked = selectableVisible.length > 0 && selectableVisible.every(r => r.selected)
  const someChecked = selectableVisible.some(r => r.selected)

  // 一键入库计数：已勾选且非 existing 的行数。
  const importCount = useMemo(() => rows.filter(r => r.selected && !r.existing).length, [rows])

  const setHeaderRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = !allChecked && someChecked
  }

  // ---- 命中凭证单元格 ----
  function renderCred(r: ScanRow): React.ReactNode {
    if (r.status !== 'authed' || !r.hitUser) {
      return <span style={{ color: 'var(--text-faint)' }}>—</span>
    }
    const isKey = r.hitAuthKind === 'key'
    return (
      <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{r.hitUser}</span>
        <span style={{ color: 'var(--text-faint)' }}>/</span>
        {isKey ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-tertiary)' }}>
            <Icon name="key" size={11} />
            <span>{r.hitKeyName ?? 'key'}</span>
          </span>
        ) : (
          <span style={{ color: 'var(--text-tertiary)', letterSpacing: '0.1em' }}>••••</span>
        )}
      </span>
    )
  }

  // ---- 引擎 / OS 单元格 ----
  function renderEngineOrOs(r: ScanRow): React.ReactNode {
    if (mode === 'db') {
      const label = r.engineId ? (findEngine(r.engineId)?.label ?? r.engineId) : (r.dbType ?? '—')
      return <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
    }
    return <span style={{ color: 'var(--text-secondary)' }}>{r.os || '—'}</span>
  }

  // ---- 状态标签单元格 ----
  function renderStatus(r: ScanRow): React.ReactNode {
    const tag = rowTag(r)
    const tone = STATUS_TONE[tag]
    const label =
      tag === 'authed' ? t('scan.tag.authed')
        : tag === 'unauthed' ? t('scan.tag.unauthed')
          : tag === 'existing' ? t('scan.tag.existing')
            : t('scan.tag.unconfirmed')
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 22, padding: '0 9px', borderRadius: 6,
        fontSize: 11.5, fontWeight: 600,
        color: tone.fg, background: tone.bg,
      }}>
        {tag === 'authed' && <Icon name="circle-check" size={12} />}
        {tag === 'unauthed' && <Icon name="alert-triangle" size={12} />}
        {tag === 'open' && <Icon name="circle-dot" size={12} />}
        {label}
      </span>
    )
  }

  return (
    <div className="col" style={{ gap: 14, minHeight: 0, flex: 1 }}>
      {/* 顶部汇总 */}
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {t('scan.results.summary', stats)}
      </div>

      {/* 过滤区 */}
      <div className="row gap10" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <Icon name="filter" size={13} style={{ color: 'var(--text-faint)' }} />
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('scan.results.filterStatus')}</span>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}
              aria-label={t('scan.results.filterStatus')} style={SELECT_STYLE}>
              <option value="all">{t('scan.results.statusAll')}</option>
              <option value="authed">{t('scan.results.statusAuthed')}</option>
              <option value="unauthed">{t('scan.results.statusUnauthed')}</option>
              <option value="existing">{t('scan.results.statusExisting')}</option>
            </select>
            <Icon name="chevron-right" size={12} style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--text-faint)', pointerEvents: 'none' }} />
          </span>
        </label>

        {mode === 'db' && (
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('scan.results.filterEngine')}</span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <select value={engineFilter} onChange={e => setEngineFilter(e.target.value)}
                aria-label={t('scan.results.filterEngine')} style={SELECT_STYLE}>
                <option value="all">{t('scan.results.engineAll')}</option>
                {engineOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.label} ({o.n})</option>
                ))}
              </select>
              <Icon name="chevron-right" size={12} style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--text-faint)', pointerEvents: 'none' }} />
            </span>
          </label>
        )}
      </div>

      {/* 表格 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border-hairline)', borderRadius: 12, background: 'var(--surface-card)' }}>
        {visibleRows.length === 0 ? (
          <div className="col" style={{ alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 16px', color: 'var(--text-faint)' }}>
            <Icon name="search" size={24} />
            <span style={{ fontSize: 13 }}>{t('scan.results.empty')}</span>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}>
              <tr>
                <th style={{ ...TH, width: 38, textAlign: 'center' }}>
                  <input type="checkbox" ref={setHeaderRef} checked={allChecked}
                    disabled={selectableVisible.length === 0}
                    onChange={e => onToggleAll(e.target.checked, visibleRowIds)}
                    aria-label="全选" style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)' }} />
                </th>
                <th style={TH}>{t('scan.col.address')}</th>
                <th style={TH}>{mode === 'db' ? t('scan.col.engine') : t('scan.col.os')}</th>
                <th style={TH}>{t('scan.col.version')}</th>
                <th style={TH}>{t('scan.col.cred')}</th>
                <th style={TH}>{t('scan.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => {
                const dim = r.existing
                return (
                  <tr key={r.rowId} style={{ opacity: dim ? 0.55 : 1 }}>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <input type="checkbox" checked={r.selected} disabled={dim}
                        onChange={() => onToggleRow(r.rowId)}
                        aria-label={r.address}
                        style={{ cursor: dim ? 'default' : 'pointer', accentColor: 'var(--accent-primary)' }} />
                    </td>
                    <td style={{ ...TD }}>
                      <span className="mono" style={{ color: 'var(--text-primary)' }}>{r.address}</span>
                    </td>
                    <td style={TD}>{renderEngineOrOs(r)}</td>
                    <td style={TD}>
                      <span className="mono" style={{ color: 'var(--text-tertiary)' }}>{r.version || '—'}</span>
                    </td>
                    <td style={TD}>{renderCred(r)}</td>
                    <td style={TD}>{renderStatus(r)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 操作区 */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="row gap10" style={{ alignItems: 'center' }}>
          <Btn variant="ghost" icon="chevron-right" onClick={onBack}
            style={{ transform: 'scaleX(-1)' }} title={t('scan.back')}>
            <span style={{ transform: 'scaleX(-1)', display: 'inline-block' }}>{t('scan.back')}</span>
          </Btn>
          {/* 分组下拉（占位；实际写入由 ScanWizard 接管） */}
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('scan.results.group')}</span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <select value={groupId} onChange={e => onGroupChange(e.target.value)}
                aria-label={t('scan.results.group')} style={SELECT_STYLE}>
                <option value="">—</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <Icon name="chevron-right" size={12} style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--text-faint)', pointerEvents: 'none' }} />
            </span>
          </label>
        </div>

        <div className="row gap10" style={{ alignItems: 'center' }}>
          {/* 导出选中 */}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Btn variant="secondary" icon="download" iconR="chevron-right"
              onClick={() => setExportOpen(v => !v)} title={t('scan.results.export')}>
              {t('scan.results.export')}
            </Btn>
            {exportOpen && (
              <div className="col" style={{
                position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, minWidth: 140,
                padding: 4, borderRadius: 10, border: '1px solid var(--border-hairline-alt)',
                background: 'var(--surface-card)', boxShadow: 'var(--shadow-card)', zIndex: 5,
              }}>
                <button onClick={() => { setExportOpen(false); onExport('csv') }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left' }}>
                  <Icon name="download" size={13} />{t('scan.results.exportCsv')}
                </button>
                <button onClick={() => { setExportOpen(false); onExport('json') }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left' }}>
                  <Icon name="download" size={13} />{t('scan.results.exportJson')}
                </button>
              </div>
            )}
          </span>

          {/* 一键入库 */}
          <Btn variant="primary" icon="upload" onClick={onImport} disabled={importCount === 0}
            title={t('scan.results.import', { n: importCount })}>
            {t('scan.results.import', { n: importCount })}
          </Btn>
        </div>
      </div>
    </div>
  )
}
