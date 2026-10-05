import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeAll,beforeEach,expect,it,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import i18n from '../../i18n'
import {DatabaseStructurePeek} from './DatabaseStructurePeek'
const api=vi.hoisted(()=>({catalog:vi.fn(),structure:vi.fn()}))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),loadSchemaNamespace:api.catalog,tableStructure:api.structure}))
const shape={comment:'',columns:[{name:'amount',type:'DECIMAL(28,9)',nullable:false,default:null,key:'',comment:''}],indexes:[],fks:[]}
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{api.catalog.mockReset().mockResolvedValue({name:'main',tables:[{name:'orders'}],views:[],functions:[],status:'loaded'});api.structure.mockReset().mockResolvedValue(shape)})
const show=()=>render(<LanguageProvider><DatabaseStructurePeek connId="c" schemas={['main','archive']} defaultSchema="main" onClose={()=>{}}/></LanguageProvider>)
it('loads metadata only after an explicit object choice, preserving schema and type precision',async()=>{show();await screen.findByRole('option',{name:'orders'});expect(api.structure).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText('Object'),{target:{value:'orders'}});await screen.findByText(/DECIMAL\(28,9\)/);expect(api.structure).toHaveBeenCalledWith('c','main','orders')})
it('ignores old metadata replies after namespace changes',async()=>{let done!:(v:unknown)=>void;api.structure.mockReturnValueOnce(new Promise(resolve=>{done=resolve}));show();await screen.findByRole('option',{name:'orders'});fireEvent.change(screen.getByLabelText('Object'),{target:{value:'orders'}});await waitFor(()=>expect(api.structure).toHaveBeenCalledTimes(1));fireEvent.change(screen.getByLabelText('Default DB / schema'),{target:{value:'archive'}});await act(async()=>{done(shape)});expect(screen.queryByText(/DECIMAL\(28,9\)/)).toBeNull();expect(api.catalog).toHaveBeenLastCalledWith('c','archive')})
it('surfaces metadata failure and supports retry without changing query context',async()=>{api.catalog.mockRejectedValueOnce(new Error('offline'));show();expect(await screen.findByRole('alert')).toHaveTextContent('offline');fireEvent.click(screen.getByText('Retry'));await screen.findByRole('option',{name:'orders'});expect(api.catalog).toHaveBeenCalledTimes(2);expect(api.structure).not.toHaveBeenCalled()})
