import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeAll,beforeEach,expect,it,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import i18n from '../../i18n'
import {NewConnectionModal} from './NewConnectionModal'
const api=vi.hoisted(()=>({test:vi.fn(),connect:vi.fn(),save:vi.fn()}))
vi.mock('../../services/db',async orig=>({...await orig<typeof import('../../services/db')>(),testConnection:api.test,dbConnect:api.connect}))
vi.mock('../../state/dbConnections',async orig=>({...await orig<typeof import('../../state/dbConnections')>(),saveDbConnection:api.save,setActiveDbConnection:vi.fn()}))
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{localStorage.clear();api.test.mockReset().mockResolvedValue({version:'embedded',latencyMs:1});api.connect.mockReset().mockResolvedValue({connId:'fixture',capabilities:{}});api.save.mockReset()})
function show(dbType:'sqlite'|'duckdb',host=''){return render(<LanguageProvider><DataProvider><NewConnectionModal onClose={()=>{}} editProfile={{id:'embedded-fixture',name:'embedded',dbType,host,port:5432,user:'stale-user',database:'stale-db',options:'stale=true',ssl:true}}/></DataProvider></LanguageProvider>)}
it.each(['sqlite','duckdb'] as const)('requires an explicit %s file path instead of a blank temporary database',type=>{show(type);expect(screen.getByLabelText('Database file path')).toHaveValue('');expect(screen.getByRole('button',{name:'Test connection'})).toBeDisabled();expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();expect(screen.queryByLabelText('Port')).toBeNull();expect(screen.queryByLabelText('Database (optional)')).toBeNull();expect(screen.queryByText('Via SSH tunnel')).toBeNull();expect(api.connect).not.toHaveBeenCalled()})
it('passes the path through the existing host contract without stale network parameters',async()=>{show('sqlite');fireEvent.change(screen.getByLabelText('Database file path'),{target:{value:':memory:'}});fireEvent.click(screen.getByRole('button',{name:'Test connection'}));await waitFor(()=>expect(api.test).toHaveBeenCalledTimes(1));expect(api.test.mock.calls[0][0]).toMatchObject({dbType:'sqlite',host:':memory:',port:0,user:''});for(const key of ['database','options','ssl','caCertPath','sslRejectUnauthorized'])expect(api.test.mock.calls[0][0]).not.toHaveProperty(key);fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(api.connect).toHaveBeenCalledTimes(1));expect(api.save.mock.calls[0][0]).toMatchObject({host:':memory:',port:0,user:''});expect(api.save.mock.calls[0][0]).not.toHaveProperty('database')})
