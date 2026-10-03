import {describe,it,expect} from 'vitest'
import {computeDiff,genSyncStatements,valuesEqual} from './compareTables'
describe('typed and safe data comparison',()=>{
 it('does not merge a binary key with an identical-looking text key',()=>{
  const diff=computeDiff({srcColumns:['id','v'],tgtColumns:['v','id'],pkNames:['id'],
   srcRows:[['0xff','bytes'],['0xff','text']],srcBinaryCells:[[0,0]],
   tgtRows:[['old','0xff']],tgtBinaryCells:[]})
  expect(diff.error).toBeUndefined();expect(diff.inserts).toHaveLength(1);expect(diff.updates).toHaveLength(1)
  const sql=genSyncStatements(diff,'main','t',{engine:'sqlite',allowDelete:true})
  expect(sql.join('\n')).toContain("X'ff'")
  expect(sql.join('\n')).toContain('WHERE "id" = \'0xff\'')
 })
 it('preserves binary value metadata when target columns are reordered',()=>{
  const diff=computeDiff({srcColumns:['id','payload'],tgtColumns:['payload','id'],pkNames:['id'],
   srcRows:[[1,'0xab']],srcBinaryCells:[[0,1]],tgtRows:[['0xcd',1]],tgtBinaryCells:[[0,0]]})
  const sql=genSyncStatements(diff,'public','t',{engine:'postgres',allowDelete:true})
  expect(sql[0]).toContain("decode('ab', 'hex')")
 })
 it('rejects absent, nullable or duplicated row identities before producing sync SQL',()=>{
  const base={srcColumns:['id'],tgtColumns:['id'],srcRows:[[1]],tgtRows:[[1]],pkNames:['id']}
  expect(computeDiff({...base,pkNames:[]}).error).toBeTruthy()
  expect(computeDiff({...base,srcRows:[[null]]}).error).toBeTruthy()
  expect(computeDiff({...base,tgtRows:[[1],[1]]}).error).toBeTruthy()
  expect(computeDiff({...base,srcRows:[[1],[1]]}).error).toBeTruthy()
 })
 it('compares mixed numeric representations without rounding away real differences',()=>{
  expect(valuesEqual('9007199254740993',9007199254740992)).toBe(false)
  expect(valuesEqual('1.0000000000000000001',1)).toBe(false)
  expect(valuesEqual('1.20e2',120)).toBe(true)
  expect(valuesEqual({a:1,b:2},{b:2,a:1})).toBe(true)
 })
 it('repositions target binary keys for DELETE and rejects malformed metadata',()=>{
  const base={srcColumns:['id','v'],tgtColumns:['v','id'],pkNames:['id'],srcRows:[],tgtRows:[['data','0xAA']]}
  const diff=computeDiff({...base,tgtBinaryCells:[[0,1]]})
  expect(genSyncStatements(diff,'main','t',{engine:'sqlite',allowDelete:true})[0]).toContain('WHERE "id" = X\'AA\'')
  expect(computeDiff({...base,tgtBinaryCells:[[0,9]]}).error).toBe('invalid-binary')
  expect(computeDiff({...base,tgtRows:[['data','0xf']],tgtBinaryCells:[[0,1]]}).error).toBe('invalid-binary')
 })
 it('uses SQL Server Unicode and mode-independent MySQL string escaping',()=>{
  const diff=computeDiff({srcColumns:['id','v'],tgtColumns:['id','v'],pkNames:['id'],srcRows:[[1,"中文\\'"]],tgtRows:[]})
  expect(genSyncStatements(diff,'dbo','t',{engine:'sqlserver',allowDelete:true})[0]).toContain("N'中文")
  expect(genSyncStatements(diff,'db','t',{engine:'mysql',allowDelete:true})[0]).toContain("CONVERT(X'")
 })
})
