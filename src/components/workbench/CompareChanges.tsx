import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompareDiff } from './compareTables'
import { compareChanges } from './compareSelection'
import './compareChanges.css'

const PAGE_SIZE = 50
function display(value: unknown): string {
  if (value == null) return 'NULL'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}
export function CompareChanges({ diff, selected, allowDelete, disabled, onSelect }: {
  diff: CompareDiff; selected: ReadonlySet<string>; allowDelete: boolean; disabled: boolean; onSelect: (selection: Set<string>) => void
}) {
  const { t } = useTranslation()
  const changes = useMemo(() => compareChanges(diff), [diff])
  const [page, setPage] = useState(0), [active, setActive] = useState<string | null>(null)
  useEffect(() => { setPage(0); setActive(null) }, [diff])
  const pages = Math.max(1, Math.ceil(changes.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1)
  const rows = changes.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const detail = changes.find(item => item.id === active)
  const eligible = changes.filter(item => allowDelete || item.kind !== 'deletes')
  const keys = diff.pkNames.map(name => diff.colNames.indexOf(name))
  function toggle(id: string) { if (disabled) return; const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); onSelect(next) }
  return <section className="db-compare-changes" aria-label={t('compareChanges.title')}>
    <header><strong>{t('compareChanges.title')}</strong><span role="status">{t('compareChanges.count', { selected: selected.size, total: eligible.length })}</span>
      <button className="btn btn-ghost sm" disabled={disabled || !eligible.length} onClick={() => onSelect(new Set(eligible.map(item => item.id)))}>{t('compareChanges.selectAll')}</button>
      <button className="btn btn-ghost sm" disabled={disabled || !selected.size} onClick={() => onSelect(new Set())}>{t('compareChanges.clear')}</button>
    </header>
    <p className="db-compare-note">{t('compareChanges.scope')}</p>
    <div className="db-compare-scroll"><table><thead><tr><th>{t('compareChanges.include')}</th><th>{t('compareChanges.kind')}</th><th>{t('compareChanges.key')}</th><th>{t('compareChanges.details')}</th></tr></thead><tbody>
      {rows.map(item => <tr key={item.id} data-active={item.id === active}>
        <td><input type="checkbox" aria-label={t('compareChanges.selectRow', { kind: t('compareChanges.' + item.kind), n: item.ordinal + 1 })} disabled={disabled || item.kind === 'deletes' && !allowDelete} checked={selected.has(item.id)} onChange={() => toggle(item.id)}/></td>
        <td>{t('compareChanges.' + item.kind)}{item.kind === 'deletes' && !allowDelete && <small> · {t('compareChanges.suppressed')}</small>}</td>
        <td className="mono">{keys.map((c, i) => <span key={c}>{i ? ', ' : ''}{diff.pkNames[i]}={display((item.source ?? item.target)?.[c])}{(item.source ? item.sourceBinary : item.targetBinary).has(c) ? ' [HEX]' : ''}</span>)}</td>
        <td><button className="btn btn-ghost sm" aria-expanded={item.id === active} aria-label={t('compareChanges.inspectRow', { kind: t('compareChanges.' + item.kind), n: item.ordinal + 1 })} onClick={() => setActive(item.id === active ? null : item.id)}>{t('compareChanges.changed', { count: item.changedColumns.length })}</button></td>
      </tr>)}
    </tbody></table></div>
    <nav aria-label={t('compareChanges.pages')}><button className="btn btn-ghost sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('dbflow.back')}</button><span>{currentPage + 1} / {pages}</span><button className="btn btn-ghost sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{t('dbflow.next')}</button></nav>
    {detail && <div className="db-compare-scroll" role="region" aria-label={t('compareChanges.cellDiff')}><table><thead><tr><th>{t('compareChanges.column')}</th><th>{t('compareChanges.before')}</th><th>{t('compareChanges.after')}</th></tr></thead><tbody>
      {diff.colNames.map((name, c) => <tr key={c} data-changed={detail.changedColumns.includes(c)}><th className="mono">{name}{detail.changedColumns.includes(c) && <span> · {t('compareChanges.changedCell')}</span>}</th>
        <td><pre>{detail.target ? display(detail.target[c]) : t('compareChanges.missing')}</pre>{detail.targetBinary.has(c) && <small>HEX</small>}</td>
        <td><pre>{detail.source ? display(detail.source[c]) : t('compareChanges.missing')}</pre>{detail.sourceBinary.has(c) && <small>HEX</small>}</td>
      </tr>)}
    </tbody></table></div>}
  </section>
}
