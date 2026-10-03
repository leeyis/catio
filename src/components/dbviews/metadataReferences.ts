/** Completion loading only: this is not a SQL authorization/classification boundary. */
export function referencedNamespaces(sql:string,names:string[],current?:string):string[]{
  const known=new Map(names.map(name=>[name.toLowerCase(),name]))
  const selected=new Set<string>()
  if(current&&known.has(current.toLowerCase()))selected.add(known.get(current.toLowerCase())!)
  const qualifier=/"((?:[^"]|"")*)"\s*\.|`((?:[^`]|``)*)`\s*\.|\[((?:[^\]]|\]\])*)\]\s*\.|([\p{L}_][\p{L}\p{N}_$]*)\s*\./gu
  for(const match of sql.matchAll(qualifier)){
    const name=(match[1]?.replace(/""/g,'"')??match[2]?.replace(/``/g,'`')??match[3]?.replace(/\]\]/g,']')??match[4]).toLowerCase()
    const actual=known.get(name);if(actual)selected.add(actual)
  }
  return [...selected]
}
