import { dialectFor } from './sqlDialect'

export type ClauseToken = { from:number; to:number; kind:'word'|'identifier'|'value'|'symbol'|'comment'; open?:string; closed?:boolean }
const wordChar=/[\p{L}\p{N}_$]/u
/** Bounded lexer for suggestions, not a SQL validator. Never reinterpret literal/comment text as a field. */
export function clauseTokens(value:string,engine?:string):ClauseToken[]|null {
  if(value.length>16_384)return null
  const spec=dialectFor(engine).spec,quotes=spec.identifierQuotes??'"',tokens:ClauseToken[]=[]
  let i=0
  const push=(from:number,kind:ClauseToken['kind'],extra:Partial<ClauseToken>={})=>tokens.push({from,to:i,kind,...extra})
  while(i<value.length){
    if(tokens.length>=2048)return null
    const from=i,c=value[i]
    if(/\s/.test(c)){i++;continue}
    if(value.startsWith('--',i)||(c==='#'&&spec.hashComments)){
      i=value.indexOf('\n',i);if(i<0)i=value.length;push(from,'comment',{closed:i<value.length});continue
    }
    if(value.startsWith('/*',i)){
      i+=2;let depth=1
      while(i<value.length&&depth){if(value.startsWith('/*',i)){depth++;i+=2}else if(value.startsWith('*/',i)){depth--;i+=2}else i++}
      push(from,'comment',{closed:depth===0});continue
    }
    const dollar=c==='$'?/^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(value.slice(i)):null
    if(dollar){const end=value.indexOf(dollar[0],i+dollar[0].length);i=end<0?value.length:end+dollar[0].length;push(from,'value',{closed:end>=0});continue}
    // Conservatively protect Oracle alternative quotes even for an unknown JDBC profile.
    if(/[qQ]/.test(c)&&value[i+1]==="'"&&value[i+2]){
      const open=value[i+2],close:Record<string,string>={'[':']','(':')','{':'}','<':'>'}
      const end=value.indexOf((close[open]??open)+"'",i+3);i=end<0?value.length:end+2;push(from,'value',{closed:end>=0});continue
    }
    const prefixed=/[eEnNbBxX]/.test(c)&&value[i+1]==="'"
    const quote=prefixed?"'":c
    if(quote==="'"||quote==='"'||quotes.includes(quote)){
      const identifier=!prefixed&&quote!=="'"&&quotes.includes(quote)&&!(quote==='"'&&spec.doubleQuotedStrings)
      const close=quote==='['?']':quote
      const escapes=!identifier&&(!!spec.backslashEscapes||prefixed&&/[eE]/.test(c))
      i+=prefixed?2:1;let closed=false
      while(i<value.length){if(escapes&&value[i]==='\\'){i+=Math.min(2,value.length-i);continue}if(value[i]===close){if(value[i+1]===close){i+=2;continue}i++;closed=true;break}i++}
      push(from,identifier?'identifier':'value',{open:quote,closed});continue
    }
    const number=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?/.exec(value.slice(i))
    if(number){i+=number[0].length;push(from,'value');continue}
    if(wordChar.test(c)){while(i<value.length&&wordChar.test(value[i]))i++;push(from,'word');continue}
    const symbol=/^(?:<=|>=|<>|!=|::|\|\||[.,()+\-*/%<>=~!&|;])/.exec(value.slice(i))
    if(!symbol)return null
    i+=symbol[0].length;push(from,'symbol')
  }
  return tokens
}

export type ClauseRole='field'|'operator'|'value'|'connector'|'betweenFirst'|'betweenAnd'|'betweenSecond'|'is'|'isNot'|'notOperator'|'in'|'direction'|'ordered'
/** Intentionally small expression recognizer. Subqueries, casts and unfamiliar syntax fail closed. */
export function clauseRole(value:string,tokens:ClauseToken[],order:boolean):ClauseRole|null {
  type Frame={role:ClauseRole;opaque?:boolean;depth?:number}
  const frames:Frame[]=[{role:'field'}]
  let previous:ClauseToken|undefined,lastOperand:ClauseRole|undefined
  const finish=(role:ClauseRole):ClauseRole|null=>role==='field'?(order?'direction':'operator'):role==='value'?'connector':role==='betweenFirst'?'betweenAnd':role==='betweenSecond'?'connector':null
  for(const token of tokens){
    if(token.kind==='comment')continue
    const text=value.slice(token.from,token.to).toUpperCase(),frame=frames[frames.length-1]
    if(frame.opaque){
      if(text==='(')frame.depth=(frame.depth??1)+1
      if(text===')'){frame.depth=(frame.depth??1)-1;if(frame.depth===0)frames.pop()}
      previous=token;continue
    }
    const role=frame.role
    if(text==='('){
      if(previous?.kind==='word'&&lastOperand){frames.push({role:'value',opaque:true,depth:1})}
      else if(role==='in'){frame.role='connector';frames.push({role:'value',opaque:true,depth:1})}
      else if(role==='field'){frame.role='connector';frames.push({role:'field'})}
      else {const next=finish(role);if(!next)return null;frame.role=next;frames.push({role:'value',opaque:true,depth:1})}
      if(frames.length>32)return null
    }else if(text===')'){
      if(frames.length===1||!['operator','connector'].includes(role))return null
      frames.pop()
    }else if(token.kind==='symbol'){
      if(order&&text===','&&(role==='direction'||role==='ordered'))frame.role='field'
      else if(!order&&/^(?:=|<>|!=|<=|>=|<|>)$/.test(text)&&role==='operator')frame.role='value'
      else if(/^[+\-*/%]$/.test(text)&&lastOperand)frame.role=lastOperand
      else if(/^[+\-]$/.test(text)&&['field','value','betweenFirst','betweenSecond'].includes(role)){/* unary sign */}
      else return null
    }else if(token.kind==='word'&&text==='NOT'){
      if(role==='operator')frame.role='notOperator';else if(role==='is')frame.role='isNot';else if(role!=='field')return null
    }else if(token.kind==='word'&&text==='AND'&&role==='betweenAnd')frame.role='betweenSecond'
    else if(token.kind==='word'&&/^(AND|OR)$/.test(text)&&!order){if(!['operator','connector'].includes(role))return null;frame.role='field'}
    else if(token.kind==='word'&&text==='IS'&&role==='operator')frame.role='is'
    else if(token.kind==='word'&&/^(BETWEEN|IN|LIKE|ILIKE|REGEXP|RLIKE|GLOB)$/.test(text)&&['operator','notOperator'].includes(role))frame.role=text==='BETWEEN'?'betweenFirst':text==='IN'?'in':'value'
    else if(token.kind==='word'&&/^(NULL|TRUE|FALSE)$/.test(text)&&['is','isNot'].includes(role))frame.role='connector'
    else if(order&&token.kind==='word'&&/^(ASC|DESC)$/.test(text)&&role==='direction')frame.role='ordered'
    else {
      if(token.kind==='word'&&/^(SELECT|WITH|EXISTS|CASE|WHEN|THEN|ELSE|END)$/.test(text))return null
      const next=finish(role);if(!next)return null;frame.role=next;lastOperand=role;previous=token;continue
    }
    lastOperand=undefined;previous=token
  }
  return frames[frames.length-1].opaque?null:frames[frames.length-1].role
}
