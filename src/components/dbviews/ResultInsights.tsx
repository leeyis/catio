import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QueryResult } from '../../services/types'
import { INSIGHT_ROW_LIMIT, INSIGHT_COLUMN_LIMIT, profileResult, resultFrequencies } from './resultInsightAnalysis'
import './resultInsights.css'

/** Read-only, bounded analysis of the execution snapshot. It never queries or edits the database. */
export function ResultInsights({ result }: { result: QueryResult }) {
  const { t } = useTranslation()
  const [view, setView] = useState<'transpose'|'profile'|'chart'>('profile')
  const [page, setPage] = useState(0), [column, setColumn] = useState(0)
  const count = Math.min(result.rows.length, INSIGHT_ROW_LIMIT), cols = result.columns.slice(0, INSIGHT_COLUMN_LIMIT)
  const rowStart = Math.min(page, Math.max(0, Math.ceil(count / 10) - 1)) * 10
  const profiles = useMemo(() => profileResult(result), [result])
  const frequencies = useMemo(() => resultFrequencies(result, column), [result, column])
  const binary = useMemo(() => new Set((result.binaryCells ?? []).map(([r,c]) => `${r}:${c}`)), [result])
  const display = (value: unknown) => value == null ? 'NULL' : typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const max = Math.max(1, ...frequencies.items.map(item => item.count), frequencies.other)
  return <section className="db-result-insights" aria-label={t('resultInsights.title')}>
    <nav aria-label={t('resultInsights.views')}>{(['profile','transpose','chart'] as const).map(mode => <button className="btn btn-secondary sm" key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{t('resultInsights.' + mode)}</button>)}</nav>
    <p className="db-insight-note">{t('resultInsights.scope', { rows:count, columns:cols.length, totalRows:result.rows.length, totalColumns:result.columns.length })}{result.truncated && <> {t('resultInsights.truncated')}</>}</p>
    {view === 'profile' && <><p className="db-insight-note">{t('resultInsights.numericBoundary')}</p><div className="db-insight-scroll"><table><thead><tr>
      {['column','type','nulls','empty','binary','numbers','min','max'].map(key => <th key={key}>{t('resultInsights.' + key)}</th>)}
    </tr></thead><tbody>{profiles.map(p => <tr key={p.index}><th className="mono">{p.index + 1}. {p.name}</th><td>{p.type}</td><td>{p.nulls}</td><td>{p.empty}</td><td>{p.binary}</td><td>{p.numbers}</td><td>{p.min ?? '—'}</td><td>{p.max ?? '—'}</td></tr>)}</tbody></table></div></>}
    {view === 'transpose' && <>
      <nav><button className="btn btn-ghost sm" disabled={rowStart === 0} onClick={() => setPage(page - 1)}>{t('dbflow.back')}</button><span>{count ? rowStart + 1 : 0}–{Math.min(count, rowStart + 10)} / {count}</span><button className="btn btn-ghost sm" disabled={rowStart + 10 >= count} onClick={() => setPage(page + 1)}>{t('dbflow.next')}</button></nav>
      <div className="db-insight-scroll"><table><thead><tr><th>{t('resultInsights.column')}</th>{result.rows.slice(rowStart, Math.min(count, rowStart + 10)).map((_, i) => <th key={i}>{t('resultInsights.row', { n:rowStart + i + 1 })}</th>)}</tr></thead><tbody>
        {cols.map((col,c) => <tr key={c}><th className="mono">{c + 1}. {col.name}<small> · {col.type}</small></th>{result.rows.slice(rowStart, Math.min(count, rowStart + 10)).map((row,i) => <td key={i}><pre>{display(row[c])}</pre>{binary.has(`${rowStart + i}:${c}`) && <small>HEX</small>}</td>)}</tr>)}
      </tbody></table></div>
    </>}
    {view === 'chart' && <>
      <label className="db-insight-column">{t('resultInsights.column')}<select aria-label={t('resultInsights.chartColumn')} value={column} onChange={e => setColumn(Number(e.target.value))}>{cols.map((col,i) => <option value={i} key={i}>{i + 1}. {col.name}</option>)}</select></label>
      <p className="db-insight-note">{t('resultInsights.chartScope', { skipped:frequencies.skipped })}</p>
      <div className="db-frequency-chart" role="img" aria-label={t('resultInsights.chartLabel')}>
        {frequencies.items.map((item,i) => <div key={i} className="db-frequency-row"><span title={item.label} className="mono">{item.label}</span><div><i style={{ width:`${item.count / max * 100}%` }}/></div><b>{item.count}</b></div>)}
        {frequencies.other > 0 && <div className="db-frequency-row"><span>{t('resultInsights.other')}</span><div><i style={{ width:`${frequencies.other / max * 100}%` }}/></div><b>{frequencies.other}</b></div>}
        {!frequencies.items.length && <p>{t('resultInsights.noChart')}</p>}
      </div>
    </>}
  </section>
}
