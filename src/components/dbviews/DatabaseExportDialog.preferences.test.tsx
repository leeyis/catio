import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { DatabaseExportDialog } from './DatabaseExportDialog'
const h=vi.hoisted(()=>({native:false,server:false,reveal:vi.fn()}))
vi.mock('../../services/transport',async original=>({...await original<typeof import('../../services/transport')>(),isTauri:()=>h.native,isServer:()=>h.server}))
vi.mock('@tauri-apps/plugin-opener',()=>({revealItemInDir:h.reveal}))
const KEY='catio:database:export-options:v1'
const draw=(onExport=vi.fn().mockResolvedValue({kind:'saved',name:'C:\\qa\\public.sql'}))=>render(<DatabaseExportDialog connId="private-connection" schema="private-schema" allTables={['zebra','Alpha','beta']} onClose={vi.fn()} onExport={onExport}/> )
beforeEach(async()=>{localStorage.clear();vi.clearAllMocks();h.native=false;h.server=false;h.reveal.mockResolvedValue(undefined);await i18n.changeLanguage('en')})
afterEach(()=>vi.restoreAllMocks())
it('waits for the first successful table load, then selects it without including later arrivals',()=>{
  const onExport=vi.fn().mockResolvedValue({kind:'download',name:'main.sql'})
  const props={schema:'main',onClose:vi.fn(),onExport}
  const ui=render(<DatabaseExportDialog {...props} allTables={[]} tablesState="loading"/>)
  expect(screen.getByRole('status')).toHaveTextContent('Loading tables')
  expect(screen.queryByText('No tables to export')).not.toBeInTheDocument()
  expect(screen.getByTestId('dbflow-next')).toBeDisabled()
  ui.rerender(<DatabaseExportDialog {...props} allTables={['one']} tablesState="ready"/>)
  expect(screen.getByTestId('dbexport-tbl:one')).toHaveAttribute('aria-pressed','true')
  fireEvent.click(screen.getByTestId('dbflow-next'))
  ui.rerender(<DatabaseExportDialog {...props} allTables={['one','late']} tablesState="ready"/>)
  expect(screen.getByTestId('dbexport-review')).not.toHaveTextContent('late')
})
it('shows catalog failure rather than an empty database and exposes retry',()=>{
  const retry=vi.fn()
  render(<DatabaseExportDialog schema="main" allTables={[]} tablesState="error" tableError="catalog denied" onReloadTables={retry} onClose={vi.fn()} onExport={vi.fn()}/>)
  expect(screen.getByRole('alert')).toHaveTextContent('catalog denied')
  expect(screen.queryByText('No tables to export')).not.toBeInTheDocument()
  expect(screen.getByTestId('dbflow-next')).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'Reload tables'}));expect(retry).toHaveBeenCalledTimes(1)
})
it('sorts the picker and the frozen review without mutating catalog order',()=>{
  draw()
  expect(screen.getAllByTestId(/^dbexport-tbl:/).map(e=>e.textContent)).toEqual(['Alpha','beta','zebra'])
  fireEvent.click(screen.getByTestId('dbflow-next'))
  expect(screen.getByTestId('dbexport-review')).toHaveTextContent('Alpha, beta, zebra')
})
it('remembers only validated options on review, never targets, paths or selected objects',()=>{
  const ui=draw()
  fireEvent.click(screen.getByTestId('dbexport-opt-structure'))
  fireEvent.change(screen.getByTestId('dbexport-batch'),{target:{value:'250'}})
  fireEvent.change(screen.getByTestId('dbexport-rowlimit'),{target:{value:'42'}})
  fireEvent.click(screen.getByTestId('dbexport-tbl:zebra'))
  expect(localStorage.getItem(KEY)).toBeNull()
  fireEvent.click(screen.getByTestId('dbflow-next'))
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({includeStructure:false,includeData:true,batchSize:250,rowLimit:42})
  ui.unmount();draw()
  expect(screen.getByTestId('dbexport-opt-structure')).toHaveAttribute('aria-pressed','false')
  expect(screen.getByTestId('dbexport-batch')).toHaveValue(250)
  expect(screen.getByTestId('dbexport-rowlimit')).toHaveValue(42)
  expect(screen.getByTestId('dbexport-tbl:zebra')).toHaveAttribute('aria-pressed','true')
})
it('normalizes corrupt options and reports blocked storage without blocking export',()=>{
  localStorage.setItem(KEY,JSON.stringify({includeData:false,includeStructure:false,batchSize:-3,rowLimit:1e30,path:'/private'}))
  draw()
  expect(screen.getByTestId('dbflow-next')).toBeEnabled()
  expect(screen.getByTestId('dbexport-batch')).toHaveValue(null)
  const deny=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked')})
  fireEvent.click(screen.getByTestId('dbflow-next'))
  expect(screen.getByRole('alert')).toHaveTextContent('preferences could not be saved')
  expect(screen.getByTestId('dbexport-run')).toBeEnabled()
  deny.mockRestore()
})
it('reveals the acknowledged native file only on request and preserves its saved receipt after reveal failure',async()=>{
  h.native=true
  const onExport=vi.fn().mockResolvedValue({kind:'saved',name:'C:\\qa\\public.sql'})
  draw(onExport);fireEvent.click(screen.getByTestId('dbflow-next'));fireEvent.click(screen.getByTestId('dbexport-run'))
  const reveal=await screen.findByRole('button',{name:'Show in folder'})
  expect(h.reveal).not.toHaveBeenCalled()
  h.reveal.mockRejectedValueOnce(new Error('Explorer unavailable'))
  fireEvent.click(reveal)
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Explorer unavailable'))
  expect(h.reveal).toHaveBeenCalledWith('C:\\qa\\public.sql')
  expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent('File saved successfully')
  expect(onExport).toHaveBeenCalledTimes(1)
})
it('serializes native reveal clicks and never dispatches a second export',async()=>{
  h.native=true
  let finish!:()=>void
  h.reveal.mockImplementation(()=>new Promise<void>(r=>{finish=r}))
  draw();fireEvent.click(screen.getByTestId('dbflow-next'));fireEvent.click(screen.getByTestId('dbexport-run'))
  const button=await screen.findByRole('button',{name:'Show in folder'})
  act(()=>{button.click();button.click()})
  await waitFor(()=>expect(h.reveal).toHaveBeenCalledTimes(1))
  await act(async()=>finish())
})
it.each(['download','cancelled'])('does not offer native file reveal for %s outcomes',async(kind)=>{
  h.native=true
  draw(vi.fn().mockResolvedValue({kind,name:'public.sql'}));fireEvent.click(screen.getByTestId('dbflow-next'));fireEvent.click(screen.getByTestId('dbexport-run'))
  await waitFor(()=>expect(screen.queryByText('Exporting…')).not.toBeInTheDocument())
  expect(screen.queryByRole('button',{name:'Show in folder'})).not.toBeInTheDocument()
  expect(h.reveal).not.toHaveBeenCalled()
})
