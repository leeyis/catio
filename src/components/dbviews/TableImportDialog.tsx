import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReportDatabaseWork } from '../../state/databaseDraftWork'
import { useActiveDbConnections } from '../../state/dbConnections'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { importPreview, importTable, importPreviewBytes, importTableBytes, tableStructure, dbErrMsg,
  type ImportPreview, type BrowserImportFile, type ImportSummary, type ImportParseOptions } from '../../services/db'
import { isServer } from '../../services/transport'
import { autoMapImportColumns, engineSupportsImportTransaction } from './tableImport'
import { DatabaseFileFlow } from './DatabaseFileFlow'
import {defaultImportOptions, validImportOptions, importPreviewMatches, mapImportByPosition} from './importParsing'
import {ImportParsingOptions, ImportParsingSummary} from './ImportParsingOptions'

export interface TableImportDialogProps {
  connId: string
  schema?: string
  table: string
  engine?: string
  transactions?: boolean
  onClose: () => void
  onImported?: (rowsImported: number) => void
}

export function TableImportDialog(props: TableImportDialogProps) {
  // Target changes invalidate the entire review, file preparation and late callbacks.
  return <TableImportFlow key={JSON.stringify([props.connId, props.schema ?? '', props.table, props.engine])} {...props}/>
}
function TableImportFlow({ connId, schema, table, engine, transactions, onClose, onImported }: TableImportDialogProps) {
  const { t } = useTranslation()
  const active = useActiveDbConnections()
  const connectionName = active.find(c => c.connId === connId)?.name ?? connId
  const target = `${connectionName} · ${schema ? `${schema}.` : ''}${table}`
  const noRollback = !(transactions ?? engineSupportsImportTransaction(engine))
  const [step, setStep] = useState(0)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [parseOptions, setParseOptions] = useState<ImportParseOptions>()
  const [webFile, setWebFile] = useState<BrowserImportFile | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [targetColumns, setTargetColumns] = useState<{name:string;type:string}[]>([])
  const [metadata, setMetadata] = useState<'loading'|'ready'|'error'>('loading')
  const [metadataError, setMetadataError] = useState(''), [reload, setReload] = useState(0)
  const [mapping, setMapping] = useState<Record<string,string>>(()=>Object.create(null))
  const [mode, setMode] = useState<'append'|'truncate'>('append')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false), lock = useRef(false), generation = useRef(0)
  const [err, setErr] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  useEffect(() => () => { generation.current++ }, [])
  useReportDatabaseWork('import', !!filePath && step !== 3, busy)
  useEffect(() => {
    let alive = true
    setMetadata('loading'); setMetadataError(''); setTargetColumns([])
    tableStructure(connId, schema ?? '', table).then(st => {
      if (alive) { setTargetColumns(st.columns); setMetadata('ready') }
    }).catch(e => { if (alive) { setMetadata('error'); setMetadataError(dbErrMsg(e)) } })
    return () => { alive = false }
  }, [connId, schema, table, reload])
  useEffect(() => {
    if (preview) setMapping(autoMapImportColumns(preview.columns, targetColumns.map(c => c.name)))
  }, [preview, targetColumns])
  const binaryCells = useMemo(() => new Set((preview?.binaryCells ?? []).map(([r,c]) => `${r}:${c}`)), [preview])
  const pairs = (preview?.columns ?? []).map(sourceColumn => ({sourceColumn, targetColumn: mapping[sourceColumn] ?? ''})).filter(m => m.targetColumn.trim() !== '')
  const sourceUnique = !preview || new Set(preview.columns).size === preview.columns.length
  const mappingProblem = !sourceUnique ? t('dbflow.duplicateSource')
    : new Set(pairs.map(p => p.targetColumn)).size !== pairs.length ? t('dbflow.duplicateTarget')
    : pairs.some(p => !targetColumns.some(c => c.name === p.targetColumn)) ? t('dbflow.unknownTarget')
    : pairs.length === 0 ? t('dbflow.noMapping') : null
  const sourceReady = !!preview && metadata === 'ready' && targetColumns.length > 0 && sourceUnique
  const mappingReady = sourceReady && !mappingProblem && (mode !== 'truncate' || !noRollback)
  const canRun = mappingReady && (mode !== 'truncate' || confirmation === table)

  function close() { if (!lock.current) onClose() }
  async function prepare(read: () => Promise<{path:string;web?:BrowserImportFile} | null>, requested?: ImportParseOptions) {
    if (lock.current || step !== 0) return
    lock.current = true; setBusy(true); setErr(null)
    const token = ++generation.current
    try {
      const source = await read()
      if (token !== generation.current || !source) return
      // Keep the selected bytes/path after parse failure, so settings can be corrected.
      const options = requested ?? defaultImportOptions(source.path)
      setFilePath(source.path); setWebFile(source.web ?? null); setPreview(null); setParseOptions(options)
      setMapping(Object.create(null)); setConfirmation(''); setSummary(null)
      if (!validImportOptions(options)) throw new Error(t('dbimport.invalidOptions'))
      const result = source.web ? await importPreviewBytes(source.web, options) : await importPreview(source.path, options)
      if (token !== generation.current) return
      if (!importPreviewMatches(result, options)) throw new Error(t('dbimport.incompatiblePreview'))
      setPreview(result)
    } catch (error) {
      if (token === generation.current) { setPreview(null); setErr(dbErrMsg(error)) }
    } finally {
      if (token === generation.current) { lock.current = false; setBusy(false) }
    }
  }
  function changeParsing(options: ImportParseOptions) {
    if (lock.current || step !== 0) return
    generation.current++; setParseOptions(options); setPreview(null); setMapping(Object.create(null)); setConfirmation(''); setErr(null)
  }
  function reloadPreview() {
    if (!filePath || !validImportOptions(parseOptions)) return
    void prepare(async()=>({path:filePath,...(webFile?{web:webFile}:{})}), parseOptions)
  }
  function pickFile() {
    if (lock.current) return
    if (isServer()) { fileInput.current?.click(); return }
    void prepare(async () => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple:false, filters:[{name:t('dbviews.importFileFilter'),extensions:['csv','tsv','json','xlsx','xlsm','xls']}] })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return null
      return {path}
    })
  }
  function pickBrowserFile(file?: File) {
    if (!file) return
    void prepare(async () => {
      if (file.size > 8 * 1024 * 1024) throw new Error(t('dbviews.webImportLimit'))
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
      const web = {fileName:file.name, dataBase64:btoa(binary)}
      return {path:file.name, web}
    })
  }
  async function runImport() {
    if (lock.current || step !== 2 || !canRun || !filePath || !preview) return
    lock.current = true; setBusy(true); setStep(3); setErr(null)
    const token = ++generation.current
    try {
      const args = {connId, schema, table, mappings:pairs, mode, parseOptions:preview.parseOptions ?? undefined, sourceFingerprint:preview.sourceFingerprint, ...(mode === 'truncate' ? {allowDestructive:true} : {})}
      const result = webFile ? await importTableBytes({...args,...webFile}) : await importTable({...args,filePath})
      if (token !== generation.current) return
      if (!Number.isSafeInteger(result?.rowsImported) || result.rowsImported < 0) throw new Error(t('dbflow.noReceipt'))
      setSummary(result)
      // Refresh failure must not turn a confirmed write into a retryable import failure.
      try { await onImported?.(result.rowsImported) }
      catch (error) { if (token === generation.current) setRefreshError(dbErrMsg(error)) }
    } catch (error) { if (token === generation.current) setErr(dbErrMsg(error)) }
    finally { if (token === generation.current) { lock.current = false; setBusy(false) } }
  }
  const steps = [t('dbflow.source'), t('dbflow.mapping'), t('dbflow.review'), t('dbflow.receipt')]
  return <DatabaseFileFlow title={t('dbviews.importTitle')} target={target} steps={steps} step={step} busy={busy} onClose={close}
    footer={<>
      <Btn variant="ghost" disabled={busy} onClick={close}>{step === 3 ? t('dbviews.close') : t('dbviews.cancel')}</Btn>
      {step > 0 && step < 3 && <Btn variant="secondary" testId="dbflow-back" disabled={busy} onClick={() => { setStep(step-1); setConfirmation('') }}>{t('dbflow.back')}</Btn>}
      {step < 2 && <Btn variant="primary" testId="dbflow-next" disabled={busy || !(step === 0 ? sourceReady : mappingReady)} onClick={() => setStep(step+1)}>{t('dbflow.next')}</Btn>}
      {step === 2 && <Btn variant={mode === 'truncate' ? 'danger' : 'primary'} testId="dbimport-run" icon="upload" disabled={busy || !canRun} onClick={runImport}>{t('dbviews.importApply',{count:pairs.length})}</Btn>}
    </>}>
    {step === 0 && <>
      <h3>{t('dbflow.source')}</h3>
      <div className="db-flow-file"><Icon name="file" size={24}/><div><strong>{preview?.fileName ?? filePath?.split(/[\\/]/).pop() ?? t('dbflow.chooseSource')}</strong>
        <p className="db-flow-muted">{preview ? `${preview.fileType.toUpperCase()} · ${preview.sizeBytes} bytes · ${t('dbviews.importRowCount',{count:preview.totalRows})}` : t('dbviews.importSupported')}</p></div>
        <Btn size="sm" variant="secondary" icon="upload" onClick={pickFile} disabled={busy}>{t('dbviews.importChooseFile')}</Btn>
        {isServer() && <input ref={fileInput} type="file" hidden accept=".csv,.tsv,.json,.xlsx,.xlsm,.xls" data-testid="browser-import-file" onChange={e => { const file=e.currentTarget.files?.[0]; e.currentTarget.value=''; pickBrowserFile(file) }}/>}</div>
      <p className="db-flow-muted">{isServer() ? t('dbflow.webSource') : t('dbflow.desktopSource')}</p>
      {filePath && <div className="db-import-parsing">
        {parseOptions && <ImportParsingOptions value={parseOptions} onChange={changeParsing} busy={busy}/>}
        {!validImportOptions(parseOptions) && <p role="alert" className="db-flow-notice" data-danger="true">{t('dbimport.invalidOptions')}</p>}
        {!preview && <p className="db-flow-muted">{t('dbimport.previewRequired')}</p>}
        <Btn size="sm" variant="secondary" disabled={busy || !validImportOptions(parseOptions)} onClick={reloadPreview}>{t('dbimport.updatePreview')}</Btn>
      </div>}
      {busy && <p role="status">{t('dbflow.preparing')}</p>}
      {metadata === 'loading' && <p role="status" className="db-flow-muted">{t('dbflow.loadingColumns')}</p>}
      {(metadata === 'error' || (metadata === 'ready' && !targetColumns.length)) && <div className="db-flow-notice" role="alert" data-danger="true">{metadataError || t('dbflow.noTargetColumns')} <Btn size="sm" disabled={busy} onClick={() => setReload(v=>v+1)}>{t('dbflow.reloadColumns')}</Btn></div>}
      {preview && <section><h3>{t('dbviews.importPreview')}</h3><p className="db-flow-muted">{t('dbflow.previewScope',{shown:preview.rows.length,total:preview.totalRows})}</p>
        <div className="db-flow-scroll"><table><thead><tr>{preview.columns.map((c,i)=><th key={i} className="mono">{c}</th>)}</tr></thead><tbody>{preview.rows.map((row,ri)=><tr key={ri}>{preview.columns.map((_,ci)=><td key={ci} className="mono"><span className="db-flow-cell">{row[ci] == null ? 'NULL' : row[ci] === '' ? t('dbflow.emptyString') : typeof row[ci] === 'object' ? JSON.stringify(row[ci]) : String(row[ci])}</span>{binaryCells.has(`${ri}:${ci}`) && <small> HEX</small>}</td>)}</tr>)}</tbody></table></div>
        {!sourceUnique && <p role="alert" className="db-flow-notice" data-danger="true">{t('dbflow.duplicateSource')}</p>}
      </section>}
      {err && <p role="alert" className="db-flow-notice" data-danger="true">{err}</p>}
    </>}
    {step === 1 && preview && <>
      <h3>{t('dbviews.importMapping')}</h3>
      <Btn size="sm" variant="secondary" onClick={()=>{setMapping(mapImportByPosition(preview.columns,targetColumns.map(c=>c.name)));setConfirmation('')}}>{t('dbimport.byPosition')}</Btn>
      <p className="db-flow-muted">{t('dbimport.positionHint')}</p>
      <div className="db-flow-scroll"><table className="db-flow-mapping"><thead><tr><th>{t('dbviews.importSourceColumn')}</th><th>{t('dbviews.importTargetColumn')}</th></tr></thead><tbody>
        {preview.columns.map(src=><tr key={src}><td className="mono">{src}</td><td><select aria-label={t('dbflow.mapColumn',{column:src})} value={mapping[src] ?? ''} onChange={e=>setMapping(m=>({...m,[src]:e.target.value}))}>
          <option value="">{t('dbviews.importSkipColumn')}</option>{targetColumns.map(c=><option key={c.name} value={c.name}>{c.name} · {c.type}</option>)}</select></td></tr>)}
      </tbody></table></div>
      <p className="db-flow-muted">{t('dbflow.mappingCount',{mapped:pairs.length,skipped:preview.columns.length-pairs.length})}</p>
      {mappingProblem && <p role="alert" className="db-flow-notice" data-danger="true">{mappingProblem}</p>}
      <section><h3>{t('dbviews.importMode')}</h3><div className="db-flow-mode">{(['append','truncate'] as const).map(m=><button className="btn btn-secondary sm" key={m} aria-pressed={m === mode} onClick={()=>{setMode(m);setConfirmation('')}}>{m === 'append' ? t('dbviews.importModeAppend') : t('dbflow.replaceMode')}</button>)}</div>
        {mode === 'truncate' && <p className="db-flow-notice" data-danger="true">{noRollback ? t('dbviews.importAtomicUnavailable') : t('dbflow.replaceWarning')}</p>}
      </section>
    </>}
    {step === 2 && preview && <section data-testid="dbimport-review"><h3>{t('dbflow.review')}</h3>
      <dl className="db-flow-summary"><dt>{t('dbviews.importFile')}</dt><dd>{preview.fileName} · {preview.fileType.toUpperCase()}</dd><dt>{t('dbflow.target')}</dt><dd className="mono">{target}</dd><dt>{t('dbviews.importMode')}</dt><dd>{mode === 'append' ? t('dbviews.importModeAppend') : t('dbflow.replaceMode')}</dd><dt>{t('dbflow.rows')}</dt><dd>{preview.totalRows}</dd><dt>{t('dbviews.importMapping')}</dt><dd>{t('dbflow.mappingCount',{mapped:pairs.length,skipped:preview.columns.length-pairs.length})}</dd></dl>
      <div className="db-flow-scroll"><table><tbody>{pairs.map(p=><tr key={p.sourceColumn}><td className="mono">{p.sourceColumn}</td><td aria-hidden="true">→</td><td className="mono">{p.targetColumn}</td></tr>)}</tbody></table></div>
      {preview.parseOptions && <ImportParsingSummary value={preview.parseOptions}/>}
      <p className="db-flow-muted">{t('dbimport.integrity')}</p>
      <p className="db-flow-notice">{t('dbflow.importBoundary')}</p>
      {!isServer() && <p className="db-flow-muted">{t('dbflow.desktopSource')}</p>}
      {mode === 'truncate' && <><p className="db-flow-notice" data-danger="true">{t('dbflow.replaceWarning')}</p><label>{t('dbviews.importConfirmTable',{table})}<input aria-label={t('dbviews.importConfirmTable',{table})} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label></>}
    </section>}
    {step === 3 && <section className="db-flow-receipt" data-testid="dbflow-receipt" data-error={!!err} aria-live="polite">
      <Icon name={busy ? 'loader' : err ? 'alert-triangle' : 'circle-check'} size={28}/>
      <h3>{summary ? t('dbviews.importDone',{count:summary.rowsImported}) : busy ? t('dbviews.importing') : t('dbflow.unconfirmed')}</h3>
      <p className="mono">{target}</p><p>{preview?.fileName}</p>
      {busy && <p className="db-flow-notice">{t('dbflow.waitReceipt')}</p>}
      {err && <><p role="alert" className="db-flow-notice" data-danger="true">{err}</p><p className="db-flow-notice">{t('dbflow.checkTarget')}</p></>}
      {summary && <p className="db-flow-muted">{t('dbflow.importReceiptHint')}</p>}
      {refreshError && <p role="alert" className="db-flow-notice" data-danger="true">{t('dbflow.refreshFailed',{error:refreshError})}</p>}
    </section>}
  </DatabaseFileFlow>
}
