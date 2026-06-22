import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { RedisKeyspaceView } from './RedisKeyspaceView'

const keyspaceInfo = vi.fn()
vi.mock('../../services/db', () => ({
  keyspaceInfo: (...a: unknown[]) => keyspaceInfo(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('RedisKeyspaceView', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

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
})
