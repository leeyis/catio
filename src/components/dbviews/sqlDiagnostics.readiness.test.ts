import {expect,it,vi} from 'vitest'
import {EditorState} from '@codemirror/state'
import {dialectFor} from './sqlDialect'
const control=vi.hoisted(()=>({ensure:vi.fn()}))
vi.mock('@codemirror/language',async()=>({...await vi.importActual<typeof import('@codemirror/language')>('@codemirror/language'),ensureSyntaxTree:control.ensure}))
import {sqlIssuesAt} from './sqlDiagnosticAnalysis'
it('reports unavailable checks rather than falling back to a stale tree or guessing object absence',()=>{
  control.ensure.mockReturnValue(null)
  const state=EditorState.create({doc:'SELECT * FROM missing;',extensions:[dialectFor('postgres').language]})
  expect(sqlIssuesAt(state,{tables:['known']},'postgres')).toEqual([{from:0,to:1,severity:'info',code:'notReady'}])
  expect(control.ensure).toHaveBeenCalledWith(state,state.doc.length,20)
})
it('does not invoke the parser at all beyond the live document budget',()=>{
  control.ensure.mockClear()
  expect(sqlIssuesAt(EditorState.create({doc:'x'.repeat(200_001)}),{tables:[]})[0].code).toBe('limited')
  expect(control.ensure).not.toHaveBeenCalled()
})
