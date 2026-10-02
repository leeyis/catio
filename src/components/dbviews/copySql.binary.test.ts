import {describe,it,expect} from 'vitest'
import {buildInsertSql,buildUpdateSql} from './copySql'

describe('typed binary SQL clipboard',()=>{
  it('uses byte literals only for the tagged cells',()=>{
    expect(buildInsertSql([['0x00ff','0x00ff'],['0x','0x']], 't',['bytes','text'],'sqlite',undefined,[[0,0],[1,0]]))
      .toBe('INSERT INTO "t" ("bytes", "text") VALUES (X\'00ff\', \'0x00ff\');\nINSERT INTO "t" ("bytes", "text") VALUES (X\'\', \'0x\');')
  })
  it('uses binary key predicates and keeps text columns as text',()=>{
    expect(buildUpdateSql([['0xff','0xff']], 't',['id','text'],'postgres',undefined,['id'],undefined,[[0,0]]))
      .toBe('UPDATE "t" SET "text" = \'0xff\' WHERE "id" = decode(\'ff\', \'hex\');')
  })
  it('never copies malformed binary as executable SQL',()=>{
    expect(()=>buildInsertSql([['0xf']], 't',['b'],'mysql',undefined,[[0,0]])).toThrow(/hexadecimal/i)
  })
})
