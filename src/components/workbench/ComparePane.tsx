/* Data Compare UI: pick a source and target table (same or different connection), fetch
 * both row sets (ordered by PK, capped) and diff them by primary key, then show the sync
 * SQL that makes the target match the source. The diff + SQL generation live in the pure,
 * unit-tested compareTables module. When the row window is truncated, DELETE generation is
 * suppressed so a partial source set can never delete real target rows. */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { runQuery, tableStructure, getSchema, execSyncBatch } from '../../services/db'
import { listActiveDbConnections } from '../../state/dbConnections'
import { computeDiff, genSyncStatements, qtable, qid } from './compareTables'
import type { SchemaNamespace } from '../../services/types'

export interface ComparePaneProps {
  /** Source connection (the active DB workbench connection). */
  connId: string
  engine?: string
  /** Source schemas/tables. */
  schemas: SchemaNamespace[]
}

const ROW_LIMIT = 5000

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 5, flex: 1, minWidth: 150 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
      {children}
    </div>
  )
}

interface Summary {
  inserts: number
  updates: number
  deletes: number
  truncated: boolean
  deleteSuppressed: boolean
}

export function ComparePane({ connId, engine, schemas }: ComparePaneProps) {
  const { t } = useTranslation()
  const actives = listActiveDbConnections()

  const [srcSchema, setSrcSchema] = useState(schemas[0]?.name ?? '')
  const [srcTable, setSrcTable] = useState('')
  const [tgtConnId, setTgtConnId] = useState(connId)
  const [tgtSchemas, setTgtSchemas] = useState<SchemaNamespace[]>(schemas)
  const [tgtSchema, setTgtSchema] = useState(schemas[0]?.name ?? '')
  const [tgtTable, setTgtTable] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [sql, setSql] = useState('')
  const [statements, setStatements] = useState<string[]>([])
  const [executing, setExecuting] = useState(false)
  const [execMsg, setExecMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const srcTables = useMemo(() => schemas.find(s => s.name === srcSchema)?.tables ?? [], [schemas, srcSchema])
  const tgtTables = useMemo(() => tgtSchemas.find(s => s.name === tgtSchema)?.tables ?? [], [tgtSchemas, tgtSchema])
  const tgtEngine = actives.find(a => a.connId === tgtConnId)?.dbType ?? engine

  // Any selection change invalidates the generated SQL, so a stale batch can never be
  // executed against a switched connection/table.
  useEffect(() => {
    setSql(''); setStatements([]); setSummary(null); setExecMsg(null)
  }, [srcSchema, srcTable, tgtConnId, tgtSchema, tgtTable])

  // Load the target connection's schemas when it changes.
  useEffect(() => {
    let cancelled = false
    if (tgtConnId === connId) { setTgtSchemas(schemas); return }
    getSchema(tgtConnId).then(s => { if (!cancelled) { setTgtSchemas(s.schemas); setTgtSchema(s.schemas[0]?.name ?? '') } }).catch(() => { if (!cancelled) setTgtSchemas([]) })
    return () => { cancelled = true }
  }, [tgtConnId, connId, schemas])

  async function compare() {
    if (!srcTable || !tgtTable || busy) return
    setBusy(true); setError(null); setSummary(null); setSql(''); setStatements([]); setExecMsg(null)
    try {
      const st = await tableStructure(connId, srcSchema, srcTable)
      const pkCols = st.columns.filter(c => c.key === 'PK').map(c => c.name)
      if (pkCols.length === 0) throw new Error(t('compare.noPk'))

      const srcOrder = pkCols.map(c => qid(c, engine)).join(', ')
      const tgtOrder = pkCols.map(c => qid(c, tgtEngine)).join(', ')
      // SQL LIMIT is ROW_LIMIT+1 but maxRows caps at ROW_LIMIT: the driver only flags
      // `truncated` when it actually sees the (ROW_LIMIT+1)-th row, so an over-limit table
      // is correctly detected (which then suppresses DELETE generation below).
      const srcQ = await runQuery(connId, `SELECT * FROM ${qtable(srcSchema, srcTable, engine)} ORDER BY ${srcOrder} LIMIT ${ROW_LIMIT + 1}`, undefined, undefined, ROW_LIMIT)
      const tgtQ = await runQuery(tgtConnId, `SELECT * FROM ${qtable(tgtSchema, tgtTable, tgtEngine)} ORDER BY ${tgtOrder} LIMIT ${ROW_LIMIT + 1}`, undefined, undefined, ROW_LIMIT)

      const diff = computeDiff({
        srcColumns: srcQ.columns.map(c => c.name),
        srcRows: srcQ.rows,
        tgtColumns: tgtQ.columns.map(c => c.name),
        tgtRows: tgtQ.rows,
        pkNames: pkCols,
      })
      if (diff.error === 'columns-mismatch') throw new Error(t('compare.colMismatch'))
      if (diff.error === 'pk-missing') throw new Error(t('compare.pkMissing'))

      const truncated = srcQ.truncated === true || tgtQ.truncated === true
      const deleteSuppressed = truncated && diff.deletes.length > 0
      setSummary({ inserts: diff.inserts.length, updates: diff.updates.length, deletes: diff.deletes.length, truncated, deleteSuppressed })
      const stmts = genSyncStatements(diff, tgtSchema, tgtTable, { engine: tgtEngine, allowDelete: !truncated })
      setStatements(stmts)
      setSql(stmts.join('\n'))
    } catch (e) {
      setError(String((e as { message?: string } | null)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  function copySql() { if (sql && navigator.clipboard) navigator.clipboard.writeText(sql).catch(() => {}) }

  async function execute() {
    if (!statements.length || executing) return
    if (!window.confirm(t('compare.confirmExec', { n: statements.length }))) return
    // Truncation suppressed DELETEs, so this only syncs the INSERT/UPDATE subset.
    const partial = summary?.deleteSuppressed ?? false
    setExecuting(true); setExecMsg(null)
    try {
      const affected = await execSyncBatch(tgtConnId, statements)
      await compare() // refresh the diff first (it resets execMsg), then report the result
      setExecMsg({ ok: true, text: t(partial ? 'compare.executedPartial' : 'compare.executed', { n: affected }) })
    } catch (e) {
      setExecMsg({ ok: false, text: t('compare.execFailed', { msg: String((e as { message?: string } | null)?.message ?? e) }) })
    } finally {
      setExecuting(false)
    }
  }

  const selectStyle: CSSProperties = { height: 32, width: '100%', boxSizing: 'border-box', padding: '0 8px', borderRadius: 8, fontSize: 12.5, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', outline: 'none', minWidth: 0 }
  const canCompare = !!srcTable && !!tgtTable && !busy

  return (
    <div className="col" style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'auto', padding: 14, gap: 14 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="git-compare" size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{t('compare.title')}</span>
      </div>

      {/* 5 labeled fields: source schema / source table / target conn / target schema / target table */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label={t('compare.srcSchema')}>
          <select value={srcSchema} onChange={e => { setSrcSchema(e.target.value); setSrcTable('') }} style={selectStyle}>
            {schemas.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.srcTable')}>
          <select value={srcTable} onChange={e => setSrcTable(e.target.value)} style={selectStyle}>
            <option value="">{t('compare.pickTable')}</option>
            {srcTables.map(tb => <option key={tb.name} value={tb.name}>{tb.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtConn')}>
          <select value={tgtConnId} onChange={e => { setTgtConnId(e.target.value); setTgtTable('') }} style={selectStyle}>
            {actives.map(a => <option key={a.connId} value={a.connId}>{a.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtSchema')}>
          <select value={tgtSchema} onChange={e => { setTgtSchema(e.target.value); setTgtTable('') }} style={selectStyle}>
            {tgtSchemas.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtTable')}>
          <select value={tgtTable} onChange={e => setTgtTable(e.target.value)} style={selectStyle}>
            <option value="">{t('compare.pickTable')}</option>
            {tgtTables.map(tb => <option key={tb.name} value={tb.name}>{tb.name}</option>)}
          </select>
        </Field>
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button onClick={() => void compare()} disabled={!canCompare}
          style={{ height: 32, padding: '0 16px', borderRadius: 8, background: 'var(--accent-primary)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: canCompare ? 'pointer' : 'default', opacity: canCompare ? 1 : 0.5 }}>
          {busy ? t('compare.comparing') : t('compare.compare')}
        </button>
        {summary && (
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--signal-green)' }}>+{summary.inserts}</span> · <span style={{ color: 'var(--signal-amber)' }}>~{summary.updates}</span> · <span style={{ color: 'var(--danger-fg, #e5484d)' }}>-{summary.deletes}</span>
            {summary.truncated && <span style={{ color: 'var(--text-faint)' }}> · {t('compare.truncated', { n: ROW_LIMIT })}</span>}
          </span>
        )}
      </div>

      {error && (
        <div className="row gap6" style={{ fontSize: 12, color: 'var(--danger-fg, #e5484d)' }}>
          <Icon name="alert-triangle" size={13} /> <span>{error}</span>
        </div>
      )}

      {summary?.deleteSuppressed && (
        <div className="row gap6" style={{ fontSize: 12, color: 'var(--signal-amber)' }}>
          <Icon name="alert-triangle" size={13} /> <span>{t('compare.deleteSuppressed', { n: summary.deletes })}</span>
        </div>
      )}

      {summary && (
        <div className="col" style={{ gap: 6, flex: 1, minHeight: 0 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('compare.syncSql')}</span>
            <div className="row gap6">
              <button onClick={() => void execute()} disabled={!sql || executing} title={t('compare.executeHint')}
                style={{ height: 26, padding: '0 12px', borderRadius: 7, border: 'none', background: 'var(--accent-primary)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: sql && !executing ? 'pointer' : 'default', opacity: sql && !executing ? 1 : 0.5 }}>
                <Icon name="play" size={12} /> {executing ? t('compare.executing') : t('compare.execute')}
              </button>
              <button onClick={copySql} disabled={!sql} style={{ height: 26, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', color: 'var(--text-secondary)', fontSize: 12, cursor: sql ? 'pointer' : 'default' }}>
                <Icon name="copy" size={12} /> {t('compare.copy')}
              </button>
            </div>
          </div>
          {execMsg && (
            <div className="row gap6" style={{ fontSize: 12, color: execMsg.ok ? 'var(--signal-green)' : 'var(--danger-fg, #e5484d)' }}>
              <Icon name={execMsg.ok ? 'check' : 'alert-triangle'} size={13} /> <span>{execMsg.text}</span>
            </div>
          )}
          <textarea readOnly value={sql || t('compare.identical')} onFocus={e => sql && e.currentTarget.select()}
            style={{ flex: 1, minHeight: 160, width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }} />
        </div>
      )}
    </div>
  )
}
