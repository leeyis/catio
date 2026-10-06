import {expect,it} from 'vitest'
import {EditorState} from '@codemirror/state'
import {dialectFor} from './sqlDialect'
import {sqlExecutionTarget} from './sqlExecutionTarget'

it.each(['#local','##global','@rows'])('keeps SQL Server %s in a single executable statement',name=>{
  const doc=`SELECT * FROM ${name};`
  const state=EditorState.create({doc,selection:{anchor:7},extensions:[dialectFor('sqlserver').language]})
  expect(sqlExecutionTarget(state,'current')).toMatchObject({target:{sql:doc,from:0,to:doc.length}})
})
it('uses Oracle double quotes for identifiers while preserving q-literals',()=>{
  const doc='SELECT "quoted identifier", q\'[)]\' FROM dual'
  const tree=dialectFor('oracle').language.parser.parse(doc)
  const kinds:string[]=[]
  tree.iterate({enter(n){if(n.name==='String'||n.name==='QuotedIdentifier')kinds.push(n.name)}})
  expect(kinds).toEqual(['QuotedIdentifier','String'])
})
