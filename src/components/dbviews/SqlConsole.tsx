/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import { SqlEditor } from './SqlEditor'
import { DataGrid } from './DataGrid'

export interface SqlConsoleProps {
  density?: 'comfortable' | 'compact'
  fresh?: boolean
  queryN?: number
}

export function SqlConsole({ density, fresh, queryN }: SqlConsoleProps) {
  const { t } = useTranslation()
  const D = useData()
  const [code, setCode] = useState(
    fresh
      ? `-- ${t('dbviews.newQueryComment')} · ⌘↵ ${t('dbviews.run')}\nselect *\nfrom orders\nwhere status = 'pending'\nlimit 100;`
      : D.sampleSQL
  )
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>(fresh ? 'idle' : 'done')

  function run() {
    setPhase('running')
    setTimeout(() => setPhase('done'), 450)
  }

  useEffect(() => {
    const h = (e: Event) => {
      const ce = e as CustomEvent
      if (!ce.detail || ce.detail.kind !== 'sql') return
      setCode(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' : '') + ce.detail.text)
    }
    window.addEventListener('catio-insert', h)
    return () => window.removeEventListener('catio-insert', h)
  }, [])

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      {/* console toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
        <div className="row gap8">
          <span className="chip" style={{ background: 'var(--surface-sunken)' }}><Icon name="file-code" size={12} /> query-{queryN || 1}.sql</span>
          <span className="chip" style={{ background: 'var(--accent-soft-alt)', color: 'var(--accent-primary)' }}><Icon name="link" size={11} /> {t('dbviews.viaTunnel')}</span>
        </div>
        <div className="row gap6">
          <button className="icon-btn bare" title={t('dbviews.format')}><Icon name="wrench" size={15} /></button>
          <button className="icon-btn bare" title={t('dbviews.clear')} onClick={() => setCode('')}><Icon name="eraser" size={15} /></button>
          <div style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
          <Btn size="sm" variant="primary" icon={phase === 'running' ? 'loader' : 'play'} onClick={run}>
            {phase === 'running' ? t('dbviews.running') : t('dbviews.run')} <span style={{ opacity: .6, fontSize: 10, marginLeft: 2 }}>⌘↵</span>
          </Btn>
        </div>
      </div>
      {/* editor */}
      <div style={{ flex: 'none', height: 188, borderBottom: '1px solid var(--border-hairline)' }}>
        <SqlEditor code={code} onChange={setCode} />
      </div>
      {/* results */}
      <div className="grow" style={{ minHeight: 0 }}>
        {phase === 'running'
          ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--text-tertiary)' }}>
              <Icon name="loader" size={26} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>{t('dbviews.executingOn')}</span>
            </div>
          : phase === 'idle'
          ? <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-faint)' }}>
              <Icon name="play-circle" size={28} />
              <span style={{ fontSize: 13 }}>{t('dbviews.runToSeeResults')}</span>
              <span style={{ fontSize: 11.5 }}>{t('dbviews.runHint')}</span>
            </div>
          : <DataGrid
              columns={D.ordersColumns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk }))}
              rows={D.ordersRows.map(r => D.ordersColumns.map(c => (r as unknown as Record<string, unknown>)[c.name]))}
              statusTones={D.statusTones} density={density} />}
      </div>
    </div>
  )
}
