/* 对象(视图/函数/存储过程)源码预览 pane:统一 tab 系统中的 kind:'object' 内容。
   自管 objectSource fetch(逻辑自 DbWorkbench 平移)。 */
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import { SqlEditor } from '../dbviews/SqlEditor'
import { objectSource, saveObjectSource, dbErrMsg } from '../../services/db'

export interface ObjectPaneProps {
  connId: string | null
  schema: string
  name: string
  objKind: 'view' | 'function' | 'procedure'
}

export function ObjectPane({ connId, schema, name, objKind }: ObjectPaneProps) {
  const { t } = useTranslation()
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 保存态:idle → saving → saved(短暂回弹到 idle);saveErr 单独承载失败提示。
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // dirty 守卫:仅当源码相对上次 fetch/保存发生改动才允许保存,避免误触发重跑 DDL。
  const [isDirty, setIsDirty] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  async function save() {
    if (!connId || !src.trim() || saving || !isDirty) return
    setSaving(true)
    setSaveErr(null)
    setSaved(false)
    try {
      await saveObjectSource(connId, schema, name, objKind, src)
      setIsDirty(false)
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1600)
    } catch (e) {
      setSaveErr(dbErrMsg(e))
    } finally {
      setSaving(false)
    }
  }

  // One-tap source copy: copy → switch icon to `check` for ~1.2s → revert.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  function copySrc() {
    if (!src) return
    navigator.clipboard.writeText(src)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1200)
  }

  useEffect(() => {
    if (!connId) { setSrc(''); setErr(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setErr(null)
    setSrc('')
    setSaved(false)
    setSaveErr(null)
    setIsDirty(false)
    objectSource(connId, schema, name, objKind)
      .then(s => { if (!cancelled) setSrc(s) })
      .catch(e => { if (!cancelled) setErr(dbErrMsg(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema, name, objKind])

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', flex: 'none', gap: 12 }}>
        <div className="row gap7" style={{ minWidth: 0 }}>
          <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
            <Icon name={objKind === 'view' ? 'eye' : 'function-square'} size={15} />
          </div>
          <div className="col" style={{ lineHeight: 1.25, minWidth: 0 }}>
            <span className="mono ell" style={{ fontSize: 13.5, fontWeight: 700 }}>{`${schema}.${name}`}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('dbviews.objectDefinition')}</span>
          </div>
        </div>
        <div className="row gap6" style={{ flex: 'none', alignItems: 'center' }}>
          {saveErr
            ? <span className="ell" style={{ fontSize: 11, color: 'var(--signal-red)', maxWidth: 240 }}>{t('dbviews.objSaveError', { message: saveErr })}</span>
            : saved
              ? <span className="row gap5" style={{ fontSize: 11, fontWeight: 600, color: 'var(--signal-green)' }}><Icon name="check" size={13} />{t('dbviews.objSaved')}</span>
              : null}
          <IconBtn name={copied ? 'check' : 'copy'} size={14} variant="bare"
            title={copied ? t('dbviews.copied') : t('dbviews.copyDdl')}
            style={{ color: copied ? 'var(--signal-green)' : undefined, ...(src ? null : { opacity: 0.4, pointerEvents: 'none' }) }}
            onClick={copySrc} />
          <Btn variant="primary" size="sm" icon="save"
            onClick={save} disabled={saving || !src.trim() || !isDirty}>
            {saving ? t('dbviews.objSaving') : t('dbviews.objSave')}
          </Btn>
          <span className="mono" style={{ alignSelf: 'center', height: 22, lineHeight: '22px', padding: '0 9px', borderRadius: 7, fontSize: 11, fontWeight: 600,
            color: 'var(--accent-primary)', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)' }}>
            {objKind === 'view' ? t('dbviews.objViewKind') : objKind === 'function' ? t('dbviews.objFunctionKind') : t('dbviews.objProcedureKind')}
          </span>
        </div>
      </div>
      <div className="grow" style={{ minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {loading
          ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.objLoading')}</div>
          : err
            ? <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--signal-red)', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('dbviews.loadError', { message: err })}</div>
            : src
              ? <SqlEditor code={src} onChange={v => { setSrc(v); setIsDirty(true); if (saveErr) setSaveErr(null); if (saved) setSaved(false) }} />
              : <div className="grow" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 12 }}>{t('dbviews.noDefinition')}</div>}
      </div>
    </>
  )
}
