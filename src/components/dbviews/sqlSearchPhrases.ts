import {EditorState} from '@codemirror/state'

export function sqlSearchPhrases(t:(key:string)=>string) {
  const keys:Record<string,string>={
    Find:'find',Replace:'replacement',next:'next',previous:'previous',all:'all',
    'match case':'matchCase',regexp:'regexp','by word':'wholeWord',replace:'replace',
    'replace all':'replaceAll',close:'close','Go to line':'goToLine',go:'go',
    'current match':'currentMatch','on line':'onLine',
    'replaced match on line $':'replacedLine','replaced $ matches':'replacedCount',
  }
  return EditorState.phrases.of(Object.fromEntries(Object.entries(keys).map(([phrase,key])=>[phrase,t('dbviews.editorSearch.'+key)])))
}
