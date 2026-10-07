import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {ensureSyntaxTree} from '@codemirror/language'
import {sqlColumnIssues} from './sqlColumnDiagnostics'
import {sqlDiagnostics,sqlLinter,type SqlDiagnosticSchema} from './sqlDiagnostics'
import {EditorState} from '@codemirror/state'
import type {EditorView} from '@codemirror/view'
import {dialectFor} from './sqlDialect'
import i18n from '../../i18n'

const schema:SqlDiagnosticSchema={
  defaultSchema:'app',
  namespaces:[
    {name:'app',status:'loaded',tables:[{name:'orders'},{name:'customers'},{name:'generate_series'}],views:[]},
    {name:'audit',status:'loaded',tables:[{name:'orders'}],views:[]},
  ],
  columnCatalogs:{app:{orders:['id','customer_id','note','CaseName','a.b'],customers:['id','name'],generate_series:['physical_only']},audit:{orders:['audit_id']}},
}
const check=(sql:string,engine='postgres',catalog:SqlDiagnosticSchema=schema)=>sqlDiagnostics(sql,catalog,{engine}).filter(d=>d.code==='unknownColumn'||d.code==='ambiguousColumn')
// These cases test semantics, not a loaded CI worker's wall clock. The actual
// 30 ms cutoff has a separate controlled regression below; production is unchanged.
beforeEach(async()=>{await i18n.changeLanguage('en');vi.spyOn(performance,'now').mockReturnValue(0)})
afterEach(()=>vi.restoreAllMocks())
it('stops rather than guessing when the column-analysis time budget is exhausted',()=>{
  const state=EditorState.create({doc:'SELECT o.missing FROM orders o;',extensions:[dialectFor('postgres').language]})
  const tree=ensureSyntaxTree(state,state.doc.length,100)!
  let clock=0;vi.mocked(performance.now).mockImplementation(()=>clock+=31)
  expect(sqlColumnIssues(state,tree,schema,'postgres')).toEqual([expect.objectContaining({code:'limited',severity:'info'})])
})
describe('evidence-backed column diagnostics',()=>{
  it.each([
    ['SELECT o.missing FROM orders o','missing'],
    ['SELECT missing FROM orders','missing'],
    ['SELECT id FROM orders WHERE missing = 1','missing'],
    ['SELECT COALESCE(missing, 0) FROM orders','missing'],
    ['SELECT app.orders.missing FROM app.orders','missing'],
    ['SELECT o.id FROM audit.orders o','id'],
    ['SELECT o.casename FROM orders o','casename'],
    ['SELECT (SELECT o.missing) FROM orders o','missing'],
    ['SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE o.missing = c.id)','missing'],
    ['SELECT (SELECT o.id FROM audit.orders o) FROM orders o','id'],
    ['SELECT * FROM orders o CROSS JOIN LATERAL (SELECT o.missing) q','missing'],
    ['WITH r AS (SELECT o.missing FROM orders o) SELECT * FROM r','missing'],
  ])('locates an unknown physical column: %s',(sql,missing)=>{
    const ds=check(sql)
    expect(ds).toHaveLength(1);expect(ds[0].code).toBe('unknownColumn')
    expect(sql.slice(ds[0].from,ds[0].to)).toBe(missing)
    expect(ds[0].message).toContain(missing)
  })
  it.each([
    'SELECT o.id, o."CaseName", o."a.b" FROM orders o',
    'SELECT id AS output_name FROM orders ORDER BY output_name',
    'SELECT note COLLATE "C" FROM orders',
    'SELECT CAST(id AS custom_type), id::custom_type FROM orders',
    'SELECT EXTRACT(epoch FROM id) FROM orders',
    'SELECT orders FROM orders',
    'SELECT o.ctid FROM orders o',
    'SELECT o.id FROM orders o JOIN (SELECT o.missing) q ON true',
    'SELECT * FROM orders o CROSS JOIN LATERAL (SELECT later.missing) q JOIN customers later ON true',
    'SELECT o.id FROM orders o; SELECT o.missing',
    'SELECT o.id FROM orders o UNION ALL SELECT o.missing FROM customers c',
    'SELECT * FROM orders o JOIN customers c ON later.missing = o.id JOIN orders later ON true',
    'SELECT c.id FROM orders o JOIN customers c ON true, orders later WHERE c.id = 1',
    'SELECT q.unknown FROM (SELECT * FROM orders) q',
    'WITH r AS (SELECT id FROM orders) SELECT r.unknown FROM r',
    'WITH orders AS (SELECT 1 AS only_cte_column) SELECT o.missing FROM orders o',
    'SELECT (SELECT o.missing FROM unknown_table o) FROM orders o',
    'SELECT o.missing FROM orders o JOIN customers o ON true',
    'SELECT :parameter FROM orders',
    'SELECT o."a""b" FROM orders o',
    'SELECT g.missing FROM generate_series(1,3) g',
    'SELECT o.missing FROM orders o(renamed)',
    'SELECT id FROM orders o JOIN customers c USING(id)',
    'SELECT id FROM orders NATURAL JOIN customers',
    "SELECT 'o.missing', 1 /* missing */ FROM orders o -- c.missing",
    'CREATE TEMP TABLE local_t(id INT); SELECT l.missing FROM local_t l;',
    'SELECT o.missing FROM unknown_table o',
  ])('does not turn incomplete, non-column or forbidden scope into a false diagnosis: %s',sql=>expect(check(sql)).toEqual([]))
  it('reports proven local ambiguity with the available qualifiers, not for a qualified reference',()=>{
    const sql='SELECT id FROM orders o JOIN customers c ON o.customer_id = c.id'
    const ds=check(sql)
    expect(ds).toEqual([expect.objectContaining({code:'ambiguousColumn',from:7,to:9,values:{name:'id',sources:'o, c'}})])
    expect(check(sql.replace('SELECT id','SELECT o.id'))).toEqual([])
  })
  it('requires full, current column catalogs rather than interpreting an empty completion list',()=>{
    expect(check('SELECT o.missing FROM orders o','postgres',{...schema,columnCatalogs:undefined})).toEqual([])
    expect(check('SELECT o.missing FROM orders o','postgres',{...schema,columnCatalogs:{audit:{orders:['audit_id']}}})).toEqual([])
    expect(check('SELECT o.missing FROM orders o','postgres',{...schema,namespaces:[{...schema.namespaces![0],status:'loading'}]})).toEqual([])
    expect(check('SELECT o.missing FROM orders o','postgres',{...schema,namespaces:[{...schema.namespaces![0],truncated:true}]})).toEqual([])
    expect(check('SELECT missing FROM orders o JOIN customers c ON true','postgres',{...schema,columnCatalogs:{app:{orders:['id']}}})).toEqual([])
  })
  it('does not materialize unrelated catalogs just to inspect a lexical scope',()=>{
    const catalog:SqlDiagnosticSchema={defaultSchema:'app',namespaces:[{name:'app',get tables():{name:string}[]{throw new Error('unrelated catalog was enumerated')},views:[]}],columnCatalogs:{app:{}}}
    expect(check('SELECT no_source','postgres',catalog)).toEqual([])
    expect(check('SELECT 1','postgres',catalog)).toEqual([])
  })
  it('keeps dotted names and prototype-like metadata keys as identifiers, not object properties',()=>{
    const catalog:SqlDiagnosticSchema={defaultSchema:'app',namespaces:[{name:'app',tables:[{name:'a.b'},{name:'__proto__'}],views:[]}],columnCatalogs:{app:JSON.parse('{"a.b":["id"],"__proto__":["id"]}')}}
    expect(check('SELECT t.missing FROM "a.b" t','postgres',catalog)).toHaveLength(1)
    expect(check('SELECT t.id FROM "__proto__" t','postgres',catalog)).toEqual([])
    expect(check('SELECT t.missing FROM "__proto__" t','postgres',{...catalog,columnCatalogs:{app:{}}})).toEqual([])
  })
  it('honors H2 unquoted folding and quoted field identity',()=>{
    const catalog={defaultSchema:'PUBLIC',namespaces:[{name:'PUBLIC',tables:[{name:'ORDERS'}],views:[]}],columnCatalogs:{PUBLIC:{ORDERS:['ID','Mixed']}}}
    expect(check('SELECT o.id, o."Mixed" FROM orders o','h2',catalog)).toEqual([])
    expect(check('SELECT o.mixed FROM orders o','h2',catalog)).toEqual([expect.objectContaining({code:'unknownColumn',values:{name:'mixed',sources:'o'}})])
  })
  it('keeps SQL Server APPLY visibility without treating date-part names as fields',()=>{
    expect(check('SELECT * FROM orders o CROSS APPLY (SELECT o.missing) q','sqlserver')).toHaveLength(1)
    expect(check('SELECT DATEPART(day,id) FROM orders','sqlserver')).toEqual([])
  })
  it('does not flag SQLite pseudo columns or its WHERE projection aliases',()=>{
    expect(check('SELECT o.rowid, o._rowid_, o.oid FROM orders o','sqlite')).toEqual([])
    expect(check('SELECT id AS output_name FROM orders WHERE output_name > 0','sqlite')).toEqual([])
    expect(check('SELECT missing FROM orders','sqlite')).toHaveLength(1)
  })
  it('can disable catalog checks without disabling concrete lexical repairs',()=>{
    expect(sqlDiagnostics('SELECT o.missing FROM orders o',schema,{engine:'postgres',checkReferences:false})).toEqual([])
    expect(sqlDiagnostics('SELECT * FROM missing_table',schema,{engine:'postgres',checkReferences:false})).toEqual([])
    expect(sqlDiagnostics('SELECT 1；',schema,{engine:'postgres',checkReferences:false})[0].code).toBe('confusablePunctuation')
  })
  it('localizes exact field evidence and suppresses the field currently being typed',async()=>{
    const sql='SELECT o.missing FROM orders o;'
    const v=(anchor:number)=>({state:EditorState.create({doc:sql,selection:{anchor},extensions:[dialectFor('postgres').language]})}) as EditorView
    const source=sqlLinter(()=>schema,{engine:'postgres'})
    expect(source(v(12))).toEqual([])
    await i18n.changeLanguage('zh')
    expect(source(v(sql.length))[0].message).toContain('字段')
  })
})
