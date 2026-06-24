import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import {
  filterTables, toggleSelected, selectAllFiltered, clearFiltered,
  buildSelectedTablesPayload, exportReady,
} from './databaseExport'
import { dbErrMsg } from '../../services/db'

/** 父级(DbWorkbench)拿到这份选项后:收集每表 DDL → 调 exportDatabaseSql → 落盘。 */
export interface DatabaseExportRequest {
  /** undefined = 导出全部表(全选/无表);否则为按规范顺序的显式子集。 */
  selectedTables: string[] | undefined
  includeStructure: boolean
  includeData: boolean
  /** 每条 INSERT 的批大小(后端缺省 = DEFAULT_INSERT_BATCH_SIZE)。 */
  batchSize?: number
  /** 每表行上限;undefined = 无上限(导出全部行)。 */
  rowLimit?: number
}

export interface DatabaseExportDialogProps {
  /** 当前导出的 schema/库名(展示用,也用作默认文件名)。 */
  schema: string
  /** 该 schema 下可导出的表名(视图已由调用方剔除)。 */
  allTables: string[]
  onClose: () => void
  /** 执行导出。落盘/后端调用由父级负责;dialog 只负责选项编排与就绪校验。 */
  onExport: (req: DatabaseExportRequest) => Promise<void>
}

/**
 * 整库导出对话框:选表(多选,默认全选)+ 选项(结构/数据、批大小、行上限)→ 导出为 .sql。
 *
 * 对齐 dbx DatabaseExportDialog.vue 的过滤/全选/清空交互;选择与就绪归约抽到纯函数
 * databaseExport.ts(已单测)。真实落盘走父级 onExport(复用 T13 service exportDatabaseSql)。
 */
