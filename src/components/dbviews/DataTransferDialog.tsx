import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import {
  transferTable, tableStructure, getSchema, dbErrMsg,
  type TransferColumnMapping, type TransferMode,
} from '../../services/db'
import { autoMapImportColumns, IMPORT_SKIP_TARGET } from './tableImport'
import { availableTransferModes, transferReady } from './dataTransfer'

/** 一个可选的连接（迁移源/目标）。engine 用于判定目标是否支持原生 upsert。 */
export interface TransferConnectionOption {
  id: string
  name: string
  engine?: string
}

export interface DataTransferDialogProps {
  /** 可选的连接列表（源 + 目标都从这里选）。 */
  connections: TransferConnectionOption[]
  /** 预置的源连接/库/表（通常由「右键表 → 迁移」带入）。 */
  initialSourceConnId: string
  initialSourceSchema?: string
  initialSourceTable: string
  onClose: () => void
  /** 迁移成功回调（父组件可刷新目标网格）。 */
  onTransferred?: (rowsTransferred: number) => void
}

/**
 * 跨库/跨表数据迁移向导：选源（连接/库/表，通常预置）→ 选目标（连接/库/表）→ 列映射 →
 * 模式（追加/覆盖/Upsert）→ 迁移。映射 / 模式 / 写 SQL 生成在后端纯函数（transfer.rs，
 * 已单测），自动映射 + 就绪校验在前端纯函数（dataTransfer.ts / tableImport.ts，已单测），
 * 这里只负责对话框编排与状态。
 */
