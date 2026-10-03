/** Shared error normalization for database RPCs and metadata; no circular service imports. */
export function dbErrMsg(error:unknown):string {
  if(error instanceof Error)return error.message
  if(typeof error==='string')return error
  if(error&&typeof error==='object'){
    const value=error as Record<string,unknown>
    if(typeof value.message==='string'&&value.message)return value.message
    try{return JSON.stringify(error)}catch{return String(error)}
  }
  return String(error)
}
