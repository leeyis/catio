import {describe,it,expect} from 'vitest'
import {referencedNamespaces} from './metadataReferences'
describe('metadata namespace references',()=>{
 it('loads current and referenced namespaces without enumerating unrelated ones',()=>{
   expect(referencedNamespaces('SELECT * FROM analytics.events a JOIN public.users u ON a.id=u.id',['public','analytics','unused'],'public')).toEqual(['public','analytics'])
 })
 it('recognizes quoted namespaces and excludes ordinary aliases',()=>{
   expect(referencedNamespaces('SELECT x.id FROM "Sales Space".orders x JOIN [a]]b].items y ON y.id=x.id JOIN `雪`.t z ON z.id=x.id',['Sales Space','a]b','雪','unused'])).toEqual(['Sales Space','a]b','雪'])
 })
})
