import {expect,it} from 'vitest'
import {defaultImportOptions,importPreviewMatches,mapImportByPosition,validImportOptions} from './importParsing'
it('supports explicit positional mapping including prototype-like names without guessing',()=>{
  const mapped=mapImportByPosition(['__proto__','constructor','extra'],['id','name'])
  expect(Object.keys(mapped)).toEqual(['__proto__','constructor','extra'])
  expect(mapped.__proto__).toBe('id');expect(mapped.constructor).toBe('name');expect(mapped.extra).toBe('')
})
it('defaults only delimited UTF-8 sources and validates all record bounds',()=>{
  expect(defaultImportOptions('book.xlsx')).toBeUndefined();expect(defaultImportOptions('a.JSON')).toBeUndefined()
  expect(defaultImportOptions('a.TSV')?.delimiter).toBe('\t')
  const valid=defaultImportOptions('a.csv')!
  for(const patch of [{headerRow:-1},{headerRow:1.5},{headerRow:NaN},{headerRow:1_000_001},{dataStartRow:0},{dataStartRow:1},{dataStartRow:Infinity},{delimiter:'，'},{delimiter:'"'}])expect(validImportOptions({...valid,...patch})).toBe(false)
  expect(validImportOptions({...valid,headerRow:0,dataStartRow:1})).toBe(true)
})
it('requires a backend receipt with every requested option intact',()=>{
  const options=defaultImportOptions('a.csv')!
  const preview={fileName:'a.csv',fileType:'csv',sizeBytes:1,columns:['id'],rows:[],totalRows:0,truncated:false,sourceFingerprint:'b'.repeat(64),parseOptions:options}
  expect(importPreviewMatches(preview,options)).toBe(true)
  expect(importPreviewMatches({...preview,parseOptions:null},options)).toBe(false)
  expect(importPreviewMatches({...preview,sourceFingerprint:'old'},options)).toBe(false)
  expect(importPreviewMatches({...preview,parseOptions:{...options,emptyStringAsNull:false}},options)).toBe(false)
})
