import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataGrid } from './DataGrid'

const api=vi.hoisted(()=>({ tablePreview:vi.fn(), previewDml:vi.fn(), applyEdits:vi.fn() }))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),...api}))
const wrap=(node:React.ReactNode)=>render(<LanguageProvider>{node}</LanguageProvider>)
function change(value:string,next:string) {
  fireEvent.doubleClick(screen.getAllByText(value).find(e=>e.closest('.gridrow'))!)
  const input=screen.getByDisplayValue(value)
  fireEvent.change(input,{target:{value:next}})
  fireEvent.keyDown(input,{key:'Enter'})
}
beforeEach(async()=>{localStorage.clear();Object.values(api).forEach(m=>m.mockReset());api.previewDml.mockResolvedValue('-- SQL');await i18n.changeLanguage('en')})

describe('binary grid protocol',()=>{
  it('edits binary values and uses a binary primary key without guessing text',async()=>{
    wrap(<DataGrid connId="c" table="mixed" engine="sqlite" livePreview
      columns={[{name:'id',type:'TEXT',pk:true},{name:'payload',type:'BLOB'}]}
      rows={[["0x00ff","0x1122"]]} binaryCells={[[0,0],[0,1]]} />)
    change('0x1122','0xaabb')
    fireEvent.click(screen.getByTitle('Save edits'))
    await waitFor(()=>expect(api.previewDml).toHaveBeenCalledWith('c',expect.objectContaining({
      pk:[['id','0x00ff']],cells:[['payload','0xaabb']],binaryPkColumns:['id'],binaryColumns:['payload'],
    })))
  })
  it('explicitly identifies a hex-looking TEXT key as non-binary',async()=>{
    wrap(<DataGrid connId="c" table="mixed" engine="sqlite" livePreview
      columns={[{name:'id',type:'TEXT',pk:true},{name:'payload',type:'TEXT'}]}
      rows={[["0x00ff","original"]]} binaryCells={[]} />)
    change('original','changed')
    fireEvent.click(screen.getByTitle('Save edits'))
    await waitFor(()=>expect(api.previewDml).toHaveBeenCalledWith('c',expect.objectContaining({binaryPkColumns:[],binaryColumns:[]})))
  })
  it('rejects malformed hex before preview or save',()=>{
    wrap(<DataGrid connId="c" table="mixed" engine="sqlite" livePreview
      columns={[{name:'id',type:'INT',pk:true},{name:'payload',type:'BLOB'}]}
      rows={[[1,'0x1122']]} binaryCells={[[0,1]]} />)
    change('0x1122','0xf')
    expect(screen.getByRole('alert')).toHaveTextContent('hexadecimal')
    expect(api.previewDml).not.toHaveBeenCalled()
    expect(screen.queryByTitle('Save edits')).not.toBeInTheDocument()
  })
  it('remaps binary coordinates after a ctid column is removed on a later page',async()=>{
    api.tablePreview.mockResolvedValue({columns:[{name:'__ctid',type:'tid'},{name:'id',type:'bytea'},{name:'v',type:'text'}],
      rows:[['(0,2)','0x00ff','second']],binaryCells:[[0,1]],truncated:false})
    wrap(<DataGrid connId="c" table="mixed" engine="postgres" livePreview truncated
      columns={[{name:'id',type:'bytea',pk:true},{name:'v',type:'text'}]}
      rows={[["0x0001","first"]]} binaryCells={[[0,0]]} />)
    fireEvent.click(screen.getByRole('button',{name:'Next page'}))
    await screen.findByText('second')
    change('second','changed')
    fireEvent.click(screen.getByTitle('Save edits'))
    await waitFor(()=>expect(api.previewDml).toHaveBeenCalledWith('c',expect.objectContaining({binaryPkColumns:['id'],pk:[['id','0x00ff']]})))
  })
})
