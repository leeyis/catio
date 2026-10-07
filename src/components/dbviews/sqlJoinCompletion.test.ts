import { expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql } from '@codemirror/lang-sql'
import { ensureSyntaxTree } from '@codemirror/language'
import { dialectFor } from './sqlDialect'
import { sqlAdvancedCompletion, type JoinTable } from './sqlAdvancedCompletion'
const tables: JoinTable[] = [
  { schema: 'app', name: 'orders', columns: ['id', 'tenant', 'user_id'], foreignKeys: [
    { column: 'tenant', refTable: 'users', refSchema: 'auth', refColumn: 'tenant', constraintId: 'fk_user', ordinal: 1, columnCount: 2 },
    { column: 'user_id', refTable: 'users', refSchema: 'auth', refColumn: 'id', constraintId: 'fk_user', ordinal: 2, columnCount: 2 },
  ] },
  { schema: 'auth', name: 'users', columns: ['tenant', 'id'], foreignKeys: [] },
  { schema: 'app', name: 'users', columns: ['not_the_target'], foreignKeys: [] },
]
function complete(marked: string, catalog = tables, engine = 'postgres', defaultSchema = 'app') {
  const pos = marked.indexOf('|'), doc = marked.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: dialectFor(engine) })] })
  // Semantic fixture preparation; exhausted parser budgets have separate fail-closed tests.
  expect(ensureSyntaxTree(state, state.doc.length, 100)).not.toBeNull()
  const result = sqlAdvancedCompletion(() => engine, () => catalog, () => defaultSchema)(new CompletionContext(state, pos, true))
  const joins = result?.options.filter(option => option.detail?.startsWith('FK JOIN')) ?? []
  return { result, joins, insert: (index = 0) => result && joins[index] ? doc.slice(0, result.from) + joins[index].apply + doc.slice(result.to ?? pos) : doc }
}
it('generates one cross-schema JOIN with the entire composite condition and the actual alias', () => {
  const c = complete('SELECT * FROM app.orders o |')
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toBe('SELECT * FROM app.orders o JOIN "auth"."users" ON o."tenant" = "auth"."users"."tenant" AND o."user_id" = "auth"."users"."id"')
})
it.each(['JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN'])('never inserts a second JOIN after an existing %s', keyword => {
  const c = complete(`SELECT * FROM app.orders o ${keyword} |`)
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toContain(`${keyword} "auth"."users" ON `)
  expect(c.insert()).not.toContain(`${keyword} JOIN`)
})
it('replaces only the partially entered target, preserving the JOIN kind', () => {
  const c = complete('SELECT * FROM app.orders o LEFT JOIN auth.us|')
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toContain('LEFT JOIN "auth"."users" ON ')
  expect(c.insert()).not.toContain('auth.JOIN')
})
it('replaces a target prefix in the middle of a token without leaving its suffix', () => {
  const c = complete('SELECT * FROM app.orders o LEFT JOIN auth.us|ers')
  expect(c.insert()).toContain('LEFT JOIN "auth"."users" ON ')
  expect(c.insert()).not.toMatch(/\"id\"ers$/)
})
it('preserves an existing alias and ON clause when replacing a target prefix', () => {
  const c = complete('SELECT * FROM app.orders o JOIN auth.us|ers u ON o.user_id = u.id')
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toBe('SELECT * FROM app.orders o JOIN "auth"."users" u ON o.user_id = u.id')
})
it('does not prepend an ON condition to an existing predicate', () => {
  expect(complete('SELECT * FROM app.orders o JOIN auth.users u ON |u.id = o.user_id').joins).toHaveLength(0)
})
it.each(['CROSS JOIN', 'NATURAL JOIN'])('does not add an illegal ON clause to %s', keyword => {
  expect(complete(`SELECT * FROM app.orders o ${keyword} |`).joins).toHaveLength(0)
})
it('provides a composite ON condition for an already joined table using both aliases', () => {
  const c = complete('SELECT * FROM app.orders o JOIN auth.users u ON |')
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toBe('SELECT * FROM app.orders o JOIN auth.users u ON o."tenant" = u."tenant" AND o."user_id" = u."id"')
})
it('does not confuse a same-name table from another namespace', () => {
  expect(complete('SELECT * FROM app.orders o JOIN app.users u ON |').joins).toHaveLength(0)
})
it('resolves an unqualified source using the actual default schema', () => {
  expect(complete('SELECT * FROM orders o |').joins).toHaveLength(1)
  expect(complete('SELECT * FROM orders o |', tables, 'postgres', 'other').joins).toHaveLength(0)
})
it('does not leak sources from a previous statement', () => {
  expect(complete('SELECT * FROM app.orders; SELECT 1 |').joins).toHaveLength(0)
})
it('does not leak an outer source into a nested query JOIN', () => {
  expect(complete('SELECT * FROM app.orders WHERE EXISTS (SELECT * FROM app.users u JOIN |)').joins).toHaveLength(0)
})
it('does not mistake a CTE that shadows a physical table for that physical source', () => {
  expect(complete('WITH orders AS (SELECT 1 AS user_id) SELECT * FROM orders |').joins).toHaveLength(0)
})
it.each(["SELECT 'FROM app.orders JOIN |", 'SELECT * FROM app.orders -- JOIN |', 'SELECT * FROM app.orders WHERE |'])('suppresses non-table contexts: %s', marked => {
  expect(complete(marked).joins).toHaveLength(0)
})
it('ignores commented-out sources while keeping actual sources', () => {
  expect(complete('SELECT * /* FROM app.users */ FROM app.orders o JOIN |').joins).toHaveLength(1)
})
it.each(['missing', 'duplicate', 'unknown'])('fails closed for %s composite metadata', kind => {
  const copy = structuredClone(tables)
  if (kind === 'missing') copy[0].foreignKeys.pop()
  if (kind === 'duplicate') copy[0].foreignKeys[1].ordinal = 1
  if (kind === 'unknown') copy[0].foreignKeys.forEach(key => { delete key.constraintId; delete key.columnCount })
  expect(complete('SELECT * FROM app.orders |', copy).joins).toHaveLength(0)
})
it('keeps two independent FK constraints as two alternatives, not a combined condition', () => {
  const copy = structuredClone(tables)
  copy[0].foreignKeys.forEach((key, index) => { key.constraintId = `fk_${index}`; key.ordinal = 1; key.columnCount = 1 })
  expect(complete('SELECT * FROM app.orders |', copy).joins).toHaveLength(2)
})
it('quotes literal dots and embedded quote characters as identifiers, not namespace separators', () => {
  const copy: JoinTable[] = [
    { schema: 'a.b', name: 'o"r', columns: ['x'], foreignKeys: [{ column: 'x', refSchema: 'a.b', refTable: 'u.s', refColumn: 'i"d', constraintId: 'fk', ordinal: 1, columnCount: 1 }] },
    { schema: 'a.b', name: 'u.s', columns: ['i"d'], foreignKeys: [] },
  ]
  const c = complete('SELECT * FROM "a.b"."o""r" o JOIN |', copy)
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toContain('JOIN "a.b"."u.s" ON o."x" = "a.b"."u.s"."i""d"')
})
it('does not mistake a table-valued function for a same-name physical table', () => {
  expect(complete('SELECT * FROM app.orders(1) o JOIN |').joins).toHaveLength(0)
})
it('does not reuse original column names after an explicit column alias list', () => {
  expect(complete('SELECT * FROM app.orders AS o(a,b,c) JOIN |').joins).toHaveLength(0)
})
it('keeps doubled quotes inside aliases rather than referring to a different alias', () => {
  const c = complete('SELECT * FROM app.orders AS "o""r" JOIN |')
  expect(c.joins).toHaveLength(1)
  expect(c.insert()).toContain('ON "o""r"."tenant" = ')
})
it('keeps a quoted namespace split across adjacent CST nodes as one identity', () => {
  const copy = structuredClone(tables); copy[0].schema = 'a"b'
  const c = complete('SELECT * FROM "a""b".orders o JOIN |', copy)
  expect(c.joins).toHaveLength(1)
})
it('keeps PostgreSQL quoted-case identities distinct', () => {
  const copy = structuredClone(tables); copy[0].name = 'Orders'
  expect(complete('SELECT * FROM app.orders |', copy).joins).toHaveLength(0)
  expect(complete('SELECT * FROM app."Orders" |', copy).joins).toHaveLength(1)
})
