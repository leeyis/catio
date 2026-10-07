import {beforeEach,expect,it,vi} from 'vitest'
import {EditorState} from '@codemirror/state'
import type {EditorView} from '@codemirror/view'
import {dialectFor} from './sqlDialect'
import {sqlDiagnostics,sqlLinter} from './sqlDiagnostics'
import i18n from '../../i18n'

const catalog={tables:['zebra_export','orders']}
const state=(sql:string)=>EditorState.create({doc:sql,extensions:[dialectFor('sqlite').language]})
const view=(sql:string)=>({state:state(sql),dispatch:vi.fn(),focus:vi.fn()}) as unknown as EditorView
beforeEach(async()=>{await i18n.changeLanguage('en')})

it.each([['；',';'],['，',','],['（','('],['）',')'],['＝','=']])('locates confusable punctuation %s and explains the ASCII replacement',(punctuation,replacement)=>{
  const sql=`SELECT * FROM zebra_export LIMIT 100${punctuation}`
  const diagnostics=sqlDiagnostics(sql,catalog,{engine:'sqlite'})
  expect(diagnostics).toEqual([expect.objectContaining({code:'confusablePunctuation',from:sql.length-1,to:sql.length,severity:'warning',values:{name:punctuation,replacement}})])
  expect(diagnostics[0].message).toContain(replacement)
})
it.each([
  "SELECT '；，（）＝' FROM orders;",
  'SELECT "；，（）＝" FROM orders;',
  'SELECT `；，（）＝` FROM orders;',
  'SELECT [；，（）＝] FROM orders;',
  'SELECT 1; -- ；，（）＝',
  'SELECT /* ；，（）＝ */ 1;',
  'SELECT * FROM 订单；历史',
])('does not offer to rewrite quoted text, comments or opaque Unicode identifiers: %s',sql=>{
  expect(sqlDiagnostics(sql,catalog,{engine:'sqlite'}).filter(d=>d.code==='confusablePunctuation')).toEqual([])
})
it.each([
  ['postgres','SELECT $tag$；，（）＝$tag$;'],
  ['oracle',"SELECT q'[；，（）＝]' FROM dual"],
  ['mysql',"SELECT 'it\\'s ；，（）＝'"],
  ['sqlserver','SELECT [；，（）＝];'],
])('respects %s protected literal/identifier spans',(engine,sql)=>{
  expect(sqlDiagnostics(sql,catalog,{engine}).filter(d=>d.code==='confusablePunctuation')).toEqual([])
})
it('does not apply a repair to a read-only document',()=>{
  const sql='SELECT 1；',v=view(sql)
  const [d]=sqlLinter(()=>catalog,{engine:'sqlite'})(v)
  const locked={...v,state:EditorState.create({doc:sql,extensions:[dialectFor('sqlite').language,EditorState.readOnly.of(true)]})} as EditorView
  d.actions![0].apply(locked,8,9)
  expect(locked.dispatch).not.toHaveBeenCalled()
})
it('keeps capability notices out of editor diagnostics without changing the analysis contract',()=>{
  const sql='CREATE TEMP TABLE session_t(id INT); SELECT * FROM session_t;'
  expect(sqlDiagnostics(sql,catalog,{engine:'sqlite'})).toEqual([expect.objectContaining({code:'referenceSkipped'})])
  expect(sqlLinter(()=>catalog,{engine:'sqlite'})(view(sql))).toEqual([])
  expect(sqlLinter(()=>catalog,{engine:'sqlite'})(view(' '.repeat(200_001)))).toEqual([])
})
it('offers a scoped repair for the screenshot SQL, never automatic execution',()=>{
  const v=view('SELECT * FROM zebra_export LIMIT 100；')
  const [d]=sqlLinter(()=>catalog,{engine:'sqlite'})(v)
  expect(d).toMatchObject({from:36,to:37,severity:'warning'})
  expect(d.actions?.[0].name).toContain(';')
  expect(v.dispatch).not.toHaveBeenCalled()
  d.actions![0].apply(v,36,37)
  expect(v.dispatch).toHaveBeenCalledWith(expect.objectContaining({changes:{from:36,to:37,insert:';'}}))
})
it('revalidates mapped repairs so a stale action cannot rewrite a new value or a literal',()=>{
  const [d]=sqlLinter(()=>catalog,{engine:'sqlite'})(view('SELECT 1；'))
  expect(d.actions).toHaveLength(1)
  const changed=view('SELECT 1;')
  d.actions![0].apply(changed,8,9);expect(changed.dispatch).not.toHaveBeenCalled()
  const literal=view("SELECT '；'")
  d.actions![0].apply(literal,8,9);expect(literal.dispatch).not.toHaveBeenCalled()
  const shifted=view('-- comment\nSELECT 1；')
  d.actions![0].apply(shifted,19,20)
  expect(shifted.dispatch).toHaveBeenCalledWith(expect.objectContaining({changes:{from:19,to:20,insert:';'}}))
})
it('localizes concrete punctuation guidance and repair labels',async()=>{
  await i18n.changeLanguage('zh')
  const [d]=sqlLinter(()=>catalog,{engine:'sqlite'})(view('SELECT 1；'))
  expect(d.message).toContain('全角标点「；」')
  expect(d.actions?.[0].name).toBe('替换为 ;')
})
