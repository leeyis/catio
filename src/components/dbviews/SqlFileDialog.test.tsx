import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest'
import {SqlFileDialog} from './SqlFileDialog'
import {LanguageProvider} from '../../state/LanguageContext'
import i18n from '../../i18n'
import type {SqlFileProgress} from './sqlFileRun'
const api=vi.hoisted(()=>({pick:vi.fn(),preview:vi.fn(),previewBytes:vi.fn(),run:vi.fn(),cancel:vi.fn(),listen:vi.fn(),off:vi.fn(),callback:null as ((p:SqlFileProgress)=>void)|null}))
vi.mock('@tauri-apps/plugin-dialog',()=>({open:api.pick}))
vi.mock('../../services/db',()=>({sqlFilePreview:api.preview,sqlFilePreviewBytes:api.previewBytes,runSqlFile:api.run,cancelSqlFile:api.cancel,onSqlFileProgress:api.listen,dbErrMsg:(e:unknown)=>String(e)}))
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{for(const [key,value] of Object.entries(api))if(key!=='callback')(value as ReturnType<typeof vi.fn>).mockReset();api.callback=null;api.pick.mockResolvedValue('fixture.sql');api.preview.mockResolvedValue({fileName:'fixture.sql',sizeBytes:12,statementCount:2});api.listen.mockImplementation(async(cb:(p:SqlFileProgress)=>void)=>{api.callback=cb;return api.off});api.cancel.mockResolvedValue(undefined)})
afterEach(()=>{delete (window as unknown as Record<string,unknown>).__CATIO_SERVER__;vi.unstubAllGlobals()})
it('uses a valid execution ID when randomUUID is unavailable on a non-secure LAN origin',async()=>{
  vi.stubGlobal('crypto',undefined);show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}))
  await waitFor(()=>expect(api.run).toHaveBeenCalled());expect(api.run.mock.calls[0][0].executionId).toMatch(/^[a-zA-Z0-9_-]+$/)
})
it('uploads browser bytes instead of using a native dialog or server path',async()=>{
  ;(window as unknown as Record<string,unknown>).__CATIO_SERVER__=true
  api.previewBytes.mockResolvedValue({fileName:'local.sql',sizeBytes:9,statementCount:2,fingerprint:'web-hash',encoding:'UTF-8'})
  show();const file=new File(['SELECT 1;'],'local.sql');Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('SELECT 1;').buffer})
  fireEvent.change(screen.getByTestId('browser-sql-file'),{target:{files:[file]}})
  await waitFor(()=>expect(screen.getByRole('button',{name:'Run (2)'})).toBeEnabled())
  expect(api.pick).not.toHaveBeenCalled();expect(api.preview).not.toHaveBeenCalled()
  expect(api.previewBytes).toHaveBeenCalledWith('isolated',{fileName:'local.sql',dataBase64:btoa('SELECT 1;')})
  fireEvent.click(screen.getByRole('button',{name:'Run (2)'}))
  await waitFor(()=>expect(api.run).toHaveBeenCalledWith(expect.objectContaining({webFile:{fileName:'local.sql',dataBase64:btoa('SELECT 1;')},expectedFingerprint:'web-hash'})))
})
it('rejects a browser file larger than the upload budget before reading it',async()=>{
  ;(window as unknown as Record<string,unknown>).__CATIO_SERVER__=true
  show();const file=new File([''],'too-large.sql'),read=vi.fn();Object.defineProperty(file,'size',{value:8*1024*1024+1});Object.defineProperty(file,'arrayBuffer',{value:read})
  fireEvent.change(screen.getByTestId('browser-sql-file'),{target:{files:[file]}})
  await screen.findByRole('alert');expect(read).not.toHaveBeenCalled();expect(api.previewBytes).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Run (0)'})).toBeDisabled()
})
function show(){const close=vi.fn();const view=render(<LanguageProvider><SqlFileDialog connId="isolated" onClose={close}/></LanguageProvider>);return {close,...view}}
async function choose(){fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Run (2)'})).toBeEnabled())}
it('clears an old preview when the replacement file fails to parse',async()=>{show();await choose();api.preview.mockRejectedValueOnce(new Error('bad encoding'));fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText(/bad encoding/);expect(screen.getByRole('button',{name:'Run (0)'})).toBeDisabled();expect(api.run).not.toHaveBeenCalled()})
it('does not start a late subscription after the dialog has unmounted',async()=>{let ready!:(value:()=>void)=>void;api.listen.mockImplementation(()=>new Promise(resolve=>{ready=resolve}));const view=show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));view.unmount();await act(async()=>{ready(api.off)});expect(api.off).toHaveBeenCalledTimes(1);expect(api.run).not.toHaveBeenCalled()})
it('cancels before dispatch if the listener is still being prepared',async()=>{let ready!:(value:()=>void)=>void;api.listen.mockImplementation(()=>new Promise(resolve=>{ready=resolve}));show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));fireEvent.click(screen.getByRole('button',{name:'Cancel run'}));await act(async()=>{ready(api.off)});expect(api.run).not.toHaveBeenCalled();expect(api.cancel).not.toHaveBeenCalled();expect(screen.getByText('Cancelled')).toBeInTheDocument()})
it('does not claim success when the native command returns without a terminal receipt',async()=>{api.run.mockResolvedValue(undefined);show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await screen.findByText(/without a terminal progress receipt/);expect(screen.queryByText(/Done —/)).toBeNull();expect(api.off).toHaveBeenCalledTimes(1)})
it('uses the cancellation banner, not a duplicate raw English error, for a confirmed cancellation',async()=>{
  api.run.mockImplementation(async(args)=>({executionId:args.executionId,status:'cancelled',statementIndex:1,total:2,successCount:0,failureCount:0,affectedRows:0,elapsedMs:3,statementSummary:'',error:'query cancelled'}))
  show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await screen.findByText('Cancelled');expect(screen.queryByText('query cancelled')).toBeNull()
})
it('accepts a terminal RPC receipt even if the event was lost and binds execution to the preview',async()=>{
  api.preview.mockResolvedValue({fileName:'fixture.sql',sizeBytes:12,statementCount:2,fingerprint:'qa-hash',encoding:'UTF-8'})
  api.run.mockImplementation(async(args)=>({executionId:args.executionId,status:'done',statementIndex:2,total:2,successCount:2,failureCount:0,affectedRows:1,elapsedMs:3,statementSummary:'',error:null}))
  show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await screen.findByText('Done — 2 succeeded, 0 failed')
  expect(api.run).toHaveBeenCalledWith(expect.objectContaining({expectedFingerprint:'qa-hash'}))
})
it('requires an explicit database-verification acknowledgement before replaying a previous run',async()=>{
  api.run.mockImplementation(async(args)=>({executionId:args.executionId,status:'error',statementIndex:1,total:2,successCount:1,failureCount:0,affectedRows:1,elapsedMs:3,statementSummary:'',error:'verify before retry'}))
  show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await screen.findByText('verify before retry')
  fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));expect(api.run).toHaveBeenCalledTimes(1)
  fireEvent.click(await screen.findByRole('button',{name:'Database checked — run again'}));await waitFor(()=>expect(api.run).toHaveBeenCalledTimes(2))
})
it('surfaces preparation and terminal errors carried in the real receipt',async()=>{
  api.run.mockImplementation(async(args)=>({executionId:args.executionId,status:'error',statementIndex:0,total:0,successCount:0,failureCount:0,affectedRows:0,elapsedMs:3,statementSummary:'',error:'SQL file changed after preview'}))
  show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await screen.findByText('SQL file changed after preview');expect(screen.queryByText(/Done —/)).toBeNull()
})
it('keeps close blocked until the active command returns, and reports cancellation failure',async()=>{let finish!:()=>void;api.run.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}));api.cancel.mockRejectedValueOnce(new Error('cancel unavailable'));const view=show();await choose();fireEvent.click(screen.getByRole('button',{name:'Run (2)'}));await waitFor(()=>expect(api.run).toHaveBeenCalledTimes(1));fireEvent.click(screen.getByRole('button',{name:'Cancel run'}));await screen.findByText(/cancel unavailable/);expect(view.close).not.toHaveBeenCalled();const id=api.run.mock.calls[0][0].executionId;await act(async()=>{api.callback?.({executionId:id,status:'done',statementIndex:2,total:2,successCount:2,failureCount:0,affectedRows:3,elapsedMs:10,statementSummary:'',error:null});finish()});await screen.findByText('Done — 2 succeeded, 0 failed');expect(screen.getByRole('button',{name:'Close'})).toBeEnabled();expect(api.run).toHaveBeenCalledTimes(1)})
