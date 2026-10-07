export interface DatabaseExportPreferences {
  includeStructure: boolean
  includeData: boolean
  batchSize?: number
  rowLimit?: number
}
const KEY = 'catio:database:export-options:v1'
const defaults: DatabaseExportPreferences = { includeStructure:true, includeData:true }
function positive(value:unknown,max:number):number|undefined {
  return typeof value==='number' && Number.isSafeInteger(value) && value>0 && value<=max ? value : undefined
}
/** Deliberate allowlist: no table, connection, namespace, path or SQL is persisted. */
export function normalizeDatabaseExportPreferences(value:unknown):DatabaseExportPreferences {
  const input=value && typeof value==='object' ? value as Record<string,unknown> : {}
  const includeStructure=typeof input.includeStructure==='boolean' ? input.includeStructure : true
  const includeData=typeof input.includeData==='boolean' ? input.includeData : true
  return {includeStructure:includeStructure || !includeData,includeData:includeData || !includeStructure,
    batchSize:positive(input.batchSize,1000),rowLimit:positive(input.rowLimit,4294967295)}
}
export function readDatabaseExportPreferences():DatabaseExportPreferences {
  try {return normalizeDatabaseExportPreferences(JSON.parse(localStorage.getItem(KEY) ?? 'null'))}
  catch {return {...defaults}}
}
export function saveDatabaseExportPreferences(value:DatabaseExportPreferences):boolean {
  try {localStorage.setItem(KEY,JSON.stringify(normalizeDatabaseExportPreferences(value)));return true}
  catch {return false}
}
/** Pin collation and break case/accent ties independently of incoming catalog order. */
export function sortExportTables(names:readonly string[]):string[] {
  return [...new Set(names)].sort((a,b)=>a.localeCompare(b,'en',{sensitivity:'base',numeric:true}) || (a<b?-1:a>b?1:0))
}
