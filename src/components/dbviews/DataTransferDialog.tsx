import { useReportDatabaseWork } from '../../state/databaseDraftWork'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { transferTable, tableStructure, getSchema, dbErrMsg, type TransferMode } from '../../services/db'
import { autoMapImportColumns } from './tableImport'
import { availableTransferModes, transferReady } from './dataTransfer'
import { DatabaseFileFlow } from './DatabaseFileFlow'

export interface TransferConnectionOption { id: string; name: string; engine?: string }
export interface DataTransferDialogProps {
  connections: TransferConnectionOption[]
  initialSourceConnId: string
  initialSourceSchema?: string
  initialSourceTable: string
  onClose: () => void
  onTransferred?: (rowsTransferred: number) => void
}
type Structure = Awaited<ReturnType<typeof tableStructure>>
const fingerprint = (value: Structure) => JSON.stringify({ columns: value.columns, indexes: value.indexes, fks: value.fks })

/** Data-only copy into an existing table. A reviewed UI is not a server-side structure plan. */
export function DataTransferDialog(props: DataTransferDialogProps) {
  return <DataTransferFlow key={JSON.stringify([props.initialSourceConnId, props.initialSourceSchema, props.initialSourceTable])} {...props}/>
}
function DataTransferFlow({ connections, initialSourceConnId, initialSourceSchema, initialSourceTable, onClose, onTransferred }: DataTransferDialogProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [targetConnId, setTargetConnId] = useState(''), [targetSchema, setTargetSchema] = useState(''), [targetTable, setTargetTable] = useState('')
  const [namespaces, setNamespaces] = useState<{ name: string; tables: string[] }[]>([])
  const [source, setSource] = useState<Structure | null>(null), [target, setTarget] = useState<Structure | null>(null)
  const [sourceError, setSourceError] = useState(''), [targetError, setTargetError] = useState(''), [namespaceError, setNamespaceError] = useState('')
  const [loadingSource, setLoadingSource] = useState(true), [loadingTarget, setLoadingTarget] = useState(false), [loadingNamespaces, setLoadingNamespaces] = useState(false)
  const [reload, setReload] = useState(0)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<TransferMode>('append'), [upsertKeys, setUpsertKeys] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false), lock = useRef(false), sent = useRef(false), mounted = useRef(true)
  const [err, setErr] = useState<string | null>(null), [summary, setSummary] = useState<number | null>(null), [refreshError, setRefreshError] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useReportDatabaseWork('transfer', !!targetTable && summary == null, busy)
  const engine = connections.find(c => c.id === targetConnId)?.engine
  const modes = useMemo(() => availableTransferModes(engine), [engine])
  const sourceLabel = `${connections.find(c => c.id === initialSourceConnId)?.name ?? initialSourceConnId} · ${initialSourceSchema ? initialSourceSchema + '.' : ''}${initialSourceTable}`
  const targetLabel = `${connections.find(c => c.id === targetConnId)?.name ?? targetConnId} · ${targetSchema ? targetSchema + '.' : ''}${targetTable}`
  useEffect(() => { if (!modes.includes(mode)) setMode('append') }, [mode, modes])
  useEffect(() => {
    let alive = true
    setSource(null); setLoadingSource(true); setSourceError('')
    tableStructure(initialSourceConnId, initialSourceSchema ?? '', initialSourceTable)
      .then(st => { if (alive) setSource(st) })
      .catch(e => { if (alive) setSourceError(dbErrMsg(e)) })
      .finally(() => { if (alive) setLoadingSource(false) })
    return () => { alive = false }
  }, [initialSourceConnId, initialSourceSchema, initialSourceTable, reload])
  useEffect(() => {
    let alive = true
    setNamespaces([]); setTargetSchema(''); setTargetTable(''); setNamespaceError('')
    if (!targetConnId) { setLoadingNamespaces(false); return }
    setLoadingNamespaces(true)
    getSchema(targetConnId).then(result => {
      if (!alive) return
      setNamespaceError(result.schemas.filter(ns => ns.error).map(ns => `${ns.name}: ${ns.error}`).join('; '))
      // Never offer an errored namespace as if its incomplete table list were authoritative.
      const options = result.schemas.filter(ns => !ns.error).map(ns => ({ name: ns.name, tables: ns.tables.map(tb => tb.name) }))
      setNamespaces(options); setTargetSchema(options.length === 1 ? options[0].name : '')
    }).catch(e => { if (alive) setNamespaceError(dbErrMsg(e)) }).finally(() => { if (alive) setLoadingNamespaces(false) })
    return () => { alive = false }
  }, [targetConnId, reload])
  useEffect(() => {
    let alive = true
    setTarget(null); setTargetError(''); setMapping({}); setUpsertKeys([]); setConfirmation('')
    if (!targetConnId || !targetTable) { setLoadingTarget(false); return }
    setLoadingTarget(true)
    tableStructure(targetConnId, targetSchema, targetTable).then(st => { if (alive) setTarget(st) })
      .catch(e => { if (alive) setTargetError(dbErrMsg(e)) }).finally(() => { if (alive) setLoadingTarget(false) })
    return () => { alive = false }
  }, [targetConnId, targetSchema, targetTable, reload])
  useEffect(() => {
    setMapping(source && target ? autoMapImportColumns(source.columns.map(c => c.name), target.columns.map(c => c.name)) : {})
  }, [source, target])
  const pairs = (source?.columns ?? []).map(c => ({ sourceColumn: c.name, targetColumn: mapping[c.name] ?? '' })).filter(p => p.targetColumn !== '')
  const sameTable = targetConnId === initialSourceConnId && targetTable === initialSourceTable && (!initialSourceSchema || targetSchema === initialSourceSchema)
  const sourceReady = !!source?.columns.length && !!target?.columns.length && !!targetConnId && !!targetTable && !sameTable && !loadingSource && !loadingTarget && !loadingNamespaces
  const mappingError = new Set(pairs.map(p => p.targetColumn)).size !== pairs.length ? t('dbflow.duplicateTarget')
    : pairs.some(p => !target?.columns.some(c => c.name === p.targetColumn)) ? t('dbflow.unknownTarget')
    : !pairs.length ? t('dbflow.noMapping') : null
  const mappingReady = sourceReady && !mappingError && transferReady({ targetTable, mapping, mode, upsertKeys })
  const canRun = mappingReady && (mode !== 'overwrite' || confirmation === targetTable)
  const modeLabel = (value: TransferMode) => t(value === 'append' ? 'dbviews.importModeAppend' : value === 'overwrite' ? 'dbviews.importModeTruncate' : 'dbviews.transferModeUpsert')
  function close() { if (!lock.current) onClose() }
  function back() { if (lock.current || sent.current) return; setStep(current => current - 1); setConfirmation(''); setErr(null) }
  async function run() {
    if (lock.current || sent.current || step !== 2 || !canRun || !source || !target) return
    lock.current = true; setBusy(true); setErr(null); setStep(3)
    try {
      // Recheck the reviewed metadata immediately before dispatch. This does not lock out concurrent DDL.
      const [freshSource, freshTarget] = await Promise.all([
        tableStructure(initialSourceConnId, initialSourceSchema ?? '', initialSourceTable), tableStructure(targetConnId, targetSchema, targetTable),
      ])
      if (!mounted.current) return
      if (fingerprint(freshSource) !== fingerprint(source) || fingerprint(freshTarget) !== fingerprint(target)) {
        setErr(t('dbTransfer.metadataChanged')); setStep(0); setConfirmation(''); setReload(v => v + 1); return
      }
      sent.current = true
      const result = await transferTable({
        sourceConnId: initialSourceConnId, sourceSchema: initialSourceSchema || undefined, sourceTable: initialSourceTable,
        targetConnId, targetSchema: targetSchema || undefined, targetTable, mappings: pairs, mode,
        upsertKeys: mode === 'upsert' ? upsertKeys : undefined, allowDestructive: mode === 'overwrite' ? true : undefined,
      })
      if (!mounted.current) return
      if (!Number.isSafeInteger(result?.rowsTransferred) || result.rowsTransferred < 0) throw new Error(t('dbflow.noReceipt'))
      setSummary(result.rowsTransferred)
      try { await onTransferred?.(result.rowsTransferred) } catch { if (mounted.current) setRefreshError(true) }
    } catch (error) {
      if (mounted.current) {
        setErr(dbErrMsg(error))
        if (!sent.current) setStep(2)
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  return <DatabaseFileFlow title={t('dbviews.transferTitle')} target={`${sourceLabel}${targetTable ? ' → ' + targetLabel : ''}`}
    steps={[t('dbflow.target'), t('dbflow.mapping'), t('dbflow.review'), t('dbflow.receipt')]} step={step} busy={busy} onClose={close}
    footer={<>
      <Btn variant="ghost" disabled={busy} onClick={close}>{t(step === 3 ? 'dbviews.close' : 'dbviews.cancel')}</Btn>
      {step > 0 && step < 3 && <Btn variant="secondary" disabled={busy} onClick={back}>{t('dbflow.back')}</Btn>}
      {step < 2 && <Btn variant="primary" disabled={busy || !(step === 0 ? sourceReady : mappingReady)} onClick={() => { setStep(step + 1); setErr(null) }}>{t('dbflow.next')}</Btn>}
      {step === 2 && <Btn variant={mode === 'overwrite' ? 'danger' : 'primary'} icon="arrow-up-down" disabled={busy || !canRun} onClick={() => void run()}>{t('dbviews.transferApply', { count: pairs.length })}</Btn>}
    </>}>
    {step === 0 && <>
      <h3>{t('dbviews.transferSource')}</h3><p className="mono">{sourceLabel}</p>
      <h3>{t('dbviews.transferTarget')}</h3>
      <div className="col gap12">
        <label>{t('dbviews.transferSelectConnection')}<select aria-label="transfer-target-conn" value={targetConnId} onChange={e => { setTargetConnId(e.target.value); setNamespaces([]); setTargetSchema(''); setTargetTable(''); setTarget(null) }}>
          <option value="">{t('dbviews.transferSelectConnection')}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label>{t('dbviews.transferSchema')}<select aria-label="transfer-target-schema" value={targetSchema} disabled={!namespaces.length} onChange={e => { setTargetSchema(e.target.value); setTargetTable(''); setTarget(null) }}>
          <option value="">{t('dbviews.transferSchema')}</option>{namespaces.map(ns => <option key={ns.name} value={ns.name}>{ns.name}</option>)}
        </select></label>
        <label>{t('dbviews.transferSelectTable')}<select aria-label="transfer-target-table" value={targetTable} disabled={loadingNamespaces || !namespaces.length} onChange={e => { setTargetTable(e.target.value); setTarget(null) }}>
          <option value="">{t('dbviews.transferSelectTable')}</option>{(namespaces.find(ns => ns.name === targetSchema)?.tables ?? []).map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
      </div>
      {(loadingSource || loadingTarget || loadingNamespaces) && <p role="status">{t('dbflow.loadingColumns')}</p>}
      {[sourceError, targetError, namespaceError, sameTable ? t('dbTransfer.sameTable') : ''].filter(Boolean).map((text, i) => <p key={i} role="alert" className="db-flow-notice" data-danger="true">{text}</p>)}
      {!loadingSource && !loadingTarget && (source?.columns.length === 0 || target?.columns.length === 0) && <p role="alert">{t('dbflow.noTargetColumns')}</p>}
      <Btn variant="secondary" disabled={loadingSource || loadingTarget || loadingNamespaces} onClick={() => setReload(n => n + 1)}>{t('dbflow.reloadColumns')}</Btn>
      <p className="db-flow-notice">{t('dbTransfer.dataOnly')}</p>
    </>}
    {step === 1 && <>
      <h3>{t('dbviews.importMapping')}</h3>
      <div className="db-flow-scroll"><table className="db-flow-mapping"><thead><tr><th>{t('dbviews.importSourceColumn')}</th><th>{t('dbviews.importTargetColumn')}</th></tr></thead><tbody>
        {source?.columns.map(c => <tr key={c.name}><td className="mono">{c.name}<small> · {c.type}</small></td><td><select aria-label={`map-${c.name}`} value={mapping[c.name] ?? ''} onChange={e => { setMapping(m => ({ ...m, [c.name]: e.target.value })); setUpsertKeys([]) }}>
          <option value="">{t('dbviews.importSkipColumn')}</option>{target?.columns.map(tc => <option key={tc.name} value={tc.name}>{tc.name} · {tc.type}</option>)}
        </select></td></tr>)}
      </tbody></table></div>
      <p className="db-flow-muted">{t('dbflow.mappingCount', { mapped: pairs.length, skipped: (source?.columns.length ?? 0) - pairs.length })}</p>
      {mappingError && <p role="alert" className="db-flow-notice" data-danger="true">{mappingError}</p>}
      <h3>{t('dbviews.importMode')}</h3><div className="db-flow-mode">{modes.map(value => <button key={value} className="btn btn-secondary sm" aria-pressed={mode === value} onClick={() => { setMode(value); setConfirmation('') }}>{modeLabel(value)}</button>)}</div>
      {mode === 'overwrite' && <p className="db-flow-notice" data-danger="true">{t('dbviews.transferOverwriteWarn')}</p>}
      {mode === 'upsert' && <section><h3>{t('dbviews.transferUpsertKeys')}</h3><p className="db-flow-muted">{t('dbviews.transferUpsertKeysHint')}</p><div className="db-flow-mode">
        {[...new Set(pairs.map(p => p.targetColumn))].map(col => <button key={col} aria-label={`upsert-key-${col}`} className="btn btn-secondary sm" aria-pressed={upsertKeys.includes(col)} onClick={() => setUpsertKeys(keys => keys.includes(col) ? keys.filter(k => k !== col) : [...keys, col])}>{col}</button>)}
      </div></section>}
    </>}
    {step === 2 && <section data-testid="dbtransfer-review">
      <h3>{t('dbflow.review')}</h3><dl className="db-flow-summary">
        <dt>{t('dbviews.transferSource')}</dt><dd className="mono">{sourceLabel}</dd><dt>{t('dbviews.transferTarget')}</dt><dd className="mono">{targetLabel}</dd>
        <dt>{t('dbviews.importMode')}</dt><dd>{modeLabel(mode)}</dd>
        {mode === 'upsert' && <><dt>{t('dbviews.transferUpsertKeys')}</dt><dd>{upsertKeys.join(', ')}</dd></>}
      </dl>
      <div className="db-flow-scroll"><table><thead><tr><th>{t('dbviews.importSourceColumn')}</th><th>{t('dbviews.importTargetColumn')}</th></tr></thead><tbody>{pairs.map(p => <tr key={p.sourceColumn}><td className="mono">{p.sourceColumn}</td><td className="mono">{p.targetColumn}</td></tr>)}</tbody></table></div>
      <p className="db-flow-notice">{t('dbTransfer.boundary')}</p>
      {mode === 'overwrite' && <><p className="db-flow-notice" data-danger="true">{t('dbviews.transferOverwriteWarn')}</p><label>{t('dbviews.transferOverwriteConfirmHint', { table: targetTable })}<input aria-label="transfer-destructive-confirm" value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label></>}
    </section>}
    {step === 3 && <section className="db-flow-receipt" aria-live="polite" data-error={!!err}>
      <Icon name={busy ? 'loader' : summary != null ? 'circle-check' : 'alert-triangle'} size={28}/>
      <h3>{busy ? t('dbviews.transferring') : summary != null ? t('dbviews.transferDone', { count: summary }) : t('dbTransfer.unconfirmed')}</h3>
      <p className="mono">{sourceLabel} → {targetLabel}</p>
      {busy && <p role="status">{t('dbflow.waitReceipt')}</p>}
      {!busy && summary == null && <p className="db-flow-notice" data-danger="true">{t('dbviews.transferCheckOutcome')}</p>}
      {summary != null && <p className="db-flow-muted">{t('dbTransfer.receiptScope')}</p>}
      {refreshError && <p role="alert" className="db-flow-notice">{t('dbviews.transferRefreshFailed')}</p>}
    </section>}
    {err && <p role="alert" className="db-flow-notice" data-danger="true">{err}</p>}
  </DatabaseFileFlow>
}