export function DataTransferDialog({
  connections, initialSourceConnId, initialSourceSchema, initialSourceTable, onClose, onTransferred,
}: DataTransferDialogProps) {
  const { t } = useTranslation()

  const [targetConnId, setTargetConnId] = useState('')
  const [targetSchema, setTargetSchema] = useState('')
  const [targetTable, setTargetTable] = useState('')
  // 目标连接的库/Schema 树(用于把目标 Schema、表做成下拉框,而非自由输入)。
  const [targetNamespaces, setTargetNamespaces] = useState<{ name: string; tables: string[] }[]>([])

  const [sourceColumns, setSourceColumns] = useState<string[]>([])
  const [targetColumns, setTargetColumns] = useState<string[]>([])
  // source column → target column ('' = 跳过)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [userEdited, setUserEdited] = useState(false)
  const [mode, setMode] = useState<TransferMode>('append')
  const [upsertKeys, setUpsertKeys] = useState<string[]>([])
  // 破坏性 Overwrite 的二次确认：用户须重新输入目标表名，匹配才放行（不可绕过）。
  const [destructiveConfirm, setDestructiveConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [summary, setSummary] = useState<number | null>(null)

  const targetEngine = useMemo(
    () => connections.find(c => c.id === targetConnId)?.engine,
    [connections, targetConnId],
  )
  const modes = useMemo(() => availableTransferModes(targetEngine), [targetEngine])

  // 目标引擎变化导致 upsert 不再可用时，回落到 append（避免卡在隐藏的模式上）。
  useEffect(() => {
    if (!modes.includes(mode)) setMode('append')
  }, [modes, mode])

  // 加载源表列（用于映射左列）。失败不阻断。
  useEffect(() => {
    let alive = true
    tableStructure(initialSourceConnId, initialSourceSchema ?? '', initialSourceTable)
      .then(st => { if (alive) setSourceColumns(st.columns.map(c => c.name)) })
      .catch(() => { /* best-effort */ })
    return () => { alive = false }
  }, [initialSourceConnId, initialSourceSchema, initialSourceTable])

  // 选定目标连接后,内省其库/Schema 树,把目标 Schema 与表做成下拉框(对齐真机反馈)。
  // 单一命名空间时自动选中(省一步);多库时留空由用户选,避免误默认到错误的库。
  useEffect(() => {
    let alive = true
    if (!targetConnId) { setTargetNamespaces([]); setTargetSchema(''); setTargetTable(''); return }
    getSchema(targetConnId)
      .then(s => {
        if (!alive) return
        const ns = s.schemas.map(x => ({ name: x.name, tables: x.tables.map(t => t.name) }))
        setTargetNamespaces(ns)
        setTargetSchema(ns.length === 1 ? ns[0].name : '')
        setTargetTable('')
      })
      .catch(() => { if (alive) setTargetNamespaces([]) })
    return () => { alive = false }
  }, [targetConnId])

  // 当前目标 Schema 下的表名(下拉选项)。未选 Schema 但只有一个命名空间时回退到它。
  const targetTableOptions = useMemo(() => {
    const ns = targetNamespaces.find(n => n.name === targetSchema)
      ?? (targetNamespaces.length === 1 ? targetNamespaces[0] : undefined)
    return ns?.tables ?? []
  }, [targetNamespaces, targetSchema])

  // 加载目标表列（用于映射下拉 + upsert 键候选）。失败不阻断——用户仍可手填目标列。
  useEffect(() => {
    let alive = true
    if (!targetConnId || !targetTable.trim()) { setTargetColumns([]); return }
    tableStructure(targetConnId, targetSchema, targetTable)
      .then(st => { if (alive) setTargetColumns(st.columns.map(c => c.name)) })
      .catch(() => { if (alive) setTargetColumns([]) })
    return () => { alive = false }
  }, [targetConnId, targetSchema, targetTable])

  // 源/目标列就绪且用户未手动改过时，重算自动映射。
  useEffect(() => {
    if (sourceColumns.length > 0 && !userEdited) {
      setMapping(autoMapImportColumns(sourceColumns, targetColumns))
    }
  }, [sourceColumns, targetColumns, userEdited])

  const mappedTargets = useMemo(
    () => Object.values(mapping).map(v => v.trim()).filter(v => v !== ''),
    [mapping],
  )
  const mappedCount = mappedTargets.length

  // Overwrite 是破坏性操作：除常规就绪外，还要求确认输入精确等于目标表名。
  const destructiveConfirmed = mode !== 'overwrite' || destructiveConfirm.trim() === targetTable.trim()
  const ready = useMemo(
    () => transferReady({ targetTable, mapping, mode, upsertKeys }) && destructiveConfirmed,
    [targetTable, mapping, mode, upsertKeys, destructiveConfirmed],
  )

  function setTargetFor(source: string, target: string) {
    setUserEdited(true)
    setMapping(m => ({ ...m, [source]: target }))
  }

  function toggleUpsertKey(col: string) {
    setUpsertKeys(keys => keys.includes(col) ? keys.filter(k => k !== col) : [...keys, col])
  }

  async function runTransfer() {
    if (!ready) return
    setErr(null)
    setBusy(true)
    try {
      const mappings: TransferColumnMapping[] = Object.entries(mapping)
        .filter(([, target]) => target.trim() !== '')
        .map(([sourceColumn, targetColumn]) => ({ sourceColumn, targetColumn }))
      const res = await transferTable({
        sourceConnId: initialSourceConnId,
        sourceSchema: initialSourceSchema || undefined,
        sourceTable: initialSourceTable,
        targetConnId,
        targetSchema: targetSchema || undefined,
        targetTable,
        mappings,
        mode,
        upsertKeys: mode === 'upsert' ? upsertKeys : undefined,
        allowDestructive: mode === 'overwrite' ? true : undefined,
      })
      setSummary(res.rowsTransferred)
      onTransferred?.(res.rowsTransferred)
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

  // 注意:图标名必须是 Icon 组件已定义的,否则会渲染成无意义的兜底圆圈(repeat 即不存在)。
  const modeIcon = (m: TransferMode) => m === 'append' ? 'plus' : m === 'overwrite' ? 'eraser' : 'refresh-cw'
  const modeLabel = (m: TransferMode) =>
    m === 'append' ? t('dbviews.importModeAppend')
      : m === 'overwrite' ? t('dbviews.importModeTruncate')
        : t('dbviews.transferModeUpsert')

  // 通过 portal 渲染到 body 并用 position:fixed 全屏遮罩,确保连左侧数据库连接/目录树一并遮住
  // (此前 absolute 只覆盖工作台内容区,挡不住侧边栏)。
  return createPortal(
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: 680, maxWidth: '92%', maxHeight: '88%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.transferTitle')}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {initialSourceSchema ? `${initialSourceSchema}.${initialSourceTable}` : initialSourceTable}
            </span>
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 14, padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {/* source (read-only summary) + target pickers */}
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <span style={labelStyle}>{t('dbviews.transferSource')}</span>
              <span className="mono ell" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {connections.find(c => c.id === initialSourceConnId)?.name ?? initialSourceConnId}
              </span>
              <span className="mono ell" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {initialSourceSchema ? `${initialSourceSchema}.${initialSourceTable}` : initialSourceTable}
              </span>
            </div>
            <Icon name="arrow-right" size={15} style={{ marginTop: 22, color: 'var(--text-faint)' }} />
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <span style={labelStyle}>{t('dbviews.transferTarget')}</span>
              <select aria-label="transfer-target-conn" value={targetConnId}
                onChange={e => { setTargetConnId(e.target.value); setUserEdited(false) }}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">{t('dbviews.transferSelectConnection')}</option>
                {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select aria-label="transfer-target-schema" value={targetSchema}
                onChange={e => { setTargetSchema(e.target.value); setTargetTable(''); setUserEdited(false) }}
                disabled={targetNamespaces.length === 0}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">{t('dbviews.transferSchema')}</option>
                {targetNamespaces.map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
              </select>
              <select aria-label="transfer-target-table" value={targetTable}
                onChange={e => { setTargetTable(e.target.value); setUserEdited(false) }}
                disabled={targetTableOptions.length === 0}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">{t('dbviews.transferSelectTable')}</option>
                {targetTableOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          </div>

          {/* column mapping */}
          {sourceColumns.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.importMapping')}</span>
              <div className="row" style={{ gap: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', padding: '0 2px' }}>
                <span style={{ flex: 1 }}>{t('dbviews.importSourceColumn')}</span>
                <span style={{ width: 20 }} />
                <span style={{ flex: 1 }}>{t('dbviews.importTargetColumn')}</span>
              </div>
              {sourceColumns.map(src => (
                <div key={src} className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="mono ell" style={{ flex: 1, fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0 }}>{src}</span>
                  <Icon name="arrow-right" size={13} style={{ width: 20, color: 'var(--text-faint)' }} />
                  <select aria-label={`map-${src}`} value={mapping[src] ?? IMPORT_SKIP_TARGET}
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

          {/* mode */}
          <div className="col" style={{ gap: 6 }}>
            <span style={labelStyle}>{t('dbviews.importMode')}</span>
            <div className="row gap8">
              {modes.map(m => (
                <button key={m} className="row" onClick={() => setMode(m)}
                  style={{ gap: 6, padding: '6px 12px', borderRadius: 8, border: `1px solid ${mode === m ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: mode === m ? 'var(--accent-soft)' : 'transparent', color: mode === m ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5 }}>
                  <Icon name={modeIcon(m)} size={13} />
                  {modeLabel(m)}
                </button>
              ))}
            </div>
            {mode === 'overwrite' && (
              <div className="col" style={{ gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--danger, #d9534f)' }}>{t('dbviews.transferOverwriteWarn')}</span>
                <span style={labelStyle}>{t('dbviews.transferOverwriteConfirmLabel')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {t('dbviews.transferOverwriteConfirmHint', { table: targetTable })}
                </span>
                <input aria-label="transfer-destructive-confirm" value={destructiveConfirm}
                  onChange={e => setDestructiveConfirm(e.target.value)}
                  placeholder={targetTable} style={inputStyle} />
              </div>
            )}
          </div>

          {/* upsert keys */}
          {mode === 'upsert' && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.transferUpsertKeys')}</span>
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('dbviews.transferUpsertKeysHint')}</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {mappedTargets.map(col => (
                  <label key={col} aria-label={`upsert-key-${col}`} className="row"
                    onClick={() => toggleUpsertKey(col)}
                    style={{ gap: 5, padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12, border: `1px solid ${upsertKeys.includes(col) ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: upsertKeys.includes(col) ? 'var(--accent-soft)' : 'transparent', color: upsertKeys.includes(col) ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                    <Icon name={upsertKeys.includes(col) ? 'check' : 'circle'} size={12} />
                    <span className="mono">{col}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {err && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--danger, #d9534f)', fontSize: 12 }}>
              <Icon name="alert-triangle" size={14} />
              <span>{t('dbviews.transferError', { message: err })}</span>
            </div>
          )}
          {summary != null && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--accent-primary)', fontSize: 12.5 }}>
              <Icon name="circle-check" size={14} />
              <span>{t('dbviews.transferDone', { count: summary })}</span>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="row gap8" style={{ justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: '1px solid var(--border-hairline)', flex: 'none' }}>
          <Btn variant="ghost" onClick={onClose}>{summary != null ? t('dbviews.close') : t('dbviews.cancel')}</Btn>
          <Btn variant="primary" icon="arrow-right-to-line"
            onClick={runTransfer}
            disabled={busy || !ready}>
            {busy ? t('dbviews.transferring') : t('dbviews.transferApply', { count: mappedCount })}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  )
}
