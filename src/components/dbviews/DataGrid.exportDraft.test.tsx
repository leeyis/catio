import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DataGrid } from './DataGrid'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'

const api=vi.hoisted(()=>({web:false,exportXlsx:vi.fn(),exportXlsxBytes:vi.fn(),save:vi.fn()}))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),exportXlsx:api.exportXlsx,exportXlsxBytes:api.exportXlsxBytes}))
vi.mock('../../services/transport',async original=>({...await original<typeof import('../../services/transport')>(),isServer:()=>api.web}))
vi.mock('@tauri-apps/plugin-dialog',()=>({save:api.save}))
beforeEach(async()=>{
  vi.clearAllMocks(); localStorage.clear(); await i18n.changeLanguage('en')
  api.save.mockResolvedValue('export.xlsx');api.exportXlsx.mockResolvedValue(undefined);api.exportXlsxBytes.mockResolvedValue(new Uint8Array([1,2]))
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:qa')})
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()})
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
})
afterEach(()=>{delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;vi.restoreAllMocks()})
it.each([false,true])('exports committed cell drafts consistently in XLSX (Web=%s)',async web=>{
  api.web=web
  if(!web)Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{}})
  render(<LanguageProvider><DataGrid connId="qa" table="draft_export" columns={[{name:'id',type:'int',pk:true},{name:'amount',type:'text'}]} rows={[[1,'1.2300'],[2,'900719925474099312345']]}/></LanguageProvider>)
  fireEvent.doubleClick(screen.getByText('1.2300'))
  const input=screen.getByDisplayValue('1.2300')
  fireEvent.change(input,{target:{value:'1.4500'}});fireEvent.keyDown(input,{key:'Enter'})
  fireEvent.click(screen.getByRole('button',{name:'Export'}))
  expect(screen.getByText(/Current page.*cell drafts/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Excel'}))
  const call=web?api.exportXlsxBytes:api.exportXlsx
  await waitFor(()=>expect(call).toHaveBeenCalledTimes(1))
  expect(call.mock.calls[0][0]).toMatchObject({rows:[[1,'1.4500'],[2,'900719925474099312345']]})
  expect(screen.getByTitle('Save edits')).toBeInTheDocument()
})
