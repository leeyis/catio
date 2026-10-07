import { expect, it } from 'vitest'
import type { StructColumn } from '../../services/types'
import { compareKeyStatus, comparisonStructureFingerprint } from './compareKeys'
const col=(name:string,key:StructColumn['key']=''):StructColumn=>({name,key,type:'text',nullable:false,default:null,extra:'',comment:''})
const source={columns:[col('id','PK'),col('code')],indexes:[],fks:[]}
it('accepts either key order and requires every member of both primary keys',()=>{
  const target={columns:[col('code','PK'),col('id','PK')]}
  expect(compareKeyStatus(source,target,['code','id'])).toEqual({valid:true,unique:true})
  expect(compareKeyStatus(source,target,['id'])).toEqual({valid:true,unique:false})
})
it.each([[],['id','id'],['missing'],['__proto__']].map(keys=>({keys})))('rejects missing, duplicated or unknown keys $keys',({keys})=>{
  expect(compareKeyStatus(source,source,keys).valid).toBe(false)
})
it('does not infer unique constraints or column identities from comma-separated index text',()=>{
  const st={columns:[col('a,b','UNI'),col('c','UNI')],indexes:[{name:'partial',cols:'a,b,c',unique:true,method:'BTREE'}]}
  expect(compareKeyStatus(st,st,['a,b','c'])).toEqual({valid:true,unique:false})
})
it('tracks column and index changes in the revalidation fingerprint',()=>{
  expect(comparisonStructureFingerprint(source)).not.toBe(comparisonStructureFingerprint({...source,columns:[col('id'),col('code')]}))
  expect(comparisonStructureFingerprint(source)).not.toBe(comparisonStructureFingerprint({...source,indexes:[{name:'idx',cols:'code',unique:true,method:'BTREE'}]}))
})
