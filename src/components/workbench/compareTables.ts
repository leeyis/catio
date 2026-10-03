/* Type-aware data comparison. Canonical column order is the source order; SQL literals
 * share the grid's tested dialect rules. No nullable/duplicate/ambiguous row identity. */
import type {BinaryCell} from '../../services/types'
import {sqlValue,copyDialectFor} from '../dbviews/copySql'
import {validBinaryHex} from '../dbviews/binaryValue'

export interface CompareInput {
  srcColumns:string[];srcRows:unknown[][];srcBinaryCells?:BinaryCell[]
  tgtColumns:string[];tgtRows:unknown[][];tgtBinaryCells?:BinaryCell[]
  pkNames:string[]
}
export interface CompareDiff {
  colNames:string[];pkNames:string[]
  inserts:unknown[][];updates:{src:unknown[]}[];deletes:unknown[][]
  binary?:{inserts:BinaryCell[];updates:BinaryCell[];deletes:BinaryCell[]}
  error?:'columns-mismatch'|'pk-missing'|'unsafe-key'|'duplicate-key'|'invalid-binary'
}
function numeric(value:unknown):string|null {
  if(typeof value!=='number'&&typeof value!=='string')return null
  if(typeof value==='number'&&!Number.isFinite(value))return null
  const m=String(value).match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
  if(!m)return null
  let digits=(m[2]+(m[3]??'')).replace(/^0+/,'')
  if(!digits)return '0'
  const exponent=Number(m[4]??0)-(m[3]?.length??0)
  if(!Number.isSafeInteger(exponent))return null
  const suffix=digits.match(/0+$/)?.[0].length??0
  if(suffix)digits=digits.slice(0,-suffix)
  return (m[1]==='-'?'-':'')+digits+'e'+(exponent+suffix)
}
function stableJson(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson((value as Record<string,unknown>)[key])).join(',')+'}'
  return JSON.stringify(value)??'null'
}
export function valuesEqual(a:unknown,b:unknown):boolean {
  if(a===b)return true
  if(a==null||b==null)return a==null&&b==null
  if(typeof a==='number'||typeof b==='number'){const left=numeric(a),right=numeric(b);return left!==null&&left===right}
  if(typeof a==='object'||typeof b==='object'){try{return stableJson(a)===stableJson(b)}catch{return false}}
  return String(a)===String(b)
}
function binaryRows(rows:unknown[][],columns:string[],cells:BinaryCell[]):Set<number>[]|null {
  const out=rows.map(()=>new Set<number>())
  for(const [r,c] of cells){
    if(!Number.isInteger(r)||!Number.isInteger(c)||r<0||c<0||r>=rows.length||c>=columns.length)return null
    if(rows[r][c]==null)continue
    if(!validBinaryHex(rows[r][c]))return null
    out[r].add(c)
  }
  return out
}
function rowKey(row:unknown[],keys:number[],binary:Set<number>):string {
  return JSON.stringify(keys.map(i=>binary.has(i)?['binary',String(row[i]).toLowerCase()]:['scalar',String(row[i])]))
}
export function computeDiff(input:CompareInput):CompareDiff {
  const {srcColumns:colNames,srcRows,tgtColumns,tgtRows,pkNames}=input
  const empty:CompareDiff={colNames,pkNames,inserts:[],updates:[],deletes:[],binary:{inserts:[],updates:[],deletes:[]}}
  const tgtIndexes=new Map(tgtColumns.map((c,i)=>[c,i]))
  if(new Set(colNames).size!==colNames.length||tgtIndexes.size!==tgtColumns.length||colNames.length!==tgtColumns.length||colNames.some(c=>!tgtIndexes.has(c))||srcRows.some(r=>r.length!==colNames.length)||tgtRows.some(r=>r.length!==tgtColumns.length))return {...empty,error:'columns-mismatch'}
  const keys=pkNames.map(name=>colNames.indexOf(name))
  if(!keys.length||new Set(keys).size!==keys.length||keys.some(i=>i<0))return {...empty,error:'pk-missing'}
  const sourceBinary=binaryRows(srcRows,colNames,input.srcBinaryCells??[]),targetBinary=binaryRows(tgtRows,tgtColumns,input.tgtBinaryCells??[])
  if(!sourceBinary||!targetBinary)return {...empty,error:'invalid-binary'}
  const order=colNames.map(c=>tgtIndexes.get(c)!)
  const target=tgtRows.map((row,r)=>({row:order.map(c=>row[c]),binary:new Set(order.flatMap((c,i)=>targetBinary[r].has(c)?[i]:[]))}))
  if([...srcRows,...target.map(t=>t.row)].some(row=>keys.some(i=>row[i]==null||typeof row[i]==='object'||typeof row[i]==='number'&&!Number.isFinite(row[i] as number))))return {...empty,error:'unsafe-key'}
  const targetMap=new Map<string,{row:unknown[];binary:Set<number>}>()
  for(const item of target){const key=rowKey(item.row,keys,item.binary);if(targetMap.has(key))return {...empty,error:'duplicate-key'};targetMap.set(key,item)}
  const sourceKeys=new Set<string>()
  const out:CompareDiff={colNames,pkNames,inserts:[],updates:[],deletes:[],binary:{inserts:[],updates:[],deletes:[]}}
  const mark=(kind:'inserts'|'updates'|'deletes',r:number,binary:Set<number>)=>{for(const c of binary)out.binary![kind].push([r,c])}
  for(let r=0;r<srcRows.length;r++){
    const row=srcRows[r],binary=sourceBinary[r],key=rowKey(row,keys,binary)
    if(sourceKeys.has(key))return {...empty,error:'duplicate-key'}
    sourceKeys.add(key);const previous=targetMap.get(key)
    if(!previous){mark('inserts',out.inserts.length,binary);out.inserts.push(row)}
    else if(colNames.some((_,c)=>binary.has(c)!==previous.binary.has(c)||
      (binary.has(c)?String(row[c]).toLowerCase()!==String(previous.row[c]).toLowerCase():!valuesEqual(row[c],previous.row[c])))){
      mark('updates',out.updates.length,binary);out.updates.push({src:row})
    }
  }
  for(const [key,item] of targetMap)if(!sourceKeys.has(key)){mark('deletes',out.deletes.length,item.binary);out.deletes.push(item.row)}
  return out
}
export function isMysqlish(engine?:string):boolean{return /mysql|maria|tidb|oceanbase|goldendb/i.test(engine??'')}
export function qid(name:string,engine?:string):string{
  if(isMysqlish(engine))return '`'+name.replace(/`/g,'``')+'`'
  if(/sqlserver|mssql|tiberius/i.test(engine??''))return '['+name.replace(/]/g,']]')+']'
  return '"'+name.replace(/"/g,'""')+'"'
}
export function qval(value:unknown,engine?:string,binary=false):string {
  if(typeof value==='boolean'&&isMysqlish(engine))return value?'1':'0'
  const dialect=copyDialectFor(isMysqlish(engine)?'mysql':engine)
  if(typeof value==='number'&&Number.isFinite(value)&&/e/i.test(String(value)))return sqlValue(String(value),dialect)
  return sqlValue(value,dialect,binary)
}
export function qtable(schema:string,table:string,engine?:string):string{return schema?`${qid(schema,engine)}.${qid(table,engine)}`:qid(table,engine)}
export interface SqlOptions{engine?:string;allowDelete:boolean}
export function genSyncStatements(diff:CompareDiff,schema:string,table:string,opts:SqlOptions):string[]{
  const {colNames,pkNames,inserts,updates,deletes}=diff,{engine,allowDelete}=opts
  if(diff.error||!pkNames.length||!table)return []
  const reference=qtable(schema,table,engine),keys=pkNames.map(name=>colNames.indexOf(name))
  if(keys.some(i=>i<0))return []
  const indexes=(kind:'inserts'|'updates'|'deletes')=>new Set((diff.binary?.[kind]??[]).map(([r,c])=>`${r}:${c}`))
  const where=(row:unknown[],r:number,binary:Set<string>)=>pkNames.map((name,n)=>`${qid(name,engine)} = ${qval(row[keys[n]],engine,binary.has(`${r}:${keys[n]}`))}`).join(' AND ')
  const lines:string[]=[],ib=indexes('inserts'),ub=indexes('updates'),db=indexes('deletes')
  inserts.forEach((row,r)=>lines.push(`INSERT INTO ${reference} (${colNames.map(c=>qid(c,engine)).join(', ')}) VALUES (${row.map((value,c)=>qval(value,engine,ib.has(`${r}:${c}`))).join(', ')});`))
  updates.forEach(({src},r)=>{
    const values=colNames.map((name,c)=>keys.includes(c)?null:`${qid(name,engine)} = ${qval(src[c],engine,ub.has(`${r}:${c}`))}`).filter(Boolean)
    if(values.length)lines.push(`UPDATE ${reference} SET ${values.join(', ')} WHERE ${where(src,r,ub)};`)
  })
  if(allowDelete)deletes.forEach((row,r)=>lines.push(`DELETE FROM ${reference} WHERE ${where(row,r,db)};`))
  return lines
}
export function genSyncSql(diff:CompareDiff,schema:string,table:string,opts:SqlOptions):string{return genSyncStatements(diff,schema,table,opts).join('\n')}
