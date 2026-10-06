import {act,render,waitFor} from '@testing-library/react'
import {beforeAll,beforeEach,expect,it,vi} from 'vitest'
import {Tree} from '@lezer/common'
import {EditorView} from '@codemirror/view'
import type {EditorState,StateField} from '@codemirror/state'
import {Language} from '@codemirror/language'
import {CompletionContext,type CompletionSource} from '@codemirror/autocomplete'
const control=vi.hoisted(()=>({unavailable:false}))
vi.mock('@codemirror/language',async()=>{
  const actual=await vi.importActual<typeof import('@codemirror/language')>('@codemirror/language')
  return {...actual,syntaxTree:()=>Tree.empty,ensureSyntaxTree:(state:EditorState,upto:number,timeout:number)=>control.unavailable?null:actual.ensureSyntaxTree(state,upto,timeout)}
})
import {SqlEditor} from './SqlEditor'
import i18n from '../../i18n'
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{control.unavailable=false})
async function names(input:string,withExtra=false){
  const pos=input.indexOf('|'),code=input.replace('|','')
  const {container}=render(<SqlEditor code={code} onChange={()=>{}} engine="postgres" defaultSchema="app" schema={{app:{orders:['id']}}} extraCompletion={withExtra?(context=>({from:context.pos,options:[{label:'EXTRA_MUST_BE_GUARDED'}]})):undefined}/>)
  const view=EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  act(()=>view.dispatch({selection:{anchor:pos}}))
  // Reproduce the real distinction between LanguageState.tree (published cache)
  // and ParseContext.tree (ensureSyntaxTree's newer tree). This test-only cast is
  // necessary because lang-sql's externalized import bypasses a Vitest export mock.
  const actual=await vi.importActual<typeof import('@codemirror/language')>('@codemirror/language')
  // Fixture preparation can yield under a loaded full-suite worker. This is not
  // the production 10 ms guard: unavailable-tree behavior is tested separately.
  const ready=await waitFor(()=>{
    const tree=actual.ensureSyntaxTree(view.state,view.state.doc.length,100)
    expect(tree).not.toBeNull()
    return tree!
  },{timeout:1500})
  const field=(Language as unknown as {state:StateField<{tree:Tree}>}).state
  const published=view.state.field(field)
  published.tree=new Tree(ready!.type,[],[],view.state.doc.length)
  const c=new CompletionContext(view.state,pos,true)
  const sources=view.state.languageDataAt<CompletionSource>('autocomplete',pos)
  expect(sources).toHaveLength(withExtra?3:2) // never pass by accidentally removing language data
  const results=await Promise.all(sources.map(source=>source(c)))
  return results.flatMap(r=>r?.options.map(o=>o.label)??[])
}
it('does not leak cached-tree keyword guesses into a projected CTE field',async()=>{
  expect(await names('WITH r AS (SELECT id AS public_id FROM app.orders) SELECT r.| FROM r')).toEqual(['public_id'])
})
it.each(["SELECT 'SEL|",'SELECT 1 -- SEL|','SELECT /* SEL|'])('guards keywords in literals/comments even when their cached tree is empty: %s',async input=>{
  expect(await names(input)).toEqual([])
})
it('fails closed for every SQL completion source when parsing is unavailable',async()=>{
  control.unavailable=true;expect(await names('SELECT r.| FROM app.orders r')).toEqual([])
})
it('also guards a caller-provided extra source inside a lagging literal tree',async()=>{
  expect(await names("SELECT 'text|",true)).toEqual([])
})
it('does not invoke extra sources when the shared parse guard has no tree',async()=>{
  control.unavailable=true;expect(await names('SEL|',true)).toEqual([])
})
it('keeps ordinary SQL keyword completion when the fresh tree permits it',async()=>{
  expect(await names('SEL|')).toContain('SELECT')
})
