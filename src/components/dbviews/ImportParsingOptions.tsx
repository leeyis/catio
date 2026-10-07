import {useTranslation} from 'react-i18next'
import type {ImportParseOptions} from '../../services/db'

export function ImportParsingOptions({value,onChange,busy}:{value:ImportParseOptions;onChange:(v:ImportParseOptions)=>void;busy:boolean}) {
  const {t}=useTranslation()
  return <section aria-label={t('dbimport.parsing')}>
    <h3>{t('dbimport.parsing')}</h3>
    <div className="db-flow-fields">
      <label>{t('dbimport.delimiter')}<select disabled={busy} value={value.delimiter} onChange={e=>onChange({...value,delimiter:e.target.value})}>
        {[[',','comma'],['\t','tab'],[';','semicolon'],['|','pipe']].map(([v,k])=><option key={k} value={v}>{t(`dbimport.${k}`)}</option>)}
      </select></label>
      <label>{t('dbimport.headerRow')}<input type="number" disabled={busy} min={0} max={1_000_000} step={1} value={Number.isFinite(value.headerRow)?value.headerRow:''} onChange={e=>{
        const headerRow=e.target.value===''?NaN:Number(e.target.value)
        onChange({...value,headerRow,dataStartRow:headerRow+1})
      }}/></label>
      <label>{t('dbimport.dataStartRow')}<input type="number" disabled={busy} min={1} max={1_000_001} step={1} value={Number.isFinite(value.dataStartRow)?value.dataStartRow:''} onChange={e=>onChange({...value,dataStartRow:e.target.value===''?NaN:Number(e.target.value)})}/></label>
    </div>
    <div className="db-flow-fields">
      <label className="db-import-check"><input type="checkbox" disabled={busy} checked={value.trimValues} onChange={e=>onChange({...value,trimValues:e.target.checked})}/>{t('dbimport.trim')}</label>
      <label className="db-import-check"><input type="checkbox" disabled={busy} checked={!value.emptyStringAsNull} onChange={e=>onChange({...value,emptyStringAsNull:!e.target.checked})}/>{t('dbimport.keepEmpty')}</label>
    </div>
    <p className="db-flow-muted">{t('dbimport.recordHint')}</p>
  </section>
}

export function ImportParsingSummary({value}:{value:ImportParseOptions}) {
  const {t}=useTranslation()
  const separator={',':'comma','\t':'tab',';':'semicolon','|':'pipe'}[value.delimiter]
  return <p className="db-flow-notice">{t('dbimport.parsing')}: {separator?t(`dbimport.${separator}`):value.delimiter} · {value.headerRow===0?t('dbimport.noHeader'):t('dbimport.headerSummary',{row:value.headerRow})} · {t('dbimport.dataSummary',{row:value.dataStartRow})}<br/>
    {value.trimValues?t('dbimport.trim'):t('dbimport.keepWhitespace')} · {value.emptyStringAsNull?t('dbimport.emptyNull'):t('dbimport.keepEmpty')}
  </p>
}
