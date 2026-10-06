import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { HistoryPanel } from './HistoryPanel'
import { SnippetsPanel } from './SnippetsPanel'
import i18n from '../../i18n'
const copy=vi.hoisted(()=>vi.fn())
vi.mock('../../services/clipboard',()=>({copyTextToClipboard:copy}))
beforeEach(async()=>{copy.mockReset();localStorage.clear();await i18n.changeLanguage('en')})
it.each(['history','snippet'])('waits for the %s clipboard receipt and surfaces failures',async kind=>{
  let finish!:(value:boolean)=>void
  copy.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  render(<LanguageProvider><DataProvider>{kind==='history'
    ? <HistoryPanel onClose={()=>{}} items={[{id:'h',kind:'sql',target:'qa',text:'select 17',when:'now',dur:'1ms'}]}/>
    : <SnippetsPanel onClose={()=>{}} snippets={[{id:'s',scope:'SQL',icon:'database',code:'select 17',desc:'QA'}]}/>
  }</DataProvider></LanguageProvider>)
  fireEvent.click(screen.getByTitle('Copy'))
  expect(screen.queryByTitle('Copied')).not.toBeInTheDocument()
  expect(copy).toHaveBeenCalledWith('select 17')
  await act(async()=>{finish(false)})
  expect(screen.getByRole('alert')).toHaveTextContent(/copy failed/i)
  expect(screen.queryByTitle('Copied')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTitle('Copy'))
  await act(async()=>{finish(true)})
  expect(screen.getByTitle('Copied')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
