/* Data Compare UI: pick a source and target table (same or different connection), fetch
 * both row sets (ordered by PK, capped) and diff them by primary key, then show the sync
 * SQL that makes the target match the source. The diff + SQL generation live in the pure,
 * unit-tested compareTables module. When the row window is truncated, DELETE generation is
 * suppressed so a partial source set can never delete real target rows. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConfirmModal } from '../modals/ConfirmModal'
import { queryPage, tableStructure, getSchema, execSyncBatch, preferredNamespace, dbErrMsg } from '../../services/db'
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
    <label className="col" style={{ gap: 5, flex: 1, minWidth: 150 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
      {children}
    </label>
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

  const [sourceNamespaces, setSourceNamespaces] = useState(schemas)
  const [sourceDefault, setSourceDefault] = useState<string>()
  const [sourceMetadataError, setSourceMetadataError] = useState<string | null>(null)
  const [targetMetadataError, setTargetMetadataError] = useState<string | null>(null)
  const sourceChosen = useRef(false)
  const targetChosen = useRef(false)
  const operation = useRef(0)
  const metadataError = [sourceMetadataError, targetMetadataError].filter(Boolean).join('; ')
  const [srcSchema, setSrcSchema] = useState(preferredNamespace(schemas.map(s => s.name)))
  const [srcTable, setSrcTable] = useState('')
  const [tgtConnId, setTgtConnId] = useState(connId)
  const [tgtSchemas, setTgtSchemas] = useState<SchemaNamespace[]>(schemas)
  const [tgtSchema, setTgtSchema] = useState(preferredNamespace(schemas.map(s => s.name)))
  const [tgtTable, setTgtTable] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [sql, setSql] = useState('')
  const [statements, setStatements] = useState<string[]>([])
  const [executing, setExecuting] = useState(false)
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null)
  const [execMsg, setExecMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const srcTables = useMemo(() => sourceNamespaces.find(s => s.name === srcSchema)?.tables ?? [], [sourceNamespaces, srcSchema])
  const tgtTables = useMemo(() => tgtSchemas.find(s => s.name === tgtSchema)?.tables ?? [], [tgtSchemas, tgtSchema])
  const tgtEngine = actives.find(a => a.connId === tgtConnId)?.dbType ?? engine

  // Any selection change invalidates the generated SQL, so a stale batch can never be
  // executed against a switched connection/table.
  useLayoutEffect(() => {
    operation.current++
    setSql(''); setStatements([]); setSummary(null); setExecMsg(null); setError(null); setBusy(false); setConfirmVersion(null)
    return () => { operation.current++ }
  }, [connId, srcSchema, srcTable, tgtConnId, tgtSchema, tgtTable])

  useEffect(() => {
    let alive = true
    setSourceMetadataError(null)
    if (!schemas.some(ns => ns.status && ns.status !== 'loaded')) { setSourceNamespaces(schemas); return }
    void getSchema(connId).then(result => {
      if (!alive) return
      setSourceNamespaces(result.schemas)
      setSourceDefault(result.defaultNamespace)
      setSrcSchema(current => preferredNamespace(result.schemas.map(ns => ns.name), sourceChosen.current ? current : undefined, result.defaultNamespace))
      const errors = result.schemas.filter(ns => ns.error).map(ns => ns.name + ': ' + ns.error)
      setSourceMetadataError(errors.length ? errors.join('; ') : null)
    }).catch(e => { if (alive) setSourceMetadataError(dbErrMsg(e)) })
    return () => { alive = false }
  }, [connId, schemas])

  // Full table pickers remain explicit consumers even when the sidebar tree is lazy.
  useEffect(() => {
    let cancelled = false
    setTargetMetadataError(null)
    if (tgtConnId === connId) {
      setTgtSchemas(sourceNamespaces)
      setTgtSchema(current => preferredNamespace(sourceNamespaces.map(ns => ns.name), targetChosen.current ? current : undefined, sourceDefault))
      return
    }
    getSchema(tgtConnId).then(result => {
      if (cancelled) return
      setTgtSchemas(result.schemas)
      setTgtSchema(current => preferredNamespace(result.schemas.map(ns => ns.name), targetChosen.current ? current : undefined, result.defaultNamespace))
      const errors = result.schemas.filter(ns => ns.error).map(ns => ns.name + ': ' + ns.error)
      setTargetMetadataError(errors.length ? errors.join('; ') : null)
    }).catch(e => { if (!cancelled) { setTgtSchemas([]); setTargetMetadataError(dbErrMsg(e)) } })
    return () => { cancelled = true }
  }, [tgtConnId, connId, sourceNamespaces, sourceDefault])

  async function compare() {
    if (!srcTable || !tgtTable || busy) return
    const version = ++operation.current
    setBusy(true); setError(null); setSummary(null); setSql(''); setStatements([]); setExecMsg(null)
    try {
      const st = await tableStructure(connId, srcSchema, srcTable)
      if (version !== operation.current) return
      const pkCols = st.columns.filter(c => c.key === 'PK').map(c => c.name)
      if (pkCols.length === 0) throw new Error(t('compare.noPk'))
      const target = await tableStructure(tgtConnId, tgtSchema, tgtTable)
      if (version !== operation.current) return
      const targetPk = target.columns.filter(c => c.key === 'PK').map(c => c.name)
      if (targetPk.length !== pkCols.length || pkCols.some(name => !targetPk.includes(name))) throw new Error(t('compare.keyMismatch'))

      const srcOrder = pkCols.map(c => qid(c, engine)).join(', ')
      const tgtOrder = pkCols.map(c => qid(c, tgtEngine)).join(', ')
      // The shared paging contract supplies dialect-aware LIMIT/OFFSET or cursor bounds
      // and checks the extra row. Never inject a MySQL-style LIMIT into SQL Server/JDBC.
      const srcQ = await queryPage(connId, `SELECT * FROM ${qtable(srcSchema, srcTable, engine)} ORDER BY ${srcOrder}`, ROW_LIMIT, 0)
      if (version !== operation.current) return
      const tgtQ = await queryPage(tgtConnId, `SELECT * FROM ${qtable(tgtSchema, tgtTable, tgtEngine)} ORDER BY ${tgtOrder}`, ROW_LIMIT, 0)
      if (version !== operation.current) return

      const diff = computeDiff({
        srcColumns: srcQ.columns.map(c => c.name), srcRows: srcQ.rows, srcBinaryCells: srcQ.binaryCells,
        tgtColumns: tgtQ.columns.map(c => c.name), tgtRows: tgtQ.rows, tgtBinaryCells: tgtQ.binaryCells,
        pkNames: pkCols,
      })
      if (diff.error) {
        const messages = { 'columns-mismatch': 'colMismatch', 'pk-missing': 'pkMissing', 'unsafe-key': 'unsafeKey', 'duplicate-key': 'duplicateKey', 'invalid-binary': 'invalidBinary' }
        throw new Error(t(`compare.${messages[diff.error]}`))
      }

      const truncated = srcQ.truncated === true || tgtQ.truncated === true
      const deleteSuppressed = truncated && diff.deletes.length > 0
      setSummary({ inserts: diff.inserts.length, updates: diff.updates.length, deletes: diff.deletes.length, truncated, deleteSuppressed })
      const stmts = genSyncStatements(diff, tgtSchema, tgtTable, { engine: tgtEngine, allowDelete: !truncated })
      setStatements(stmts)
      setSql(stmts.join('\n'))
    } catch (e) {
      if (version === operation.current) setError(dbErrMsg(e))
    } finally {
      if (version === operation.current) setBusy(false)
    }
  }

  function copySql() { if (sql && navigator.clipboard) navigator.clipboard.writeText(sql).catch(() => {}) }

  async function execute() {
    if (!statements.length || executing || confirmVersion !== operation.current) return
    setConfirmVersion(null)
    // Truncation suppressed DELETEs, so this only syncs the INSERT/UPDATE subset.
    const partial = summary?.deleteSuppressed ?? false
    const version = operation.current
    let refreshVersion = version
    setExecuting(true); setExecMsg(null)
    try {
      const affected = await execSyncBatch(tgtConnId, statements)
      if (version !== operation.current) return
      const refresh = compare()
      refreshVersion = operation.current
      await refresh
      if (refreshVersion === operation.current) setExecMsg({ ok: true, text: t(partial ? 'compare.executedPartial' : 'compare.executed', { n: affected }) })
    } catch (e) {
      if (refreshVersion === operation.current) setExecMsg({ ok: false, text: t('compare.execFailed', { msg: dbErrMsg(e) }) })
    } finally {
      setExecuting(false)
    }
  }

  const selectStyle: CSSProperties = { height: 32, width: '100%', boxSizing: 'border-box', padding: '0 8px', borderRadius: 8, fontSize: 12.5, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', outline: 'none', minWidth: 0 }
  const canCompare = !!srcTable && !!tgtTable && !busy && !executing

  return (
    <div className="col" style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'auto', padding: 14, gap: 14 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="git-compare" size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{t('compare.title')}</span>
      </div>

      {confirmVersion !== null && <div role="dialog" aria-modal="true" aria-label={t('compare.confirmTitle')}>
        <ConfirmModal title={t('compare.confirmTitle')} confirmLabel={t('compare.execute')} danger confirmIcon="play"
          message={<><p>{t('compare.confirmExec', { n: statements.length })}</p><p style={{ overflowWrap: 'anywhere' }}>{t('compare.confirmTarget', { connection: actives.find(a => a.connId === tgtConnId)?.name ?? tgtConnId, table: `${tgtSchema}.${tgtTable}` })}</p></>}
          onConfirm={() => void execute()} onCancel={() => setConfirmVersion(null)} />
      </div>}

      {/* 5 labeled fields: source schema / source table / target conn / target schema / target table */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label={t('compare.srcSchema')}>
          <select disabled={busy || executing} value={srcSchema} onChange={e => { sourceChosen.current = true; setSrcSchema(e.target.value); setSrcTable('') }} style={selectStyle}>
            {sourceNamespaces.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.srcTable')}>
          <select disabled={busy || executing} value={srcTable} onChange={e => { sourceChosen.current = true; setSrcTable(e.target.value) }} style={selectStyle}>
            <option value="">{t('compare.pickTable')}</option>
            {srcTables.map(tb => <option key={tb.name} value={tb.name}>{tb.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtConn')}>
          <select disabled={busy || executing} value={tgtConnId} onChange={e => { targetChosen.current = false; setTgtConnId(e.target.value); setTgtTable('') }} style={selectStyle}>
            {actives.map(a => <option key={a.connId} value={a.connId}>{a.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtSchema')}>
          <select disabled={busy || executing} value={tgtSchema} onChange={e => { targetChosen.current = true; setTgtSchema(e.target.value); setTgtTable('') }} style={selectStyle}>
            {tgtSchemas.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('compare.tgtTable')}>
          <select disabled={busy || executing} value={tgtTable} onChange={e => { targetChosen.current = true; setTgtTable(e.target.value) }} style={selectStyle}>
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

      {metadataError && <div role="alert" style={{padding:10,color:'var(--danger-fg)',fontSize:12}}>{metadataError}</div>}
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
              <button onClick={() => setConfirmVersion(operation.current)} disabled={!sql || executing} title={t('compare.executeHint')}
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
          <textarea aria-label={t('compare.syncSql')} readOnly value={sql || t('compare.identical')} onFocus={e => sql && e.currentTarget.select()}
            style={{ flex: 1, minHeight: 160, width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }} />
        </div>
      )}
    </div>
  )
}
