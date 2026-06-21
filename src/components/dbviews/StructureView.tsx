/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7; live structure wired in E-series; column editing (add/modify/drop) added */
import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented, Toggle } from '../atoms'
import { useData } from '../../state/DataContext'
import { tableStructure, runQuery, dbErrMsg } from '../../services/db'
import type { StructColumn, TableStructure } from '../../services/types'
import { highlightSQL } from './highlightSQL'
import { dialectFor, qualifiedTable, buildAddColumn, buildModifyColumn, buildDropColumn, buildCreateTableDDL, type ColumnDraft } from './structureDdl'

export interface StructureViewProps {
  table: string
  /** Live backend connection id; when undefined we render the mock structure (pixel-identical demo). */
  connId?: string
  /** Schema namespace qualifying the table (live path); used for the real structure fetch + DDL prefix. */
  schema?: string
  /** Engine string (Connection.engine / DbType) — selects identifier quoting. Postgres-first. */
  engine?: string
  /** Whether structure EDITING (add/modify/drop column) is supported by the engine
   *  (capabilities.structureEdit). Viewing columns is always allowed. Defaults true. */
  canEdit?: boolean
}

// `table-layout: fixed` makes the table honor `width:100%` strictly and split the
// remaining width evenly across the (non-`#`) columns instead of shrink-wrapping to
// content and leaving a large blank on the right.
const tblStyle: React.CSSProperties = { width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12.5 }
const thCell: React.CSSProperties = { textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)', borderBottom: '1px solid var(--border-hairline-alt)', position: 'sticky', top: 0, background: 'var(--surface-subtle)', zIndex: 1 }
const tdCell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', color: 'var(--text-secondary)', verticalAlign: 'middle' }
const inputStyle: React.CSSProperties = { border: '1px solid var(--border-hairline)', borderRadius: 7, padding: '6px 9px', background: 'var(--surface-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12.5, outline: 'none', width: '100%' }

// Column widths for the fixed-layout structure table, by header index
// (#, 列名, 类型, 可空, 默认值, 键, 备注). 列名/类型 get the most room; 默认值/备注
// (undefined) share whatever's left. Cells truncate so nothing overlaps regardless.
const colWidth: (number | string | undefined)[] = [36, '26%', '18%', 64, undefined, 72, undefined]
// Single-line ellipsis truncation for a fixed-table cell (maxWidth:0 forces the
// cell to honor its column width instead of growing to fit the content).
const ellCell: React.CSSProperties = { maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function Empty({ icon, text }: { icon: string; text: string }) {
  return <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-faint)' }}><Icon name={icon} size={26} /><span style={{ fontSize: 13 }}>{text}</span></div>
}

/** Local edit-form state for the add/modify dialog. */
interface ColForm {
  /** 'add' → ADD COLUMN; otherwise the name of the existing column being modified. */
  mode: 'add' | { editing: string; original: ColumnDraft }
  name: string
  type: string
  nullable: boolean
  default: string
  comment: string
}

export function StructureView({ table, connId, schema, engine, canEdit = true }: StructureViewProps) {
  const { t } = useTranslation()
  const D = useData()
  const mockSt = D.tableStructures[table] || D.tableStructures['orders']
  // Live path: fetch the real structure from the backend; null until loaded.
  const [liveSt, setLiveSt] = useState<TableStructure | null>(null)
  const [structErr, setStructErr] = useState<string | null>(null)
  // Bumped after a successful DDL apply to force a structure re-fetch.
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    if (!connId) { setLiveSt(null); setStructErr(null); return }
    let cancelled = false
    setStructErr(null)
    tableStructure(connId, schema ?? '', table)
      .then(s => { if (!cancelled) setLiveSt(s) })
      .catch(e => { if (!cancelled) { setLiveSt(null); setStructErr(dbErrMsg(e)) } })
    return () => { cancelled = true }
  }, [connId, schema, table, refreshTick])
  // When connected, render real data once loaded; otherwise the mock structure.
  const st: TableStructure = connId ? (liveSt ?? { comment: '', columns: [], indexes: [], fks: [] }) : mockSt
  const ddlQualified = connId ? (schema ? `${schema}.${table}` : table) : `public.${table}`
  const [tab, setTab] = useState('columns')
  const keyTone: Record<string, string> = { PK: 'var(--signal-amber)', FK: 'var(--signal-blue)', UNI: 'var(--signal-violet)' }

  // ---- One-tap DDL copy: copy → switch icon to `check` for ~1.2s → revert. ----
  const [ddlCopied, setDdlCopied] = useState(false)
  const ddlCopyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (ddlCopyTimer.current) clearTimeout(ddlCopyTimer.current) }, [])
  function copyDdl() {
    navigator.clipboard.writeText(buildCreateTableDDL(dialect, ddlQualified, st))
    setDdlCopied(true)
    if (ddlCopyTimer.current) clearTimeout(ddlCopyTimer.current)
    ddlCopyTimer.current = setTimeout(() => setDdlCopied(false), 1200)
  }

  // ---- Column editing (live path only, and only when the engine supports
  // structure edits — MongoDB/ClickHouse/… can VIEW structure but not ALTER it). ----
  const editable = !!connId && canEdit
  const dialect = dialectFor(engine)
  const sqlQualified = qualifiedTable(dialect, schema, table)
  // Open add/modify form (null = closed).
  const [form, setForm] = useState<ColForm | null>(null)
  // Preview gate: the generated statements awaiting confirmation.
  const [preview, setPreview] = useState<string[] | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyErr, setApplyErr] = useState<string | null>(null)

  function openAdd() {
    setApplyErr(null)
    setForm({ mode: 'add', name: '', type: '', nullable: true, default: '', comment: '' })
  }
  function openEdit(c: StructColumn) {
    setApplyErr(null)
    const original: ColumnDraft = { name: c.name, type: c.type, nullable: c.nullable, default: c.default ?? '', comment: c.comment ?? '' }
    setForm({ mode: { editing: c.name, original }, name: c.name, type: c.type, nullable: c.nullable, default: c.default ?? '', comment: c.comment ?? '' })
  }

  // Build the statements for the open form and hand them to the preview gate.
  function submitForm() {
    if (!form) return
    const draft: ColumnDraft = { name: form.name, type: form.type, nullable: form.nullable, default: form.default, comment: form.comment }
    const stmts = form.mode === 'add'
      ? buildAddColumn(dialect, sqlQualified, draft)
      : buildModifyColumn(dialect, sqlQualified, form.mode.original, draft)
    if (stmts.length === 0) return
    setApplyErr(null)
    setForm(null)
    setPreview(stmts)
  }

  // DROP COLUMN → straight to the preview gate (the gate itself is the confirm step).
  function startDrop(c: StructColumn) {
    setApplyErr(null)
    setPreview(buildDropColumn(dialect, sqlQualified, c.name))
  }

  // Run each statement sequentially; stop + surface on the first error; refresh on success.
  async function confirmApply() {
    if (!preview || !connId) return
    setApplying(true)
    setApplyErr(null)
    try {
      for (const stmt of preview) {
        await runQuery(connId, stmt)
      }
      setPreview(null)
      setRefreshTick(n => n + 1)
    } catch (e) {
      setApplyErr(t('dbviews.applyError', { message: dbErrMsg(e) }))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="col" style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8, flex: 'none' }}>
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: 'columns', label: `${t('dbviews.tabColumns')} (${st.columns.length})` },
          { value: 'indexes', label: `${t('dbviews.tabIndexes')} (${st.indexes.length})` },
          { value: 'fks', label: `${t('dbviews.tabFks')} (${st.fks.length})` },
          { value: 'ddl', label: 'DDL' },
        ]} />
        <div className="grow" />
        {tab === 'ddl' && (
          <IconBtn name={ddlCopied ? 'check' : 'copy'} size={14} variant="bare"
            title={ddlCopied ? t('common.copied') : t('dbviews.copyDdl')}
            style={ddlCopied ? { color: 'var(--signal-green)' } : undefined} onClick={copyDdl} />
        )}
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st.comment || undefined}>{st.comment}</span>
        <Btn size="sm" variant="secondary" icon="plus" onClick={editable ? openAdd : undefined} disabled={!editable}>{t('dbviews.addColumn')}</Btn>
      </div>
      <div className="grow" style={{ overflow: 'auto' }}>
        {structErr && <Empty icon="alert-triangle" text={structErr} />}
        {!structErr && tab === 'columns' && (
          <table style={tblStyle}>
            <thead><tr>
              {['', t('dbviews.colName'), t('dbviews.colType'), t('dbviews.colNullable'), t('dbviews.colDefault'), t('dbviews.colKey'), t('dbviews.colComment')].map((h, i) => (
                // Fixed-layout widths: give 列名/类型 the most room (long names/types
                // overflowed into the next column); 可空/键 are narrow, 默认值/备注 share.
                <th key={i} style={{ ...thCell, width: colWidth[i], textAlign: i === 3 ? 'center' : 'left' }}>{h}</th>
              ))}
              {editable && <th style={{ ...thCell, width: 72, textAlign: 'right' }} />}
            </tr></thead>
            <tbody>
              {st.columns.map((c, i) => (
                <tr key={c.name} className="structrow" style={{ background: i % 2 ? 'var(--surface-subtle)' : 'transparent' }}>
                  <td style={{ ...tdCell, width: 30, color: 'var(--text-disabled)', textAlign: 'center' }}>{i + 1}</td>
                  <td style={{ ...tdCell, ...ellCell }}>
                    <span className="row gap6" style={{ minWidth: 0 }}>
                      <Icon name={c.key === 'PK' ? 'key' : c.key === 'FK' ? 'link' : 'hash'} size={12} style={{ flex: 'none', color: c.key ? keyTone[c.key] : 'var(--text-disabled)' }} />
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
                    </span>
                  </td>
                  <td style={{ ...tdCell, ...ellCell }} title={c.type}><span className="mono" style={{ color: 'var(--signal-blue)' }}>{c.type}</span></td>
                  <td style={{ ...tdCell, textAlign: 'center' }}>{c.nullable ? <span style={{ color: 'var(--text-faint)' }}>NULL</span> : <Icon name="check" size={13} style={{ color: 'var(--signal-green)' }} />}</td>
                  <td style={tdCell}><span className="mono" style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>{c.default || '—'}</span></td>
                  <td style={tdCell}>{c.key ? <span className="badge-accent" style={{ background: `color-mix(in srgb, ${keyTone[c.key]} 16%, transparent)`, color: keyTone[c.key] }}>{c.key}</span> : ''}</td>
                  <td style={{ ...tdCell, color: 'var(--text-faint)', fontSize: 11.5, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.comment || undefined}>{c.comment}</td>
                  {editable && (
                    <td style={{ ...tdCell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span className="structrow-actions row gap6" style={{ justifyContent: 'flex-end' }}>
                        <IconBtn name="pencil" size={13} variant="bare" title={t('dbviews.editColumn')} onClick={() => openEdit(c)} />
                        <IconBtn name="trash-2" size={13} variant="bare" title={t('dbviews.dropColumn')} style={{ color: 'var(--danger-fg)' }} onClick={() => startDrop(c)} />
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!structErr && tab === 'indexes' && (
          <table style={tblStyle}>
            <thead><tr>{['', t('dbviews.idxName'), t('dbviews.idxCols'), t('dbviews.idxUnique'), t('dbviews.idxMethod')].map((h, i) => <th key={i} style={{ ...thCell, width: i === 0 ? 36 : undefined }}>{h}</th>)}</tr></thead>
            <tbody>
              {st.indexes.map((ix, i) => (
                <tr key={ix.name} style={{ background: i % 2 ? 'var(--surface-subtle)' : 'transparent' }}>
                  <td style={{ ...tdCell, width: 30, textAlign: 'center', color: 'var(--text-disabled)' }}>{i + 1}</td>
                  <td style={tdCell}><span className="row gap6"><Icon name="gauge" size={12} style={{ color: ix.unique ? 'var(--signal-amber)' : 'var(--text-faint)' }} /><span className="mono" style={{ fontWeight: 600 }}>{ix.name}</span></span></td>
                  <td style={tdCell}><span className="mono" style={{ color: 'var(--signal-blue)' }}>{ix.cols}</span></td>
                  <td style={tdCell}>{ix.unique ? <span className="badge-accent" style={{ background: 'color-mix(in srgb, var(--signal-amber) 16%, transparent)', color: 'var(--signal-amber)' }}>UNIQUE</span> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                  <td style={tdCell}><span className="chip mono" style={{ height: 20 }}>{ix.method}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!structErr && tab === 'fks' && (
          st.fks.length ? (
            <table style={tblStyle}>
              <thead><tr>{['', t('dbviews.fkCol'), t('dbviews.fkRef'), 'ON DELETE', 'ON UPDATE'].map((h, i) => <th key={i} style={{ ...thCell, width: i === 0 ? 36 : undefined }}>{h}</th>)}</tr></thead>
              <tbody>
                {st.fks.map((fk, i) => (
                  <tr key={i} style={{ background: i % 2 ? 'var(--surface-subtle)' : 'transparent' }}>
                    <td style={{ ...tdCell, width: 30, textAlign: 'center', color: 'var(--text-disabled)' }}>{i + 1}</td>
                    <td style={tdCell}><span className="row gap6"><Icon name="link" size={12} style={{ color: 'var(--signal-blue)' }} /><span className="mono" style={{ fontWeight: 600 }}>{fk.col}</span></span></td>
                    <td style={tdCell}><span className="mono" style={{ color: 'var(--signal-blue)' }}>{fk.ref}</span></td>
                    <td style={tdCell}><span className="chip mono" style={{ height: 20 }}>{fk.onDelete}</span></td>
                    <td style={tdCell}><span className="chip mono" style={{ height: 20 }}>{fk.onUpdate}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty icon="link" text={t('dbviews.noFks')} />
        )}
        {!structErr && tab === 'ddl' && (
          <pre className="mono" style={{ margin: 0, padding: 16, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
            dangerouslySetInnerHTML={{ __html: highlightSQL(buildCreateTableDDL(dialect, ddlQualified, st)) }} />
        )}
      </div>

      {/* Add / Modify column form — modal, mirrors the DML preview gate's visual language */}
      {form && (
        <div onClick={() => setForm(null)}
          style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 460, maxWidth: '90%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>
                {form.mode === 'add' ? t('dbviews.addColumnTitle') : t('dbviews.editColumnTitle')}
              </span>
              <IconBtn name="x" size={16} variant="bare" onClick={() => setForm(null)} />
            </div>
            <div className="col" style={{ gap: 12, padding: '16px 20px 20px' }}>
              <label className="col" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('dbviews.colName')}</span>
                <input autoFocus value={form.name} onChange={e => setForm(f => f && { ...f, name: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') submitForm() }} style={inputStyle} />
              </label>
              <label className="col" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('dbviews.colType')}</span>
                <input value={form.type} onChange={e => setForm(f => f && { ...f, type: e.target.value })}
                  placeholder="text, integer, timestamptz…"
                  onKeyDown={e => { if (e.key === 'Enter') submitForm() }} style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }} />
              </label>
              <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('dbviews.colNullable')}</span>
                <Toggle on={form.nullable} onChange={v => setForm(f => f && { ...f, nullable: v })} />
              </div>
              <label className="col" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('dbviews.colDefault')} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({t('dbviews.optional')})</span></span>
                <input value={form.default} onChange={e => setForm(f => f && { ...f, default: e.target.value })}
                  placeholder="0, 'pending', now()…"
                  onKeyDown={e => { if (e.key === 'Enter') submitForm() }} style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }} />
              </label>
              <label className="col" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('dbviews.colComment')} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({t('dbviews.optional')})</span></span>
                <input value={form.comment} onChange={e => setForm(f => f && { ...f, comment: e.target.value })}
                  placeholder={t('dbviews.colCommentPlaceholder')}
                  onKeyDown={e => { if (e.key === 'Enter') submitForm() }} style={inputStyle} />
              </label>
              <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 2 }}>
                <Btn variant="ghost" onClick={() => setForm(null)}>{t('dbviews.cancel')}</Btn>
                <Btn variant="primary" icon="arrow-right" onClick={submitForm} disabled={!form.name.trim() || !form.type.trim()}>{t('dbviews.previewSql')}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DDL preview gate — mirrors DataGrid's "Review changes" modal */}
      {preview && (
        <div onClick={() => !applying && setPreview(null)}
          style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="pop-in"
            style={{ width: 540, maxWidth: '90%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.previewTitle')}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('dbviews.previewSubtitle', { count: preview.length })}</span>
              </div>
              <IconBtn name="x" size={16} variant="bare" onClick={() => !applying && setPreview(null)} />
            </div>
            <div className="col" style={{ gap: 10, padding: '16px 20px 20px' }}>
              <pre className="mono" style={{ margin: 0, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.6, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{preview.join('\n')}</pre>
              {applyErr && (
                <div className="row gap6" style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger-fg)', fontSize: 12 }}>
                  <Icon name="alert-triangle" size={14} style={{ flex: 'none' }} />
                  <span>{applyErr}</span>
                </div>
              )}
              <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 2 }}>
                <Btn variant="ghost" onClick={() => setPreview(null)} disabled={applying}>{t('dbviews.cancel')}</Btn>
                <Btn variant="primary" icon="check" onClick={confirmApply} disabled={applying}>{applying ? t('dbviews.applying') : t('dbviews.applyChanges')}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
