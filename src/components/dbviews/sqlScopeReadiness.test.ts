import { beforeEach, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { Tree } from '@lezer/common'
import { CompletionContext } from '@codemirror/autocomplete'
const control = vi.hoisted(() => ({ unavailable: false, ensure: vi.fn() }))
vi.mock('@codemirror/language', async () => {
  const actual = await vi.importActual<typeof import('@codemirror/language')>('@codemirror/language')
  return { ...actual, syntaxTree: () => Tree.empty, ensureSyntaxTree: (state: EditorState, upto: number, timeout: number) => {
    control.ensure(upto, timeout)
    return control.unavailable ? null : actual.ensureSyntaxTree(state, upto, timeout)
  } }
})
import { scopedSchemaCompletion } from './sqlScopeCompletion'
import { sqlAdvancedCompletion } from './sqlAdvancedCompletion'
beforeEach(() => { control.unavailable = false; control.ensure.mockClear() })
function complete(input: string) {
  const pos = input.indexOf('|'), state = EditorState.create({ doc: input.replace('|', ''), extensions: [sql({ dialect: PostgreSQL })] })
  return scopedSchemaCompletion({ main: { orders: ['id'] } }, 'main', 'postgres')(new CompletionContext(state, pos, true))
}
it('finishes a bounded parse rather than missing derived columns when the cached tree lags', async () => {
  const result = await complete('SELECT q.| FROM (SELECT id AS public_id FROM orders) q')
  expect(result?.options.map(o => o.label)).toEqual(['public_id'])
  expect(control.ensure).toHaveBeenCalled()
  expect(control.ensure.mock.calls[0][1]).toBeLessThanOrEqual(20)
})
it('retains lexical suppression even when the outer cached-tree guard lags', async () => {
  const code = "SELECT 'COA"
  const state = EditorState.create({ doc: code, extensions: [sql({ dialect: PostgreSQL })] })
  expect(await sqlAdvancedCompletion(() => 'postgres', () => [])(new CompletionContext(state, code.length, true))).toBeNull()
  expect(await complete('SELECT /* ord|')).toBeNull()
})
it('does not guess scope from an incomplete tree if the parse budget is exhausted', async () => {
  control.unavailable = true
  expect(await complete('SELECT * FROM ord|')).toBeNull()
})
