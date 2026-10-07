import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn } from '../atoms'
import { DatabaseFileFlow } from './DatabaseFileFlow'
import { DEFAULT_DATABASE_EDITOR_PREFERENCES, updateDatabaseEditorPreferences, useDatabaseEditorPreferences, type DatabaseEditorPreferences } from '../../state/databaseEditorPreferences'

export function DatabaseEditorSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const settings = useDatabaseEditorPreferences()
  const [memoryOnly, setMemoryOnly] = useState(false)
  function update(patch: Partial<DatabaseEditorPreferences>) { setMemoryOnly(!updateDatabaseEditorPreferences(patch)) }
  const toggles = ['completionOnTyping', 'functionParameters', 'signatureHelp', 'lineWrapping', 'foldGutter'] as const
  return <DatabaseFileFlow title={t('dbEditor.title')} target={t('dbEditor.scope')} steps={[]} step={0} busy={false} onClose={onClose}
    footer={<><Btn variant="secondary" onClick={() => update({ ...DEFAULT_DATABASE_EDITOR_PREFERENCES })}>{t('dbEditor.reset')}</Btn><Btn variant="primary" onClick={onClose}>{t('dbviews.close')}</Btn></>}>
    <h3>{t('dbEditor.formatting')}</h3>
    <div className="db-flow-mapping col gap12">
      <label>{t('dbEditor.keywordCase')}<select aria-label={t('dbEditor.keywordCase')} value={settings.keywordCase} onChange={e => update({ keywordCase: e.target.value as DatabaseEditorPreferences['keywordCase'] })}>
        {(['upper', 'lower', 'preserve'] as const).map(value => <option key={value} value={value}>{t('dbEditor.' + value)}</option>)}
      </select></label>
      <label>{t('dbEditor.commaPosition')}<select aria-label={t('dbEditor.commaPosition')} value={settings.commaPosition} onChange={e => update({ commaPosition: e.target.value as DatabaseEditorPreferences['commaPosition'] })}>
        <option value="after">{t('dbEditor.commaAfter')}</option><option value="before">{t('dbEditor.commaBefore')}</option>
      </select></label>
      <label>{t('dbEditor.tabWidth')}<select aria-label={t('dbEditor.tabWidth')} value={settings.tabWidth} onChange={e => update({ tabWidth: Number(e.target.value) as 2 | 4 | 8 })}>
        {[2, 4, 8].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </div>
    <h3>{t('dbEditor.input')}</h3>
    <div className="col gap12">
      {toggles.map(key => <label className="row gap8" style={{ flexDirection: 'row', alignItems: 'center' }} key={key}><input type="checkbox" checked={settings[key]} onChange={e => update({ [key]: e.target.checked })}/>{t('dbEditor.' + key)}</label>)}
      <label>{t('dbEditor.completionKey')}<select aria-label={t('dbEditor.completionKey')} value={settings.completionKey} onChange={e => update({ completionKey: e.target.value as DatabaseEditorPreferences['completionKey'] })}>
        <option value="Ctrl-Space">Ctrl + Space</option><option value="Alt-Space">Alt + Space</option>
      </select></label>
    </div>
    <p className="db-flow-muted">{t('dbEditor.shortcuts')}</p>
    {memoryOnly && <p role="alert" className="db-flow-notice">{t('dbEditor.memoryOnly')}</p>}
  </DatabaseFileFlow>
}
