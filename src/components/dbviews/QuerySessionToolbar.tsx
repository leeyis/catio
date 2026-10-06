import {useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {ConfirmModal} from '../modals/ConfirmModal'
import {MetadataNodeActions} from '../workbench/MetadataNodeActions'
import type {QuerySessionInfo,TransactionAction} from '../../services/db'

/** One transaction status/menu, rather than another row of competing actions. */
export function QuerySessionToolbar({info,loading,busy,error,onAction,onReconnect,ownerKey=''}:{
  ownerKey?:string;info:QuerySessionInfo|null;loading:boolean;busy:boolean;error:string|null;
  onAction:(action:TransactionAction)=>void;onReconnect:()=>void;
}) {
  const {t}=useTranslation(),[confirm,setConfirm]=useState(false)
  const state=info?.transactionState??'unknown'
  const disabled=loading||busy||!info||info.supportsTransactions===false
  useEffect(()=>setConfirm(false),[ownerKey,info?.id])
  const label=loading?t('dbviews.sessionOpening'):busy?t('dbviews.workspace.busy'):info?.supportsTransactions===false?t('dbviews.workspace.noTransactions'):t(`dbviews.txState.${state}`)
  return <>
    <div className="db-transaction-control" data-state={state} data-error={!!error}>
      <MetadataNodeActions className="db-action-menu" ownerKey={JSON.stringify([ownerKey,info?.id,state,loading,busy,error])}
        title={t('dbviews.workspace.transactionActions')} triggerIcon="chevron-down"
        triggerLabel={<span title={t(state==='manual'?'dbviews.jdbcManualStateHint':'dbviews.isolatedSessionHint')}>{t('dbviews.workspace.transaction')} · {label}</span>}
        items={[
          {id:'begin',label:t('dbviews.txBegin'),icon:'play',disabled:disabled||state!=='idle',action:()=>onAction('begin')},
          {id:'commit',label:t('dbviews.txCommit'),icon:'check',disabled:disabled||!['active','manual'].includes(state),action:()=>onAction('commit')},
          {id:'rollback',label:t('dbviews.txRollback'),icon:'rotate-ccw',danger:true,disabled:disabled||state==='idle',action:()=>onAction('rollback')},
          {id:'reconnect',label:t('dbviews.sessionReconnect'),icon:'refresh-cw',disabled:loading||busy,action:()=>{if(info&&(info.busy||state!=='idle'))setConfirm(true);else onReconnect()}},
        ]}><span/></MetadataNodeActions>
      {error&&<span className="db-session-error" role="alert">{error}</span>}
    </div>
    {confirm&&<ConfirmModal title={t('dbviews.sessionReconnect')} message={t('dbviews.sessionCloseWarning')}
      confirmLabel={t('dbviews.sessionReconnectConfirm')} danger confirmIcon="refresh-cw"
      onCancel={()=>setConfirm(false)} onConfirm={()=>{setConfirm(false);onReconnect()}}/>}
  </>
}
