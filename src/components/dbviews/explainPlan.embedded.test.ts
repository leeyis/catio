import { expect, it } from 'vitest'
import { parseExplainResult, supportsExplainPlan, flattenExplainPlanNodes } from './explainPlan'
import type { QueryResult } from '../../services/types'
const sqlite = (rows: unknown[][]): QueryResult => ({ columns: ['id', 'parent', 'notused', 'detail'].map(name => ({ name, type: 'text' })), rows })
it.each(['sqlite', 'duckdb', 'rqlite'] as const)('supports non-executing %s plans', engine => expect(supportsExplainPlan(engine)).toBe(true))
it('builds SQLite parent/child relations without inventing costs or cardinality', () => {
  const plan = parseExplainResult('sqlite', sqlite([[2,0,0,'SCAN orders'],[5,2,0,'SEARCH users USING INDEX user_pk (id=?)']]))
  expect(plan.nodes).toHaveLength(1)
  expect(plan.nodes[0].title).toBe('SCAN orders')
  expect(plan.nodes[0].children[0].index).toBe('user_pk')
  expect(plan.nodes[0].cost).toBeUndefined(); expect(plan.nodes[0].rows).toBeUndefined()
  expect(plan.incomplete).toBe(false)
})
it('reads named columns instead of assuming their order', () => {
  const plan = parseExplainResult('rqlite', { columns: ['detail','parent','id'].map(name=>({name,type:'text'})), rows:[['SCAN t',0,9]] })
  expect(plan.nodes[0].title).toBe('SCAN t')
})
it('does not fabricate a tree from malformed or cyclic SQLite rows', () => {
  for (const result of [sqlite([[1,2,0,'a'],[2,1,0,'b']]), { columns: [], rows: [[1]] }, sqlite([[1,0,0,'a'],[1,0,0,'b']])]) {
    expect(parseExplainResult('sqlite', result).incomplete).toBe(true)
  }
})
it('chooses DuckDB explain_value rather than its physical_plan label', () => {
  const value = JSON.stringify([{ name:'PROJECTION', extra_info:{'Estimated Cardinality':'2'}, children:[{name:'SEQ_SCAN',extra_info:{Table:'orders',Projections:['id','amount']},children:[]}] }])
  const plan = parseExplainResult('duckdb', { columns:[{name:'explain_key',type:'text'},{name:'explain_value',type:'text'}], rows:[['physical_plan',value]] })
  expect(plan.nodes[0].nodeType).toBe('PROJECTION')
  expect(plan.nodes[0].rows).toBe('2')
  expect(plan.nodes[0].children[0].relation).toBe('orders')
  expect(plan.nodes[0].cost).toBeUndefined()
  expect(flattenExplainPlanNodes(plan.nodes)).toHaveLength(2)
})
it('marks backend truncation and unknown result formats as incomplete', () => {
  expect(parseExplainResult('sqlite', { ...sqlite([[1,0,0,'SCAN t']]), truncated:true }).incomplete).toBe(true)
  expect(parseExplainResult('duckdb', { columns:[], rows:[['physical_plan','not JSON']] }).incomplete).toBe(true)
})
it('does not display MySQL select_id as estimated rows', () => {
  const plan = parseExplainResult('mysql', { columns: [{ name: 'EXPLAIN', type: 'json' }], rows: [[JSON.stringify({ query_block: { select_id: 42, table: { table_name: 't', rows_examined_per_scan: 9 } } })]] })
  expect(plan.nodes[0].rows).toBeUndefined()
  expect(plan.nodes[0].children[0].rows).toBe('9')
})
it('marks unrecognized PostgreSQL and MySQL JSON as incomplete', () => {
  for (const engine of ['postgres', 'mysql'] as const) expect(parseExplainResult(engine, { columns: [], rows: [[{ message: 'not a plan' }]] }).incomplete).toBe(true)
})
it('bounds pathological plan depth', () => {
  let root: unknown = {name:'SCAN',children:[]}
  for(let i=0;i<100;i++)root={name:'WRAP',children:[root]}
  const plan=parseExplainResult('duckdb',{columns:[{name:'explain_value',type:'text'}],rows:[[JSON.stringify([root])]]})
  expect(plan.incomplete).toBe(true)
  expect(flattenExplainPlanNodes(plan.nodes).length).toBeLessThanOrEqual(65)
})
