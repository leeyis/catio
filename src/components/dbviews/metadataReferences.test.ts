import { describe, it, expect } from 'vitest'
import { referencedNamespaces } from './metadataReferences'

describe('metadata namespace references', () => {
  it('loads current and referenced namespaces without enumerating unrelated ones', () => {
    expect(referencedNamespaces('SELECT * FROM analytics.events a JOIN public.users u ON a.id=u.id', ['public','analytics','unused'], 'public')).toEqual(['public','analytics'])
  })
  it.each([
    ['postgres', 'SELECT x.id FROM "Sales Space".orders x', 'Sales Space'],
    ['sqlserver', 'SELECT x.id FROM [a]]b].items x', 'a]b'],
    ['mysql', 'SELECT x.id FROM `雪`.t x', '雪'],
  ])('recognizes quoted namespaces using %s syntax', (engine, sql, name) => {
    expect(referencedNamespaces(sql, [name,'unused'], undefined, engine)).toEqual([name])
  })
  it.each([
    ['postgres', "SELECT 'unused.secret' FROM public.orders -- unused.other\n/* unused.third */"],
    ['postgres', 'SELECT $body$unused.secret$body$ FROM public.orders'],
    ['postgres', '/* outer /* unused.secret */ unused.other */ SELECT * FROM public.orders'],
    ['mysql', "SELECT 'it\\'s unused.secret' FROM public.orders # unused.other"],
    ['oracle', "SELECT q'[unused.secret]' FROM public.orders"],
    ['sqlserver', "SELECT N'unused.secret' FROM public.orders"],
  ])('never loads namespaces mentioned only in %s comments or literals', (engine, sql) => {
    expect(referencedNamespaces(sql, ['public','unused'], 'public', engine)).toEqual(['public'])
  })
  it('still loads a namespace when its qualifier is being typed', () => {
    expect(referencedNamespaces('SELECT * FROM analytics.', ['public','analytics'], 'public', 'postgres')).toEqual(['public','analytics'])
  })
})
