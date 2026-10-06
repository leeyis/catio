import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { TableImportDialog } from './TableImportDialog'

const importPreview=vi.fn(), importTable=vi.fn(), tableStructure=vi.fn(), dialogOpen=vi.fn()
vi.mock('../../services/db',()=>({
  importPreview:(...a:unknown[])=>importPreview(...a),importTable:(...a:unknown[])=>importTable(...a),
  tableStructure:(...a:unknown[])=>tableStructure(...a),dbErrMsg:(e:unknown)=>e instanceof Error?e.message:String(e),
}))
vi.mock('@tauri-apps/plugin-dialog',()=>({open:(...a:unknown[])=>dialogOpen(...a)}))
const wrap=(ui:React.ReactNode)=>render(<LanguageProvider>{ui}</LanguageProvider>)
const next=()=>fireEvent.click(screen.getByTestId('dbflow-next'))

describe('TableImportDialog',()=>{
  beforeAll(async()=>{await i18n.changeLanguage('en')})
  beforeEach(()=>{
    importPreview.mockReset();importTable.mockReset();tableStructure.mockReset();dialogOpen.mockReset()
    tableStructure.mockResolvedValue({comment:'',indexes:[],fks:[],columns:[
      {name:'user_id',type:'int',nullable:false,default:null,key:'PK',extra:'',comment:''},
      {name:'display_name',type:'text',nullable:true,default:null,key:'',extra:'',comment:''},
    ]})
  })
  it('previews, reviews the mapping, and imports exactly the mapped pairs',async()=>{
    dialogOpen.mockResolvedValue('/data/users.csv')
    importPreview.mockResolvedValue({fileName:'users.csv',fileType:'csv',sizeBytes:100,columns:['user_id','display_name'],rows:[['1','Ada'],['2','Linus']],totalRows:2,truncated:false})
    importTable.mockResolvedValue({rowsImported:2,totalRows:2})
    wrap(<TableImportDialog connId="c1" schema="public" table="users" onClose={()=>{}} />)
    expect(screen.getByTestId('dbflow-next')).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText('Ada')
    next();expect(screen.getByLabelText('Map user_id')).toHaveValue('user_id');expect(screen.getByLabelText('Map display_name')).toHaveValue('display_name')
    next();const run=screen.getByRole('button',{name:/Import 2 column/i});expect(run).toBeEnabled();fireEvent.click(run)
    await waitFor(()=>expect(importTable).toHaveBeenCalledTimes(1))
    expect(importTable).toHaveBeenCalledWith({connId:'c1',schema:'public',table:'users',filePath:'/data/users.csv',mode:'append',mappings:[{sourceColumn:'user_id',targetColumn:'user_id'},{sourceColumn:'display_name',targetColumn:'display_name'}]})
    expect(await screen.findByText(/Imported 2 row/i)).toBeInTheDocument()
  })
  it('skips unmapped columns and requires exact target confirmation for replacement',async()=>{
    dialogOpen.mockResolvedValue('/data/x.csv')
    importPreview.mockResolvedValue({fileName:'x.csv',fileType:'csv',sizeBytes:50,columns:['user_id','junk'],rows:[['1','z']],totalRows:1,truncated:false})
    importTable.mockResolvedValue({rowsImported:1,totalRows:1})
    wrap(<TableImportDialog connId="c1" schema="public" table="users" onClose={()=>{}} />)
    fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await screen.findByText('z');next()
    expect(screen.getByLabelText('Map junk')).toHaveValue('')
    fireEvent.click(screen.getByRole('button',{name:'Replace existing rows'}));next()
    const run=screen.getByRole('button',{name:/Import 1 column/i});expect(run).toBeDisabled();expect(importTable).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox',{name:/Type users to confirm/i}),{target:{value:'users'}});fireEvent.click(run)
    await waitFor(()=>expect(importTable).toHaveBeenCalledTimes(1))
    expect(importTable.mock.calls[0][0]).toMatchObject({mode:'truncate',allowDestructive:true,mappings:[{sourceColumn:'user_id',targetColumn:'user_id'}]})
  })
  it('offers Excel extensions in the file picker',async()=>{
    dialogOpen.mockResolvedValue(null)
    wrap(<TableImportDialog connId="c1" table="users" onClose={()=>{}} />)
    fireEvent.click(screen.getByRole('button',{name:'Choose file'}));await waitFor(()=>expect(dialogOpen).toHaveBeenCalledTimes(1))
    expect(dialogOpen.mock.calls[0][0].filters[0].extensions).toEqual(expect.arrayContaining(['csv','tsv','json','xlsx','xlsm','xls']))
  })
  it('surfaces a preview error without writing',async()=>{
    dialogOpen.mockResolvedValue('/data/bad.xlsx');importPreview.mockRejectedValue(new Error('Excel import not supported'))
    wrap(<TableImportDialog connId="c1" table="users" onClose={()=>{}} />)
    fireEvent.click(screen.getByRole('button',{name:'Choose file'}))
    expect(await screen.findByText(/Excel import not supported/)).toBeInTheDocument();expect(importTable).not.toHaveBeenCalled()
  })
})
