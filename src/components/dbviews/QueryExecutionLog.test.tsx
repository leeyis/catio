import {render,screen} from '@testing-library/react'
import {beforeAll,expect,it,vi} from 'vitest'
import {QueryExecutionLog,receiptRowImpact} from './QueryExecutionLog'
import i18n from '../../i18n'
beforeAll(async()=>{await i18n.changeLanguage('en')})
it.each(['CREATE VIEW v AS SELECT * FROM t','BEGIN','COMMIT','PRAGMA foreign_keys=ON','INSERT INTO t VALUES(1); CREATE VIEW v AS SELECT * FROM t'])('does not turn a stale driver changes counter into the impact of %s',sql=>{
  expect(receiptRowImpact(sql,{columns:[],rows:[],rowsAffected:4})).toBeUndefined()
})
it.each(['INSERT INTO t VALUES(1)','UPDATE t SET n=1','DELETE FROM t WHERE id=3'])('retains a DML row-impact receipt for %s',sql=>{
  expect(receiptRowImpact(sql,{columns:[],rows:[],rowsAffected:4})).toBe(4)
})
it('renders a DDL receipt without a misleading affected-rows claim and disables stale source location',()=>{
  render(<QueryExecutionLog entries={[{sql:'CREATE VIEW v AS SELECT * FROM t',result:{columns:[],rows:[],rowsAffected:4},source:{document:'old',from:0,to:10}}]} running={false} error={null} total={1} document="changed" onLocate={vi.fn()}/>)
  expect(screen.getByText('Receipt received')).toBeInTheDocument()
  expect(screen.getByText('Command returned (no row count)')).toBeInTheDocument()
  expect(screen.queryByText(/Affected 4/)).toBeNull()
  expect(screen.getByRole('button',{name:'Locate source SQL'})).toBeDisabled()
})
