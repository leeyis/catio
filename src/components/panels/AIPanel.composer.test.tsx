import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import type { TableStructure, Connection } from '../../services/types'
import { AIPanel, type AIPanelProps } from './AIPanel'

const api = vi.hoisted(() => ({ schema: vi.fn(), structure: vi.fn() }))
vi.mock('../../services/db', () => ({ getSchema: api.schema, tableStructure: api.structure }))
vi.mock('../../state/agentConfig', () => ({ useAgentConfig: () => ({ config: { model: 'test', executionMode: 'manual' }, update: vi.fn() }) }))
const connection: Connection = { id: 'profile', group: '', kind: 'db', name: 'QA SQLite', sub: '', icon: 'database', status: 'up', engine: 'sqlite' }
const structure: TableStructure = { comment: '', columns: [{ name: 'id', type: 'INTEGER', nullable: false, default: null, key: 'PK', extra: '', comment: '' }], indexes: [], fks: [] }
const catalog = { db: 'main', schemas: [{ name: 'main', tables: [{ name: 'orders', cols: 1, rows: '' }], views: [], functions: [] }] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function panel(props: Partial<AIPanelProps> = {}) {
  return <LanguageProvider><AIPanel conn={connection} connId="runtime-1" contextKey="tab-1" engine="sqlite" onClose={() => {}} attachment={null} onClearAttachment={() => {}} {...props}/></LanguageProvider>
}
async function selectTable() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '解释 @orders' } })
  fireEvent.click(await screen.findByText('orders'))
}
beforeEach(() => {
  localStorage.clear()
  api.schema.mockReset().mockResolvedValue(catalog)
  api.structure.mockReset().mockResolvedValue(structure)
})
afterEach(() => { vi.useRealTimers() })

it('does not enumerate the database before an explicit @ request', () => {
  render(panel())
  expect(api.schema).not.toHaveBeenCalled()
})
it('shows a catalog failure rather than an empty database and offers retry', async () => {
  api.schema.mockRejectedValueOnce(new Error('sensitive backend details'))
  render(panel())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('对象列表加载失败')
  expect(screen.queryByText('没有找到匹配的对象')).toBeNull()
  expect(screen.queryByText(/sensitive backend details/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('orders')).toBeTruthy()
})
it('preserves draft, table and selection when required metadata fails; sends nothing', async () => {
  api.structure.mockRejectedValueOnce(new Error('password=do-not-forward'))
  const send = vi.fn(), clear = vi.fn()
  render(panel({ onSend: send, onClearAttachment: clear, attachment: { kind: 'sql', target: 'QA source', text: 'SELECT 7' } }))
  await selectTable()
  fireEvent.click(screen.getByTitle('发送'))
  expect(await screen.findByRole('alert')).toHaveTextContent('未发送')
  expect(screen.getByRole('textbox')).toHaveValue('解释 ')
  expect(screen.getByTitle('移除表')).toBeTruthy()
  expect(clear).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(screen.queryByText(/do-not-forward/)).toBeNull()
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(send.mock.calls[0][0]).toContain('QA source')
  expect(send.mock.calls[0][0]).toContain('SELECT 7')
  expect(send.mock.calls[0][0]).toContain('CREATE TABLE')
  expect(clear).toHaveBeenCalledOnce()
})
it.each(['tab', 'connection', 'conversation', 'hidden'])('discards a pending preparation after a %s change', async change => {
  const pending = deferred<TableStructure>(), send = vi.fn()
  api.structure.mockReturnValueOnce(pending.promise)
  const view = render(panel({ onSend: send }))
  await selectTable()
  fireEvent.click(screen.getByTitle('发送'))
  const next: Partial<AIPanelProps> = change === 'tab' ? { contextKey: 'tab-2' }
    : change === 'connection' ? { connId: 'runtime-2' }
    : change === 'conversation' ? { conversation: { id: 'new', hostKey: 'profile', title: '', messages: [], createdAt: 1, updatedAt: 1 } }
    : { visible: false }
  view.rerender(panel({ onSend: send, ...next }))
  await act(async () => pending.resolve(structure))
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('解释 ')
})
it('unmount cannot dispatch the pending message', async () => {
  const pending = deferred<TableStructure>(), send = vi.fn()
  api.structure.mockReturnValueOnce(pending.promise)
  const view = render(panel({ onSend: send }))
  await selectTable(); fireEvent.click(screen.getByTitle('发送'))
  view.unmount()
  await act(async () => pending.resolve(structure))
  expect(send).not.toHaveBeenCalled()
})
it('locks preparation against double Enter and clears context only when ready to dispatch', async () => {
  const pending = deferred<TableStructure>(), send = vi.fn(), clear = vi.fn()
  api.structure.mockReturnValue(pending.promise)
  render(panel({ onSend: send, onClearAttachment: clear, attachment: { kind: 'sql', target: 'source', text: 'SELECT 7' } }))
  await selectTable()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(api.structure).toHaveBeenCalledOnce()
  expect(clear).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly')
  await act(async () => pending.resolve(structure))
  expect(send).toHaveBeenCalledOnce()
  expect(clear).toHaveBeenCalledOnce()
})
it('cancel leaves the draft intact and late metadata cannot dispatch', async () => {
  const pending = deferred<TableStructure>(), send = vi.fn()
  api.structure.mockReturnValueOnce(pending.promise)
  render(panel({ onSend: send })); await selectTable()
  fireEvent.click(screen.getByTitle('发送'))
  fireEvent.click(screen.getByRole('button', { name: '取消准备' }))
  await act(async () => pending.resolve(structure))
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('解释 ')
})
it('bounds metadata preparation and ignores responses after timeout', async () => {
  const pending = deferred<TableStructure>(), send = vi.fn()
  api.structure.mockReturnValueOnce(pending.promise)
  render(panel({ onSend: send })); await selectTable()
  vi.useFakeTimers()
  fireEvent.click(screen.getByTitle('发送'))
  await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
  expect(screen.getByRole('alert')).toHaveTextContent('超时')
  await act(async () => pending.resolve(structure))
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('解释 ')
})
it('replacement selection cancels old preparation without clearing the new selection', async () => {
  const pending = deferred<TableStructure>(), send = vi.fn(), clear = vi.fn()
  api.structure.mockReturnValueOnce(pending.promise)
  const view = render(panel({ onSend: send, onClearAttachment: clear }))
  await selectTable(); fireEvent.click(screen.getByTitle('发送'))
  view.rerender(panel({ onSend: send, onClearAttachment: clear, attachment: { kind: 'sql', target: 'new', text: 'SELECT 99' } }))
  await act(async () => pending.resolve(structure))
  expect(send).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
  expect(screen.getByText('SELECT 99')).toBeTruthy()
})
it('does not send from an IME confirmation or without a send handler', () => {
  const send = vi.fn()
  const view = render(panel({ onSend: send }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '解释' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(send).not.toHaveBeenCalled()
  view.rerender(panel())
  fireEvent.click(screen.getByTitle('发送'))
  expect(screen.getByRole('textbox')).toHaveValue('解释')
})
it('fails closed on an oversized context without truncating or losing the draft', async () => {
  const send = vi.fn()
  render(panel({ onSend: send, attachment: { kind: 'sql', target: 'QA', text: '界'.repeat(30_000) } }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '解释' } })
  fireEvent.click(screen.getByTitle('发送'))
  expect(await screen.findByRole('alert')).toHaveTextContent('上下文过大')
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('解释')
})
