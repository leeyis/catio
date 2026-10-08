// WHERE/ORDER BY suggestions are local editing aids, never an execution gate.
import {clauseRole,clauseTokens} from './clauseContext'
import {completionIdentifier} from './sqlCompletionSchema'
import {dialectFor} from './sqlDialect'
export type ClauseMode='where'|'order'
export interface ClauseItem { label:string; insert:string; kind:'column'|'keyword'; detail?:string }
export interface ClauseSuggest {start:number;end:number;items:ClauseItem[];source:string}

export function clauseSuggest(value:string,cursor:number,columns:string[],mode:ClauseMode,engine?:string):ClauseSuggest {
  const pos=Math.max(0,Math.min(Number.isFinite(cursor)?cursor:0,value.length)),empty:ClauseSuggest={start:pos,end:pos,items:[],source:value}
  const tokens=clauseTokens(value,engine);if(!tokens)return empty
  const token=tokens.find(t=>pos>t.from&&pos<=t.to)
  if(!token||!['word','identifier'].includes(token.kind)||token.kind==='identifier'&&token.closed&&pos===token.to)return empty
  const role=clauseRole(value,tokens.filter(t=>t.to<=token.from),mode==='order')
  if(!role)return empty
  const close=token.open==='['?']':token.open
  const prefix=token.kind==='identifier'?value.slice(token.from+1,pos).split(close!+close!).join(close):value.slice(token.from,pos)
  if(!prefix)return empty // Focusing or a bare operator never opens a menu.
  const lower=prefix.toLowerCase(),items:ClauseItem[]=[],seen=new Set<string>()
  if(role==='field'){
    for(const name of columns.slice(0,10000)){
      if(!name.toLowerCase().startsWith(lower)||name.toLowerCase()===lower||seen.has(name))continue
      seen.add(name)
      const insert=token.open?token.open+name.split(close!).join(close!+close!)+close
        :dialectFor(engine)===dialectFor('sqlserver')?'['+name.replace(/]/g,']]')+']':completionIdentifier(name,engine)
      items.push({label:name,insert,kind:'column'});if(items.length>=50)break
    }
  }else if(token.kind==='word'){
    const dialect=dialectFor(engine),postgres=dialect===dialectFor('postgres'),mysql=dialect===dialectFor('mysql')||dialect===dialectFor('mariadb'),sqlite=dialect===dialectFor('sqlite')
    const operators=['BETWEEN','NOT BETWEEN','LIKE','NOT LIKE','IN','NOT IN','IS NULL','IS NOT NULL',...(postgres?['ILIKE','NOT ILIKE']:[]),...(mysql?['REGEXP','RLIKE']:[]),...(sqlite?['GLOB']:[])]
    const booleans=postgres||mysql||sqlite?['TRUE','FALSE']:[]
    const keywords=role==='operator'?[...operators,'AND','OR']:role==='connector'?['AND','OR']:role==='betweenAnd'?['AND']:role==='notOperator'?operators.filter(k=>!k.startsWith('NOT ')&&!k.startsWith('IS ')):role==='is'?['NULL','NOT NULL',...booleans]:role==='isNot'?['NULL',...booleans]:role==='direction'?['ASC','DESC']:[]
    for(const label of keywords)if(label.toLowerCase().startsWith(lower)&&label.toLowerCase()!==lower)items.push({label,insert:label,kind:'keyword',...(label.endsWith('BETWEEN')?{detail:label+' … AND …'}:{})})
  }
  return {start:token.from,end:token.to,items,source:value}
}

/** Refuse an obsolete menu; never replace a newer draft with its old token range. */
export function applyClauseItem(value:string,sug:ClauseSuggest,item:ClauseItem):{value:string;cursor:number}{
  if(value!==sug.source||!sug.items.some(i=>i.insert===item.insert&&i.kind===item.kind))return {value,cursor:Math.min(sug.end,value.length)}
  const before=value.slice(0,sug.start)+item.insert
  return {value:before+value.slice(sug.end),cursor:before.length}
}
