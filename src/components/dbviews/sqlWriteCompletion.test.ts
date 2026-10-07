import { expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { LanguageSupport, ensureSyntaxTree } from '@codemirror/language'
import { dialectFor } from './sqlDialect'
import { sqlDataTypeCompletion } from './sqlWriteCompletion'
import { scopedSchemaCompletion } from './sqlScopeCompletion'
import { guardedSqlKeywordCompletion } from './sqlKeywordCompletion'
import { sqlAdvancedCompletion } from './sqlAdvancedCompletion'
const schema = { app: { users: ['id','name','two words','__proto__'] }, audit: { users: ['other'] } }
async function candidates(text: string, engine = 'postgres'): Promise<readonly Completion[]> {
  const pos = text.indexOf('|'), doc = text.replace('|', '')
  const dialect = dialectFor(engine)
  const state = EditorState.create({ doc, extensions: [new LanguageSupport(dialect.language)] })
  ensureSyntaxTree(state, doc.length, 100)
  const context = new CompletionContext(state, pos, true)
  const sources = [sqlDataTypeCompletion(engine), scopedSchemaCompletion(schema, 'app', engine), guardedSqlKeywordCompletion(dialect), sqlAdvancedCompletion(() => engine, () => [])]
  return (await Promise.all(sources.map(source => source(context)))).flatMap(result => result?.options ?? [])
}
it.each(['CREATE TABLE t (id |)', 'CREATE TABLE t (id |', 'CREATE TABLE t (id INT, name |)', 'ALTER TABLE t ADD COLUMN name |', 'ALTER TABLE t ALTER COLUMN name TYPE |', 'SELECT CAST(name AS |) FROM t'])('offers only datatype candidates in %s', async text => {
  const result = await candidates(text)
  expect(result.map(c => c.label)).toContain('TEXT')
  expect(result.every(c => c.type === 'type')).toBe(true)
  expect(result.map(c => c.label)).not.toContain('users')
  expect(result.map(c => c.label)).not.toContain('COUNT')
})
it.each([['oracle','VARCHAR2','JSONB'], ['mysql','TINYINT','BYTEA'], ['sqlserver','NVARCHAR','BOOLEAN'], ['postgres','BYTEA','NVARCHAR']])('scopes suggested types to %s', async (engine, yes, no) => {
  const names = (await candidates('CREATE TABLE t (value |)',engine)).map(c => c.label)
  expect(names).toContain(yes); expect(names).not.toContain(no)
})
it.each(['CREATE TABLE t (name TEXT DEFAULT \'|\')','CREATE TABLE t (id INT -- |\n)', 'CREATE TABLE t (id INT /* | */)'])('does not offer types in strings/comments: %s', async text => {
  expect(await candidates(text)).toEqual([])
})
it.each(['INSERT INTO users (|)', 'INSERT INTO app.users (|', 'UPDATE users SET |', 'UPDATE app.users u SET |'])('uses only target columns for %s', async text => {
  const result = await candidates(text)
  expect(result.map(c => c.label)).toEqual(['id','name','two words','__proto__'])
  expect(result.every(c => c.type === 'property')).toBe(true)
})
it('excludes completed INSERT columns but replaces the whole current quoted token', async () => {
  const result = await candidates('INSERT INTO users (id, "na|me") VALUES (1,2)')
  expect(result).toEqual([expect.objectContaining({ label:'name', apply:'"name"' })])
})
it('excludes already assigned UPDATE columns without inspecting commas in nested values', async () => {
  const result = await candidates("UPDATE users SET id=COALESCE(1,2), n|")
  expect(result.map(c => c.label)).toEqual(['name'])
})
it('resolves explicit target namespace and quoted columns without leaking another schema', async () => {
  expect((await candidates('INSERT INTO audit.users (|)')).map(c => c.label)).toEqual(['other'])
  expect((await candidates('INSERT INTO users ("two |")'))[0]).toMatchObject({ label:'two words', apply:'"two words"' })
})
