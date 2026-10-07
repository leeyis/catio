import {act, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import i18n from '../../i18n'
import {TableImportDialog} from './TableImportDialog'

const h=vi.hoisted(()=>({preview:vi.fn(),write:vi.fn(),open:vi.fn(),structure:vi.fn(),previewBytes:vi.fn(),writeBytes:vi.fn()}))
vi.mock('../../services/db',()=>({importPreview:h.preview,importTable:h.write,tableStructure:h.structure,importPreviewBytes:h.previewBytes,importTableBytes:h.writeBytes,dbErrMsg:(e:Error)=>e.message}))
vi.mock('@tauri-apps/plugin-dialog',()=>({open:h.open}))
const options={delimiter:',',headerRow:1,dataStartRow:2,trimValues:false,emptyStringAsNull:true}
const receipt=(overrides={})=>({fileName:'rows.csv',fileType:'csv',sizeBytes:12,columns:['id','name'],rows:[['1','Ada']],totalRows:1,truncated:false,parseOptions:options,sourceFingerprint:'a'.repeat(64),...overrides})
const mount=()=>render(<LanguageProvider><TableImportDialog connId="c" schema="main" table="target" onClose={vi.fn()}/></LanguageProvider>)
const next=()=>fireEvent.click(screen.getByTestId('dbflow-next'))
async function choose(){fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText('Ada')}
beforeEach(async()=>{vi.clearAllMocks();localStorage.clear();await i18n.changeLanguage('en');h.open.mockResolvedValue('/qa/rows.csv');h.structure.mockResolvedValue({columns:[{name:'id',type:'int'},{name:'name',type:'text'}]});h.preview.mockResolvedValue(receipt());h.write.mockResolvedValue({rowsImported:1,totalRows:1})})
afterEach(()=>{delete (window as unknown as Record<string,unknown>).__CATIO_SERVER__})

it('invalidates the preview and mapping, then executes only reviewed parsing options and fingerprint',async()=>{
  mount();await choose();next();fireEvent.change(screen.getByLabelText('Map name'),{target:{value:''}});fireEvent.click(screen.getByTestId('dbflow-back'))
  fireEvent.change(screen.getByLabelText('Delimiter'),{target:{value:';'}})
  expect(screen.getByTestId('dbflow-next')).toBeDisabled();expect(screen.queryByText('Ada')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Header record (0 = no header)'),{target:{value:'0'}})
  fireEvent.click(screen.getByLabelText('Preserve empty fields as empty strings'))
  const chosen={...options,delimiter:';',headerRow:0,dataStartRow:1,emptyStringAsNull:false}
  h.preview.mockResolvedValue(receipt({columns:['column_1','column_2'],parseOptions:chosen,sourceFingerprint:'b'.repeat(64)}))
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByText('Ada');next()
  fireEvent.click(screen.getByRole('button',{name:'Map by position'}));expect(screen.getByLabelText('Map column_1')).toHaveValue('id');expect(screen.getByLabelText('Map column_2')).toHaveValue('name')
  next();expect(screen.getByTestId('dbimport-review')).toHaveTextContent('No header');expect(h.write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('dbimport-run'));await waitFor(()=>expect(h.write).toHaveBeenCalledTimes(1))
  expect(h.write.mock.calls[0][0]).toMatchObject({parseOptions:chosen,sourceFingerprint:'b'.repeat(64),mappings:[{sourceColumn:'column_1',targetColumn:'id'},{sourceColumn:'column_2',targetColumn:'name'}]})
})
it('keeps prototype-like source names as ordinary keys during mapping initialization',async()=>{
  h.preview.mockResolvedValue(receipt({columns:['__proto__','constructor'],rows:[['x','y']]}))
  mount();fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText('x');next()
  expect(screen.getByLabelText('Map __proto__')).toHaveValue('');expect(screen.getByLabelText('Map constructor')).toHaveValue('')
  fireEvent.click(screen.getByRole('button',{name:'Map by position'}));expect(screen.getByLabelText('Map constructor')).toHaveValue('name')
})
it('retains a selected file after parsing failure so options can be corrected without choosing it again',async()=>{
  h.preview.mockRejectedValueOnce(new Error('wrong header'));mount();fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText('wrong header')
  fireEvent.change(screen.getByLabelText('Header record (0 = no header)'),{target:{value:'2'}})
  h.preview.mockResolvedValue(receipt({parseOptions:{...options,headerRow:2,dataStartRow:3}}))
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByText('Ada');expect(h.open).toHaveBeenCalledTimes(1);expect(screen.getByTestId('dbflow-next')).toBeEnabled()
})
it('refuses a preview that did not confirm the requested parser or fingerprint',async()=>{
  h.preview.mockResolvedValue(receipt({sourceFingerprint:undefined}));mount();fireEvent.click(screen.getByRole('button',{name:'Choose file'}))
  await screen.findByRole('alert');expect(screen.getByTestId('dbflow-next')).toBeDisabled()
  h.preview.mockResolvedValue(receipt());fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByText('Ada')
  fireEvent.change(screen.getByLabelText('Delimiter'),{target:{value:';'}})
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByRole('alert');expect(screen.getByTestId('dbflow-next')).toBeDisabled();expect(h.write).not.toHaveBeenCalled()
})
it('validates record numbers and prevents racing option changes while preparing',async()=>{
  mount();await choose()
  fireEvent.change(screen.getByLabelText('Header record (0 = no header)'),{target:{value:'1.5'}})
  expect(screen.getByRole('button',{name:'Update preview'})).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Header record (0 = no header)'),{target:{value:'1'}})
  fireEvent.change(screen.getByLabelText('First data record'),{target:{value:'1'}})
  expect(screen.getByRole('button',{name:'Update preview'})).toBeDisabled()
  fireEvent.change(screen.getByLabelText('First data record'),{target:{value:'3'}})
  let resolve!:(v:ReturnType<typeof receipt>)=>void;h.preview.mockReturnValue(new Promise(r=>{resolve=r}))
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await waitFor(()=>expect(h.preview).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText('Delimiter')).toBeDisabled();expect(screen.getByTestId('dbflow-next')).toBeDisabled()
  await act(async()=>resolve(receipt({parseOptions:{...options,dataStartRow:3}})));expect(screen.getByTestId('dbflow-next')).toBeEnabled()
})
it('re-previews the same browser bytes and resets CSV options when selecting JSON',async()=>{
  ;(window as unknown as Record<string,unknown>).__CATIO_SERVER__=true;h.previewBytes.mockResolvedValue(receipt());mount()
  const file=(name:string,contents:string)=>{const f=new File([contents],name);Object.defineProperty(f,'arrayBuffer',{value:async()=>new TextEncoder().encode(contents).buffer});return f}
  fireEvent.change(screen.getByTestId('browser-import-file'),{target:{files:[file('rows.csv','id,name\n1,Ada')]}});await screen.findByText('Ada')
  expect(screen.getByText(/CSV \/ TSV support header and no-header modes/)).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Trim surrounding whitespace'));h.previewBytes.mockResolvedValue(receipt({parseOptions:{...options,trimValues:true}}))
  fireEvent.click(screen.getByRole('button',{name:'Update preview'}));await screen.findByText('Ada')
  expect(h.previewBytes.mock.calls[1][0]).toEqual(h.previewBytes.mock.calls[0][0])
  h.previewBytes.mockResolvedValue(receipt({fileName:'rows.json',fileType:'json',parseOptions:null}))
  fireEvent.change(screen.getByTestId('browser-import-file'),{target:{files:[file('rows.json','[{"id":1,"name":"Ada"}]')]}})
  await screen.findByText('rows.json');await waitFor(()=>expect(screen.queryByLabelText('Delimiter')).not.toBeInTheDocument())
  next();next();h.writeBytes.mockResolvedValue({rowsImported:1,totalRows:1});fireEvent.click(screen.getByTestId('dbimport-run'));await waitFor(()=>expect(h.writeBytes).toHaveBeenCalledTimes(1))
  expect(h.writeBytes.mock.calls[0][0].parseOptions).toBeUndefined();expect(h.preview).not.toHaveBeenCalled()
})
