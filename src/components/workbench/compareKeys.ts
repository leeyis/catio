import type { TableStructure } from '../../services/types'

type Structure = Pick<TableStructure,'columns'> & Partial<Pick<TableStructure,'indexes'|'fks'>>
export function compareKeyStatus(source:Structure,target:Structure,keys:readonly string[]):{valid:boolean;unique:boolean} {
  const sourceNames=new Set(source.columns.map(c=>c.name)), targetNames=new Set(target.columns.map(c=>c.name))
  const valid=keys.length>0 && new Set(keys).size===keys.length && sourceNames.size===source.columns.length && targetNames.size===target.columns.length && keys.every(k=>sourceNames.has(k)&&targetNames.has(k))
  // Legacy index.cols is a display string: do not split commas or assume a partial
  // unique index proves whole-table uniqueness. Only complete primary keys are proven.
  const containsPk=(st:Structure)=>{const pk=st.columns.filter(c=>c.key==='PK');return pk.length>0 && pk.every(c=>keys.includes(c.name))}
  return {valid,unique:valid && containsPk(source) && containsPk(target)}
}
export function comparisonStructureFingerprint(structure:Structure):string {
  return JSON.stringify([structure.columns,structure.indexes ?? [],structure.fks ?? []])
}
