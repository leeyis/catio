import { expect, it } from 'vitest'
import { buildJoinTables } from './sqlJoinCatalog'
import type { ErRelation } from '../../services/types'
const namespaces = ['app', 'other'].map(name => ({ name, tables: [{ name: 'orders' }], views: [] }))
const relation: ErRelation = { from: 'orders', fromCol: 'owner', to: 'users', toCol: 'id', fromSchema: 'app', toSchema: 'other', constraintId: 'fk', ordinal: 1, columnCount: 1 }
it('does not merge same-name tables across namespaces', () => {
  const catalog = buildJoinTables(namespaces, (schema) => [schema + '_column'], { app: [relation] })
  expect(catalog.filter(t => t.name === 'orders')).toEqual([
    expect.objectContaining({ schema: 'app', columns: ['app_column'], foreignKeys: [expect.objectContaining({ refSchema: 'other', constraintId: 'fk' })] }),
    expect.objectContaining({ schema: 'other', columns: ['other_column'], foreignKeys: [] }),
  ])
  expect(catalog.some(t => t.schema === 'other' && t.name === 'users')).toBe(true)
})
it('does not guess identities for legacy or incomplete providers', () => {
  const old: ErRelation = { from: 'orders', fromCol: 'owner', to: 'users', toCol: 'id' }
  expect(buildJoinTables(namespaces, () => [], { app: [old, { ...relation, toSchema: undefined }, { ...relation, columnCount: undefined }] }).every(t => !t.foreignKeys.length)).toBe(true)
})
it('does not use a namespace response as evidence for a different source', () => {
  expect(buildJoinTables(namespaces, () => [], { other: [relation] }).every(t => !t.foreignKeys.length)).toBe(true)
})
it('treats case, dots and prototype-like names as exact identities', () => {
  const ns = [{ name: '__proto__', tables: [{ name: 'a.b' }, { name: 'A.B' }], views: [] }]
  expect(buildJoinTables(ns, () => [], Object.create(null)).map(t => [t.schema, t.name])).toEqual([['__proto__','a.b'],['__proto__','A.B']])
})
