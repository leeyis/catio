import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn } from '../atoms'
import { Icon } from '../Icon'
import { ConfirmModal } from '../modals/ConfirmModal'
import type { QuerySessionInfo, TransactionAction } from '../../services/db'

export function QuerySessionToolbar({info,loading,busy,error,onAction,onReconnect}:{
  info:QuerySessionInfo|null;loading:boolean;busy:boolean;error:string|null;
  onAction:(action:TransactionAction)=>void;onReconnect:()=>void;
}) {
  const {t}=useTranslation()
  const [confirm,setConfirm]=useState(false)
  const state=info?.transactionState??'unknown'
  const disabled=loading||busy||!info
  return <>
    <div className="row" style={{gap:8,flexWrap:'wrap',padding:'5px 12px',borderBottom:'1px solid var(--border-hairline)',flex:'none'}}>
      <span className="chip" title={t('dbviews.isolatedSessionHint')} style={{fontSize:11,color:state==='failed'?'var(--danger-fg)':state==='active'?'var(--signal-amber)':'var(--text-tertiary)'}}>
        {t(loading?'dbviews.sessionOpening':'dbviews.isolatedSession')} · {t(`dbviews.txState.${state}`)}
      </span>
      <Btn size="sm" variant="ghost" disabled={disabled||state!=='idle'} onClick={()=>onAction('begin')}>{t('dbviews.txBegin')}</Btn>
      <Btn size="sm" variant="ghost" disabled={disabled||state!=='active'} onClick={()=>onAction('commit')}>{t('dbviews.txCommit')}</Btn>
      <Btn size="sm" variant="ghost" disabled={disabled||state==='idle'} onClick={()=>onAction('rollback')}>{t('dbviews.txRollback')}</Btn>
      <button className="icon-btn bare" title={t('dbviews.sessionReconnect')} disabled={loading||busy}
        onClick={()=>{if(info&&(info.busy||state!=='idle'))setConfirm(true);else onReconnect()}}>
        <Icon name="refresh-cw" size={14}/>
      </button>
      {error&&<span role="alert" style={{color:'var(--danger-fg)',fontSize:11.5,overflowWrap:'anywhere'}}>{error}</span>}
    </div>
    {confirm&&<ConfirmModal title={t('dbviews.sessionReconnect')} message={t('dbviews.sessionCloseWarning')}
      confirmLabel={t('dbviews.sessionReconnectConfirm')} danger confirmIcon="refresh-cw"
      onCancel={()=>setConfirm(false)} onConfirm={()=>{setConfirm(false);onReconnect()}}/>}
  </>
}
