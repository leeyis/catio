import {beforeEach,expect,it,vi} from 'vitest'
const api=vi.hoisted(()=>({native:false,server:true,rpc:vi.fn(),invalidate:vi.fn(),subscribe:vi.fn(),ready:vi.fn(),off:vi.fn()}))
vi.mock('./transport',()=>({rpc:api.rpc,isTauri:()=>api.native,isServer:()=>api.server,subscribe:api.subscribe,ensureSubscription:api.ready}))
vi.mock('./dbMetadata',async importOriginal=>({...await importOriginal<typeof import('./dbMetadata')>(),invalidateSchemaCache:api.invalidate}))
import {cancelSqlFile,onSqlFileProgress,runSqlFile,sqlFilePreview,sqlFilePreviewBytes} from './db'
beforeEach(()=>{api.native=false;api.server=true;api.rpc.mockReset().mockResolvedValue(undefined);api.invalidate.mockReset();api.subscribe.mockReset().mockResolvedValue(api.off);api.ready.mockReset().mockResolvedValue(undefined);api.off.mockReset()})
it('web execution uploads previewed bytes, never the desktop filePath',async()=>{
  const webFile={fileName:'query.sql',dataBase64:btoa('SELECT 1;')}
  await sqlFilePreviewBytes('owned',webFile)
  expect(api.rpc).toHaveBeenLastCalledWith('db_sql_file_preview_bytes',{connId:'owned',...webFile})
  const args={connId:'owned',executionId:'file-1',filePath:'/never/read/server.sql',continueOnError:false,expectedFingerprint:'preview-hash',webFile}
  await runSqlFile(args)
  expect(api.rpc).toHaveBeenLastCalledWith('db_run_sql_file_bytes',{connId:'owned',executionId:'file-1',continueOnError:false,expectedFingerprint:'preview-hash',...webFile})
  await expect(sqlFilePreview('owned','/server/secret')).rejects.toThrow('Tauri')
})
it('web execution without uploaded bytes is rejected rather than falling back to a server path',async()=>{
  await expect(runSqlFile({connId:'owned',executionId:'file-1',filePath:'/server/secret',continueOnError:false})).rejects.toThrow('browser SQL file')
  expect(api.rpc).not.toHaveBeenCalled()
})
it('native execution keeps the path and carries preview fingerprint, without browser bytes',async()=>{
  api.native=true;api.server=false
  await runSqlFile({connId:'owned',executionId:'file-1',filePath:'local.sql',continueOnError:true,expectedFingerprint:'hash'})
  expect(api.rpc).toHaveBeenCalledWith('db_run_sql_file',{req:{connId:'owned',executionId:'file-1',filePath:'local.sql',continueOnError:true,expectedFingerprint:'hash'}})
})
it('invalidates metadata only after a terminal response, including unknown transport outcomes',async()=>{
  let finish!:(value:unknown)=>void;api.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const request={connId:'owned',executionId:'file-1',filePath:'unused.sql',continueOnError:false,webFile:{fileName:'local.sql',dataBase64:'AA=='}}
  const running=runSqlFile(request);expect(api.invalidate).not.toHaveBeenCalled()
  finish({status:'cancelled'});await running;expect(api.invalidate).toHaveBeenCalledWith('owned')
  api.invalidate.mockClear();api.rpc.mockRejectedValueOnce(new Error('response lost'))
  await expect(runSqlFile(request)).rejects.toThrow('response lost');expect(api.invalidate).toHaveBeenCalledWith('owned')
})
it('cancellation is always scoped to a connection as well as execution ID',async()=>{
  await cancelSqlFile('file-1','owned');expect(api.rpc).toHaveBeenCalledWith('db_cancel_sql_file',{connId:'owned',executionId:'file-1'})
})
it('waits for the real web subscription receipt and cleans up failed subscriptions',async()=>{
  let release!:()=>void;api.ready.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve}))
  let resolved=false;const listening=onSqlFileProgress(()=>{}).then(off=>{resolved=true;return off})
  await vi.waitFor(()=>expect(api.ready).toHaveBeenCalledWith('db://sql-file-progress'));expect(resolved).toBe(false)
  release();expect(await listening).toBe(api.off)
  api.ready.mockRejectedValueOnce(new Error('subscription failed'))
  await expect(onSqlFileProgress(()=>{})).rejects.toThrow('subscription failed');expect(api.off).toHaveBeenCalledOnce()
})
