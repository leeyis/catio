export function rawValueText(value:unknown):string {
  if(value==null)return 'NULL'
  if(typeof value==='string')return value
  if(typeof value==='object'){try{return JSON.stringify(value)}catch{return String(value)}}
  return String(value)
}
/** Pretty printing is lexical: JSON number tokens, escapes and original types are
 * never converted through Number / JSON.parse + stringify. */
export function formatJsonValue(raw:string):string|null {
  if(raw.length>1_048_576)return null
  try{JSON.parse(raw)}catch{return null}
  const text=raw.trim();if(!['{','['].includes(text[0]??''))return null
  let out='',depth=0,quoted=false,escaped=false
  const newline=()=>{out+='\n'+'  '.repeat(Math.min(depth,128))}
  for(let i=0;i<text.length;i++){
    if(out.length>2_097_152)return null // Indentation expansion also has a budget.
    const ch=text[i]
    if(quoted){out+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue}
    if(ch==='"'){quoted=true;out+=ch}
    else if(ch==='{'||ch==='['){out+=ch;depth++;if(depth>128)return null;if(text[i+1]!=='}'&&text[i+1]!==']')newline()}
    else if(ch==='}'||ch===']'){depth--;if(text[i-1]!=='{'&&text[i-1]!=='[')newline();out+=ch}
    else if(ch===','){out+=ch;newline()}
    else if(ch===':')out+=': '
    else if(!/\s/.test(ch))out+=ch
  }
  return out
}
