import {expect,it,vi} from 'vitest'
import {EditorState} from '@codemirror/state'
import {ensureSyntaxTree} from '@codemirror/language'
import {CompletionContext} from '@codemirror/autocomplete'
import {dialectFor} from './sqlDialect'
import {scopedSchemaCompletion} from './sqlScopeCompletion'

const schema={app:{orders:['id','note'],users:['id','name'],hidden:['secret']},audit:{orders:['audit_id']}}
async function complete(marked:string,engine='postgres',catalog=schema){
  const pos=marked.indexOf('|'),state=EditorState.create({doc:marked.replace('|',''),extensions:[dialectFor(engine).language]})
  expect(ensureSyntaxTree(state,state.doc.length,100)).not.toBeNull()
  const result=await scopedSchemaCompletion(catalog,'app',engine)(new CompletionContext(state,pos,true))
  return {result,properties:result?.options.filter(o=>o.type==='property')??[],state}
}
it.each([
  ['SELECT | FROM orders',['id','note']],
  ['SELECT * FROM orders WHERE |',['id','note']],
  ['SELECT COALESCE(|, 0) FROM orders',['id','note']],
  ['SELECT SUM(id) OVER (PARTITION BY |) FROM orders',['id','note']],
  ['WITH r AS (SELECT 1 AS public_id) SELECT | FROM r',['public_id']],
  ['SELECT | FROM (SELECT id AS public_id FROM orders) q',['public_id']],
  ['SELECT * FROM orders WHERE EXISTS (SELECT |)',['orders.id','orders.note']],
  ['SELECT * FROM orders o JOIN (SELECT |) q ON true',[]],
  ['SELECT * FROM orders o CROSS JOIN LATERAL (SELECT |) q',['o.id','o.note']],
  ['SELECT (SELECT | FROM audit.orders o) FROM orders o',['audit_id']],
  ['SELECT (SELECT | FROM missing o) FROM orders o',[]],
  ['SELECT | FROM orders o JOIN users u ON o.id=u.id',['o.id','o.note','u.id','u.name']],
  ['SELECT | FROM orders o JOIN missing m ON true',['o.id','o.note']],
  ['SELECT * FROM orders o JOIN users u ON | JOIN hidden h ON true',['o.id','o.note','u.id','u.name']],
  ['SELECT * FROM hidden h, orders o JOIN users u ON |',['o.id','o.note','u.id','u.name']],
  ['SELECT * FROM orders o, generate_series(|) g',['o.id','o.note']],
  ['SELECT * FROM generate_series(|) g, orders o',[]],
  ['SELECT * FROM orders; SELECT |',[]],
  ['SELECT * FROM orders; |',[]],
  ['SELECT id FROM orders UNION ALL SELECT | FROM audit.orders',['audit_id']],
  ['SELECT 1 AS first_col UNION ALL SELECT 2 AS second_col ORDER BY |',['first_col']],
  ['SELECT id AS public_id FROM orders ORDER BY |',['public_id','id','note']],
  ['SELECT id AS public_id FROM orders WHERE |',['id','note']],
  ['SELECT id AS public_id FROM orders GROUP BY |',['id','note','public_id']],
  ['SELECT id AS public_id FROM orders ORDER BY ABS(|)',['id','note']],
  ['SELECT id AS public_id FROM orders ORDER BY public_id + |',['id','note']],
  ['SELECT | FROM (SELECT id, id FROM orders) q',[]],
  ['SELECT * FROM orders o JOIN users u USING (|)',['id']],
  ['SELECT CAST(| AS TEXT) FROM orders',['id','note']],
  ['SELECT EXTRACT(YEAR FROM |) FROM orders',['id','note']],
])('resolves bare expression columns without a statement-wide fallback: %s',async(sql,names)=>{
  expect((await complete(sql)).properties.map(o=>o.displayLabel??o.label)).toEqual(names)
})
it.each([
  'SELECT * FROM |','SELECT * FROM orders JOIN |','SELECT id AS | FROM orders',
  'SELECT id | FROM orders','SELECT * FROM orders |','SELECT CAST(id AS |) FROM orders',
  'SELECT id FROM orders LIMIT |','WITH r(|) AS (SELECT 1) SELECT * FROM r',
  "SELECT 'id| FROM orders",'SELECT /* id| */ FROM orders',
])('does not put column candidates in a non-column slot: %s',async sql=>expect((await complete(sql)).properties).toEqual([]))
it.each([
  ['postgres',false],['sqlserver',false],['oracle',false],['mysql',true],['sqlite',true],['duckdb',true],
])('limits HAVING output aliases to known supporting dialects: %s',async(engine,alias)=>{
  const props=(await complete('SELECT COUNT(*) AS total FROM orders HAVING |',engine)).properties
  expect(props.some(o=>o.label.toLowerCase()==='total')).toBe(alias)
})
it('replaces the complete identifier at mid-word rather than leaving a suffix',async()=>{
  const {result,properties,state}=await complete('SELECT no|te FROM orders')
  const option=properties.find(o=>o.label==='note')!
  expect(option?.apply).toBe('"note"')
  expect(state.update({changes:{from:result!.from,to:result!.to??9,insert:String(option.apply)}}).state.doc.toString()).toBe('SELECT "note" FROM orders')
})
it('preserves quoted aliases and quoted column replacement bounds',async()=>{
  const {result,properties,state}=await complete('SELECT "no|te" FROM orders "odd alias"')
  expect(properties.find(o=>o.label==='note')?.apply).toBe('"note"')
  expect([result?.from,result?.to]).toEqual([7,13])
  expect(state.sliceDoc(result!.from,result!.to)).toBe('"note"')
  const multi=await complete('SELECT | FROM orders "odd alias", users u')
  expect(multi.properties.find(o=>o.displayLabel==='odd alias.note')?.apply).toBe('"odd alias"."note"')
})
it('declines over-budget metadata and star expansion instead of materializing an unbounded pool',async()=>{
  const huge={...schema,app:{...schema.app,orders:Array.from({length:5000},(_,i)=>`col_${i}`)}}
  expect((await complete('SELECT | FROM orders','postgres',huge)).result).toBeNull()
  const many={...schema,app:{...schema.app,orders:Array.from({length:1000},(_,i)=>`col_${i}`)}}
  expect((await complete('SELECT | FROM (SELECT o.*,o.*,o.*,o.* FROM orders o) q','postgres',many)).result).toBeNull()
})
it('does not read whole nested bodies to compare keyword tokens',async()=>{
  const doc=`SELECT * FROM ${'('.repeat(80)}SELECT 1${')'.repeat(80)} q`
  const state=EditorState.create({doc,extensions:[dialectFor('postgres').language]})
  ensureSyntaxTree(state,doc.length,100)
  const read=vi.spyOn(state,'sliceDoc')
  expect(await scopedSchemaCompletion(schema,'app','postgres')(new CompletionContext(state,doc.indexOf('SELECT 1')+7,true))).toBeNull()
  expect(read.mock.calls.every(([from=0,to=state.doc.length])=>to-from<=32)).toBe(true)
})
