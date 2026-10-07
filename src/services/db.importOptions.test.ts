import {beforeEach,expect,it,vi} from 'vitest'
const api=vi.hoisted(()=>({native:false,server:true,rpc:vi.fn()}))
vi.mock('./transport',()=>({rpc:api.rpc,isTauri:()=>api.native,isServer:()=>api.server}))
import {importPreview,importPreviewBytes,importTable,importTableBytes} from './db'
const parseOptions={delimiter:';',headerRow:0,dataStartRow:1,trimValues:true,emptyStringAsNull:false}
const review={connId:'owned',table:'target',mappings:[{sourceColumn:'column_1',targetColumn:'name'}],mode:'append' as const,parseOptions,sourceFingerprint:'a'.repeat(64)}
beforeEach(()=>{api.native=false;api.server=true;api.rpc.mockReset().mockResolvedValue({})})
it('carries the same options and fingerprint over browser bytes without a server path',async()=>{
  const file={fileName:'test.csv',dataBase64:'YQ=='}
  await importPreviewBytes(file,parseOptions)
  expect(api.rpc).toHaveBeenLastCalledWith('db_import_preview_bytes',{...file,parseOptions})
  await importTableBytes({...review,...file})
  expect(api.rpc).toHaveBeenLastCalledWith('db_import_table_bytes',{...review,...file})
  await expect(importPreview('/server/file.csv',parseOptions)).rejects.toThrow('Tauri')
})
it('carries the same options and fingerprint through native commands',async()=>{
  api.native=true;api.server=false
  await importPreview('local.csv',parseOptions)
  expect(api.rpc).toHaveBeenLastCalledWith('db_import_preview',{filePath:'local.csv',parseOptions})
  await importTable({...review,filePath:'local.csv'})
  expect(api.rpc).toHaveBeenLastCalledWith('db_import_table',{...review,filePath:'local.csv'})
  await expect(importPreviewBytes({fileName:'x',dataBase64:'AA=='})).rejects.toThrow('server mode')
})
