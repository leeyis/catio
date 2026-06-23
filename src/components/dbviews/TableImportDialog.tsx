import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import {
  importPreview, importTable, tableStructure, dbErrMsg,
  type ImportPreview, type ImportColumnMapping,
} from '../../services/db'
import { autoMapImportColumns, IMPORT_SKIP_TARGET, engineSupportsImportTransaction } from './tableImport'

export interface TableImportDialogProps {
  connId: string
  /** schema 限定（无 schema 概念的引擎传 undefined/空串）。 */
  schema?: string
  /** 目标表名。 */
  table: string
  /** 连接引擎串：用于判断 truncate 模式是否有事务回滚保护。 */
  engine?: string
  onClose: () => void
  /** 导入成功后回调（父组件刷新数据网格）。 */
  onImported?: (rowsImported: number) => void
}

/**
 * 表数据导入对话框：选文件 → 预览 → 列映射 → 选模式 → 导入。
 * 解析 / 列映射 / INSERT 生成均在后端纯函数（table_import.rs，已单测），自动映射在
 * tableImport.ts（已单测），这里只负责对话框编排与状态。
 */
export function TableImportDialog({ connId, schema, table, engine, onClose, onImported }: TableImportDialogProps) {
  const { t } = useTranslation()
  // 不支持事务的引擎在 truncate 模式无回滚保护，额外提示用户。
  const noRollback = !engineSupportsImportTransaction(engine)

  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [targetColumns, setTargetColumns] = useState<string[]>([])
  // source column → target column ('' = 跳过)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  // 用户是否手动改过映射。未改过则在 preview / 目标列变化时持续重算自动映射
  // （避免目标列异步晚到导致映射停留在「全跳过」）。
  const [userEdited, setUserEdited] = useState(false)
  const [mode, setMode] = useState<'append' | 'truncate'>('append')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [summary, setSummary] = useState<number | null>(null)

  // 加载目标表的列名（用于映射下拉）。失败不阻断——用户仍可手动填写目标列。
  useEffect(() => {
    let alive = true
    tableStructure(connId, schema ?? '', table)
      .then(st => { if (alive) setTargetColumns(st.columns.map(c => c.name)) })
      .catch(() => { /* best-effort */ })
    return () => { alive = false }
  }, [connId, schema, table])

  async function pickFile() {
    setErr(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        multiple: false,
        filters: [{ name: t('dbviews.importFileFilter'), extensions: ['csv', 'tsv', 'json', 'xlsx', 'xlsm', 'xls'] }],
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      setFilePath(path)
      setSummary(null)
      setUserEdited(false)
      setBusy(true)
      const pv = await importPreview(path)
      setPreview(pv)
      // 初始映射：按列名启发式自动匹配目标列（目标列若晚到，由下方 effect 重算）。
      setMapping(autoMapImportColumns(pv.columns, targetColumns))
    } catch (e) {
      setErr(dbErrMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // preview 或目标列变化且用户尚未手动调整时，重算自动映射。
  useEffect(() => {
    if (preview && !userEdited) {
      setMapping(autoMapImportColumns(preview.columns, targetColumns))
    }
  }, [preview, targetColumns, userEdited])

  const mappedCount = useMemo(
    () => Object.values(mapping).filter(v => v.trim() !== '').length,
    [mapping],
  )

  function setTargetFor(source: string, target: string) {
    setUserEdited(true)
    setMapping(m => ({ ...m, [source]: target }))
  }

  async function runImport() {
    if (!filePath || mappedCount === 0) return
    setErr(null)
    setBusy(true)
    try {
      const mappings: ImportColumnMapping[] = Object.entries(mapping)
        .filter(([, target]) => target.trim() !== '')
        .map(([sourceColumn, targetColumn]) => ({ sourceColumn, targetColumn }))
      const res = await importTable({ connId, schema, table, filePath, mappings, mode })
      setSummary(res.rowsImported)
      onImported?.(res.rowsImported)
    } catch (e) {
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

  return (
    <div onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: 680, maxWidth: '92%', maxHeight: '88%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.importTitle')}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {schema ? `${schema}.${table}` : table}
            </span>
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 14, padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {/* file picker */}
          <div className="col" style={{ gap: 6 }}>
            <span style={labelStyle}>{t('dbviews.importFile')}</span>
            <div className="row gap8" style={{ alignItems: 'center' }}>
              <Btn size="sm" variant="secondary" icon="upload" onClick={pickFile} disabled={busy}>
                {t('dbviews.importChooseFile')}
              </Btn>
              {preview && (
                <span className="mono ell" style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
                  {preview.fileName} · {preview.fileType.toUpperCase()} · {t('dbviews.importRowCount', { count: preview.totalRows })}
                </span>
              )}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('dbviews.importSupported')}</span>
          </div>

          {/* column mapping */}
          {preview && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.importMapping')}</span>
              <div className="row" style={{ gap: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', padding: '0 2px' }}>
                <span style={{ flex: 1 }}>{t('dbviews.importSourceColumn')}</span>
                <span style={{ width: 20 }} />
                <span style={{ flex: 1 }}>{t('dbviews.importTargetColumn')}</span>
              </div>
              {preview.columns.map(src => (
                <div key={src} className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="mono ell" style={{ flex: 1, fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0 }}>{src}</span>
                  <Icon name="arrow-right" size={13} style={{ width: 20, color: 'var(--text-faint)' }} />
                  <select value={mapping[src] ?? IMPORT_SKIP_TARGET}
                    onChange={e => setTargetFor(src, e.target.value)}
                    style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}>
                    <option value={IMPORT_SKIP_TARGET}>{t('dbviews.importSkipColumn')}</option>
                    {targetColumns.length === 0 && mapping[src] && mapping[src] !== IMPORT_SKIP_TARGET && (
                      <option value={mapping[src]}>{mapping[src]}</option>
                    )}
                    {targetColumns.map(tc => <option key={tc} value={tc}>{tc}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {/* preview table */}
          {preview && preview.rows.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.importPreview')}</span>
              <div style={{ border: '1px solid var(--border-hairline-alt)', borderRadius: 10, overflow: 'auto', maxHeight: 180 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                  <thead>
                    <tr>
                      {preview.columns.map(c => (
                        <th key={c} className="mono" style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border-hairline)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-card)' }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr key={ri}>
                        {preview.columns.map((_, ci) => (
                          <td key={ci} className="mono" style={{ padding: '5px 10px', borderBottom: '1px solid var(--border-hairline-alt)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row[ci] == null ? <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>NULL</span> : String(row[ci])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* mode */}
          {preview && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.importMode')}</span>
              <div className="row gap8">
                {(['append', 'truncate'] as const).map(m => (
                  <button key={m} className="row" onClick={() => setMode(m)}
                    style={{ gap: 6, padding: '6px 12px', borderRadius: 8, border: `1px solid ${mode === m ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: mode === m ? 'var(--accent-soft)' : 'transparent', color: mode === m ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5 }}>
                    <Icon name={m === 'append' ? 'plus' : 'trash-2'} size={13} />
                    {t(m === 'append' ? 'dbviews.importModeAppend' : 'dbviews.importModeTruncate')}
                  </button>
                ))}
              </div>
              {mode === 'truncate' && (
                <span style={{ fontSize: 11, color: 'var(--danger, #d9534f)' }}>{t('dbviews.importTruncateWarn')}</span>
              )}
              {mode === 'truncate' && noRollback && (
                <span style={{ fontSize: 11, color: 'var(--danger, #d9534f)' }}>{t('dbviews.importTruncateNoRollback')}</span>
              )}
            </div>
          )}

          {err && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--danger, #d9534f)', fontSize: 12 }}>
              <Icon name="alert-triangle" size={14} />
              <span>{t('dbviews.importError', { message: err })}</span>
            </div>
          )}
          {summary != null && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--accent-primary)', fontSize: 12.5 }}>
              <Icon name="circle-check" size={14} />
              <span>{t('dbviews.importDone', { count: summary })}</span>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="row gap8" style={{ justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: '1px solid var(--border-hairline)', flex: 'none' }}>
          <Btn variant="ghost" onClick={onClose}>{summary != null ? t('dbviews.close') : t('dbviews.cancel')}</Btn>
          <Btn variant="primary" icon="upload"
            onClick={runImport}
            disabled={busy || !preview || mappedCount === 0}>
            {busy ? t('dbviews.importing') : t('dbviews.importApply', { count: mappedCount })}
          </Btn>
        </div>
      </div>
    </div>
  )
}
