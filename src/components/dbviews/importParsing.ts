import type {ImportParseOptions, ImportPreview} from '../../services/db'

export function defaultImportOptions(path: string): ImportParseOptions | undefined {
  if (!/\.(csv|tsv)$/i.test(path)) return undefined
  return {delimiter:/\.tsv$/i.test(path)?'\t':',',headerRow:1,dataStartRow:2,trimValues:false,emptyStringAsNull:true}
}
export function validImportOptions(o?: ImportParseOptions): boolean {
  if (!o) return true
  return typeof o.delimiter==='string' && typeof o.trimValues==='boolean' && typeof o.emptyStringAsNull==='boolean' && o.delimiter.length===1 && o.delimiter.charCodeAt(0)<128 && !['\0','\r','\n','"'].includes(o.delimiter)
    && Number.isSafeInteger(o.headerRow) && o.headerRow>=0 && o.headerRow<=1_000_000
    && Number.isSafeInteger(o.dataStartRow) && o.dataStartRow>o.headerRow && o.dataStartRow<=1_000_001
}
/** A legacy server must not silently ignore options selected in the new UI. */
export function importPreviewMatches(preview: ImportPreview, options?: ImportParseOptions): boolean {
  if (!preview || !/^[a-f0-9]{64}$/.test(preview.sourceFingerprint ?? '')) return false
  const actual=preview.parseOptions
  if (!options) return actual==null
  return !!actual && validImportOptions(actual) && (Object.keys(options) as (keyof ImportParseOptions)[]).every(k=>actual[k]===options[k])
}
export function mapImportByPosition(source: string[], target: string[]): Record<string,string> {
  return Object.fromEntries(source.map((name,index)=>[name,target[index]??'']))
}
