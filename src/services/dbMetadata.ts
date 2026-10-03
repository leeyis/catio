import { DATA } from './mockData'
import { dbErrMsg } from './dbError'
import { rpc,isTauri,isServer } from './transport'
import type { Schema,SchemaNamespace } from './types'

export const SCHEMA_INVALIDATED_EVENT='catio-schema-invalidated'
const TTL=60_000
interface CacheEntry {expires:number;promise:Promise<unknown>}
interface ConnectionCache {requests:Map<string,CacheEntry>}
const caches=new Map<string,ConnectionCache>()
function cacheFor(connId:string){let cache=caches.get(connId);if(!cache){cache={requests:new Map()};caches.set(connId,cache)}return cache}
async function cached<T>(connId:string,key:string,load:()=>Promise<T>):Promise<T>{
  const cache=cacheFor(connId),existing=cache.requests.get(key)
  if(existing&&existing.expires>Date.now())return existing.promise as Promise<T>
  const promise:Promise<T>=load().then(value=>{
    if(caches.get(connId)!==cache||cache.requests.get(key)?.promise!==promise)throw new Error('Metadata request was superseded by a connection refresh')
    cache.requests.get(key)!.expires=Date.now()+TTL
    return value
  }).catch(error=>{if(cache.requests.get(key)?.promise===promise)cache.requests.delete(key);throw error})
  // TTL starts after resolution; slow in-flight requests remain deduplicated.
  cache.requests.set(key,{expires:Number.POSITIVE_INFINITY,promise});return promise
}
export function cacheMetadataRequest<T>(connId:string,key:string,load:()=>Promise<T>):Promise<T>{return cached(connId,key,load)}
export function invalidateSchemaCache(connId?:string,options:{schema?:string;announce?:boolean}={}){
  if(connId&&options.schema){const cache=caches.get(connId);for(const kind of ['namespace','columns','relations'])cache?.requests.delete(`${kind}:${options.schema}`)}
  else if(connId)caches.delete(connId);else caches.clear()
  if(options.announce!==false&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent(SCHEMA_INVALIDATED_EVENT,{detail:{connId,schema:options.schema}}))
}
export function preferredNamespace(names:string[],explicit?:string,preferred?:string):string {
  if(explicit&&names.includes(explicit))return explicit
  if(preferred&&names.includes(preferred))return preferred
  const system=/^(information_schema|pg_catalog|pg_toast|mysql|performance_schema|sys|sysibm|syscat|system_lobs)$/i
  return names.find(name=>!system.test(name))??names[0]??''
}
interface Catalog {namespaces:string[];defaultNamespace?:string|null;defaultNamespaceError?:string|null}
interface Objects {name:string;tables:{name:string;kind:string;rowsEstimate?:number|null}[];functions:string[];functionsError?:string|null}
function objectsToNamespace(raw:Objects):SchemaNamespace {
  return {name:raw.name,status:'loaded',tables:raw.tables.filter(t=>t.kind!=='view').map(t=>({name:t.name,rows:t.rowsEstimate==null?'':String(t.rowsEstimate),cols:0})),
    views:raw.tables.filter(t=>t.kind==='view').map(t=>({name:t.name})),functions:raw.functions.map(name=>({name})),routineError:raw.functionsError??undefined}
}
export async function loadSchemaNamespace(connId:string,name:string):Promise<SchemaNamespace>{
  if(!isTauri()&&!isServer())return DATA.schema.schemas.find(ns=>ns.name===name)??{name,tables:[],views:[],functions:[]}
  const raw=await cached<Objects>(connId,`namespace:${name}`,()=>rpc('db_schema_namespace',{connId,schema:name}))
  return objectsToNamespace(raw)
}
export async function getSchema(connId:string,options:{lazy?:boolean}={}):Promise<Schema>{
  if(!isTauri()&&!isServer())return DATA.schema
  const catalog=await cached<Catalog>(connId,'catalog',()=>rpc('db_schema_catalog',{connId}))
  const schemas:SchemaNamespace[]=catalog.namespaces.map(name=>({name,status:'unloaded',tables:[],views:[],functions:[]}))
  if(!options.lazy){
    let next=0
    await Promise.all(Array.from({length:Math.min(4,schemas.length)},async()=>{
      while(next<schemas.length){const index=next++;const name=schemas[index].name
        try{schemas[index]=await loadSchemaNamespace(connId,name)}catch(error){schemas[index]={name,status:'error',error:dbErrMsg(error),tables:[],views:[],functions:[]}}
      }
    }))
  }
  return {db:connId,schemas,defaultNamespace:catalog.defaultNamespace??undefined,defaultNamespaceError:catalog.defaultNamespaceError??undefined}
}
export interface ColumnCatalog {
  tables: [string, string[]][]
  errors: { schema: string; message: string }[]
  truncated: boolean
}
export async function schemaColumnCatalog(connId: string, schema: string): Promise<ColumnCatalog> {
  if (!isTauri() && !isServer()) return { tables: [], errors: [], truncated: false }
  return cached(connId, `columns:${schema}`, () => rpc<ColumnCatalog>('db_column_catalog', { connId, schema }))
}

export interface MetadataSearchResult {
  objects:{schema:string;name:string;kind:string}[]
  errors:{schema:string;message:string}[]
  truncated:boolean
  cancelled:boolean
}
export async function searchSchemaObjects(connId:string,pattern:string,executionId:string,limit=200):Promise<MetadataSearchResult>{
  if(!isTauri()&&!isServer())return {objects:[],errors:[],truncated:false,cancelled:false}
  return rpc('db_search_objects',{connId,pattern,executionId,limit})
}
export async function cancelMetadataSearch(connId:string,executionId:string):Promise<void>{
  if(!isTauri()&&!isServer())return
  return rpc('db_cancel_metadata',{connId,executionId})
}
