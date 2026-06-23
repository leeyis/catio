import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { RedisKeyspaceView } from './RedisKeyspaceView'

const keyspaceInfo = vi.fn()
const redisEdit = vi.fn()
vi.mock('../../services/db', () => ({
  keyspaceInfo: (...a: unknown[]) => keyspaceInfo(...a),
  redisEdit: (...a: unknown[]) => redisEdit(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('RedisKeyspaceView', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { keyspaceInfo.mockReset(); redisEdit.mockReset() })

  it('renders total keys and the sampled key-type distribution', async () => {
    keyspaceInfo.mockResolvedValue({
      totalKeys: 234,
      sampled: 234,
      types: [{ name: 'string', count: 600 }, { name: 'hash', count: 400 }],
    })
    wrap(<RedisKeyspaceView connId="c1" schema="db0" />)
    expect(await screen.findByText('234')).toBeInTheDocument()
    expect(screen.getByText('string')).toBeInTheDocument()
    expect(screen.getByText('hash')).toBeInTheDocument()
    expect(screen.getByText('600')).toBeInTheDocument()
  })

  it('shows an empty state when the database has no keys', async () => {
    keyspaceInfo.mockResolvedValue({ totalKeys: 0, sampled: 0, types: [] })
    wrap(<RedisKeyspaceView connId="c1" schema="db5" />)
    expect(await screen.findByText('No keys in this database')).toBeInTheDocument()
  })

  it('applies a string SET edit via redisEdit and keeps the read-only summary', async () => {
    keyspaceInfo.mockResolvedValue({ totalKeys: 1, sampled: 1, types: [{ name: 'string', count: 1 }] })
    redisEdit.mockResolvedValue(0)
    wrap(<RedisKeyspaceView connId="c1" schema="db0" />)
    // 只读摘要仍在(查看态保留)。
    expect(await screen.findByText('string')).toBeInTheDocument()

    // 填 key + value,点应用 → 调用 redisEdit 的 setString 编辑。
    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'mykey' } })
    fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(redisEdit).toHaveBeenCalledWith('c1', {
      kind: 'setString', key: 'mykey', value: 'hello',
    }, false))
  })

  it('asks for confirmation before a DEL and passes confirm=true when accepted', async () => {
    keyspaceInfo.mockResolvedValue({ totalKeys: 1, sampled: 1, types: [{ name: 'string', count: 1 }] })
    redisEdit.mockResolvedValue(1)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    wrap(<RedisKeyspaceView connId="c1" schema="db0" />)
    await screen.findByText('string')

    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'doomed' } })
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'delKey' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    await waitFor(() => expect(redisEdit).toHaveBeenCalledWith('c1', { kind: 'delKey', key: 'doomed' }, true))
    confirmSpy.mockRestore()
  })

  it('does not delete when the confirmation is cancelled', async () => {
    keyspaceInfo.mockResolvedValue({ totalKeys: 1, sampled: 1, types: [{ name: 'string', count: 1 }] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap(<RedisKeyspaceView connId="c1" schema="db0" />)
    await screen.findByText('string')

    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'doomed' } })
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'delKey' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(redisEdit).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('applies a TTL edit (EXPIRE) for the entered key', async () => {
    keyspaceInfo.mockResolvedValue({ totalKeys: 1, sampled: 1, types: [{ name: 'string', count: 1 }] })
    redisEdit.mockResolvedValue(0)
    wrap(<RedisKeyspaceView connId="c1" schema="db0" />)
    await screen.findByText('string')

    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'mykey' } })
    // 切到 TTL 操作类型。
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'setTtl' } })
    fireEvent.change(screen.getByPlaceholderText('TTL (seconds)'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(redisEdit).toHaveBeenCalledWith('c1', {
      kind: 'setTtl', key: 'mykey', ttl: 60,
    }, false))
  })
})
