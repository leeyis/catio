/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7 */
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, Segmented } from '../atoms'
import { useData } from '../../state/DataContext'
import { highlightSQL } from './highlightSQL'

export interface StructureViewProps {
  table: string
}

const tblStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }
const thCell: React.CSSProperties = { textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)', borderBottom: '1px solid var(--border-hairline-alt)', position: 'sticky', top: 0, background: 'var(--surface-subtle)', zIndex: 1 }
const tdCell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', color: 'var(--text-secondary)', verticalAlign: 'middle' }

function buildDDL(table: string, st: ReturnType<typeof useData>['tableStructures'][string]) {
  const cols = st.columns.map(c => `  ${c.name.padEnd(16)} ${c.type}${c.nullable ? '' : ' not null'}${c.default ? ' default ' + c.default : ''}${c.key === 'PK' ? ' primary key' : ''}`).join(',\n')
  const fks = st.fks.map(fk => `  foreign key (${fk.col}) references ${fk.ref} on delete ${fk.onDelete}`).join(',\n')
  return `create table public.${table} (\n${cols}${fks ? ',\n' + fks : ''}\n);\n\n${st.indexes.filter(i => !i.name.endsWith('pkey')).map(i => `create ${i.unique ? 'unique ' : ''}index ${i.name} on public.${table} using ${i.method} (${i.cols});`).join('\n')}`
}

function Empty({ icon, text }: { icon: string; text: string }) {
  return <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-faint)' }}><Icon name={icon} size={26} /><span style={{ fontSize: 13 }}>{text}</span></div>
}

export function StructureView({ table }: StructureViewProps) {
  const { t } = useTranslation()
  const D = useData()
  const st = D.tableStructures[table] || D.tableStructures['orders']
  const [tab, setTab] = useState('columns')
  const keyTone: Record<string, string> = { PK: 'var(--signal-amber)', FK: 'var(--signal-blue)', UNI: 'var(--signal-violet)' }

  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8, flex: 'none' }}>
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: 'columns', label: `${t('dbviews.tabColumns')} (${st.columns.length})` },
          { value: 'indexes', label: `${t('dbviews.tabIndexes')} (${st.indexes.length})` },
          { value: 'fks', label: `${t('dbviews.tabFks')} (${st.fks.length})` },
          { value: 'ddl', label: 'DDL' },
        ]} />
        <div className="grow" />
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{st.comment}</span>
        <Btn size="sm" variant="secondary" icon="plus">{t('dbviews.addColumn')}</Btn>
      </div>
      <div className="grow" style={{ overflow: 'auto' }}>
        {tab === 'columns' && (
          <table style={tblStyle}>
            <thead><tr>
              {['', t('dbviews.colName'), t('dbviews.colType'), t('dbviews.colNullable'), t('dbviews.colDefault'), t('dbviews.colKey'), t('dbviews.colComment')].map((h, i) => (
                <th key={i} style={{ ...thCell, textAlign: i === 3 ? 'center' : 'left' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {st.columns.map((c, i) => (
                <tr key={c.name} className="structrow" style={{ background: i % 2 ? 'var(--surface-subtle)' : 'transparent' }}>
                  <td style={{ ...tdCell, width: 30, color: 'var(--text-disabled)', textAlign: 'center' }}>{i + 1}</td>
                  <td style={tdCell}><span className="row gap6"><Icon name={c.key === 'PK' ? 'key' : c.key === 'FK' ? 'link' : 'hash'} size={12} style={{ color: c.key ? keyTone[c.key] : 'var(--text-disabled)' }} /><span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span></span></td>
                  <td style={tdCell}><span className="mono" style={{ color: 'var(--signal-blue)' }}>{c.type}</span></td>
                  <td style={{ ...tdCell, textAlign: 'center' }}>{c.nullable ? <span style={{ color: 'var(--text-faint)' }}>NULL</span> : <Icon name="check" size={13} style={{ color: 'var(--signal-green)' }} />}</td>
                  <td style={tdCell}><span className="mono" style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>{c.default || '—'}</span></td>
                  <td style={tdCell}>{c.key ? <span className="badge-accent" style={{ background: `color-mix(in srgb, ${keyTone[c.key]} 16%, transparent)`, color: keyTone[c.key] }}>{c.key}</span> : ''}</td>
                  <td style={{ ...tdCell, color: 'var(--text-faint)', fontSize: 11.5 }}>{c.extra}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'indexes' && (
          <table style={tblStyle}>
            <thead><tr>{['', t('dbviews.idxName'), t('dbviews.idxCols'), t('dbviews.idxUnique'), t('dbviews.idxMethod')].map((h, i) => <th key={i} style={thCell}>{h}</th>)}</tr></thead>
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
        {tab === 'fks' && (
          st.fks.length ? (
            <table style={tblStyle}>
              <thead><tr>{['', t('dbviews.fkCol'), t('dbviews.fkRef'), 'ON DELETE', 'ON UPDATE'].map((h, i) => <th key={i} style={thCell}>{h}</th>)}</tr></thead>
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
        {tab === 'ddl' && (
          <pre className="mono" style={{ margin: 0, padding: 16, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
            dangerouslySetInnerHTML={{ __html: highlightSQL(buildDDL(table, st)) }} />
        )}
      </div>
    </div>
  )
}
