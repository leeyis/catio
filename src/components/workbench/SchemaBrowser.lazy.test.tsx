import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import i18n from '../../i18n'
import {SchemaBrowser} from './SchemaBrowser'
const api=vi.hoisted(()=>({searchSchemaObjects:vi.fn(),cancelMetadataSearch:vi.fn()}))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),...api}))
const noop=()=>{}
const wrap=(node:React.ReactNode)=>render(<LanguageProvider><DataProvider>{node}</DataProvider></LanguageProvider>)
beforeEach(async()=>{localStorage.clear();api.searchSchemaObjects.mockReset();api.cancelMetadataSearch.mockResolvedValue(undefined);await i18n.changeLanguage('en')})
it('does not pretend an unloaded namespace contains zero tables and loads only when expanded',()=>{
 const load=vi.fn()
 wrap(<SchemaBrowser live connId="c" schemas={[{name:'APP',status:'unloaded',tables:[],views:[],functions:[]}]} onLoadNamespace={load}
   onPick={noop} active={null} onNewQuery={noop} onOpenER={noop} erActive={false} sqlActive={false}/>)
 expect(load).not.toHaveBeenCalled();expect(screen.getByText('Not loaded')).toBeInTheDocument()
 fireEvent.click(screen.getByTestId('schema-node:APP'));expect(load).toHaveBeenCalledWith('APP')
})
it('shows a namespace error and offers an explicit retry instead of an empty tree',()=>{
 const load=vi.fn()
 wrap(<SchemaBrowser live connId="c" schemas={[{name:'APP',status:'error',error:'permission denied',tables:[],views:[],functions:[]}]} onLoadNamespace={load}
   onPick={noop} active={null} onNewQuery={noop} onOpenER={noop} erActive={false} sqlActive={false}/>)
 fireEvent.click(screen.getByTestId('schema-node:APP'))
 expect(screen.getByRole('alert')).toHaveTextContent('permission denied')
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(load).toHaveBeenCalledWith('APP',true)
})
it('searches across unloaded namespaces rather than only filtering loaded nodes',async()=>{
 const pick=vi.fn();api.searchSchemaObjects.mockResolvedValue({objects:[{schema:'UNOPENED',name:'needle',kind:'table'}],errors:[],truncated:false,cancelled:false})
 wrap(<SchemaBrowser live connId="c" schemas={[{name:'UNOPENED',status:'unloaded',tables:[],views:[],functions:[]}]} onLoadNamespace={noop}
   onPick={pick} active={null} onNewQuery={noop} onOpenER={noop} erActive={false} sqlActive={false}/>)
 fireEvent.change(screen.getByPlaceholderText('Search tables / views…'),{target:{value:'needle'}})
 await waitFor(()=>expect(api.searchSchemaObjects).toHaveBeenCalledWith('c','needle',expect.any(String)))
 fireEvent.click(await screen.findByRole('button',{name:'UNOPENED.needle'}));expect(pick).toHaveBeenCalledWith('UNOPENED','needle')
})
