import {render,screen} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import i18n from '../../i18n'
import {QuerySessionToolbar} from './QuerySessionToolbar'
beforeEach(async()=>{localStorage.clear();await i18n.changeLanguage('en')})
it('labels JDBC manual mode honestly and permits explicit commit or rollback',()=>{
  render(<LanguageProvider><QuerySessionToolbar info={{id:'j',transactionState:'manual',busy:false,canCancel:true,supportsTransactions:true,leaseSeconds:1800}}
    loading={false} busy={false} error={null} onAction={vi.fn()} onReconnect={vi.fn()}/></LanguageProvider>)
  expect(screen.getByText(/Manual commit mode/)).toHaveAttribute('title',expect.stringContaining('implicitly commit'))
  expect(screen.getByRole('button',{name:'Commit transaction'})).toBeEnabled()
  expect(screen.getByRole('button',{name:'Begin transaction'})).toBeDisabled()
})
it('does not offer transaction actions for a session whose driver lacks transactions',()=>{
  render(<LanguageProvider><QuerySessionToolbar info={{id:'j',transactionState:'idle',busy:false,canCancel:false,supportsTransactions:false,leaseSeconds:1800}}
    loading={false} busy={false} error={null} onAction={vi.fn()} onReconnect={vi.fn()}/></LanguageProvider>)
  for(const name of ['Begin transaction','Commit transaction','Roll back transaction'])expect(screen.getByRole('button',{name})).toBeDisabled()
})