export function DatabaseExportDialog({ schema, allTables, onClose, onExport }: DatabaseExportDialogProps) {
  const { t } = useTranslation()

  const [selected, setSelected] = useState<string[]>([...allTables])
  const [filter, setFilter] = useState('')
  const [includeStructure, setIncludeStructure] = useState(true)
  const [includeData, setIncludeData] = useState(true)
  // 空串 = 用后端缺省批大小;空串 = 无行上限。两者都接受手填数字。
  const [batchSize, setBatchSize] = useState('')
  const [rowLimit, setRowLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const filtered = useMemo(() => filterTables(allTables, filter), [allTables, filter])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const ready = exportReady({ selectedCount: selected.length, includeStructure, includeData })

  function parsePositiveInt(raw: string): number | undefined {
    const v = raw.trim()
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
  }

  async function run() {
    if (!ready || busy) return
    setErr(null)
    setBusy(true)
    try {
      await onExport({
        selectedTables: buildSelectedTablesPayload(allTables, selected),
        includeStructure,
        includeData,
        batchSize: parsePositiveInt(batchSize),
        rowLimit: parsePositiveInt(rowLimit),
      })
    } catch (e) {
      // Tauri 命令以 DbError 普通对象 { kind, message } reject 时,String(e) 会得到
      // '[object Object]',丢掉真实原因。用 dbErrMsg 统一抽取消息。
      setErr(dbErrMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 30, boxSizing: 'border-box', border: '1px solid var(--border-hairline-alt)',
    borderRadius: 8, background: 'var(--surface-sunken)', color: 'var(--text-primary)',
    font: 'inherit', fontSize: 12.5, padding: '0 8px', outline: 'none',
  }
  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }

  const checkRow = (testId: string, on: boolean, toggle: () => void, label: string) => (
    <button data-testid={testId} aria-pressed={on} onClick={toggle} className="row gap8"
      style={{ width: '100%', textAlign: 'left', padding: '6px 4px', border: 'none', background: 'transparent', cursor: 'pointer', alignItems: 'center', color: 'var(--text-primary)', fontSize: 12.5 }}>
      <span style={{ width: 15, height: 15, borderRadius: 4, flex: 'none', display: 'grid', placeItems: 'center', border: `1.5px solid ${on ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: on ? 'var(--accent-primary)' : 'transparent' }}>
        {on && <Icon name="check" size={10} style={{ color: '#fff' }} />}
      </span>
      <span>{label}</span>
    </button>
  )

  return (
    <div onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: 520, maxWidth: '92%', maxHeight: '88%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
          <div className="row gap8" style={{ alignItems: 'center', minWidth: 0 }}>
            <Icon name="download" size={16} style={{ color: 'var(--accent-primary)', flex: 'none' }} />
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbexport.title')}</span>
              <span className="mono ell" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{schema}</span>
            </div>
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 14, padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {/* table selection */}
          <div className="col" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={labelStyle}>{t('dbexport.tableSelection')}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {t('dbexport.selectedCount', { selected: selected.length, total: allTables.length })}
              </span>
            </div>
            <div className="col" style={{ gap: 8, border: '1px solid var(--border-hairline)', borderRadius: 10, padding: 8 }}>
              <div className="row gap6" style={{ height: 30, padding: '0 9px', background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8 }}>
                <Icon name="search" size={13} style={{ color: 'var(--text-faint)' }} />
                <input data-testid="dbexport-filter" value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder={t('dbexport.filterTables')}
                  style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-primary)' }} />
              </div>
              <div className="row gap8">
                <Btn variant="ghost" size="sm" testId="dbexport-select-all"
                  onClick={() => setSelected(selectAllFiltered(allTables, selected, filtered))}>
                  {t('dbexport.selectAll')}
                </Btn>
                <Btn variant="ghost" size="sm" testId="dbexport-clear"
                  onClick={() => setSelected(clearFiltered(selected, filtered))}>
                  {t('dbexport.clear')}
                </Btn>
              </div>
              <div className="col scrollon" style={{ maxHeight: 180, overflowY: 'auto', gap: 1 }}>
                {filtered.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-faint)', padding: '8px 4px' }}>{t('dbexport.noTables')}</span>
                ) : filtered.map(tbl => {
                  const on = selectedSet.has(tbl)
                  return (
                    <button key={tbl} data-testid={`dbexport-tbl:${tbl}`} aria-pressed={on}
                      onClick={() => setSelected(toggleSelected(allTables, selected, tbl))} className="row gap8"
                      style={{ width: '100%', textAlign: 'left', padding: '5px 6px', border: 'none', background: 'transparent', cursor: 'pointer', alignItems: 'center', borderRadius: 6 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-sunken)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
                      <span style={{ width: 15, height: 15, borderRadius: 4, flex: 'none', display: 'grid', placeItems: 'center', border: `1.5px solid ${on ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: on ? 'var(--accent-primary)' : 'transparent' }}>
                        {on && <Icon name="check" size={10} style={{ color: '#fff' }} />}
                      </span>
                      <Icon name="table-2" size={12} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
                      <span className="ell mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{tbl}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* options */}
          <div className="col" style={{ gap: 4 }}>
            <span style={labelStyle}>{t('dbexport.options')}</span>
            {checkRow('dbexport-opt-structure', includeStructure, () => setIncludeStructure(v => !v), t('dbexport.includeStructure'))}
            {checkRow('dbexport-opt-data', includeData, () => setIncludeData(v => !v), t('dbexport.includeData'))}
          </div>

          {/* numeric options */}
          <div className="row" style={{ gap: 12 }}>
            <div className="col" style={{ gap: 6, flex: 1 }}>
              <span style={labelStyle}>{t('dbexport.batchSize')}</span>
              <input data-testid="dbexport-batch" type="number" min={1} value={batchSize}
                onChange={e => setBatchSize(e.target.value)} placeholder={t('dbexport.batchSizePlaceholder')} style={inputStyle} />
            </div>
            <div className="col" style={{ gap: 6, flex: 1 }}>
              <span style={labelStyle}>{t('dbexport.rowLimit')}</span>
              <input data-testid="dbexport-rowlimit" type="number" min={1} value={rowLimit}
                onChange={e => setRowLimit(e.target.value)} placeholder={t('dbexport.rowLimitPlaceholder')} style={inputStyle} />
            </div>
          </div>

          {err && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--danger-fg, #d9534f)', fontSize: 12 }}>
              <Icon name="alert-triangle" size={14} />
              <span>{t('dbexport.error', { message: err })}</span>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="row gap8" style={{ justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: '1px solid var(--border-hairline)', flex: 'none' }}>
          <Btn variant="ghost" onClick={onClose}>{t('dbexport.cancel')}</Btn>
          <Btn variant="primary" icon="download" testId="dbexport-run" onClick={run} disabled={busy || !ready}>
            {busy ? t('dbexport.exporting') : t('dbexport.export')}
          </Btn>
        </div>
      </div>
    </div>
  )
}
