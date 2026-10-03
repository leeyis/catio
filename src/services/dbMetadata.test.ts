import {beforeEach,describe,it,expect,vi} from 'vitest'
const rpc=vi.hoisted(()=>vi.fn())
vi.mock('./transport',()=>({rpc,isTauri:()=>true,isServer:()=>false}))
import {getSchema,loadSchemaNamespace,invalidateSchemaCache,preferredNamespace} from './dbMetadata'
beforeEach(()=>{rpc.mockReset();invalidateSchemaCache()})
describe('scoped metadata cache',()=>{
  it('loads names and actual default without enumerating every namespace',async()=>{
    rpc.mockResolvedValue({namespaces:['INFORMATION_SCHEMA','PUBLIC'],defaultNamespace:'PUBLIC'})
    const schema=await getSchema('c',{lazy:true})
    expect(schema.defaultNamespace).toBe('PUBLIC')
    expect(schema.schemas.map(ns=>ns.status)).toEqual(['unloaded','unloaded'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('db_schema_catalog',{connId:'c'})
    expect(preferredNamespace(schema.schemas.map(s=>s.name),undefined,schema.defaultNamespace)).toBe('PUBLIC')
  })
  it('deduplicates in-flight namespace loads and preserves routine errors',async()=>{
    rpc.mockResolvedValue({name:'PUBLIC',tables:[{name:'items',kind:'table'}],functions:[],functionsError:'denied'})
    const [a,b]=await Promise.all([loadSchemaNamespace('c','PUBLIC'),loadSchemaNamespace('c','PUBLIC')])
    expect(rpc).toHaveBeenCalledTimes(1);expect(a.tables[0].name).toBe('items');expect(b.routineError).toBe('denied')
  })
  it('does not turn denied table enumeration into an empty success and allows retry',async()=>{
    rpc.mockRejectedValueOnce(new Error('namespace denied')).mockResolvedValueOnce({name:'a',tables:[],functions:[]})
    await expect(loadSchemaNamespace('c','a')).rejects.toThrow('namespace denied')
    expect((await loadSchemaNamespace('c','a')).status).toBe('loaded')
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('prevents a stale response from being reused after connection invalidation',async()=>{
    let resolve!:(v:unknown)=>void;rpc.mockReturnValueOnce(new Promise(ok=>{resolve=ok}))
    const stale=loadSchemaNamespace('c','a');invalidateSchemaCache('c')
    rpc.mockResolvedValueOnce({name:'a',tables:[{name:'new_table',kind:'table'}],functions:[]})
    const current=await loadSchemaNamespace('c','a')
    resolve({name:'a',tables:[{name:'old_table',kind:'table'}],functions:[]})
    await expect(stale).rejects.toThrow(/superseded/)
    expect((await loadSchemaNamespace('c','a')).tables).toEqual(current.tables)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('keeps slow in-flight loads deduplicated and starts TTL on resolution',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1000)
    try {
      let resolve!:(v:unknown)=>void;rpc.mockReturnValue(new Promise(ok=>{resolve=ok}))
      const first=loadSchemaNamespace('c','APP')
      clock.mockReturnValue(90_000)
      const second=loadSchemaNamespace('c','APP')
      expect(rpc).toHaveBeenCalledTimes(1)
      resolve({name:'APP',tables:[],functions:[]})
      await Promise.all([first,second])
      clock.mockReturnValue(120_000)
      await loadSchemaNamespace('c','APP')
      expect(rpc).toHaveBeenCalledTimes(1)
    } finally {clock.mockRestore()}
  })
  it('retains actionable plain-object Tauri errors for full-picker consumers',async()=>{
    rpc.mockResolvedValueOnce({namespaces:['APP'],defaultNamespace:'APP'}).mockRejectedValueOnce({kind:'queryFailed',message:'permission denied'})
    const schema=await getSchema('c')
    expect(schema.schemas[0].status).toBe('error')
    expect(schema.schemas[0].error).toBe('permission denied')
  })
  it('honors an explicit schema and never prefers a system schema just by alphabetic order',()=>{
    expect(preferredNamespace(['INFORMATION_SCHEMA','PUBLIC'],'INFORMATION_SCHEMA','PUBLIC')).toBe('INFORMATION_SCHEMA')
    expect(preferredNamespace(['INFORMATION_SCHEMA','PUBLIC'])).toBe('PUBLIC')
    expect(preferredNamespace(['pg_catalog','app'])).toBe('app')
  })
})
