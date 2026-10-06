import {beforeEach,describe,expect,it} from 'vitest'
import {EditorState} from '@codemirror/state'
import type {EditorView} from '@codemirror/view'
import {sqlDiagnostics,sqlLinter} from './sqlDiagnostics'
import {dialectFor} from './sqlDialect'
import i18n from '../../i18n'
const ns=(name:string,tables:string[],status:'loaded'|'unloaded'|'error'='loaded')=>({name,status,tables:tables.map(name=>({name})),views:[]})
const catalog={namespaces:[ns('app',['orders','CaseTable','a.b','a"b']),ns('audit',['audit_only'])],defaultSchema:'app'}
const check=(text:string,engine='postgres',schema=catalog)=>sqlDiagnostics(text,schema,{engine})
beforeEach(async()=>{await i18n.changeLanguage('en')})
describe('dialect CST diagnostics',()=>{
  it.each([
    ['postgres',"SELECT $$) FROM fake ($$, $tag$( FROM other$tag$"],
    ['postgres',"SELECT E'it\\'s )', 'normal''quote'"],
    ['oracle',"SELECT q'[)]', q'<FROM fake (' FROM dual".replace("q'<FROM fake ('","q'<FROM fake (>'")],
    ['mysql',"SELECT 'it\\'s )' # ( FROM fake\nFROM orders"],
    ['sqlite','SELECT "has ( paren", `has ) paren` FROM orders'],
    ['sqlserver','SELECT [has ( paren] FROM orders'],
    ['postgres','SELECT /* outer /* nested */ still ) */ 1'],
  ])('does not invent lexical failures for %s literals/identifiers', (engine,text)=>{
    expect(sqlDiagnostics(text,{tables:[]},{engine})).toEqual([])
  })
  it.each([
    ["SELECT 'abc",'unclosedString',7],
    ["SELECT 'abc''",'unclosedString',7],
    ['SELECT $tag$abc','unclosedString',7],
    ['SELECT "abc','unclosedIdentifier',7],
    ['SELECT /* a /* b */','unclosedComment',7],
    ['SELECT (1','unclosedParen',7],
    ['SELECT 1)','unexpectedClose',8],
  ])('reports exact UTF-16 ranges for %s',(text,code,from)=>{
    expect(check(text)[0]).toMatchObject({code,from,severity:'error'})
    expect(check(text)[0].to).toBeLessThanOrEqual(text.length)
  })
  it('keeps quote/Unicode/line coordinates instead of stripping names',()=>{
    const text='SELECT \'中😀\';\nSELECT * FROM "app"."不存在";'
    const [d]=check(text)
    expect(d).toMatchObject({code:'unknownTable',startLine:2,startColumn:15})
    expect(text.slice(d.from,d.to)).toBe('"app"."不存在"')
  })
  it('never scans huge documents synchronously or presents the skipped check as success',()=>{
    expect(check(' '.repeat(200_001))).toEqual([expect.objectContaining({code:'limited',severity:'info'})])
  })
})
describe('namespace and lexical scope',()=>{
  it.each([
    ['SELECT * FROM app.orders',[]],
    ['SELECT * FROM audit.orders',['audit.orders']],
    ['SELECT * FROM missing.orders',[]],
    ['SELECT * FROM "app"."CaseTable"',[]],
    ['SELECT * FROM app.CaseTable',['app.CaseTable']],
    ['SELECT * FROM "app"."a.b"',[]],
    ['SELECT * FROM "app"."a""b"',[]],
    ['WITH r(n) AS (SELECT 1) SELECT * FROM r',[]],
    ['WITH "r.x" AS (SELECT 1) SELECT * FROM "r.x"',[]],
    ['WITH r AS (SELECT 1) SELECT * FROM r; SELECT * FROM r',['r']],
    ['SELECT (WITH r AS (SELECT 1) SELECT * FROM r) FROM r',['r']],
    ['WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a',['b']],
    ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT * FROM r',[]],
    ['WITH RECURSIVE a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a',[]],
    ['SELECT * FROM (SELECT * FROM orders) q JOIN LATERAL (SELECT * FROM q_function()) v ON true',[]],
    ['SELECT EXTRACT(DAY FROM created_at), SUBSTRING(note FROM 1) FROM orders',[]],
    ['SELECT * FROM generate_series(1, 5)',[]],
    ['SELECT * FROM orders o, missing_table m',['missing_table']],
    ['SELECT * FROM orders WHERE EXISTS (SELECT * FROM nested_missing)',['nested_missing']],
    ['CREATE TEMP TABLE session_t(id INT); SELECT * FROM session_t',[]],
    ['SET search_path TO audit; SELECT * FROM some_table',[]],
  ])('uses a statement-local catalog scope: %s',(text,names)=>{
    const ds=check(text).filter(d=>d.code==='unknownTable')
    expect(ds.map(d=>text.slice(d.from,d.to))).toEqual(names)
  })
  it.each(['unloaded','error'] as const)('does not infer absence from %s metadata',status=>{
    expect(check('SELECT * FROM ghost','postgres',{...catalog,namespaces:[ns('app',[],status)]})).toEqual([])
  })
  it('can diagnose a complete empty namespace but not an unknown default',()=>{
    expect(check('SELECT * FROM ghost','postgres',{...catalog,namespaces:[ns('app',[])]})[0]?.code).toBe('unknownTable')
    expect(sqlDiagnostics('SELECT * FROM ghost',{namespaces:catalog.namespaces},{engine:'postgres'})).toEqual([])
  })
  it('does not mistake a partial/error namespace for a complete catalog',()=>{
    expect(sqlDiagnostics('SELECT * FROM ghost',{defaultSchema:'app',namespaces:[{...ns('app',[]),truncated:true}]},{engine:'postgres'})).toEqual([])
  })
  it.each([
    ['sqlite','WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a'],
    ['sqlite','WITH r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<2) SELECT * FROM r'],
    ['rqlite','WITH r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<2) SELECT * FROM r'],
    ['oracle','WITH r(n) AS (SELECT 1 FROM dual UNION ALL SELECT n+1 FROM r WHERE n<2) SELECT * FROM r'],
    ['mysql','SELECT 1 FROM dual'],
  ])('respects %s recursive/virtual relation rules',(engine,text)=>{
    expect(check(text,engine)).toEqual([])
  })
  it('does not claim SQL Server session variables and temporary tables are missing',()=>{
    expect(check('SELECT * FROM #local JOIN @rows r ON 1=1','sqlserver')).toEqual([])
    expect(check('WITH r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT * FROM r','sqlserver')).toEqual([])
  })
})
it('localizes via diagnostic codes and suppresses only the literal currently being edited',async()=>{
  const code="SELECT 1;\nSELECT 'abc\nstill typing"
  const source=sqlLinter(()=>({namespaces:[]}),{engine:'postgres'})
  const view=(pos:number)=>({state:EditorState.create({doc:code,selection:{anchor:pos},extensions:[dialectFor('postgres').language]})}) as EditorView
  expect(source(view(code.length))).toEqual([])
  expect(source(view(0))[0].message).toBe('Unclosed string literal')
  await i18n.changeLanguage('zh')
  expect(source(view(0))[0].message).toBe('未闭合的字符串字面量')
})
