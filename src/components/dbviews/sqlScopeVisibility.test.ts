import {expect,it} from 'vitest'
import {EditorState} from '@codemirror/state'
import {ensureSyntaxTree} from '@codemirror/language'
import {CompletionContext} from '@codemirror/autocomplete'
import {schemaCompletionSource} from '@codemirror/lang-sql'
import {dialectFor} from './sqlDialect'
import {scopedSchemaCompletion} from './sqlScopeCompletion'
const schema={app:{orders:['id','note'],generate_series:['not_a_function_column'],lateral:['regular_table_column']},audit:{orders:['audit_id']}}
async function options(marked:string,engine='postgres'){
  const pos=marked.indexOf('|'),state=EditorState.create({doc:marked.replace('|',''),extensions:[dialectFor(engine).language]})
  expect(ensureSyntaxTree(state,state.doc.length,100)).not.toBeNull()
  return (await scopedSchemaCompletion(schema,'app',engine)(new CompletionContext(state,pos,true)))?.options??[]
}
it.each([
  ['WITH r AS (SELECT id AS public_id FROM app.orders) SELECT (SELECT r.|) FROM r',['public_id']],
  ['WITH orders AS (SELECT 1 AS cte_field) SELECT (SELECT o.|) FROM orders o',['cte_field']],
  ['SELECT (SELECT o.|) FROM app.orders o',['id','note']],
  ['SELECT * FROM app.orders o WHERE EXISTS (SELECT 1 FROM audit.orders a WHERE o.|)',['id','note']],
  ['SELECT (SELECT o.| FROM audit.orders o) FROM app.orders o',['audit_id']],
  ['SELECT (SELECT o.| FROM missing o) FROM app.orders o',[]],
  ['WITH d AS (SELECT o.|) SELECT * FROM app.orders o',[]],
  ['SELECT * FROM app.orders o JOIN (SELECT o.|) d ON true',[]],
  ['SELECT * FROM app.orders o JOIN ((SELECT o.|)) d ON true',[]],
  ['SELECT (SELECT * FROM (SELECT o.|) d) FROM app.orders o',['id','note']],
  ['SELECT * FROM app.orders o CROSS JOIN LATERAL (SELECT o.|) d',['id','note']],
  ['SELECT * FROM app.orders o CROSS JOIN LATERAL (SELECT later.|) d JOIN audit.orders later ON true',[]],
  ['SELECT * FROM app.orders o CROSS JOIN LATERAL (SELECT d.|) d',[]],
  ['SELECT q.| FROM app.orders o CROSS JOIN LATERAL (SELECT o.*) q',['id','note']],
  ['SELECT q.| FROM app.orders o CROSS JOIN LATERAL (SELECT *) q',[]],
  ['SELECT o.id FROM app.orders o UNION ALL SELECT o.| FROM audit.orders a',[]],
  ['SELECT o.id FROM app.orders o; SELECT o.|',[]],
  ['SELECT g.| FROM generate_series(1, 3) g',[]],
  ['SELECT * FROM app.orders o, generate_series(o.|) g',['id','note']],
  ['SELECT * FROM generate_series(later.|) g, audit.orders later',[]],
  ['SELECT * FROM generate_series((SELECT later.|)) g, audit.orders later',[]],
  ['SELECT * FROM generate_series(g.|) g(value)',[]],
  ['SELECT g.| FROM generate_series(1, 3) g(value)',['value']],
  ['SELECT o.| FROM app.orders o(renamed_id)',['renamed_id','note']],
  ['SELECT * FROM app.orders o, LATERAL generate_series(1, 3) g(value), audit.orders a WHERE a.|',['audit_id']],
  ['SELECT q.| FROM (SELECT o. FROM app.orders o) q',[]],
])('keeps query-block visibility for %s',async(sql,names)=>{
  expect((await options(sql)).map(o=>o.label)).toEqual(names)
})
it.each([
  ['SELECT * FROM app.orders o CROSS APPLY (SELECT o.|) d',['id','note']],
  ['SELECT q.| FROM app.orders o OUTER APPLY (SELECT o.*) q',['id','note']],
  ['SELECT * FROM app.orders o CROSS APPLY (SELECT later.|) d JOIN audit.orders later ON 1=1',[]],
  ['SELECT l.| FROM lateral l',['regular_table_column']],
  ['SELECT o.| FROM app.orders o (NOLOCK)',['id','note']],
  ['SELECT orders.| FROM app.orders WITH (NOLOCK)',['id','note']],
  ['SELECT orders.| FROM app.orders (NOLOCK)',['id','note']],
])('understands SQL Server APPLY/hints without borrowing function columns: %s',async(sql,names)=>{
  expect((await options(sql,'sqlserver')).map(o=>o.label)).toEqual(names)
})
it.each([
  'UPDATE app.orders o SET note=o.|',
  'INSERT INTO app.orders AS o VALUES (1,2) RETURNING o.|',
  'DELETE FROM app.orders o RETURNING o.|',
])('retains existing DML qualifier completion: %s',async marked=>{
  const pos=marked.indexOf('|'),state=EditorState.create({doc:marked.replace('|',''),extensions:[dialectFor('postgres').language]})
  expect(ensureSyntaxTree(state,state.doc.length,100)).not.toBeNull()
  const previous=await schemaCompletionSource({schema,defaultSchema:'app',dialect:dialectFor('postgres')})(new CompletionContext(state,pos,true))
  const result=await options(marked)
  expect(result.map(o=>o.label)).toEqual((previous?.options??[]).map(o=>o.label))
})
it('does not read a forbidden alias merely because a namespace has the same name',async()=>{
  const result=await options('SELECT * FROM app.orders app JOIN (SELECT app.|) q ON true')
  expect(result.map(o=>o.label)).not.toContain('id')
  expect(result.map(o=>o.label)).not.toContain('note')
})
it('keeps namespace objects available immediately after a dot',async()=>{
  expect((await options('SELECT * FROM app.|')).map(o=>o.label)).toEqual(['orders','generate_series','lateral'])
})
it('respects DuckDB implicit lateral correlation',async()=>{
  expect((await options('SELECT * FROM app.orders o, (SELECT o.|) q','duckdb')).map(o=>o.label)).toEqual(['id','note'])
  expect(await options('SELECT * FROM app.orders o, (SELECT later.|) q, audit.orders later','duckdb')).toEqual([])
})
it.each(['sqlite','postgres'])('never substitutes a physical table for a forward %s CTE',async engine=>{
  const keyword=engine==='postgres'?'RECURSIVE ':''
  expect(await options(`WITH ${keyword}first_cte AS (SELECT x.| FROM orders x), orders AS (SELECT 1 AS later_field) SELECT * FROM first_cte`,engine)).toEqual([])
})
it.each(['sqlite','sqlserver','oracle'])('keeps explicitly declared recursive self columns on %s without a RECURSIVE keyword',async engine=>{
  const result=await options('WITH r(n) AS (SELECT 1 UNION ALL SELECT r.| FROM r) SELECT * FROM r',engine)
  expect(result.map(o=>o.label)).toEqual([engine==='oracle'?'N':'n'])
})
