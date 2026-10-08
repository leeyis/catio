import {readFileSync} from 'node:fs'
import {expect,it} from 'vitest'

// Lock the local declarations as well as checking actual hover in the browser:
// a filter-only hover rule lets .icon-btn.bare:hover replace the accent surface.
const css=readFileSync('src/components/workbench/databaseWorkspace.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'')
function declarations(selector:string){
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([,selectors])=>selectors.split(',').some(s=>s.trim()===selector))?.[2]??''
}
it.each(['',':hover','[aria-expanded="true"]'])('keeps the run dropdown on the accent surface in state %s',state=>{
  const rule=declarations('.db-run-group .db-run-menu > button'+state)
  expect(rule).toMatch(/background\s*:\s*var\(--accent-primary\)/)
  expect(rule).toMatch(/color\s*:\s*var\(--on-accent\)/)
})
it('centers the new-query icon and label as one group',()=>{
  expect(declarations('.db-explorer .db-new-query')).toMatch(/justify-content\s*:\s*center/)
})
