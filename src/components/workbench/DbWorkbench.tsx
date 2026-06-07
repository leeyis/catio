/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Segmented } from '../atoms'
import { DataGrid, StructureView, SqlConsole, ERDiagram } from '../dbviews'
import { SchemaBrowser } from './SchemaBrowser'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'

export interface DbWorkbenchProps {
  conn: Connection
  density?: 'comfortable' | 'compact'
}

export function DbWorkbench({ conn: _conn, density }: DbWorkbenchProps) {
  const { t } = useTranslation()
  const D = useData()
  // active object: a table (with data/structure sub-tab), the schema ER diagram, or a query console
  const [obj, setObj] = useState<
    | { type: 'table'; table: string }
    | { type: 'sql'; qid: number }
    | { type: 'er' }
  >({ type: 'table', table: 'orders' })
  const [tableTab, setTableTab] = useState('data') // data | structure
  const [queryN, setQueryN] = useState(1)
  const tbl = D.schema.schemas[0].tables.find(t => t.name === (obj.type === 'table' ? obj.table : ''))

  function pickTable(name: string) { setObj({ type: 'table', table: name }) }
  function newQuery() { setQueryN(n => n + 1); setObj({ type: 'sql', qid: queryN + 1 }) }
  function openER() { setObj({ type: 'er' }) }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <SchemaBrowser onPick={pickTable} active={obj.type === 'table' ? obj.table : null}
        onNewQuery={newQuery} onOpenER={openER} erActive={obj.type === 'er'} sqlActive={obj.type === 'sql'} />
      <div className="col grow" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {obj.type === 'table' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
              <div className="row gap7" style={{ minWidth: 0 }}>
                <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="table-2" size={15} /></div>
                <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
                  <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>public.{obj.table}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{tbl ? `${tbl.rows} ${t('workbench.rowsLabel')} · ${tbl.cols} ${t('workbench.colsLabel')}` : ''}</span>
                </div>
              </div>
              <Segmented value={tableTab} onChange={setTableTab} options={[
                { value: 'data', label: t('workbench.tabData'), icon: 'table-2' },
                { value: 'structure', label: t('workbench.tabStructure'), icon: 'columns' },
              ]} />
            </div>
            <div className="grow" style={{ minHeight: 0 }}>
              {tableTab === 'data' && <DataGrid columns={D.ordersColumns} rows={D.ordersRows} statusTones={D.statusTones} density={density} key={obj.table} />}
              {tableTab === 'structure' && <StructureView table={obj.table} key={obj.table} />}
            </div>
          </>
        )}
        {obj.type === 'sql' && <SqlConsole density={density} fresh queryN={obj.qid} key={'q' + obj.qid} />}
        {obj.type === 'er' && <ERDiagram onOpenTable={(tblName) => setObj({ type: 'table', table: tblName })} />}
      </div>
    </div>
  )
}
