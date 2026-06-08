import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Toggle } from '../atoms'
import { dialectFor, quoteIdent, qualifiedTable } from './structureDdl'

export interface CreateObjectModalProps {
  /** Which form to render. */
  kind: 'table' | 'view'
  /** Schema namespace the new object is created in (used for qualification). */
  schema: string
  /** Connection engine string → drives identifier quoting dialect. */
  engine?: string
  onClose: () => void
  /** Parent runs the generated DDL. */
  onCreate: (sql: string) => void
}

/** One column draft row in the CREATE TABLE form. */
interface ColRow {
  id: number
  name: string
  type: string
  nullable: boolean
  pk: boolean
  default: string
}

let colSeq = 0
function blankCol(): ColRow {
  return { id: colSeq++, name: '', type: '', nullable: true, pk: false, default: '' }
}

export function CreateObjectModal({ kind, schema, engine, onClose, onCreate }: CreateObjectModalProps) {
  const { t } = useTranslation()
  const dialect = dialectFor(engine)

  // ---- TABLE state ----
  const [tableName, setTableName] = useState('')
  const [cols, setCols] = useState<ColRow[]>(() => [blankCol()])

  // ---- VIEW state ----
  const [viewName, setViewName] = useState('')
  const [select, setSelect] = useState('')

  function addCol() { setCols(cs => [...cs, blankCol()]) }
  function removeCol(id: number) { setCols(cs => (cs.length > 1 ? cs.filter(c => c.id !== id) : cs)) }
  function patchCol(id: number, patch: Partial<ColRow>) {
    setCols(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)))
  }

  // ---- Generated DDL (live preview) ----
  const sql = useMemo(() => {
    if (kind === 'table') {
      const name = tableName.trim()
      const named = cols.filter(c => c.name.trim())
      if (!name || named.length === 0) return ''
      const qualified = qualifiedTable(dialect, schema, name)
      const defs = named.map(c => {
        const parts = [quoteIdent(dialect, c.name.trim()), c.type.trim() || 'text']
        if (!c.nullable) parts.push('NOT NULL')
        const def = c.default.trim()
        if (def) parts.push(`DEFAULT ${def}`)
        return '  ' + parts.join(' ')
      })
      const pkCols = named.filter(c => c.pk).map(c => quoteIdent(dialect, c.name.trim()))
      const body = pkCols.length
        ? [...defs, `  PRIMARY KEY (${pkCols.join(', ')})`]
        : defs
      return `CREATE TABLE ${qualified} (\n${body.join(',\n')}\n);`
    }
    // view
    const name = viewName.trim()
    const sel = select.trim()
    if (!name || !sel) return ''
    return `CREATE VIEW ${qualifiedTable(dialect, schema, name)} AS\n${sel};`
  }, [kind, tableName, cols, viewName, select, schema, dialect])

  const canCreate = sql.length > 0
  const title = kind === 'table' ? t('dbviews.createTableTitle') : t('dbviews.createViewTitle')

  const inputStyle: React.CSSProperties = {
    flex: 1, height: 34, border: '1px solid var(--border-hairline-alt)', borderRadius: 9,
    background: 'var(--surface-sunken)', color: 'var(--text-primary)', font: 'inherit',
    fontSize: 12.5, padding: '0 10px', outline: 'none',
  }
  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }

  return (
    <div onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: kind === 'table' ? 720 : 560, maxWidth: '92%', maxHeight: '88%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{title}</span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{schema}</span>
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 12, padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {kind === 'table' ? (
            <>
              <label className="col" style={{ gap: 5 }}>
                <span style={labelStyle}>{t('dbviews.tableName')}</span>
                <input autoFocus value={tableName} onChange={e => setTableName(e.target.value)} placeholder="new_table" style={inputStyle} />
              </label>

              <div className="col" style={{ gap: 6 }}>
                <span style={labelStyle}>{t('dbviews.columns')}</span>
                {/* column header row */}
                <div className="row" style={{ gap: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', padding: '0 2px' }}>
                  <span style={{ flex: 2 }}>{t('dbviews.colName')}</span>
                  <span style={{ flex: 2 }}>{t('dbviews.colType')}</span>
                  <span style={{ flex: 2 }}>{t('dbviews.colDefault')}</span>
                  <span style={{ width: 56, textAlign: 'center' }}>{t('dbviews.colNullable')}</span>
                  <span style={{ width: 40, textAlign: 'center' }}>{t('dbviews.pkLabel')}</span>
                  <span style={{ width: 24 }} />
                </div>
                {cols.map(c => (
                  <div key={c.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input value={c.name} onChange={e => patchCol(c.id, { name: e.target.value })} placeholder={t('dbviews.colName')} style={{ ...inputStyle, flex: 2 }} />
                    <input value={c.type} onChange={e => patchCol(c.id, { type: e.target.value })} placeholder="text" className="mono" style={{ ...inputStyle, flex: 2 }} />
                    <input value={c.default} onChange={e => patchCol(c.id, { default: e.target.value })} placeholder={t('dbviews.optional')} className="mono" style={{ ...inputStyle, flex: 2 }} />
                    <div style={{ width: 56, display: 'flex', justifyContent: 'center' }}>
                      <Toggle on={c.nullable} onChange={v => patchCol(c.id, { nullable: v })} size="sm" />
                    </div>
                    <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                      <input type="checkbox" checked={c.pk} title={t('dbviews.pkLabel')}
                        onChange={e => patchCol(c.id, { pk: e.target.checked, nullable: e.target.checked ? false : c.nullable })} />
                    </div>
                    <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={t('dbviews.removeColumn')} onClick={() => removeCol(c.id)} disabled={cols.length <= 1}>
                      <Icon name="x" size={13} style={{ color: 'var(--text-faint)' }} />
                    </button>
                  </div>
                ))}
                <div className="row">
                  <Btn size="sm" variant="secondary" icon="plus" onClick={addCol}>{t('dbviews.addColumn')}</Btn>
                </div>
              </div>
            </>
          ) : (
            <>
              <label className="col" style={{ gap: 5 }}>
                <span style={labelStyle}>{t('dbviews.viewName')}</span>
                <input autoFocus value={viewName} onChange={e => setViewName(e.target.value)} placeholder="new_view" style={inputStyle} />
              </label>
              <label className="col" style={{ gap: 5 }}>
                <span style={labelStyle}>{t('dbviews.selectStatement')}</span>
                <textarea value={select} onChange={e => setSelect(e.target.value)}
                  placeholder={`SELECT * FROM ${schema}.some_table`} className="mono"
                  style={{ ...inputStyle, height: 140, padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
              </label>
            </>
          )}

          {/* live SQL preview */}
          <div className="col" style={{ gap: 5 }}>
            <span style={labelStyle}>{t('dbviews.previewSql')}</span>
            <pre className="mono" style={{ margin: 0, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: sql ? 'var(--text-primary)' : 'var(--text-faint)', fontSize: 12.5, lineHeight: 1.6, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{sql || '—'}</pre>
          </div>
        </div>

        {/* footer */}
        <div className="row gap8" style={{ justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: '1px solid var(--border-hairline)', flex: 'none' }}>
          <Btn variant="ghost" onClick={onClose}>{t('dbviews.cancel')}</Btn>
          <Btn variant="primary" icon="check" onClick={() => canCreate && onCreate(sql)} disabled={!canCreate}>{t('dbviews.create')}</Btn>
        </div>
      </div>
    </div>
  )
}
